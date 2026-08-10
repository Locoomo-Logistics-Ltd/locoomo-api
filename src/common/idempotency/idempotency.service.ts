import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { isUniqueViolation } from '../database/is-unique-violation.util';
import { IdempotencyKeyEntity } from './idempotency-key.entity';

export interface IdempotencyOutcome<T> {
  result: T | undefined;
  alreadyProcessed: boolean;
}

@Injectable()
export class IdempotencyService {
  async withIdempotency<T>(
    scope: string,
    key: string,
    manager: EntityManager,
    fn: () => Promise<T>,
  ): Promise<IdempotencyOutcome<T>> {
    try {
      await manager.getRepository(IdempotencyKeyEntity).insert({ scope, key });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { result: undefined, alreadyProcessed: true };
      }
      throw error;
    }

    const result = await fn();
    return { result, alreadyProcessed: false };
  }
}
