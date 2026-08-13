import { ParcelSize } from '../../../../common/parcel-size.enum';

// Deliberately no receiver name/email/phone here — a rider deciding whether
// to accept a job doesn't need receiver PII, only enough to judge whether
// the job is worth taking (route, distance, parcel size). NDPA: don't
// expose PII beyond what the current step actually needs.
export interface AvailableOrderRow {
  id: string;
  trackingCode: string;
  originNodeId: string;
  originNodeName: string;
  originNodeAddress: string;
  destinationNodeId: string;
  destinationNodeName: string;
  destinationNodeAddress: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  createdAt: Date;
  distanceMeters: number;
}

export class AvailableOrderResponseDto {
  id!: string;
  trackingCode!: string;
  originNodeId!: string;
  originNodeName!: string;
  originNodeAddress!: string;
  destinationNodeId!: string;
  destinationNodeName!: string;
  destinationNodeAddress!: string;
  parcelDescription!: string;
  parcelSize!: ParcelSize;
  createdAt!: Date;
  distanceMeters!: number;

  static fromRow(row: AvailableOrderRow): AvailableOrderResponseDto {
    const dto = new AvailableOrderResponseDto();
    dto.id = row.id;
    dto.trackingCode = row.trackingCode;
    dto.originNodeId = row.originNodeId;
    dto.originNodeName = row.originNodeName;
    dto.originNodeAddress = row.originNodeAddress;
    dto.destinationNodeId = row.destinationNodeId;
    dto.destinationNodeName = row.destinationNodeName;
    dto.destinationNodeAddress = row.destinationNodeAddress;
    dto.parcelDescription = row.parcelDescription;
    dto.parcelSize = row.parcelSize;
    dto.createdAt = row.createdAt;
    dto.distanceMeters = Number(row.distanceMeters);
    return dto;
  }
}
