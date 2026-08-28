import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../../../common/auth/user-role.enum';
import { SELF_REGISTERABLE_ROLES } from '../../domain/self-registerable-roles.constant';

// role/consentAccepted only matter on the account-creation branch of
// GoogleAuthService.authenticate — an existing-googleId call (a plain login)
// ignores both, so neither is validated with @Equals/@IsIn-required here;
// GoogleAuthService enforces consentAccepted itself, only when it's about to
// create a new account.
export class GoogleAuthDto {
  @IsString()
  @MinLength(10, { message: 'idToken does not look like a Google ID token' })
  idToken!: string;

  @IsOptional()
  @IsIn(SELF_REGISTERABLE_ROLES, {
    message: `role must be one of: ${SELF_REGISTERABLE_ROLES.join(', ')}`,
  })
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  consentAccepted?: boolean;
}
