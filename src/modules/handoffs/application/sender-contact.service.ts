import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface SenderContact {
  email: string;
  name: string | null;
}

export interface SenderOrderRef {
  id: string;
  source?: string | null;
  consumerId: string | null;
  merchantId?: string | null;
}

export type SenderContactResolver = (
  order: SenderOrderRef,
  manager: EntityManager,
) => Promise<SenderContact | null>;

// Who to tell about a parcel's problems or return (plan §5.4): the
// consumer who booked it, or — once merchant orders exist (M4) — the
// merchant's operations contact. The merchants module registers its
// resolver here, so handoffs never imports merchants (boundary rule, E5).
@Injectable()
export class SenderContactService {
  private readonly resolvers = new Map<string, SenderContactResolver>();

  register(source: string, resolver: SenderContactResolver): void {
    this.resolvers.set(source, resolver);
  }

  async resolve(
    order: SenderOrderRef,
    manager: EntityManager,
  ): Promise<SenderContact | null> {
    const source = order.source ?? 'consumer';
    const custom = this.resolvers.get(source);
    if (custom) {
      return custom(order, manager);
    }
    if (source !== 'consumer' || !order.consumerId) {
      return null;
    }
    const [user] = await manager.query<
      { email: string; firstName: string | null }[]
    >(`SELECT email, "firstName" FROM users WHERE id = $1`, [order.consumerId]);
    return user ? { email: user.email, name: user.firstName } : null;
  }
}
