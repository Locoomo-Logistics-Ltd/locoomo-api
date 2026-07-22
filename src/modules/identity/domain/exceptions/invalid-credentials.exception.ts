import { AuthenticationException } from '../../../../common/exceptions';

// Deliberately identical whether the email doesn't exist, the password is
// wrong, or the account has no password set yet (invited, not activated) —
// distinguishing any of those in the response would let an attacker
// enumerate registered emails.
export class InvalidCredentialsException extends AuthenticationException {
  readonly errorCode = 'INVALID_CREDENTIALS';
  readonly httpStatus = 401;

  constructor() {
    super('Invalid email or password');
  }
}
