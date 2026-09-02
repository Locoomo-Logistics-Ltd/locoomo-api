import { BusinessException } from '../../../../common/exceptions';

export class NodeOperatorAlreadyOnboardedException extends BusinessException {
  readonly errorCode = 'NODE_OPERATOR_ALREADY_ONBOARDED';
  readonly httpStatus = 409;

  constructor() {
    super(
      'This account has already completed onboarding — use POST /node-operators/nodes to add another Node',
    );
  }
}
