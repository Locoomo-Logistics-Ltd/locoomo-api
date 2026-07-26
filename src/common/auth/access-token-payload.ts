import { UserRole } from './user-role.enum';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}
