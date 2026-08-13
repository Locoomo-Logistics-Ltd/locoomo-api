import { BusinessException } from '../../../../common/exceptions';
import { OrderStatus } from '../order-status.enum';

export class IllegalOrderTransitionException extends BusinessException {
  readonly errorCode = 'ILLEGAL_ORDER_TRANSITION';
  readonly httpStatus = 409;

  constructor(orderId: string, fromStatus: OrderStatus, toStatus: OrderStatus) {
    super(
      `Order ${orderId} cannot transition from ${fromStatus} to ${toStatus}`,
      {
        orderId,
        fromStatus,
        toStatus,
      },
    );
  }
}
