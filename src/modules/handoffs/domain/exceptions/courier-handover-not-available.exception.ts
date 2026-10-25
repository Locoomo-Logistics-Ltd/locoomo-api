import { BusinessException } from '../../../../common/exceptions';

// Nothing to hand over to an external courier at this Node right now: no
// courier assigned yet, the handover already happened, this Node isn't the
// side doing it, or the delivery uses Locoomo rider codes instead. The
// client should refresh the order and follow its nextAction.
export class CourierHandoverNotAvailableException extends BusinessException {
  readonly errorCode = 'COURIER_HANDOVER_NOT_AVAILABLE';
  readonly httpStatus = 409;

  constructor(orderId: string, reason: string) {
    super(`No courier handover for order ${orderId}: ${reason}`, { orderId });
  }
}
