import {
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ParcelSize } from '../../../../common/parcel-size.enum';

const PARCEL_SIZES = Object.values(ParcelSize);

export class CreatePaymentIntentDto {
  @IsUUID()
  originNodeId!: string;

  @IsUUID()
  destinationNodeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  receiverFullName!: string;

  @IsEmail()
  receiverEmail!: string;

  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'receiverPhone must be a valid phone number',
  })
  receiverPhone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  parcelDescription!: string;

  @IsIn(PARCEL_SIZES, {
    message: `parcelSize must be one of: ${PARCEL_SIZES.join(', ')}`,
  })
  parcelSize!: ParcelSize;
}
