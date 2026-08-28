import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../../../common/auth/user-role.enum';
import { Match } from '../../../../common/validators/match.decorator';
import { SELF_REGISTERABLE_ROLES } from '../../domain/self-registerable-roles.constant';

export class RegisterDto {
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
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(128)
  password!: string;

  @IsString()
  @Match('password', { message: 'passwordConfirmation must match password' })
  passwordConfirmation!: string;

  @IsBoolean()
  @Equals(true, {
    message: 'You must accept the Terms of Service and Privacy Policy',
  })
  consentAccepted!: boolean;

  @IsOptional()
  @IsIn(SELF_REGISTERABLE_ROLES, {
    message: `role must be one of: ${SELF_REGISTERABLE_ROLES.join(', ')}`,
  })
  role?: UserRole;
}
