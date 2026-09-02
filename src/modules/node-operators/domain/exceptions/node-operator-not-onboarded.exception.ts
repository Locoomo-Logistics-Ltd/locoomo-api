import { BusinessException } from '../../../../common/exceptions';

// Thrown by POST /node-operators/nodes when the caller has no owner
// membership anywhere yet — they need to complete POST
// /node-operators/onboarding first (their first Node), which is a
// meaningfully different flow (also activates the account once approved).
export class NodeOperatorNotOnboardedException extends BusinessException {
  readonly errorCode = 'NODE_OPERATOR_NOT_ONBOARDED';
  readonly httpStatus = 400;

  constructor() {
    super(
      'Complete POST /node-operators/onboarding for your first Node before adding another',
    );
  }
}
