import { AuthenticationException } from './authentication.exception';
import { AuthorizationException } from './authorization.exception';

// Uniform for unknown, malformed, revoked, expired and IP-blocked keys —
// telling them apart would help someone probing for valid keys.
export class InvalidApiKeyException extends AuthenticationException {
  readonly errorCode = 'INVALID_API_KEY';
  readonly httpStatus = 401;

  constructor() {
    super('Invalid API key');
  }
}

export class InsufficientScopeException extends AuthorizationException {
  readonly errorCode = 'INSUFFICIENT_SCOPE';
  readonly httpStatus = 403;

  constructor(readonly missingScopes: string[]) {
    super(
      `This API key is missing the required scope(s): ${missingScopes.join(', ')}`,
    );
  }
}

// 429 with Retry-After (set on the response by whoever throws this).
export class RateLimitedException extends AuthorizationException {
  readonly errorCode = 'RATE_LIMITED';
  readonly httpStatus = 429;

  constructor() {
    super(
      'Too many requests. Slow down and retry after the Retry-After delay.',
    );
  }
}
