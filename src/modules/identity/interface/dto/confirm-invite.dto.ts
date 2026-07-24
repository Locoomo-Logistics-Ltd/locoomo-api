import {
  Equals,
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Match } from '../../../../common/validators/match.decorator';

export class ConfirmInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(128)
  password!: string;

  @IsString()
  @Match('password', { message: 'passwordConfirmation must match password' })
  passwordConfirmation!: string;

  // Captured here, not at invite-creation — the Admin who invites someone
  // can't consent on their behalf; NDPA requires it from the data subject.
  @IsBoolean()
  @Equals(true, {
    message: 'You must accept the Terms of Service and Privacy Policy',
  })
  consentAccepted!: boolean;
}
