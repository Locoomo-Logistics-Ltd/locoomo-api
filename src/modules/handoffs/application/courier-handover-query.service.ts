import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { CourierHandoverService } from '../../logistics/application/courier-handover.service';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { nodeRoleFor } from '../domain/counter-view';
import { CourierHandoverNotAvailableException } from '../domain/exceptions/courier-handover-not-available.exception';
import { CourierHandoverResponseDto } from '../interface/dto/courier-handover-response.dto';

interface OrderRow {
  id: string;
  trackingCode: string;
  status: string;
  originNodeId: string;
  destinationNodeId: string;
  shelfNodeId: string | null;
  shelfNumber: number | null;
}

// The Node side of an external-courier handover: which code this Node gives
// right now — the pickup code at the origin while a courier is assigned, the
// delivery code at the destination while it's in transit.
@Injectable()
export class CourierHandoverQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
    private readonly courierHandoverService: CourierHandoverService,
  ) {}

  async forNode(
    orderId: string,
    operatorUserId: string,
  ): Promise<CourierHandoverResponseDto> {
    const myNodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);
    const [order] = await this.dataSource.query<OrderRow[]>(
      `SELECT id, "trackingCode", status, "originNodeId", "destinationNodeId",
              "shelfNodeId", "shelfNumber"
         FROM orders
        WHERE id = $1 AND ("originNodeId" = ANY($2) OR "destinationNodeId" = ANY($2))`,
      [orderId, myNodeIds],
    );
    if (!order) {
      throw new EntityNotFoundException('Order', orderId);
    }

    const role = nodeRoleFor(order, myNodeIds);
    const kind =
      role === 'origin' && order.status === 'rider_assigned'
        ? 'pickup'
        : role === 'destination' && order.status === 'in_transit'
          ? 'delivery'
          : role === 'origin' && order.status === 'return_in_transit'
            ? 'return_delivery'
            : null;
    if (!kind) {
      throw new CourierHandoverNotAvailableException(
        orderId,
        `nothing to hand over at the ${role} while ${order.status}`,
      );
    }

    const handover = await this.courierHandoverService.handoverFor(orderId);
    // A returning courier hands back with the same delivery code it would
    // have used at the destination.
    const code =
      kind === 'pickup' ? handover?.pickupCode : handover?.deliveryCode;
    if (!handover || !code) {
      throw new CourierHandoverNotAvailableException(
        orderId,
        handover
          ? 'the courier has no code for this step yet'
          : 'this delivery uses Locoomo rider codes',
      );
    }

    const dto = new CourierHandoverResponseDto();
    dto.kind = kind;
    dto.code = code;
    dto.courier = handover.courier;
    dto.providerLabel = handover.providerLabel;
    dto.shelfNumber =
      order.shelfNodeId && myNodeIds.includes(order.shelfNodeId)
        ? order.shelfNumber
        : null;
    dto.trackingCode = order.trackingCode;
    return dto;
  }
}
