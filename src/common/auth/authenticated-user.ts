import { UserRole } from './user-role.enum';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  // See AccessTokenPayload.
  sessionId?: string;
  reauthAt?: number;
}
