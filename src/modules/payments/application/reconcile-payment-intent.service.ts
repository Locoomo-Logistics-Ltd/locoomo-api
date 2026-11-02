import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import type { PaymentVerificationResult } from '../domain/ports/payment-provider.port';
import { PaymentIntentStatus } from '../domain/payment-intent-status.enum';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';
import { ConfirmPaymentIntentPaidService } from './confirm-payment-intent-paid.service';
import { PAYMENT_WEBHOOK_IDEMPOTENCY_SCOPE } from './handle-payment-webhook.service';

// The non-webhook way an intent becomes PAID: given a verify() result we
// fetched ourselves, confirm the intent if it shows the right amount paid.
// Used by the expiry sweep (webhook never arrived) and by the consumer's
// status polling (webhook hasn't arrived *yet*). Same idempotency scope/key
// as the webhook handler, so whichever path lands first wins.
@Injectable()
export class ReconcilePaymentIntentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotencyService: IdempotencyService,
    private readonly confirmPaymentIntentPaidService: ConfirmPaymentIntentPaidService,
  ) {}

  // Returns true when the verification shows the intent paid in full (and
  // it is now PAID, by us or a concurrent webhook); false when it doesn't.
  async confirmIfPaid(
    intent: PaymentIntentEntity,
    verification: PaymentVerificationResult,
  ): Promise<boolean> {
    if (
      !intent.providerReference ||
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
