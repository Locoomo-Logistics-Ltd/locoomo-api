import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AuditService,
  AuditRequestContext,
} from '../../../common/audit/audit.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { OrdersService } from '../../orders/application/orders.service';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { CounterUploadsService } from './counter-uploads.service';
import { OrderLookupService } from './order-lookup.service';
import { SenderNotificationService } from './sender-notification.service';

export const REFUSAL_REASONS = [
  'prohibited',
  'damaged',
  'unsafe',
  'packaging',
  'other',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// Origin staff turn a parcel away at drop-off (plan §5.3): prohibited,
// damaged or unsafe. The parcel goes back with whoever brought it, the
// origin slot reserved at checkout is freed, and the sender is told why.
@Injectable()
export class RefuseDropOffService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly nodesService: NodesService,
    private readonly uploads: CounterUploadsService,
    private readonly senderNotifications: SenderNotificationService,
    private readonly audit: AuditService,
  ) {}

  async refuse(
    orderId: string,
    staffUserId: string,
    input: { reason: RefusalReason; note?: string; photoPublicId?: string },
    context: AuditRequestContext,
  ): Promise<OrderTransitionResult> {
    await this.orderLookupService.assertOriginNodeOwnership(
      orderId,
      staffUserId,
    );
    if (input.photoPublicId) {
      await this.uploads.assertOwnUpload(staffUserId, input.photoPublicId);
    }
    return this.dataSource.transaction(async (manager) => {
      const order = await this.ordersService.markRefused(
        orderId,
        {
          reason: input.reason,
          note: input.note ?? null,
          photoPublicId: input.photoPublicId ?? null,
        },
        manager,
      );
      // A consumer's slot was reserved at checkout; the parcel never takes
      // it now. Merchant orders hold none until drop-off (plan §5.2).
      if (order.source !== 'merchant') {
        await this.nodesService.releaseCapacitySlot(
          order.originNodeId,
          manager,
        );
      }
      await this.senderNotifications.refused(
        order,
        { reason: input.reason, note: input.note ?? null },
        manager,
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: staffUserId },
          action: 'order.refused_at_drop_off',
          target: { type: 'order', id: orderId },
          metadata: { reason: input.reason, photo: !!input.photoPublicId },
          context,
        },
        manager,
      );
      return order;
    });
  }
}
