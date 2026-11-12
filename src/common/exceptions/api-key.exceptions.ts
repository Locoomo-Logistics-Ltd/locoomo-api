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
