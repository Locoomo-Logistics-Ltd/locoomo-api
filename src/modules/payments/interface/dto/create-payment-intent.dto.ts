import {
  IsEmail,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ParcelDetailsDto } from '../../../../common/parcel/parcel-details.dto';

export class CreatePaymentIntentDto extends ParcelDetailsDto {
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
}
