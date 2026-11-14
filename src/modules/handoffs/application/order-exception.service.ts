import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { OrdersService } from '../../orders/application/orders.service';
import { RiderCapacityService } from '../../riders/application/rider-capacity.service';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { SenderNotificationService } from './sender-notification.service';

// Statuses during which a parcel holds an origin slot.
const HOLDS_ORIGIN = new Set([
  'parcel_received_at_origin',
  'rider_assigned',
  'returned_to_origin',
  'ready_for_sender_collection',
]);
// Statuses during which an in-house rider holds a delivery slot.
const HOLDS_RIDER = new Set(['rider_assigned', 'in_transit']);

// Admin records a parcel lost or damaged in our custody (plan §5.3). The
// order stops; whatever its status was holding (origin slot, rider slot;
// the destination slot via DestinationCapacitySubscriber) is freed, and
// the sender is told. Claims open automatically from M4.
@Injectable()
export class OrderExceptionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ordersService: OrdersService,
    private readonly nodesService: NodesService,
    private readonly riderCapacityService: RiderCapacityService,
    private readonly senderNotifications: SenderNotificationService,
    private readonly audit: AuditService,
  ) {}

  async raise(
    orderId: string,
    adminUserId: string,
    input: { type: 'lost' | 'damaged'; note: string },
    context: AuditRequestContext,
  ): Promise<OrderTransitionResult> {
    return this.dataSource.transaction(async (manager) => {
      const { order, previousStatus } = await this.ordersService.markException(
        orderId,
        { ...input, byUserId: adminUserId },
        manager,
      );
      if (HOLDS_ORIGIN.has(previousStatus)) {
        await this.nodesService.releaseCapacitySlot(
          order.originNodeId,
          manager,
        );
      }
      if (HOLDS_RIDER.has(previousStatus) && order.riderId) {
        await this.riderCapacityService.releaseDeliverySlot(
          order.riderId,
          manager,
        );
      }
      await this.senderNotifications.exception(order, input.type, manager);
      await this.audit.record(
        {
          actor: { type: 'user', id: adminUserId, role: 'admin' },
          action: 'order.exception_raised',
          target: { type: 'order', id: orderId },
          before: { status: previousStatus },
          after: { status: 'exception', type: input.type },
          metadata: { note: input.note },
          context,
        },
        manager,
      );
      return order;
    });
  }
}
