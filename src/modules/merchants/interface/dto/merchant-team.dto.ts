import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MerchantRole } from '../../domain/merchant.enums';
import { ASSIGNABLE_ROLES } from '../../domain/merchant-permissions';

export class InviteTeamMemberDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Any role except owner (ownership only moves by transfer).
  @IsIn(ASSIGNABLE_ROLES)
  role!: MerchantRole;
}

export class ChangeMemberRoleDto {
  @IsIn(ASSIGNABLE_ROLES)
  role!: MerchantRole;
}

export class InviteTokenDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;
}

export class TransferOwnershipDto {
  // merchant_members id of the new owner (must already be on the team).
  @IsUUID()
  memberId!: string;
}
