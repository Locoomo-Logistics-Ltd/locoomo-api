import { BusinessException } from './business.exception';

// Generic — covers "Order not found", "Node not found", etc. Only becomes
// its own dedicated class if a specific entity ever needs different status
// or handling than a plain 404.
export class EntityNotFoundException extends BusinessException {
  readonly errorCode = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor(entity: string, id: string | number) {
    super(`${entity} with id ${String(id)} was not found`, { entity, id });
  }
}
