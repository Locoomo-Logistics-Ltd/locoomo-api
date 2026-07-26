import { UserRole } from './user-role.enum';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}
