import { UserRole } from './user-role.enum';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  // Session id = the refresh-token family this access token belongs to.
  // Lets a revoked session (sign out of one device, password reset) stop
  // working immediately instead of when the 15-minute token expires.
  // Absent on tokens issued before sessions shipped.
  sid?: string;
  // Epoch seconds of the last step-up re-authentication (password / 2FA /
  // Google) — sensitive actions require it to be recent.
  reauthAt?: number;
}
