import { BusinessException } from '../../../../common/exceptions';

export class NodeCapacityUnavailableException extends BusinessException {
  readonly errorCode = 'NODE_CAPACITY_UNAVAILABLE';
  readonly httpStatus = 409;

  constructor(nodeId: string) {
    super(`Node ${nodeId} has no available capacity`, { nodeId });
  }
}
