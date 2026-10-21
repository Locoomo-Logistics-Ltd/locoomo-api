import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { OutboxService } from '../../notifications/application/outbox.service';
import { escapeHtml } from '../../../common/html/escape-html';
import { OrdersService } from '../../orders/application/orders.service';
import { TrackingEmailService } from '../../tracking/application/tracking-email.service';
import { koboToNaira } from '../domain/money';
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
  constructor(
    private readonly ordersService: OrdersService,
    private readonly userLookupService: UserLookupService,
    private readonly nodesService: NodesService,
    private readonly outboxService: OutboxService,
    private readonly trackingEmailService: TrackingEmailService,
  ) {}

  async confirm(
    intent: PaymentIntentEntity,
    verification: PaymentVerificationResult,
    manager: EntityManager,
  ): Promise<void> {
    const repo = manager.getRepository(PaymentIntentEntity);
    intent.status = PaymentIntentStatus.PAID;
    intent.paidAt = verification.paidAt ?? new Date();
    await repo.save(intent);

    const order = await this.ordersService.createFromPaidIntent(
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
        destinationFeeKobo: intent.feeBreakdown.destinationFeeKobo,
      },
      manager,
    );

    const [consumerEmail, originNode, destinationNode] = await Promise.all([
      this.userLookupService.getEmail(intent.consumerId),
      this.nodesService.findOne(intent.originNodeId, true),
      this.nodesService.findOne(intent.destinationNodeId, true),
    ]);
    const amountNaira = koboToNaira(intent.amountKobo).toFixed(2);
    const tracking = await this.trackingEmailService.trackingBlock(
      order.trackingCode,
    );
    const label = this.trackingEmailService.labelBlock(
      order.trackingCode,
      destinationNode.name,
    );
    await this.outboxService.enqueueEmail(
      {
        to: consumerEmail,
        subject: 'Your Locoomo order is confirmed',
        text:
          `Your payment was successful and your order has been placed.\n\n` +
          `${tracking.text}\n\n` +
          `${label.text}\n\n` +
          `Drop off at: ${originNode.name}, ${originNode.address}\n` +
          `Collection at: ${destinationNode.name}\n` +
          `Receiver: ${intent.receiverFullName}\n` +
          `Parcel: ${intent.parcelDescription} (${intent.parcelSize})\n` +
          `Amount paid: NGN ${amountNaira}\n\n` +
          `Share the tracking link with the receiver so they can follow the parcel.`,
        html:
          `<p>Your payment was successful and your order has been placed.</p>` +
          tracking.html +
          label.html +
          `<ul>` +
          `<li><strong>Drop off at:</strong> ${escapeHtml(originNode.name)}, ${escapeHtml(originNode.address)}</li>` +
          `<li><strong>Collection at:</strong> ${escapeHtml(destinationNode.name)}</li>` +
          `<li><strong>Receiver:</strong> ${escapeHtml(intent.receiverFullName)}</li>` +
          `<li><strong>Parcel:</strong> ${escapeHtml(intent.parcelDescription)} (${intent.parcelSize})</li>` +
          `<li><strong>Amount paid:</strong> NGN ${amountNaira}</li>` +
          `</ul>` +
          `<p>Share the tracking link with the receiver so they can follow the parcel.</p>`,
        attachments: tracking.attachments,
      },
      manager,
    );
  }
}
