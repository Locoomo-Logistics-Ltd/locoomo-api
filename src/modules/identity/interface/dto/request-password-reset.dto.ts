import { IsEmail, MaxLength } from 'class-validator';

export class RequestPasswordResetDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;
}
