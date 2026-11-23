import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface ChecklistItem {
  key: string;
  label: string;
  // `auto`: we check it. `manual`: only the merchant can know (done: null).
  kind: 'auto' | 'manual';
  required: boolean;
  done: boolean | null;
  hint: string;
}

export interface GoLiveChecklist {
  // Every required automatic item is done.
  ready: boolean;
  items: ChecklistItem[];
}

// MERCHANT_API.md §17 (plan §12.5, M7a): what stands between a merchant
// and its first live parcel, checked live from its account.
@Injectable()
export class GoLiveChecklistService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async checklist(merchantId: string): Promise<GoLiveChecklist> {
    const [row] = await this.dataSource.query<
      {
        approved: boolean;
        leadsWithout2fa: number;
        liveSecretKey: boolean;
        liveWebhookAnswered: boolean;
        liveFunded: boolean;
        lowBalanceAlert: boolean;
        testCollected: boolean;
        testReturned: boolean;
        hubAssigned: boolean;
      }[]
    >(
      `SELECT m.status = 'approved' AS approved,
              (SELECT count(*)::int FROM merchant_members mm
                WHERE mm."merchantId" = m.id AND mm.role IN ('owner', 'admin')
                  AND NOT EXISTS (
                    SELECT 1 FROM mfa_factors f
                     WHERE f."userId" = mm."userId" AND f."confirmedAt" IS NOT NULL)
              ) AS "leadsWithout2fa",
              EXISTS (SELECT 1 FROM api_keys k
                       WHERE k."merchantId" = m.id AND k.mode = 'live' AND k.kind = 'secret'
                         AND k."revokedAt" IS NULL
                         AND (k."expiresAt" IS NULL OR k."expiresAt" > now())) AS "liveSecretKey",
              EXISTS (SELECT 1 FROM webhook_endpoints e
                       WHERE e."merchantId" = m.id AND e.mode = 'live' AND e.enabled
                         AND e."lastSuccessAt" IS NOT NULL) AS "liveWebhookAnswered",
              EXISTS (SELECT 1 FROM wallet_entries w
                       WHERE w."merchantId" = m.id AND w.mode = 'live' AND w.type = 'top_up') AS "liveFunded",
              EXISTS (SELECT 1 FROM merchant_wallets w
                       WHERE w."merchantId" = m.id AND w.mode = 'live'
                         AND w."lowBalanceThresholdKobo" IS NOT NULL) AS "lowBalanceAlert",
              EXISTS (SELECT 1 FROM merchant_shipments s
                       WHERE s."merchantId" = m.id AND s.mode = 'test' AND s.status = 'collected') AS "testCollected",
              EXISTS (SELECT 1 FROM merchant_shipments s
                       WHERE s."merchantId" = m.id AND s.mode = 'test' AND s.status = 'returned') AS "testReturned",
              m."hubNodeId" IS NOT NULL AS "hubAssigned"
         FROM merchants m WHERE m.id = $1`,
      [merchantId],
    );
    const auto = (
      key: string,
      label: string,
      done: boolean,
      hint: string,
      required = true,
    ): ChecklistItem => ({ key, label, kind: 'auto', required, done, hint });
    const manual = (
      key: string,
      label: string,
      hint: string,
    ): ChecklistItem => ({
      key,
      label,
      kind: 'manual',
      required: false,
      done: null,
      hint,
    });
    const items: ChecklistItem[] = [
      auto(
        'approved',
        'Account approved',
        row.approved,
        'Finish the onboarding checklist and submit it for review.',
      ),
      auto(
        'two_factor',
        'Two-factor authentication on for the owner and admins',
        row.leadsWithout2fa === 0,
        'Each owner and admin turns it on under Account › Security.',
      ),
      auto(
        'live_secret_key',
        'Live secret key created',
        row.liveSecretKey,
        'Developers › API keys › New key (Live, Secret). Keep it in your secrets manager.',
      ),
      auto(
        'live_webhook',
        'Live webhook endpoint answering',
        row.liveWebhookAnswered,
        'Add a live endpoint and send a test event; it must answer 2xx with signature checks on.',
      ),
      auto(
        'wallet_funded',
        'Live wallet funded',
        row.liveFunded,
        'Wallet › Top up (card or bank transfer).',
      ),
      auto(
        'low_balance_alert',
        'Low-balance alert set',
        row.lowBalanceAlert,
        'Wallet › Settings: pick the balance that should warn you.',
        false,
      ),
      auto(
        'test_collected',
        'A test shipment simulated to collected',
        row.testCollected,
        'In Test mode, create a shipment and simulate it to collected.',
      ),
      auto(
        'test_returned',
        'A test shipment simulated to returned',
        row.testReturned,
        'In Test mode, simulate a shipment to returned.',
      ),
      auto(
        'hub_assigned',
        'Hub assigned (bulk shippers)',
        row.hubAssigned,
        'Only if you drop in bulk: ask your account manager for a hub.',
        false,
      ),
      manual(
        'webhook_dedupe',
        'Webhooks deduplicated and in order',
        'Dedupe on webhook-id; ignore lower sequence; ignore unknown event types.',
      ),
      manual(
        'idempotency',
        'Idempotency-Key on every POST',
        'Send one per action and reuse it on retries.',
      ),
      manual(
        'tracking_url',
        'trackingUrl in your order emails',
        'Link buyers to their parcel from your own emails.',
      ),
    ];
    return {
      ready: items.every((i) => i.kind === 'manual' || !i.required || i.done),
      items,
    };
  }
}
