import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager, In } from 'typeorm';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { Env } from '../../../config/env.validation';
import { AdminPermissionService } from '../../identity/application/admin-permission.service';
import {
  UserContact,
  UserLookupService,
} from '../../identity/application/user-lookup.service';
import {
  EmailBlock,
  renderEmail,
} from '../../notifications/application/email-template';
import { OutboxService } from '../../notifications/application/outbox.service';
import { MerchantRole, ReviewItemKey } from '../domain/merchant.enums';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { MerchantMemberEntity } from '../infrastructure/entities/merchant-member.entity';
import { WalletTopUpEntity } from '../infrastructure/entities/wallet-top-up.entity';
import { MerchantWalletEntity } from '../infrastructure/entities/merchant-wallet.entity';
import { formatNaira } from '../domain/wallet';

export type MerchantStatusEmail =
  | 'submitted'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'suspended'
  | 'reinstated'
  | 'closed';

const SECTION_LABELS: Record<ReviewItemKey, string> = {
  [ReviewItemKey.PROFILE]: 'Business profile',
  [ReviewItemKey.BUSINESS_REGISTRATION]: 'CAC registration',
  [ReviewItemKey.DIRECTORS]: 'Owner / director ID',
  [ReviewItemKey.BANK_ACCOUNT]: 'Settlement bank account',
  [ReviewItemKey.TERMS]: 'Terms and data processing agreement',
};

export function sectionLabel(key: ReviewItemKey): string {
  return SECTION_LABELS[key];
}

// Every merchant email. Always enqueued through the outbox inside the
// caller's transaction (pass `manager`), so an email is sent if and only
// if the change it describes committed.
@Injectable()
export class MerchantNotifierService {
  private readonly logger = new Logger(MerchantNotifierService.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly userLookup: UserLookupService,
    private readonly adminPermissions: AdminPermissionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  dashboardUrl(path = ''): string {
    const dashboard: string | undefined = this.config.get(
      'MERCHANT_DASHBOARD_URL',
      { infer: true },
    );
    const base: string =
      dashboard ?? this.config.get('FRONTEND_URL', { infer: true });
    return `${base.replace(/\/$/, '')}${path}`;
  }

  async statusChanged(
    merchant: MerchantEntity,
    event: MerchantStatusEmail,
    manager: EntityManager,
    extra: {
      reason?: string | null;
      rejectedSections?: { key: ReviewItemKey; reason: string | null }[];
    } = {},
  ): Promise<void> {
    const name = merchant.tradingName;
    const reasonBlock: EmailBlock[] = extra.reason
      ? [{ kind: 'details', rows: [{ label: 'Reason', value: extra.reason }] }]
      : [];
    const content: Record<
      MerchantStatusEmail,
      { subject: string; heading: string; blocks: EmailBlock[] }
    > = {
      submitted: {
        subject: `We've received ${name}'s application`,
        heading: 'Application received',
        blocks: [
          {
            kind: 'paragraph',
            text: `Thanks for submitting ${name}. Our team usually reviews applications within one working day. We'll email you when there's an update.`,
          },
          {
            kind: 'paragraph',
            text: 'Your test API keys keep working while you wait, so you can finish your integration.',
          },
        ],
      },
      approved: {
        subject: `${name} is approved on Locoomo`,
        heading: 'You’re approved',
        blocks: [
          {
            kind: 'paragraph',
            text: `${name} can now ship live parcels. Turn on two-factor authentication for owners and admins, then create your live API keys from the dashboard.`,
          },
          {
            kind: 'button',
            label: 'Open dashboard',
            url: this.dashboardUrl('/'),
          },
        ],
      },
      changes_requested: {
        subject: `Action needed: update ${name}'s application`,
        heading: 'A few changes needed',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Our review team needs you to update these sections before we can approve your account:',
          },
          {
            kind: 'list',
            items: (extra.rejectedSections ?? []).map(
              (section) =>
                `${sectionLabel(section.key)}${section.reason ? `: ${section.reason}` : ''}`,
            ),
          },
          ...reasonBlock,
          {
            kind: 'button',
            label: 'Update application',
            url: this.dashboardUrl('/onboarding'),
          },
        ],
      },
      rejected: {
        subject: `Update on ${name}'s application`,
        heading: 'Application not approved',
        blocks: [
          {
            kind: 'paragraph',
            text: `We're unable to approve ${name} for the Locoomo merchant platform.`,
          },
          ...reasonBlock,
          {
            kind: 'paragraph',
            text: 'If you think this is a mistake, reply to this email.',
          },
        ],
      },
      suspended: {
        subject: `${name}'s account is suspended`,
        heading: 'Account suspended',
        blocks: [
          {
            kind: 'paragraph',
            text: `We've suspended ${name}. Parcels already on their way continue to their destination and you can still sign in and view your account, but you can't create new live shipments or change keys and webhooks.`,
          },
          ...reasonBlock,
          {
            kind: 'paragraph',
            text: 'Reply to this email or contact your account manager to resolve it.',
          },
        ],
      },
      reinstated: {
        subject: `${name}'s account is active again`,
        heading: 'Suspension lifted',
        blocks: [
          {
            kind: 'paragraph',
            text: `${name} is no longer suspended. Everything works as before.`,
          },
        ],
      },
      closed: {
        subject: `${name}'s merchant account is closed`,
        heading: 'Account closed',
        blocks: [
          {
            kind: 'paragraph',
            text: `${name}'s merchant account has been closed and its team removed. Your personal Locoomo sign-in still works.`,
          },
        ],
      },
    };

    const recipients = await this.teamLeads(merchant.id, manager);
    await this.send(recipients, content[event], manager);
  }

  // The KYC queue: every active admin with `kyc` (or `super`).
  async newSubmissionForReviewers(
    merchant: MerchantEntity,
    manager: EntityManager,
  ): Promise<void> {
    const admins = await this.adminsWith(AdminPermission.KYC);
    if (admins.length === 0) {
      this.logger.warn(
        `Merchant ${merchant.id} submitted but no active admin has the kyc permission`,
      );
      return;
    }
    await this.send(
      admins,
      {
        subject: `KYC review: ${merchant.tradingName}`,
        heading: 'New merchant to review',
        blocks: [
          {
            kind: 'details',
            rows: [
              { label: 'Merchant', value: merchant.tradingName },
              { label: 'Type', value: merchant.type },
              { label: 'Merchant ID', value: merchant.id },
            ],
          },
          {
            kind: 'paragraph',
            text: 'Open Merchants › Review queue in the admin app. Target: a decision within one working day.',
          },
        ],
      },
      manager,
    );
  }

  async invite(
    input: {
      email: string;
      merchantName: string;
      role: MerchantRole;
      inviterName: string;
      rawToken: string;
      expiresAt: Date;
    },
    manager: EntityManager,
  ): Promise<void> {
    const url = this.dashboardUrl(
      `/accept-invite?token=${encodeURIComponent(input.rawToken)}`,
    );
    const { html, text } = renderEmail({
      heading: `Join ${input.merchantName} on Locoomo`,
      blocks: [
        {
          kind: 'paragraph',
          text: `${input.inviterName} invited you to join ${input.merchantName}'s team as ${input.role}.`,
        },
        { kind: 'button', label: 'Accept invitation', url },
        {
          kind: 'paragraph',
          text: `Sign in, or create a free Locoomo account, with ${input.email} to accept. The invitation expires on ${input.expiresAt.toUTCString()}.`,
        },
      ],
      footnote: 'Not expecting this? You can ignore this email.',
    });
    await this.outbox.enqueueEmail(
      {
        to: input.email,
        subject: `You're invited to join ${input.merchantName} on Locoomo`,
        text,
        html,
      },
      manager,
    );
  }

  // Security notice: a change to where money goes.
  async bankAccountChanged(
    merchant: MerchantEntity,
    details: { bankName: string; last4: string; changedBy: string },
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchant.id, manager);
    await this.send(
      recipients,
      {
        subject: `${merchant.tradingName}'s settlement bank account was changed`,
        heading: 'Bank account changed',
        blocks: [
          {
            kind: 'details',
            rows: [
              {
                label: 'New account',
                value: `${details.bankName} ••••${details.last4}`,
              },
              { label: 'Changed by', value: details.changedBy },
            ],
          },
          {
            kind: 'paragraph',
            text: 'If you didn’t expect this, sign in, check your team, and contact your account manager straight away.',
          },
        ],
      },
      manager,
    );
  }

  async teamChanged(
    merchant: MerchantEntity,
    message: { subject: string; text: string },
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchant.id, manager);
    await this.send(
      recipients,
      {
        subject: message.subject,
        heading: 'Team update',
        blocks: [{ kind: 'paragraph', text: message.text }],
      },
      manager,
    );
  }

  // Webhook endpoint auto-disabled after failing for 36 hours (§12.5).
  async webhookEndpointDisabled(
    merchantId: string,
    endpoint: { url: string; mode: string },
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchantId, manager, [
      MerchantRole.OWNER,
      MerchantRole.ADMIN,
      MerchantRole.DEVELOPER,
    ]);
    await this.send(
      recipients,
      {
        subject: 'A Locoomo webhook endpoint was disabled',
        heading: 'Webhook endpoint disabled',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Every delivery to this endpoint has failed for 36 hours, so we stopped sending to it.',
          },
          {
            kind: 'details',
            rows: [
              { label: 'Endpoint', value: endpoint.url },
              { label: 'Mode', value: endpoint.mode },
            ],
          },
          {
            kind: 'paragraph',
            text: 'Fix the endpoint, re-enable it in Developers › Webhooks, then replay the events you missed.',
          },
          {
            kind: 'button',
            label: 'Open webhooks',
            url: this.dashboardUrl('/developers/webhooks'),
          },
        ],
      },
      manager,
    );
  }

  // Receipt for a top-up (plan §8.2): owner, admins and finance members.
  async walletFunded(
    merchant: MerchantEntity,
    topUp: WalletTopUpEntity,
    balanceAfterKobo: number,
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchant.id, manager, [
      MerchantRole.OWNER,
      MerchantRole.ADMIN,
      MerchantRole.FINANCE,
    ]);
    const rows = [
      { label: 'Business', value: merchant.tradingName },
      {
        label: 'Method',
        value: topUp.method === 'card' ? 'Card payment' : 'Bank transfer',
      },
      { label: 'Amount paid', value: formatNaira(topUp.amountKobo) },
      ...(topUp.feeKobo > 0
        ? [{ label: 'Card processing fee', value: formatNaira(topUp.feeKobo) }]
        : []),
      { label: 'Added to wallet', value: formatNaira(topUp.creditedKobo ?? 0) },
      { label: 'New balance', value: formatNaira(balanceAfterKobo) },
      { label: 'Reference', value: topUp.reference },
      ...(topUp.mode === 'test' ? [{ label: 'Mode', value: 'Test' }] : []),
    ];
    await this.send(
      recipients,
      {
        subject: `Wallet top-up received: ${formatNaira(topUp.creditedKobo ?? 0)}`,
        heading: 'Top-up received',
        blocks: [
          { kind: 'details', rows },
          {
            kind: 'paragraph',
            text: `Your statement is in the merchant dashboard: ${this.dashboardUrl('/wallet')}`,
          },
        ],
      },
      manager,
    );
  }

  // Available balance fell below the merchant's own threshold.
  async walletLowBalance(
    merchant: MerchantEntity,
    wallet: MerchantWalletEntity,
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchant.id, manager, [
      MerchantRole.OWNER,
      MerchantRole.ADMIN,
      MerchantRole.FINANCE,
    ]);
    const available = wallet.balanceKobo - wallet.heldKobo;
    await this.send(
      recipients,
      {
        subject: `Low wallet balance${wallet.mode === 'test' ? ' (test)' : ''}: ${formatNaira(available)} available`,
        heading: 'Your wallet is running low',
        blocks: [
          {
            kind: 'details',
            rows: [
              { label: 'Business', value: merchant.tradingName },
              { label: 'Available', value: formatNaira(available) },
              {
                label: 'Your alert level',
                value: formatNaira(wallet.lowBalanceThresholdKobo ?? 0),
              },
            ],
          },
          {
            kind: 'paragraph',
            text: `New shipments need enough available balance. Top up in the merchant dashboard: ${this.dashboardUrl('/wallet')}`,
          },
        ],
      },
      manager,
    );
  }

  // Abandoned returns (plan D20, M6a), one email per merchant per run.
  async returnsStorage(
    merchant: MerchantEntity,
    stage: 'fees_started' | 'disposal_soon' | 'disposed',
    items: {
      reference: string;
      trackingCode: string;
      nodeName: string;
      disposeAt: Date | null;
    }[],
    feeKobo: number,
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchant.id, manager, [
      MerchantRole.OWNER,
      MerchantRole.ADMIN,
      MerchantRole.OPERATIONS,
    ]);
    const n = items.length;
    const parcels = `${n} return${n === 1 ? '' : 's'}`;
    const copy = {
      fees_started: {
        subject: `Storage fees have started on ${parcels}`,
        heading: 'Your returns are waiting to be collected',
        text: `These returns have been waiting at their Node for 10 working days, so storage is now charged to your wallet at ${formatNaira(feeKobo)} per parcel per day. Collect them (one code for many: Returns › Collect these) to stop the charges.`,
      },
      disposal_soon: {
        subject: `${parcels} will be disposed of in 7 days`,
        heading: 'Collect your returns, or they will be disposed of',
        text: 'Under the merchant terms, uncollected returns are disposed of 30 days after storage fees start. Collect these before the date shown.',
      },
      disposed: {
        subject: `${parcels} disposed of`,
        heading: 'Uncollected returns disposed of',
        text: 'These returns were never collected and have been disposed of under the merchant terms. Storage fees have stopped.',
      },
    }[stage];
    await this.send(
      recipients,
      {
        subject: copy.subject,
        heading: copy.heading,
        blocks: [
          { kind: 'paragraph', text: copy.text },
          {
            kind: 'details',
            rows: items.slice(0, 50).map((item) => ({
              label: `${item.reference} (${item.trackingCode})`,
              value:
                stage === 'disposal_soon' && item.disposeAt
                  ? `${item.nodeName}, by ${item.disposeAt.toISOString().slice(0, 10)}`
                  : item.nodeName,
            })),
          },
          ...(n > 50
            ? [
                {
                  kind: 'paragraph' as const,
                  text: `…and ${n - 50} more. See them all in the merchant dashboard: ${this.dashboardUrl('/returns')}`,
                },
              ]
            : [
                {
                  kind: 'paragraph' as const,
                  text: `Merchant dashboard: ${this.dashboardUrl('/returns')}`,
                },
              ]),
        ],
      },
      manager,
    );
  }

  // Ops: physical parcels to remove from Node shelves.
  async returnsDisposedForOps(
    items: { merchantName: string; trackingCode: string; nodeName: string }[],
    manager: EntityManager,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.send(
      await this.adminsWith(AdminPermission.OPS),
      {
        subject: `${items.length} abandoned return(s) to dispose of`,
        heading: 'Abandoned returns to remove from Nodes',
        blocks: [
          {
            kind: 'paragraph',
            text: 'These merchant returns passed their disposal date. Arrange removal from the Nodes under the merchant terms.',
          },
          {
            kind: 'details',
            rows: items.slice(0, 100).map((item) => ({
              label: item.trackingCode,
              value: `${item.nodeName} · ${item.merchantName}`,
            })),
          },
        ],
      },
      manager,
    );
  }

  // A claim was approved (and paid into the wallet) or rejected (D18).
  async claimDecided(
    merchant: MerchantEntity,
    claim: {
      status: 'approved' | 'rejected';
      mode: 'test' | 'live';
      trackingCode: string;
      reference: string;
      payoutKobo: number | null;
      merchantNote: string | null;
    },
    manager: EntityManager,
  ): Promise<void> {
    const recipients = await this.teamLeads(merchant.id, manager, [
      MerchantRole.OWNER,
      MerchantRole.ADMIN,
      MerchantRole.FINANCE,
    ]);
    const approved = claim.status === 'approved';
    const test = claim.mode === 'test' ? ' (test)' : '';
    await this.send(
      recipients,
      {
        subject: approved
          ? `Claim approved${test}: ${formatNaira(claim.payoutKobo ?? 0)} credited for ${claim.reference}`
          : `Claim not approved${test}: ${claim.reference}`,
        heading: approved
          ? 'Your claim was approved'
          : 'Your claim was not approved',
        blocks: [
          {
            kind: 'details',
            rows: [
              { label: 'Business', value: merchant.tradingName },
              {
                label: 'Shipment',
                value: `${claim.reference} (${claim.trackingCode})`,
              },
              ...(approved
                ? [
                    {
                      label: 'Credited to your wallet',
                      value: formatNaira(claim.payoutKobo ?? 0),
                    },
                  ]
                : []),
              ...(claim.merchantNote
                ? [{ label: 'Note from Locoomo', value: claim.merchantNote }]
                : []),
            ],
          },
          {
            kind: 'paragraph',
            text: `See the claim in the merchant dashboard: ${this.dashboardUrl('/claims')}`,
          },
        ],
      },
      manager,
    );
  }

  // A live wallet went below its tier's negative floor (plan §8.4): ops
  // follow up; parcels in flight keep moving.
  async walletBelowFloor(
    merchant: MerchantEntity,
    wallet: MerchantWalletEntity,
    floorKobo: number,
    manager: EntityManager,
  ): Promise<void> {
    const admins = await this.adminsWith(AdminPermission.FINANCE);
    if (admins.length === 0) {
      this.logger.error(
        `Merchant ${merchant.id} wallet below floor but no active admin has the finance permission`,
      );
      return;
    }
    await this.send(
      admins,
      {
        subject: `Wallet below floor: ${merchant.tradingName}`,
        heading: 'Merchant wallet below its negative floor',
        blocks: [
          {
            kind: 'details',
            rows: [
              { label: 'Merchant', value: merchant.tradingName },
              { label: 'Merchant ID', value: merchant.id },
              { label: 'Balance', value: formatNaira(wallet.balanceKobo) },
              { label: 'Floor', value: formatNaira(floorKobo) },
            ],
          },
          {
            kind: 'paragraph',
            text: 'Re-measured parcels took the balance below the allowed floor. New shipments are already refused until they top up; contact the merchant.',
          },
        ],
      },
      manager,
    );
  }

  // Nightly reconciliation found cached wallet totals that don't match the
  // ledger (plan §8.1). Finance investigates; nothing is auto-corrected.
  async walletDrift(
    drifts: {
      merchantId: string;
      mode: string;
      balanceKobo: number;
      ledgerKobo: number;
      heldKobo: number;
      activeHoldsKobo: number;
    }[],
    manager: EntityManager,
  ): Promise<void> {
    const admins = await this.adminsWith(AdminPermission.FINANCE);
    if (admins.length === 0) {
      this.logger.error(
        `Wallet drift on ${drifts.length} wallet(s) but no active admin has the finance permission`,
      );
      return;
    }
    await this.send(
      admins,
      {
        subject: `Wallet reconciliation: ${drifts.length} wallet(s) out of balance`,
        heading: 'Wallets out of balance',
        blocks: [
          {
            kind: 'paragraph',
            text: 'These wallets’ cached totals don’t match their ledger entries and active holds. Nothing was changed. Investigate before approving any adjustment.',
          },
          ...drifts.slice(0, 20).map((drift): EmailBlock => ({
            kind: 'details',
            rows: [
              { label: 'Merchant ID', value: drift.merchantId },
              { label: 'Mode', value: drift.mode },
              {
                label: 'Balance (cached / ledger)',
                value: `${drift.balanceKobo} / ${drift.ledgerKobo} kobo`,
              },
              {
                label: 'Held (cached / active holds)',
                value: `${drift.heldKobo} / ${drift.activeHoldsKobo} kobo`,
              },
            ],
          })),
        ],
      },
      manager,
    );
  }

  // Active admins with this permission (or super).
  private async adminsWith(
    permission: AdminPermission,
  ): Promise<UserContact[]> {
    return (await this.adminPermissions.list())
      .filter(
        (admin) =>
          String(admin.status) === 'active' &&
          (admin.adminPermissions.includes(permission) ||
            admin.adminPermissions.includes(AdminPermission.SUPER)),
      )
      .map((admin) => ({
        id: admin.id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
      }));
  }

  // Owner and admins (by default): the people who act on account emails.
  private async teamLeads(
    merchantId: string,
    manager: EntityManager,
    roles: MerchantRole[] = [MerchantRole.OWNER, MerchantRole.ADMIN],
  ): Promise<UserContact[]> {
    const leads = await manager.find(MerchantMemberEntity, {
      where: { merchantId, role: In(roles) },
    });
    return this.userLookup.getContacts(leads.map((lead) => lead.userId));
  }

  private async send(
    recipients: UserContact[],
    message: { subject: string; heading: string; blocks: EmailBlock[] },
    manager: EntityManager,
  ): Promise<void> {
    for (const recipient of recipients) {
      const { html, text } = renderEmail({
        greetingName: recipient.firstName,
        heading: message.heading,
        blocks: message.blocks,
      });
      await this.outbox.enqueueEmail(
        { to: recipient.email, subject: message.subject, text, html },
        manager,
      );
    }
  }
}
