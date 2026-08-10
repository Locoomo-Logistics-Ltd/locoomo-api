import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OrdersService } from '../../orders/application/orders.service';
import { PaymentVerificationResult } from '../domain/ports/payment-provider.port';
import { PaymentIntentStatus } from '../domain/payment-intent-status.enum';
import { PaymentIntentEntity } from '../infrastructure/entities/payment-intent.entity';

// Shared by both entry points that can learn a payment succeeded — the
// webhook handler (the normal path) and ExpirePaymentIntentsService's
// reconciliation sweep (the recovery path, for a webhook that never
// arrived). Both call this from inside an IdempotencyService.withIdempotency
// block keyed on the same (scope, providerReference), so whichever runs
// first wins and the other becomes a no-op — this method itself does no
// idempotency check, that's the caller's job.
@Injectable()
export class ConfirmPaymentIntentPaidService {
  constructor(private readonly ordersService: OrdersService) {}

  async confirm(
    intent: PaymentIntentEntity,
    verification: PaymentVerificationResult,
    manager: EntityManager,
  ): Promise<void> {
    const repo = manager.getRepository(PaymentIntentEntity);
    intent.status = PaymentIntentStatus.PAID;
    intent.paidAt = verification.paidAt ?? new Date();
    await repo.save(intent);

    await this.ordersService.createFromPaidIntent(
      {
        paymentIntentId: intent.id,
        consumerId: intent.consumerId,
        originNodeId: intent.originNodeId,
        destinationNodeId: intent.destinationNodeId,
        receiverFullName: intent.receiverFullName,
        receiverEmail: intent.receiverEmail,
        receiverPhone: intent.receiverPhone,
        parcelDescription: intent.parcelDescription,
        parcelSize: intent.parcelSize,
        amountKobo: intent.amountKobo,
      },
      manager,
    );
  }
}
