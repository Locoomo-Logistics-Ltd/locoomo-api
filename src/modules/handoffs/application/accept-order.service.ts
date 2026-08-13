import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrdersService } from '../../orders/application/orders.service';
import { RiderCapacityService } from '../../riders/application/rider-capacity.service';
import { RiderCapacityUnavailableException } from '../domain/exceptions/rider-capacity-unavailable.exception';
import { OrderTransitionResult } from '../domain/order-transition-result';

// One transaction: reserve the rider's capacity slot (locks their
// RiderProfile row), then claim the order (locks/updates that specific
// order row). Consistent lock ordering across every call to this method —
// RiderProfile always before Order — so concurrent accept() calls can't
// deadlock each other.
@Injectable()
export class AcceptOrderService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly riderCapacityService: RiderCapacityService,
    private readonly ordersService: OrdersService,
  ) {}

  async accept(
    orderId: string,
    riderId: string,
  ): Promise<OrderTransitionResult> {
    return this.dataSource.transaction(async (manager) => {
      const reserved = await this.riderCapacityService.reserveDeliverySlot(
        riderId,
        manager,
      );
      if (!reserved) {
        throw new RiderCapacityUnavailableException(riderId);
      }

      // Loses the race (order already claimed by another rider) ->
      // OrdersService throws IllegalOrderTransitionException, which rolls
      // back the capacity reservation above along with everything else in
      // this transaction — no manual compensating release needed.
      return this.ordersService.assignRider(orderId, riderId, manager);
    });
  }
}
