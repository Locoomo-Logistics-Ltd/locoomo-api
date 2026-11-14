import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { assertRecentAuth } from '../../../common/auth/recent-auth';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  CursorPage,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import {
  InvalidWebhookUrlException,
  MerchantSuspendedException,
  ReplayWindowExceededException,
  WebhookEndpointLimitReachedException,
} from '../domain/exceptions/merchant.exceptions';
import { MerchantStatus } from '../domain/merchant.enums';
import {
  generateWebhookSecret,
  MAX_ENDPOINTS_PER_MODE,
  SECRET_ROLL_OVERLAP_HOURS,
  WEBHOOK_RETENTION_DAYS,
  webhookUrlProblem,
} from '../domain/webhooks';
import { WebhookDeliveryEntity } from '../infrastructure/entities/webhook-delivery.entity';
import { WebhookEndpointEntity } from '../infrastructure/entities/webhook-endpoint.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import type {
  CreatedWebhookEndpointView,
  CreateWebhookEndpointDto,
  ListWebhookDeliveriesQueryDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryView,
  WebhookEndpointView,
  WebhookTestResultView,
} from '../interface/dto/webhook.dto';
import { MerchantCaller } from './merchant-state';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEmitterService } from './webhook-emitter.service';

const MAX_REPLAY_EVENTS = 10_000;

const endpointView = (e: WebhookEndpointEntity): WebhookEndpointView => ({
  id: e.id,
  mode: e.mode,
  url: e.url,
  description: e.description,
  events: e.events,
  enabled: e.enabled,
  disabledReason: e.disabledReason,
  failingSince: e.failingSince?.toISOString() ?? null,
  lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null,
  previousSecretExpiresAt:
    e.previousSecretExpiresAt &&
    e.previousSecretExpiresAt.getTime() > Date.now()
      ? e.previousSecretExpiresAt.toISOString()
      : null,
  createdAt: e.createdAt.toISOString(),
});

// Developers › Webhooks, and the same endpoints over the API with the
// webhooks:manage scope (MERCHANT_API.md §12.1).
@Injectable()
export class WebhookEndpointService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly emitter: WebhookEmitterService,
    private readonly audit: AuditService,
  ) {}

  async list(caller: MerchantCaller): Promise<WebhookEndpointView[]> {
    const endpoints = await this.dataSource.manager.find(
      WebhookEndpointEntity,
      {
        where: { merchantId: caller.merchantId, mode: caller.mode },
        order: { createdAt: 'ASC' },
      },
    );
    return endpoints.map(endpointView);
  }

  async create(
    caller: MerchantCaller,
    dto: CreateWebhookEndpointDto,
  ): Promise<CreatedWebhookEndpointView> {
    this.assertUrl(dto.url);
    const secret = generateWebhookSecret();
    const endpoint = await this.dataSource.transaction(async (manager) => {
      await this.assertChangesAllowed(manager, caller);
      const count = await manager.countBy(WebhookEndpointEntity, {
        merchantId: caller.merchantId,
        mode: caller.mode,
      });
      if (count >= MAX_ENDPOINTS_PER_MODE) {
        throw new WebhookEndpointLimitReachedException(MAX_ENDPOINTS_PER_MODE);
      }
      const saved = await manager.save(
        manager.create(WebhookEndpointEntity, {
          merchantId: caller.merchantId,
          mode: caller.mode,
          url: dto.url,
          description: dto.description ?? null,
          events: dto.events ?? [],
          enabled: true,
          secretSealed: this.dispatcher.sealSecret(secret),
        }),
      );
      await this.record(
        manager,
        caller,
        'merchant.webhook_endpoint_created',
        saved,
      );
      return saved;
    });
    return { endpoint: endpointView(endpoint), secret };
  }

  async update(
    caller: MerchantCaller,
    id: string,
    dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointView> {
    if (dto.url !== undefined) {
      this.assertUrl(dto.url);
      // Redirecting your event stream is sensitive (plan §3.1).
      this.assertStepUp(caller);
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.assertChangesAllowed(manager, caller);
      const endpoint = await this.endpointOf(manager, caller, id);
      const before = {
        url: endpoint.url,
        events: endpoint.events,
        enabled: endpoint.enabled,
      };
      if (dto.url !== undefined) endpoint.url = dto.url;
      if (dto.events !== undefined) endpoint.events = dto.events;
      if (dto.description !== undefined) endpoint.description = dto.description;
      if (dto.enabled !== undefined && dto.enabled !== endpoint.enabled) {
        endpoint.enabled = dto.enabled;
        endpoint.disabledReason = dto.enabled ? null : 'Paused by you';
        // A fresh start: the 36-hour clock only counts from now.
        endpoint.failingSince = null;
      }
      const result = await manager.save(endpoint);
      await this.record(
        manager,
        caller,
        'merchant.webhook_endpoint_updated',
        result,
        before,
      );
      return result;
    });
    return endpointView(saved);
  }

  async remove(caller: MerchantCaller, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertChangesAllowed(manager, caller);
      const endpoint = await this.endpointOf(manager, caller, id);
      await manager.delete(WebhookEndpointEntity, endpoint.id);
      await this.record(
        manager,
        caller,
        'merchant.webhook_endpoint_deleted',
        endpoint,
      );
    });
  }

  // New secret; the old one keeps signing (a second v1 signature) for 24h.
  async rollSecret(
    caller: MerchantCaller,
    id: string,
  ): Promise<CreatedWebhookEndpointView> {
    this.assertStepUp(caller);
    const secret = generateWebhookSecret();
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.assertChangesAllowed(manager, caller);
      const endpoint = await this.endpointOf(manager, caller, id);
      endpoint.previousSecretSealed = endpoint.secretSealed;
      endpoint.previousSecretExpiresAt = new Date(
        Date.now() + SECRET_ROLL_OVERLAP_HOURS * 3_600_000,
      );
      endpoint.secretSealed = this.dispatcher.sealSecret(secret);
      const result = await manager.save(endpoint);
      await this.record(
        manager,
        caller,
        'merchant.webhook_secret_rolled',
        result,
      );
      return result;
    });
    return { endpoint: endpointView(saved), secret };
  }

  // Sends a `webhook.test` event to this endpoint now and reports the result.
  async sendTest(
    caller: MerchantCaller,
    id: string,
  ): Promise<WebhookTestResultView> {
    const deliveryId = await this.dataSource.transaction(async (manager) => {
      const endpoint = await this.endpointOf(manager, caller, id);
      const eventId = await this.emitter.emit(manager, {
        merchantId: caller.merchantId,
        mode: caller.mode,
        type: 'webhook.test',
        data: { message: 'Test event from Locoomo', endpointId: endpoint.id },
        onlyEndpointId: endpoint.id,
      });
      const delivery = await manager.findOneByOrFail(WebhookDeliveryEntity, {
        eventId,
      });
      return delivery.id;
    });
    return this.dispatcher.deliverNow(deliveryId);
  }

  async replay(
    caller: MerchantCaller,
    id: string,
    since: string,
  ): Promise<{ queued: number }> {
    const sinceDate = new Date(since);
    if (
      Date.now() - sinceDate.getTime() >
      WEBHOOK_RETENTION_DAYS * 86_400_000
    ) {
      throw new ReplayWindowExceededException(WEBHOOK_RETENTION_DAYS);
    }
    return this.dataSource.transaction(async (manager) => {
      const endpoint = await this.endpointOf(manager, caller, id);
      const inserted = await manager.query<{ id: string }[]>(
        `INSERT INTO webhook_deliveries ("eventId", "endpointId", "merchantId", status, attempts, "nextAttemptAt")
         SELECT ev.id, $1, ev."merchantId", 'pending', 0, now()
           FROM webhook_events ev
          WHERE ev."merchantId" = $2 AND ev.mode = $3 AND ev."createdAt" >= $4
            AND ev.type <> 'webhook.test'
            AND (cardinality($5::text[]) = 0 OR ev.type = ANY($5::text[]))
          ORDER BY ev."createdAt"
          LIMIT $6
         RETURNING id`,
        [
          endpoint.id,
          caller.merchantId,
          caller.mode,
          sinceDate,
          endpoint.events,
          MAX_REPLAY_EVENTS,
        ],
      );
      const queued = inserted.length;
      await this.audit.record(
        {
          actor: this.actor(caller),
          action: 'merchant.webhook_replayed',
          merchantId: caller.merchantId,
          target: { type: 'webhook_endpoint', id: endpoint.id },
          metadata: { since, queued },
          context: caller.context,
        },
        manager,
      );
      return { queued };
    });
  }

  async deliveries(
    caller: MerchantCaller,
    query: ListWebhookDeliveriesQueryDto,
  ): Promise<CursorPage<WebhookDeliveryView>> {
    const after = decodeCursor(query.cursor);
    const params: unknown[] = [caller.merchantId, caller.mode, query.limit + 1];
    const where = [`d."merchantId" = $1`, `ev.mode = $2`];
    if (query.endpointId) {
      params.push(query.endpointId);
      where.push(`d."endpointId" = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`d.status = $${params.length}`);
    }
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${cursorTime('d."createdAt"')}, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = await this.dataSource.query<
      (Omit<
        WebhookDeliveryView,
        'createdAt' | 'nextAttemptAt' | 'lastAttemptAt'
      > & {
        createdAt: Date;
        nextAttemptAt: Date;
        lastAttemptAt: Date | null;
      })[]
    >(
      `SELECT d.id, d."eventId", ev.type AS "eventType", d."endpointId", d.status,
              d.attempts, d."nextAttemptAt", d."lastAttemptAt", d."responseStatus",
              d."responseBody", d.error, d."durationMs", d."createdAt"
         FROM webhook_deliveries d
         JOIN webhook_events ev ON ev.id = d."eventId"
        WHERE ${where.join(' AND ')}
        ORDER BY ${cursorTime('d."createdAt"')} DESC, d.id DESC
        LIMIT $3`,
      params,
    );
    return toCursorPage(
      rows,
      query.limit,
      (row) => ({ t: row.createdAt.toISOString(), id: row.id }),
      (row) => ({
        ...row,
        nextAttemptAt:
          row.status === 'pending' ? row.nextAttemptAt.toISOString() : null,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  }

  private assertUrl(url: string): void {
    const problem = webhookUrlProblem(url);
    if (problem) {
      throw new InvalidWebhookUrlException(problem);
    }
  }

  // Dashboard sessions confirm it's them; API keys are already a server
  // credential with the webhooks:manage scope.
  private assertStepUp(caller: MerchantCaller): void {
    if (caller.via === 'session') {
      assertRecentAuth(caller);
    }
  }

  // Suspended merchants can't change live endpoints (plan §2.1).
  private async assertChangesAllowed(
    manager: EntityManager,
    caller: MerchantCaller,
  ): Promise<void> {
    if (caller.mode !== 'live') {
      return;
    }
    const merchant = await manager.findOneByOrFail(MerchantEntity, {
      id: caller.merchantId,
    });
    if (merchant.status === MerchantStatus.SUSPENDED) {
      throw new MerchantSuspendedException();
    }
  }

  private async endpointOf(
    manager: EntityManager,
    caller: MerchantCaller,
    id: string,
  ): Promise<WebhookEndpointEntity> {
    const endpoint = await manager.findOneBy(WebhookEndpointEntity, {
      id,
      merchantId: caller.merchantId,
      mode: caller.mode,
    });
    if (!endpoint) {
      throw new EntityNotFoundException('Webhook endpoint', id);
    }
    return endpoint;
  }

  private actor(caller: MerchantCaller) {
    return caller.via === 'api_key'
      ? { type: 'api_key' as const, id: caller.keyId }
      : { type: 'user' as const, id: caller.userId };
  }

  private async record(
    manager: EntityManager,
    caller: MerchantCaller,
    action: string,
    endpoint: WebhookEndpointEntity,
    before?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        actor: this.actor(caller),
        action,
        merchantId: caller.merchantId,
        target: { type: 'webhook_endpoint', id: endpoint.id },
        before: before ?? null,
        after: {
          mode: endpoint.mode,
          url: endpoint.url,
          events: endpoint.events,
          enabled: endpoint.enabled,
        },
        context: caller.context,
      },
      manager,
    );
  }
}
