import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { escapeHtml } from '../../../common/html/escape-html';
import { OutboxService } from '../../notifications/application/outbox.service';
import { SenderContactService } from './sender-contact.service';
import { TrackingEmailService } from '../../tracking/application/tracking-email.service';

interface OrderForReturnEmail {
  id: string;
  source?: string | null;
  merchantId?: string | null;
  trackingCode: string;
  // Null for merchant parcels (sender contact comes with M4).
  consumerId: string | null;
  receiverEmail: string | null;
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
    private readonly senders: SenderContactService,
  ) {}

  // `not_collected`: the receiver didn't come within the collection window.
  async enqueueReturnStarted(
    order: OrderForReturnEmail,
    manager: EntityManager,
    reason: 'delivery_failed' | 'not_collected' = 'delivery_failed',
  ): Promise<void> {
    const [sender, origin, tracking] = await Promise.all([
      this.senderOf(order, manager),
      this.originOf(order, manager),
      this.trackingEmailService.trackingBlock(order.trackingCode),
    ]);
    const where = `${origin.name}, ${origin.address}, ${origin.city}`;
    const description = order.parcelDescription;
    const why =
      reason === 'not_collected'
        ? `Your parcel (${description}) wasn't collected within the collection window.`
        : `We couldn't complete the delivery of your parcel (${description}).`;

    if (sender?.email) {
      await this.outboxService.enqueueEmail(
        {
          to: sender.email,
          subject: 'Your parcel is being returned',
          text:
            `${why} It's on its way back to ${where}.\n\n` +
            `We'll email you a collection code when it's ready to pick up there.\n\n${tracking.text}`,
          html:
            `<p>${escapeHtml(why)} It's on its way back to <strong>${escapeHtml(where)}</strong>.</p>` +
            `<p>We'll email you a collection code when it's ready to pick up there.</p>` +
            tracking.html,
          attachments: tracking.attachments,
        },
        manager,
      );
    }

    if (order.receiverEmail) {
      const receiverText =
        reason === 'not_collected'
          ? `The parcel sent to you (${description}) wasn't collected in time, so it's being returned to the sender.`
          : `We couldn't complete the delivery of the parcel sent to you (${description}), so it's being returned to the sender. You don't need to do anything.`;
      await this.outboxService.enqueueEmail(
        {
          to: order.receiverEmail,
          subject:
            reason === 'not_collected'
              ? 'Your parcel is going back to the sender'
              : 'Your parcel could not be delivered',
          text: `${receiverText}\n\n${tracking.text}`,
          html: `<p>${escapeHtml(receiverText)}</p>` + tracking.html,
          attachments: tracking.attachments,
        },
        manager,
      );
    }
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
    // Merchant returns are collected in batches (M4/M5), not by code email.
    if (!sender?.email) {
      return;
    }
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
  ): Promise<{ email: string } | undefined> {
    return (await this.senders.resolve(order, manager)) ?? undefined;
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
