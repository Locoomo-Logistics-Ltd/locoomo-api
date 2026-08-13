import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { InvalidHandoffCodeException } from '../domain/exceptions/invalid-handoff-code.exception';
import { HandoffCodeEntity } from '../infrastructure/entities/handoff-code.entity';
import { OrderLookupService } from './order-lookup.service';

const MAX_HANDOFF_CODE_ATTEMPTS = 5;

@Injectable()
export class ConfirmHandoffService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
    type: HandoffCodeType.RIDER_PICKUP | HandoffCodeType.RIDER_ARRIVAL,
    code: string,
  ): Promise<OrderTransitionResult> {
    // Ownership first, outside the transaction — same reasoning as
    // drop-off: immutable data, and a wrong-Node request should 404 before
    // it ever touches the idempotency table.
    if (type === HandoffCodeType.RIDER_PICKUP) {
      await this.orderLookupService.assertOriginNodeOwnership(
        orderId,
        operatorUserId,
      );
    } else {
      await this.orderLookupService.assertDestinationNodeOwnership(
        orderId,
        operatorUserId,
      );
    }

    const scope = `handoffs.confirm-handoff.${type}`;
    const { result, alreadyProcessed } = await this.dataSource.transaction(
      (manager) =>
        this.idempotencyService.withIdempotency(scope, orderId, manager, () =>
          this.validateCodeAndTransition(orderId, type, code, manager),
        ),
    );

    if (alreadyProcessed) {
      // Same transaction-poisoning reasoning as ConfirmDropOffService: the
      // idempotency insert's unique violation leaves the transaction
      // aborted even though we caught it, so the re-read has to be a fresh
      // query outside it, not chained onto the same manager.
      const [row] = await this.dataSource.query<OrderTransitionResult[]>(
        `SELECT id, "trackingCode", status, "originNodeId", "destinationNodeId"
           FROM orders WHERE id = $1`,
        [orderId],
      );
      return row;
    }

    return result as OrderTransitionResult;
  }

  private async validateCodeAndTransition(
    orderId: string,
    type: HandoffCodeType,
    code: string,
    manager: EntityManager,
  ): Promise<OrderTransitionResult> {
    const handoffCode = await manager.getRepository(HandoffCodeEntity).findOne({
      where: { orderId, type, usedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    const isValid =
      !!handoffCode &&
      handoffCode.expiresAt > new Date() &&
      handoffCode.failedAttempts < MAX_HANDOFF_CODE_ATTEMPTS &&
      hashToken(code) === handoffCode.codeHash;

    if (!isValid) {
      if (handoffCode) {
        // Durable regardless of this transaction's fate — we're about to
        // throw, which rolls back everything on `manager` including the
        // idempotency-key insert (so the caller can retry with a correct
        // code), but the lockout counter must survive that rollback or a
        // wrong-code attempt could be retried forever for free. Goes
        // through a separate connection, not `manager`.
        await this.dataSource.query(
          `UPDATE handoff_codes SET "failedAttempts" = "failedAttempts" + 1 WHERE id = $1`,
          [handoffCode.id],
        );
      }
      throw new InvalidHandoffCodeException();
    }

    await manager
      .getRepository(HandoffCodeEntity)
      .update(handoffCode.id, { usedAt: new Date() });

    return type === HandoffCodeType.RIDER_PICKUP
      ? this.ordersService.markPickedUpByRider(orderId, manager)
      : this.ordersService.markArrivedAtDestination(orderId, manager);
  }
}
