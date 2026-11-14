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
    const admins = (await this.adminPermissions.list()).filter(
      (admin) =>
        String(admin.status) === 'active' &&
        (admin.adminPermissions.includes(AdminPermission.KYC) ||
          admin.adminPermissions.includes(AdminPermission.SUPER)),
    );
    if (admins.length === 0) {
      this.logger.warn(
        `Merchant ${merchant.id} submitted but no active admin has the kyc permission`,
      );
      return;
    }
    await this.send(
      admins.map((admin) => ({
        id: admin.id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
      })),
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

  // Owner and admins: the people who act on account-level emails.
  private async teamLeads(
    merchantId: string,
    manager: EntityManager,
  ): Promise<UserContact[]> {
    const leads = await manager.find(MerchantMemberEntity, {
      where: {
        merchantId,
        role: In([MerchantRole.OWNER, MerchantRole.ADMIN]),
      },
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
