import { BusinessException } from '../../../../common/exceptions';

// An in-house action (a rider accepting, or a rider-code handover) on an
// order whose parcel isn't with the in-house pool — another courier has
// it, or it's already moved on. Same code and status as the order-level
// conflict clients already handle (refresh and re-read), so the rider and
// Node apps need no new error branch.
export class DeliveryNotClaimableException extends BusinessException {
  readonly errorCode = 'ILLEGAL_ORDER_TRANSITION';
  readonly httpStatus = 409;

  constructor(orderId: string, reason: string) {
    super(`Order ${orderId} can't be handled by an in-house rider: ${reason}`, {
      orderId,
    });
  }
}
