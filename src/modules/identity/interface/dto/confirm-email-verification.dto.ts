import { IsString } from 'class-validator';

export class ConfirmEmailVerificationDto {
  @IsString()
  token!: string;
}
