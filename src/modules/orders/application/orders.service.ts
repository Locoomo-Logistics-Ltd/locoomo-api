import { Injectable } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { ParcelSize } from '../../../common/parcel-size.enum';
import { OrderEventType } from '../domain/order-event-type.enum';
import { OrderStatus } from '../domain/order-status.enum';
import { generateTrackingCode } from '../domain/tracking-code';
import { OrderEventEntity } from '../infrastructure/entities/order-event.entity';
import { OrderEntity } from '../infrastructure/entities/order.entity';

// 32^8 possible codes — a same-transaction retry loop is the correctness
// guarantee (the unique index is what actually prevents a collision), this
// cap just stops a pathological run of bad luck from looping forever.
const MAX_TRACKING_CODE_ATTEMPTS = 5;

export interface CreateOrderFromPaidIntentFields {
  paymentIntentId: string;
  consumerId: string;
  originNodeId: string;
  destinationNodeId: string;
  receiverFullName: string;
  receiverEmail: string;
  receiverPhone: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  amountKobo: number;
}

@Injectable()
export class OrdersService {
  async createFromPaidIntent(
    fields: CreateOrderFromPaidIntentFields,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const orderRepo = manager.getRepository(OrderEntity);
    const order = await this.saveWithTrackingCode(orderRepo, fields);

    const eventRepo = manager.getRepository(OrderEventEntity);
    await eventRepo.save(
      eventRepo.create({
        orderId: order.id,
        type: OrderEventType.ORDER_PLACED,
        payload: {
          paymentIntentId: fields.paymentIntentId,
          amountKobo: fields.amountKobo,
        },
      }),
    );

    return order;
  }

  private async saveWithTrackingCode(
    orderRepo: Repository<OrderEntity>,
    fields: CreateOrderFromPaidIntentFields,
  ): Promise<OrderEntity> {
    for (let attempt = 1; attempt <= MAX_TRACKING_CODE_ATTEMPTS; attempt++) {
      try {
        return await orderRepo.save(
          orderRepo.create({
            paymentIntentId: fields.paymentIntentId,
            consumerId: fields.consumerId,
            originNodeId: fields.originNodeId,
            destinationNodeId: fields.destinationNodeId,
            receiverFullName: fields.receiverFullName,
            receiverEmail: fields.receiverEmail,
            receiverPhone: fields.receiverPhone,
            parcelDescription: fields.parcelDescription,
            parcelSize: fields.parcelSize,
            amountKobo: fields.amountKobo,
            status: OrderStatus.AWAITING_DROP_OFF,
            trackingCode: generateTrackingCode(),
          }),
        );
      } catch (error) {
        if (
          !isUniqueViolation(error) ||
          attempt === MAX_TRACKING_CODE_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    // Unreachable — the loop above always either returns or throws.
    throw new Error('Failed to generate a unique tracking code');
  }
}
