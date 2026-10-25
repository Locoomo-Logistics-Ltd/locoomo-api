import { IsUUID } from 'class-validator';
import { ParcelDetailsDto } from '../../../../common/parcel/parcel-details.dto';

export class DeliveryQuoteDto extends ParcelDetailsDto {
  @IsUUID()
  originNodeId!: string;

  @IsUUID()
  destinationNodeId!: string;
}
