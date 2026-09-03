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

// Same fields as payments' CreatePaymentIntentDto minus `originNodeId` —
// implicit from the :nodeId route param (DispatchParcelService.dispatch),
// which also keeps a dispatching operator from pointing an order at a
// Node they don't run.
export class DispatchParcelDto {
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
