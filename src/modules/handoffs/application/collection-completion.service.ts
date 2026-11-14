import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RecordRevenueSplitService } from '../../earnings/application/record-revenue-split.service';
import {
  OrdersService,
  ProofOfDelivery,
} from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';

// The receiver has their parcel — by code or by ID check. One place so
// both ways record proof of delivery and the revenue split identically.
@Injectable()
export class CollectionCompletionService {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly recordRevenueSplitService: RecordRevenueSplitService,
  ) {}

  async complete(
    manager: EntityManager,
    orderId: string,
    eventPayload: Record<string, unknown>,
    proof: ProofOfDelivery,
  ): Promise<OrderTransitionResult> {
    const order = await this.ordersService.markCollected(
      orderId,
      manager,
      eventPayload,
      proof,
    );
    // No code may still be valid once it's collected.
    await manager.query(
      `DELETE FROM handoff_codes WHERE "orderId" = $1 AND type = $2 AND "usedAt" IS NULL`,
      [orderId, HandoffCodeType.RECEIVER_COLLECTION],
    );
    // Same transaction as COMPLETED: an order can't be completed without
    // its revenue split. riderId is null when an external courier carried
    // it (recorded as a non-payable courier allocation).
    await this.recordRevenueSplitService.record(
      {
        orderId: order.id,
        amountKobo: order.amountKobo,
        destinationFeeKobo: order.destinationFeeKobo,
        riderId: order.riderId,
        originNodeId: order.originNodeId,
        destinationNodeId: order.destinationNodeId,
      },
      manager,
    );
    return order;
  }
}
