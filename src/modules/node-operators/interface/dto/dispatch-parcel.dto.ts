import {
  IsEmail,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ParcelDetailsDto } from '../../../../common/parcel/parcel-details.dto';

// Same fields as payments' CreatePaymentIntentDto minus `originNodeId` —
// implicit from the :nodeId route param (DispatchParcelService.dispatch),
// which also keeps a dispatching operator from pointing an order at a
// Node they don't run.
export class DispatchParcelDto extends ParcelDetailsDto {
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
}
