import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  PAYMENT_INTENT_POLL_VERIFY_INTERVAL_MS,
  PAYMENT_INTENT_POLL_VERIFY_TIMEOUT_MS,
} from '../domain/payment-intent.constants';
import { PaymentIntentStatus } from '../domain/payment-intent-status.enum';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';
import { PaymentProviderRegistry } from '../infrastructure/payment-provider.registry';
import { ReconcilePaymentIntentService } from './reconcile-payment-intent.service';

@Injectable()
export class PaymentIntentQueryService {
  private readonly logger = new Logger(PaymentIntentQueryService.name);
  // intentId → when we last asked the provider about it. In-process only,
  // like the sweep's isPolling guard — it just spaces out verify calls.
  private readonly lastVerifiedAt = new Map<string, number>();

  constructor(
    @InjectRepository(PaymentIntentEntity)
    private readonly paymentIntents: Repository<PaymentIntentEntity>,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly reconcilePaymentIntentService: ReconcilePaymentIntentService,
  ) {}

  // Backs the frontend's post-redirect polling — the consumer lands back on
  // our own callback page not knowing yet whether the webhook has landed,
  // and polls this until status leaves PENDING. Ownership-scoped: a consumer
  // can only read their own intents.
  //
  // A PENDING intent is verified with the provider on read, so the consumer
  // sees PAID as soon as Paystack has it — not only once the webhook lands,
  // or, if it never does, once the expiry sweep gets to it after the TTL.
  async getMine(consumerId: string, id: string): Promise<PaymentIntentEntity> {
    const intent = await this.paymentIntents.findOneBy({ id, consumerId });
    if (!intent) {
      throw new EntityNotFoundException('PaymentIntent', id);
    }
    if (intent.status !== PaymentIntentStatus.PENDING) {
      this.lastVerifiedAt.delete(id);
      return intent;
    }

    const recovered = await this.tryVerify(intent);
    if (!recovered) {
      return intent;
    }
    return (await this.paymentIntents.findOneBy({ id, consumerId })) ?? intent;
  }

  // Best effort: any failure just leaves the intent PENDING for the webhook
  // or the sweep to settle, so a provider hiccup never fails the poll.
  private async tryVerify(intent: PaymentIntentEntity): Promise<boolean> {
    if (!intent.providerReference) {
      return false;
    }
    const now = Date.now();
    const last = this.lastVerifiedAt.get(intent.id);
    if (
      last !== undefined &&
      now - last < PAYMENT_INTENT_POLL_VERIFY_INTERVAL_MS
    ) {
      return false;
    }
    this.lastVerifiedAt.set(intent.id, now);
    this.pruneLastVerified(now);

    const provider = this.paymentProviderRegistry.get(intent.provider);
    try {
      const verification = await withTimeout(
        provider.verify(intent.providerReference),
        PAYMENT_INTENT_POLL_VERIFY_TIMEOUT_MS,
      );
      return await this.reconcilePaymentIntentService.confirmIfPaid(
        intent,
        verification,
      );
    } catch (error) {
      this.logger.warn(
        `Poll-time verify failed for intent ${intent.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  // Abandoned checkouts are never polled again; drop their entries so the
  // map stays bounded by the intents being actively polled.
  private pruneLastVerified(now: number): void {
    for (const [intentId, at] of this.lastVerifiedAt) {
      if (now - at > PAYMENT_INTENT_POLL_VERIFY_INTERVAL_MS) {
        this.lastVerifiedAt.delete(intentId);
      }
    }
  }
}

// The provider's read policy retries for up to ~45s on an outage — far too
// long to hold a poll request open. The verify keeps running past the
// timeout; it's a read, so abandoning its result is harmless.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
