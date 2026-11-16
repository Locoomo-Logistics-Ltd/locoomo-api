import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { WalletService, WalletView } from './wallet.service';

export interface MerchantOverview {
  merchant: {
    id: string;
    tradingName: string;
    legalName: string | null;
    type: string;
    status: string;
    tier: string | null;
    hubNodeId: string | null;
    creationPaused: boolean;
    createdAt: string;
    approvedAt: string | null;
  };
  team: { members: number; pendingInvites: number };
  // Metadata only: never secrets or hashes.
  apiKeys: {
    id: string;
    name: string;
    mode: string;
    kind: string;
    prefix: string;
    last4: string;
    scopes: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
  }[];
  webhooks: {
    id: string;
    mode: string;
    url: string;
    enabled: boolean;
    disabledReason: string | null;
    failingSince: string | null;
    lastSuccessAt: string | null;
    last24h: { succeeded: number; failed: number; pending: number };
  }[];
  wallets: { test: WalletView; live: WalletView };
  shipments: {
    live: Record<string, number>;
    liveLast30Days: number;
    test: number;
  };
  api: {
    last24h: {
      requests: number;
      clientErrors: number;
      serverErrors: number;
      p95Ms: number | null;
    };
  };
  open: {
    claims: number;
    returnsWaiting: number;
    returnBatches: number;
    manifests: number;
  };
  recentActivity: {
    action: string;
    actorType: string;
    targetType: string | null;
    at: string;
  }[];
}

// Admin app › Merchant 360 (plan §10, M6b): everything support needs to
// answer "what's going on with this merchant?" on one screen, read-only.
// There's no "log in as merchant"; this replaces it.
@Injectable()
export class MerchantOverviewService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
  ) {}

  async overview(merchantId: string): Promise<MerchantOverview> {
    const merchant = await this.dataSource.manager.findOneBy(MerchantEntity, {
      id: merchantId,
    });
    if (!merchant) {
      throw new EntityNotFoundException('Merchant', merchantId);
    }
    const q = <T>(sql: string): Promise<T[]> =>
      this.dataSource.query<T[]>(sql, [merchantId]);

    const [team] = await q<{ members: number; pendingInvites: number }>(
      `SELECT (SELECT count(*)::int FROM merchant_members WHERE "merchantId" = $1) AS members,
              (SELECT count(*)::int FROM merchant_invites
                WHERE "merchantId" = $1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
                  AND "expiresAt" > now()) AS "pendingInvites"`,
    );
    const keys = await q<{
      id: string;
      name: string;
      mode: string;
      kind: string;
      prefix: string;
      last4: string;
      scopes: string[];
      lastUsedAt: Date | null;
      expiresAt: Date | null;
    }>(
      `SELECT id, name, mode, kind, prefix, last4, scopes, "lastUsedAt", "expiresAt"
         FROM api_keys WHERE "merchantId" = $1 AND "revokedAt" IS NULL
        ORDER BY "createdAt" DESC`,
    );
    const hooks = await q<{
      id: string;
      mode: string;
      url: string;
      enabled: boolean;
      disabledReason: string | null;
      failingSince: Date | null;
      lastSuccessAt: Date | null;
      succeeded: number;
      failed: number;
      pending: number;
    }>(
      `SELECT e.id, e.mode, e.url, e.enabled, e."disabledReason", e."failingSince", e."lastSuccessAt",
              count(d.id) FILTER (WHERE d.status = 'succeeded')::int AS succeeded,
              count(d.id) FILTER (WHERE d.status = 'failed')::int AS failed,
              count(d.id) FILTER (WHERE d.status IN ('pending', 'delivering'))::int AS pending
         FROM webhook_endpoints e
         LEFT JOIN webhook_deliveries d
           ON d."endpointId" = e.id AND d."createdAt" > now() - interval '24 hours'
        WHERE e."merchantId" = $1
        GROUP BY e.id
        ORDER BY e."createdAt"`,
    );
    const byStatus = await q<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM merchant_shipments
        WHERE "merchantId" = $1 AND mode = 'live' GROUP BY status`,
    );
    const [shipmentTotals] = await q<{ recent: number; test: number }>(
      `SELECT count(*) FILTER (WHERE mode = 'live' AND "createdAt" > now() - interval '30 days')::int AS recent,
              count(*) FILTER (WHERE mode = 'test')::int AS test
         FROM merchant_shipments WHERE "merchantId" = $1`,
    );
    const [api] = await q<{
      requests: number;
      clientErrors: number;
      serverErrors: number;
      p95Ms: number | null;
    }>(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::int AS "clientErrors",
              count(*) FILTER (WHERE "statusCode" >= 500)::int AS "serverErrors",
              percentile_disc(0.95) WITHIN GROUP (ORDER BY "durationMs") AS "p95Ms"
         FROM merchant_api_requests
        WHERE "merchantId" = $1 AND "createdAt" > now() - interval '24 hours'`,
    );
    const [open] = await q<{
      claims: number;
      returnsWaiting: number;
      returnBatches: number;
      manifests: number;
    }>(
      `SELECT (SELECT count(*)::int FROM merchant_claims WHERE "merchantId" = $1 AND status = 'open') AS claims,
              (SELECT count(*)::int FROM merchant_shipments
                WHERE "merchantId" = $1 AND mode = 'live' AND status = 'return_ready') AS "returnsWaiting",
              (SELECT count(*)::int FROM merchant_return_batches
                WHERE "merchantId" = $1 AND status = 'open') AS "returnBatches",
              (SELECT count(*)::int FROM merchant_manifests
                WHERE "merchantId" = $1 AND status IN ('open', 'closed')) AS manifests`,
    );
    const activity = await q<{
      action: string;
      actorType: string;
      targetType: string | null;
      createdAt: Date;
    }>(
      `SELECT action, "actorType", "targetType", "createdAt" FROM audit_events
        WHERE "merchantId" = $1 ORDER BY "createdAt" DESC LIMIT 20`,
    );

    return {
      merchant: {
        id: merchant.id,
        tradingName: merchant.tradingName,
        legalName: merchant.legalName,
        type: merchant.type,
        status: merchant.status,
        tier: merchant.tier,
        hubNodeId: merchant.hubNodeId,
        creationPaused: merchant.creationPaused,
        createdAt: merchant.createdAt.toISOString(),
        approvedAt: merchant.approvedAt?.toISOString() ?? null,
      },
      team,
      apiKeys: keys.map((k) => ({
        ...k,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        expiresAt: k.expiresAt?.toISOString() ?? null,
      })),
      webhooks: hooks.map((h) => ({
        id: h.id,
        mode: h.mode,
        url: h.url,
        enabled: h.enabled,
        disabledReason: h.disabledReason,
        failingSince: h.failingSince?.toISOString() ?? null,
        lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
        last24h: {
          succeeded: h.succeeded,
          failed: h.failed,
          pending: h.pending,
        },
      })),
      wallets: {
        test: await this.wallet.summary(merchantId, 'test'),
        live: await this.wallet.summary(merchantId, 'live'),
      },
      shipments: {
        live: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        liveLast30Days: shipmentTotals.recent,
        test: shipmentTotals.test,
      },
      api: {
        last24h: {
          ...api,
          p95Ms: api.p95Ms === null ? null : Number(api.p95Ms),
        },
      },
      open,
      recentActivity: activity.map((a) => ({
        action: a.action,
        actorType: a.actorType,
        targetType: a.targetType,
        at: a.createdAt.toISOString(),
      })),
    };
  }
}
