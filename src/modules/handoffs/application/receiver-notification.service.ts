import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { formatLagosDay } from '../../../common/time/working-days';
import { escapeHtml } from '../../../common/html/escape-html';
import { OutboxService } from '../../notifications/application/outbox.service';
import { TrackingEmailService } from '../../tracking/application/tracking-email.service';

interface OrderForReceiverEmail {
  trackingCode: string;
  // Null for merchant parcels whose buyer gave no email (SMS/relay only).
  receiverEmail: string | null;
  receiverPhone?: string | null;
  parcelDescription: string;
  destinationNodeId: string;
}

interface DestinationNode {
  name: string;
  address: string;
  city: string;
}

// Every email the receiver gets about a parcel. The receiver has no
// account, so these (and the tracking link inside them) are their only view
// of it. Each is enqueued on the caller's transaction — sent if and only if
// the handoff step it describes commits.
@Injectable()
export class ReceiverNotificationService {
  constructor(
    private readonly outboxService: OutboxService,
    private readonly trackingEmailService: TrackingEmailService,
  ) {}

  // First contact — sent when the origin Node confirms drop-off. Before this
  // the receiver hears nothing until the parcel is ready.
  async enqueueOnItsWay(
    order: OrderForReceiverEmail,
    manager: EntityManager,
  ): Promise<void> {
    if (!order.receiverEmail) {
      return;
    }
    const destination = await this.destinationOf(order, manager);
    const tracking = await this.trackingEmailService.trackingBlock(
      order.trackingCode,
    );
    const where = `${destination.name}, ${destination.address}, ${destination.city}`;

    await this.outboxService.enqueueEmail(
      {
        to: order.receiverEmail,
        subject: 'A parcel is on its way to you',
        text:
          `A parcel has been sent to you through Locoomo: ${order.parcelDescription}.\n\n` +
          `${tracking.text}\n\n` +
          `It will be ready for collection at ${where}. ` +
          `We'll email you a collection code when it arrives — bring it and a form of ID.`,
        html:
          `<p>A parcel has been sent to you through Locoomo: ${escapeHtml(order.parcelDescription)}.</p>` +
          tracking.html +
          `<p>It will be ready for collection at <strong>${escapeHtml(where)}</strong>. ` +
          `We'll email you a collection code when it arrives — bring it and a form of ID.</p>`,
        attachments: tracking.attachments,
      },
      manager,
    );
  }

  async enqueueReadyForCollection(
    order: OrderForReceiverEmail,
    collectionCode: string,
    collectBy: Date,
    manager: EntityManager,
  ): Promise<void> {
    await this.enqueueCollectionCode(
      order,
      collectionCode,
      collectBy,
      'Your Locoomo parcel is ready for collection',
      `Your parcel (${order.parcelDescription}) has arrived and is ready for collection.`,
      manager,
    );
  }

  async enqueueNewCollectionCode(
    order: OrderForReceiverEmail,
    collectionCode: string,
    collectBy: Date,
    manager: EntityManager,
  ): Promise<void> {
    await this.enqueueCollectionCode(
      order,
      collectionCode,
      collectBy,
      'Your new Locoomo collection code',
      `Here's a new collection code for your parcel (${order.parcelDescription}).`,
      manager,
    );
  }

  // Working days 5 and 6 of the window (D15). The code itself isn't
  // repeated (only its hash is kept); the Node can send a new one.
  async enqueueCollectionReminder(
    order: OrderForReceiverEmail,
    collectBy: Date,
    manager: EntityManager,
  ): Promise<void> {
    const destination = await this.destinationOf(order, manager);
    const where = `${destination.name}, ${destination.address}, ${destination.city}`;
    const deadline = formatLagosDay(collectBy);
    const text =
      `Your parcel (${order.parcelDescription}) is still waiting for you at ${where}. ` +
      `Collect it by ${deadline}, or it goes back to the sender. ` +
      `Bring the collection code we sent you; if you've lost it, the staff can send a new one.`;
    if (order.receiverEmail) {
      await this.outboxService.enqueueEmail(
        {
          to: order.receiverEmail,
          subject: `Reminder: collect your parcel by ${deadline}`,
          text,
          html: `<p>${escapeHtml(text)}</p>`,
        },
        manager,
      );
    }
    if (order.receiverPhone) {
      await this.outboxService.enqueueSms(
        {
          to: order.receiverPhone,
          body: `Locoomo: your parcel ${order.trackingCode} is waiting at ${destination.name}. Collect by ${deadline} or it returns to the sender.`,
          tag: 'collection_reminder',
        },
        manager,
      );
    }
  }

  // The collection code comes first in the text — it's what the receiver
  // reads out at the counter.
  private async enqueueCollectionCode(
    order: OrderForReceiverEmail,
    collectionCode: string,
    collectBy: Date,
    subject: string,
    intro: string,
    manager: EntityManager,
  ): Promise<void> {
    const destination = await this.destinationOf(order, manager);
    const where = `${destination.name}, ${destination.address}, ${destination.city}`;
    const deadline = formatLagosDay(collectBy);
    const instructions =
      `Give this code to the staff at ${where}, along with your name, to collect your parcel. ` +
      `Collect it by ${deadline}; after that it goes back to the sender.`;

    if (order.receiverEmail) {
      const tracking = await this.trackingEmailService.trackingBlock(
        order.trackingCode,
      );
      await this.outboxService.enqueueEmail(
        {
          to: order.receiverEmail,
          subject,
          text:
            `Your collection code is: ${collectionCode}\n\n` +
            `${intro}\n${instructions}\n\n${tracking.text}`,
          html:
            `<p>Your collection code is: <strong style="font-size:20px">${collectionCode}</strong></p>` +
            `<p>${escapeHtml(intro)}</p><p>${escapeHtml(instructions)}</p>` +
            tracking.html,
          attachments: tracking.attachments,
        },
        manager,
      );
    }
    // SMS where configured (D10): skipped silently otherwise.
    if (order.receiverPhone) {
      await this.outboxService.enqueueSms(
        {
          to: order.receiverPhone,
          body: `Locoomo: your parcel is ready at ${destination.name}. Collection code ${collectionCode}. Collect by ${deadline}.`,
          tag: 'collection_code',
        },
        manager,
      );
    }
  }

  private async destinationOf(
    order: OrderForReceiverEmail,
    manager: EntityManager,
  ): Promise<DestinationNode> {
    const [node] = await manager.query<DestinationNode[]>(
      `SELECT name, address, city FROM nodes WHERE id = $1`,
      [order.destinationNodeId],
    );
    return node;
  }
}
