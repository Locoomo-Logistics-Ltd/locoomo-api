import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  // No format/strength rules here — this is a login, not a registration.
  // Rejecting on length alone (not complexity) avoids handing an attacker
  // free information about the password policy via validation error content.
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
