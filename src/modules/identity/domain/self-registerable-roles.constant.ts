import { UserRole } from '../../../common/auth/user-role.enum';

// Admin is excluded for the same reason InviteUserDto excludes Consumer:
// never self-registerable, via password registration or Google sign-in.
export const SELF_REGISTERABLE_ROLES = [
  UserRole.CONSUMER,
  UserRole.NODE_OPERATOR,
  UserRole.RIDER,
];
