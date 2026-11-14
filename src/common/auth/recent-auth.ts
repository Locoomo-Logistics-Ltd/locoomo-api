import { ReauthRequiredException } from '../exceptions/reauth-required.exception';
import type { AuthenticatedUser } from './authenticated-user';

// Step-up re-authentication stays valid this long for sensitive actions.
export const REAUTH_VALID_SECONDS = 10 * 60;

export function hasRecentAuth(
  user: Pick<AuthenticatedUser, 'reauthAt'>,
): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return !!user.reauthAt && nowSeconds - user.reauthAt <= REAUTH_VALID_SECONDS;
}

// For actions that need step-up only sometimes (live API keys but not test
// ones), where a static @RequireRecentAuth() can't decide.
export function assertRecentAuth(
  user: Pick<AuthenticatedUser, 'reauthAt'>,
): void {
  if (!hasRecentAuth(user)) {
    throw new ReauthRequiredException();
  }
}
