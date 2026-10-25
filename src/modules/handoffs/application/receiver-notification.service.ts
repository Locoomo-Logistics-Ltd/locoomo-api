import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { escapeHtml } from '../../../common/html/escape-html';
import { OutboxService } from '../../notifications/application/outbox.service';
import { TrackingEmailService } from '../../tracking/application/tracking-email.service';

interface OrderForReceiverEmail {
  trackingCode: string;
  receiverEmail: string;
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
    codeTtlMinutes: number,
    manager: EntityManager,
  ): Promise<void> {
    await this.enqueueCollectionCode(
      order,
      collectionCode,
      codeTtlMinutes,
      'Your Locoomo parcel is ready for collection',
      `Your parcel (${order.parcelDescription}) has arrived and is ready for collection.`,
      manager,
    );
  }

  async enqueueNewCollectionCode(
    order: OrderForReceiverEmail,
    collectionCode: string,
    codeTtlMinutes: number,
    manager: EntityManager,
  ): Promise<void> {
    await this.enqueueCollectionCode(
      order,
      collectionCode,
      codeTtlMinutes,
      'Your new Locoomo collection code',
      `Here's a new collection code for your parcel (${order.parcelDescription}).`,
      manager,
    );
  }

  // The collection code comes first in the text — it's what the receiver
  // reads out at the counter.
  private async enqueueCollectionCode(
    order: OrderForReceiverEmail,
    collectionCode: string,
    codeTtlMinutes: number,
    subject: string,
    intro: string,
    manager: EntityManager,
  ): Promise<void> {
    const destination = await this.destinationOf(order, manager);
    const tracking = await this.trackingEmailService.trackingBlock(
      order.trackingCode,
    );
    const where = `${destination.name}, ${destination.address}, ${destination.city}`;
    const instructions =
      `Give this code to the staff at ${where}, along with your name, to collect your parcel. ` +
      `The code expires in ${codeTtlMinutes} minutes.`;

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
