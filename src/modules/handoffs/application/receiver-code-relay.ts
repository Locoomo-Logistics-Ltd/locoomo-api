import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

// 'ready': first code, the parcel was just shelved. 'reissued': a
// replacement (resend, or new receiver contact) for a parcel already there.
export type RelayKind = 'ready' | 'reissued';

export interface RelayedCode {
  trackingCode: string;
  collectionCode: string;
  collectBy: Date;
  kind: RelayKind;
}

export interface ReceiverCodeRelayHandler {
  relay(code: RelayedCode, manager: EntityManager): Promise<void>;
}

// Merchants that relay collection codes themselves (plan D19,
// notifyReceiver merchant/both) get every code we issue for their parcel,
// inside the transaction that issued it. Merchants register the handler on
// init; handoffs never imports merchants.
@Injectable()
export class ReceiverCodeRelay {
  private handler: ReceiverCodeRelayHandler | null = null;

  register(handler: ReceiverCodeRelayHandler): void {
    if (this.handler) {
      throw new Error('A receiver code relay handler is already registered');
    }
    this.handler = handler;
  }

  async relay(code: RelayedCode, manager: EntityManager): Promise<void> {
    await this.handler?.relay(code, manager);
  }
}
