import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ParcelSize } from '../../../common/parcel-size.enum';
import { OrderEventType } from '../domain/order-event-type.enum';
import { OrderStatus } from '../domain/order-status.enum';
import { OrderEventEntity } from '../infrastructure/entities/order-event.entity';
import { OrderEntity } from '../infrastructure/entities/order.entity';

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
    const order = await orderRepo.save(
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
      }),
    );

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
}
