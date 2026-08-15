import { IsBoolean, IsString, Length } from 'class-validator';

export class ConfirmCollectionDto {
  @IsString()
  @Length(6, 6)
  code!: string;

  // Operator attestation that they asked for and matched the receiver's
  // name — not system-verified, see ConfirmCollectionService.
  @IsBoolean()
  identityConfirmed!: boolean;
}
