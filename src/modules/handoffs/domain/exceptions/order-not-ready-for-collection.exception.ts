import { BusinessException } from '../../../../common/exceptions';

// Distinct from IllegalOrderTransitionException (which lives in orders'
// domain and requires OrderStatus, a cross-module import handoffs can't
// take) — this guards an action that isn't itself a transition (resending
// an already-issued code), so it gets its own small exception instead.
export class OrderNotReadyForCollectionException extends BusinessException {
  readonly errorCode = 'ORDER_NOT_READY_FOR_COLLECTION';
  readonly httpStatus = 409;

  constructor(orderId: string) {
    super(`Order ${orderId} is not awaiting collection`, { orderId });
  }
}
