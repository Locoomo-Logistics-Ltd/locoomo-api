import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { escapeHtml } from '../../../common/html/escape-html';
import { OutboxService } from '../../notifications/application/outbox.service';
import { TrackingEmailService } from '../../tracking/application/tracking-email.service';

interface OrderForReturnEmail {
  trackingCode: string;
  consumerId: string;
  receiverEmail: string;
  parcelDescription: string;
  originNodeId: string;
}

interface Station {
  name: string;
  address: string;
  city: string;
}

// Emails about a parcel going back to its sender (decision 4: return to
// the origin Pickup Station; sender and receiver both told). Enqueued on
// the caller's transaction like every other order email. No return fee is
// mentioned or charged — that policy isn't defined yet.
@Injectable()
export class ReturnNotificationService {
  constructor(
    private readonly outboxService: OutboxService,
    private readonly trackingEmailService: TrackingEmailService,
  ) {}

  async enqueueReturnStarted(
    order: OrderForReturnEmail,
    manager: EntityManager,
  ): Promise<void> {
    const [sender, origin, tracking] = await Promise.all([
      this.senderOf(order, manager),
      this.originOf(order, manager),
      this.trackingEmailService.trackingBlock(order.trackingCode),
    ]);
    const where = `${origin.name}, ${origin.address}, ${origin.city}`;

    await this.outboxService.enqueueEmail(
      {
        to: sender.email,
        subject: 'Your parcel is being returned',
        text:
          `We couldn't complete the delivery of your parcel (${order.parcelDescription}). ` +
          `It's on its way back to ${where}.\n\n` +
          `We'll email you a collection code when it's ready to pick up there.\n\n${tracking.text}`,
        html:
          `<p>We couldn't complete the delivery of your parcel (${escapeHtml(order.parcelDescription)}). ` +
          `It's on its way back to <strong>${escapeHtml(where)}</strong>.</p>` +
          `<p>We'll email you a collection code when it's ready to pick up there.</p>` +
          tracking.html,
        attachments: tracking.attachments,
      },
      manager,
    );

    await this.outboxService.enqueueEmail(
      {
        to: order.receiverEmail,
        subject: 'Your parcel could not be delivered',
        text:
          `We couldn't complete the delivery of the parcel sent to you (${order.parcelDescription}), ` +
          `so it's being returned to the sender. You don't need to do anything.\n\n${tracking.text}`,
        html:
          `<p>We couldn't complete the delivery of the parcel sent to you (${escapeHtml(order.parcelDescription)}), ` +
          `so it's being returned to the sender. You don't need to do anything.</p>` +
          tracking.html,
        attachments: tracking.attachments,
      },
      manager,
    );
  }

  // Sent on return intake and on resend. The code comes first in the text —
  // it's what the sender reads out at the counter.
  async enqueueSenderCollectionCode(
    order: OrderForReturnEmail,
    collectionCode: string,
    codeTtlMinutes: number,
    manager: EntityManager,
  ): Promise<void> {
    const [sender, origin] = await Promise.all([
      this.senderOf(order, manager),
      this.originOf(order, manager),
    ]);
    const where = `${origin.name}, ${origin.address}, ${origin.city}`;
    const instructions =
      `Your returned parcel (${order.parcelDescription}) is ready for you at ${where}. ` +
      `Give this code to the staff there, along with your name, to collect it. ` +
      `The code expires in ${codeTtlMinutes} minutes — ask the staff to resend it if it does.`;

    await this.outboxService.enqueueEmail(
      {
        to: sender.email,
        subject: 'Your returned parcel is ready for collection',
        text: `Your collection code is: ${collectionCode}\n\n${instructions}\n\nTracking code: ${order.trackingCode}`,
        html:
          `<p>Your collection code is: <strong style="font-size:20px">${collectionCode}</strong></p>` +
          `<p>${escapeHtml(instructions)}</p>` +
          `<p>Tracking code: <strong>${order.trackingCode}</strong></p>`,
      },
      manager,
    );
  }

  private async senderOf(
    order: OrderForReturnEmail,
    manager: EntityManager,
  ): Promise<{ email: string }> {
    const [sender] = await manager.query<{ email: string }[]>(
      `SELECT email FROM users WHERE id = $1`,
      [order.consumerId],
    );
    return sender;
  }

  private async originOf(
    order: OrderForReturnEmail,
    manager: EntityManager,
  ): Promise<Station> {
    const [station] = await manager.query<Station[]>(
      `SELECT name, address, city FROM nodes WHERE id = $1`,
      [order.originNodeId],
    );
    return station;
  }
}
