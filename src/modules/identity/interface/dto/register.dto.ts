import {
  Equals,
  IsBoolean,
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Match } from '../../../../common/validators/match.decorator';

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
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'phone must be a valid phone number',
  })
  phone!: string;

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
}
