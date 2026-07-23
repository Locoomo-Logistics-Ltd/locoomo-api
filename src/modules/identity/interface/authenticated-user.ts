import { UserRole } from '../domain/user-role.enum';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}
