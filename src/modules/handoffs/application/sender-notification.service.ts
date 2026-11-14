import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { escapeHtml } from '../../../common/html/escape-html';
import { OutboxService } from '../../notifications/application/outbox.service';
import { SenderContactService, SenderOrderRef } from './sender-contact.service';

interface OrderForSender extends SenderOrderRef {
  trackingCode: string;
  parcelDescription: string;
  originNodeId: string;
}

export const REFUSAL_REASON_LABELS: Record<string, string> = {
  prohibited: 'it contains items we can’t carry',
  damaged: 'it was already damaged',
  unsafe: 'it wasn’t safe to handle',
  packaging: 'it wasn’t packed well enough to travel',
  other: 'the station couldn’t accept it',
};

// Emails to whoever sent a parcel about something going wrong with it.
// Enqueued on the caller's transaction like every other order email.
@Injectable()
export class SenderNotificationService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly senders: SenderContactService,
  ) {}

  async refused(
    order: OrderForSender,
    refusal: { reason: string; note: string | null },
    manager: EntityManager,
  ): Promise<void> {
    const sender = await this.senders.resolve(order, manager);
    if (!sender) {
      return;
    }
    const [node] = await manager.query<{ name: string }[]>(
      `SELECT name FROM nodes WHERE id = $1`,
      [order.originNodeId],
    );
    const why =
      REFUSAL_REASON_LABELS[refusal.reason] ?? REFUSAL_REASON_LABELS.other;
    const text =
      `${node?.name ?? 'The station'} couldn't accept your parcel (${order.parcelDescription}) ` +
      `because ${why}.` +
      (refusal.note ? ` Staff note: ${refusal.note}` : '') +
      `\n\nTracking code: ${order.trackingCode}. If you have questions about your payment, reply to this email.`;
    await this.outbox.enqueueEmail(
      {
        to: sender.email,
        subject: 'Your parcel was not accepted at drop-off',
        text,
        html: `<p>${escapeHtml(text).replace(/\n\n/g, '</p><p>')}</p>`,
      },
      manager,
    );
  }

  async exception(
    order: OrderForSender,
    type: 'lost' | 'damaged',
    manager: EntityManager,
  ): Promise<void> {
    const sender = await this.senders.resolve(order, manager);
    if (!sender) {
      return;
    }
    const text =
      type === 'lost'
        ? `We're sorry: your parcel (${order.parcelDescription}, ${order.trackingCode}) has gone missing in our care. Our team is looking for it and will contact you.`
        : `We're sorry: your parcel (${order.parcelDescription}, ${order.trackingCode}) was damaged in our care. Our team will contact you about what happens next.`;
    await this.outbox.enqueueEmail(
      {
        to: sender.email,
        subject:
          type === 'lost'
            ? 'A problem with your parcel: it is missing'
            : 'A problem with your parcel: it was damaged',
        text,
        html: `<p>${escapeHtml(text)}</p>`,
      },
      manager,
    );
  }
}
