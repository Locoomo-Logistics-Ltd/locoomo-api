import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { Env } from '../../../config/env.validation';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { PAYMENT_INTENT_EXPIRY_POLL_INTERVAL_MS } from '../domain/payment-intent.constants';
import { PaymentIntentStatus } from '../domain/payment-intent-status.enum';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';
import type { PaymentVerificationResult } from '../domain/ports/payment-provider.port';
import { PaymentProviderRegistry } from '../infrastructure/payment-provider.registry';
import { ConfirmPaymentIntentPaidService } from './confirm-payment-intent-paid.service';
import { PAYMENT_WEBHOOK_IDEMPOTENCY_SCOPE } from './handle-payment-webhook.service';

const EXPIRY_BATCH_SIZE = 50;

// Sweeps PENDING PaymentIntents past their TTL. Two jobs in one pass:
// 1. Reconciliation — re-verify server-to-server before giving up, in case
//    the webhook simply never arrived (real networks drop things;  A recovered payment goes
//    through the exact same idempotency scope/key as the webhook handler,
//    so if the webhook shows up moments later it's a safe no-op.
// 2. Expiry — anything genuinely unpaid past its TTL is marked EXPIRED and
//    its Node capacity slot released, so abandoned checkouts don't hold a
//    slot hostage forever.
@Injectable()
export class ExpirePaymentIntentsService {
  private readonly logger = new Logger(ExpirePaymentIntentsService.name);
  // Same overlapping-run guard as OutboxPollerService — single in-process
  // instance today.
  private isPolling = false;

  constructor(
    @InjectRepository(PaymentIntentEntity)
    private readonly paymentIntents: Repository<PaymentIntentEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodesService: NodesService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly idempotencyService: IdempotencyService,
    private readonly confirmPaymentIntentPaidService: ConfirmPaymentIntentPaidService,
    @Inject(ConfigService)
    private readonly configService: ConfigService<Env, true>,
  ) {}

  // Same test-suite-skip precedent as OutboxPollerService — e2e tests call
  // poll() directly rather than letting this timer race real app boot.
  @Interval(PAYMENT_INTENT_EXPIRY_POLL_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    if (this.configService.get('NODE_ENV', { infer: true }) === 'test') {
      return;
    }
    await this.poll();
  }

  async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;

    try {
      const staleIntents = await this.paymentIntents.find({
        where: {
          status: PaymentIntentStatus.PENDING,
          expiresAt: LessThanOrEqual(new Date()),
        },
        order: { expiresAt: 'ASC' },
        take: EXPIRY_BATCH_SIZE,
      });

      for (const intent of staleIntents) {
        await this.processStaleIntent(intent);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async processStaleIntent(intent: PaymentIntentEntity): Promise<void> {
    const skipExpiry = await this.tryRecover(intent);
    if (skipExpiry) {
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PaymentIntentEntity);
      // Re-read inside the transaction — a webhook may have processed this
      // intent concurrently between the batch query above and now.
      const fresh = await repo.findOneBy({ id: intent.id });
      if (!fresh || fresh.status !== PaymentIntentStatus.PENDING) {
        return;
      }

      fresh.status = PaymentIntentStatus.EXPIRED;
      await repo.save(fresh);
      await this.nodesService.releaseCapacitySlot(fresh.originNodeId, manager);
    });
  }

  // Returns true when the caller should NOT expire this intent yet: either
  // it turned out to actually be paid and was just recovered, or the
  // provider was unreachable and we'd rather retry next poll than expire an
  // intent prematurely on our own infrastructure's account. Returns false
  // only when the provider was reachable and confirms it's genuinely unpaid
  // — the caller is then safe to expire it.
  private async tryRecover(intent: PaymentIntentEntity): Promise<boolean> {
    if (!intent.providerReference) {
      return false;
    }

    const provider = this.paymentProviderRegistry.get(intent.provider);
    let verification: PaymentVerificationResult;
    try {
      verification = await provider.verify(intent.providerReference);
    } catch (error) {
      this.logger.warn(
        `Reconciliation verify failed for intent ${intent.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true; // treat as "not resolved yet" — don't expire, retry next poll
    }

    if (
      verification.status !== 'success' ||
      verification.amountKobo !== intent.amountKobo
    ) {
      return false;
    }

    await this.dataSource.transaction(async (manager) => {
      await this.idempotencyService.withIdempotency(
        PAYMENT_WEBHOOK_IDEMPOTENCY_SCOPE,
        intent.providerReference as string,
        manager,
        async () => {
          const repo = manager.getRepository(PaymentIntentEntity);
          const fresh = await repo.findOneBy({ id: intent.id });
          if (!fresh || fresh.status !== PaymentIntentStatus.PENDING) {
            return;
          }
          await this.confirmPaymentIntentPaidService.confirm(
            fresh,
            verification,
            manager,
          );
        },
      );
    });

    return true;
  }
}
