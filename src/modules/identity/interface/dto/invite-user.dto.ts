import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../domain/user-role.enum';

// Consumer is deliberately excluded — that role is self-registration only
// (CLAUDE.md #9/#7).
const INVITABLE_ROLES = [
  UserRole.NODE_OPERATOR,
  UserRole.RIDER,
  UserRole.ADMIN,
];

export class InviteUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'phone must be a valid phone number',
  })
  phone!: string;

  @IsIn(INVITABLE_ROLES, {
    message: `role must be one of: ${INVITABLE_ROLES.join(', ')}`,
  })
  role!: UserRole;
}
