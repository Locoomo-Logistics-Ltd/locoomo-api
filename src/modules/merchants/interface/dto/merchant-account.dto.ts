import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SetPayoutAccountDto } from '../../../../common/dto/set-payout-account.dto';
import {
  DirectorIdType,
  ExpectedMonthlyVolume,
  MerchantDocumentKind,
  MerchantType,
} from '../../domain/merchant.enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateMerchantDto {
  @IsEnum(MerchantType)
  type!: MerchantType;

  // The name buyers see. Can be refined until approval.
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  tradingName!: string;
}

export class MerchantAddressDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  line1!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  line2?: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  state!: string;
}

// Every field optional: the onboarding form saves section by section.
export class UpdateMerchantProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  tradingName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(300)
  storeUrl?: string;

  @IsOptional()
  @IsEnum(ExpectedMonthlyVolume)
  expectedMonthlyVolume?: ExpectedMonthlyVolume;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

  // +2348031234567 or 08031234567.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s-]/g, '') : value,
  )
  @Matches(/^\+?\d{10,15}$/, {
    message: 'contactPhone must be a phone number, e.g. +2348031234567',
  })
  contactPhone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantAddressDto)
  address?: MerchantAddressDto;

  // RC1234567 (company) or BN1234567 (business name). Businesses only.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : value,
  )
  @Matches(/^(RC|BN|IT)?\d{4,10}$/, {
    message: 'cacNumber must look like RC1234567 or BN1234567',
  })
  cacNumber?: string;
}

export class PutMerchantDocumentDto {
  // public_id returned by Cloudinary after the signed upload.
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  publicId!: string;
}

export class MerchantDocumentKindParam {
  @IsEnum(MerchantDocumentKind)
  kind!: MerchantDocumentKind;
}

export class AddDirectorDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  fullName!: string;

  @IsEnum(DirectorIdType)
  idType!: DirectorIdType;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9]{5,20}$/, {
    message: 'idNumber must be 5–20 letters or digits',
  })
  idNumber!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idDocumentPublicId!: string;
}

export class AcceptTermsDto {
  // The version the user was shown (GET /merchant/account → terms.currentVersion).
  @IsString()
  @MaxLength(20)
  version!: string;
}

export class SetMerchantBankAccountDto extends SetPayoutAccountDto {}
