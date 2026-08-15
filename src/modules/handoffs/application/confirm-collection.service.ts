import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeValidatorService } from './handoff-code-validator.service';
import { OrderLookupService } from './order-lookup.service';

const IDEMPOTENCY_SCOPE = 'handoffs.confirm-collection';

// Final step of the flow. identityConfirmed is an operator attestation,
// not a system-enforced name match — a strict match would break legitimate
// proxy pickup (someone other than the named receiver collecting on their
// behalf, which happens routinely in this business). Recorded into the
// permanent OrderEvent audit trail, not used to gate the transition.
@Injectable()
export class ConfirmCollectionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
    private readonly handoffCodeValidatorService: HandoffCodeValidatorService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
    code: string,
    identityConfirmed: boolean,
  ): Promise<OrderTransitionResult> {
    await this.orderLookupService.assertDestinationNodeOwnership(
      orderId,
      operatorUserId,
    );

    const { result, alreadyProcessed } = await this.dataSource.transaction(
      (manager) =>
        this.idempotencyService.withIdempotency(
          IDEMPOTENCY_SCOPE,
          orderId,
          manager,
          async () => {
            await this.handoffCodeValidatorService.validate(
              manager,
              orderId,
              HandoffCodeType.RECEIVER_COLLECTION,
              code,
            );
            return this.ordersService.markCollected(orderId, manager, {
              identityConfirmed,
            });
          },
        ),
    );

    if (alreadyProcessed) {
      const [row] = await this.dataSource.query<OrderTransitionResult[]>(
        `SELECT id, "trackingCode", status, "originNodeId", "destinationNodeId"
           FROM orders WHERE id = $1`,
        [orderId],
      );
      return row;
    }

    return result as OrderTransitionResult;
  }
}
