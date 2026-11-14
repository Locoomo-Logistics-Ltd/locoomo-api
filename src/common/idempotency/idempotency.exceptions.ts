import { BusinessException } from '../exceptions';

export class IdempotencyKeyReusedException extends BusinessException {
  readonly errorCode = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = 422;

  constructor() {
    super(
      'This Idempotency-Key was already used with a different request. Use a new key for a new request.',
    );
  }
}

export class IdempotencyInProgressException extends BusinessException {
  readonly errorCode = 'IDEMPOTENCY_IN_PROGRESS';
  readonly httpStatus = 409;

  constructor() {
    super(
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
    );
  }
}

export class InvalidIdempotencyKeyException extends BusinessException {
  readonly errorCode = 'INVALID_IDEMPOTENCY_KEY';
  readonly httpStatus = 400;

  constructor() {
    super(
      'Idempotency-Key must be 1–255 printable characters (a UUID v4 is recommended).',
    );
  }
}
