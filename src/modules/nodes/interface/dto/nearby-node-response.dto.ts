import { NodeOnboardingType } from '../../domain/node-onboarding-type.enum';
import { NodeStatus } from '../../domain/node-status.enum';
import { NodeEntity } from '../../infrastructure/entities/node.entity';

export class NearbyNodeResponseDto {
  id!: string;
  name!: string;
  address!: string;
  city!: string;
  state!: string;
  country!: string;
  latitude!: number;
  longitude!: number;
  capacity!: number;
  status!: NodeStatus;
  onboardingType!: NodeOnboardingType;
  operatingHours!: string | null;
  createdAt!: Date;
  distanceMeters!: number;

  static fromRow(
    row: NodeEntity & { distance: number },
  ): NearbyNodeResponseDto {
    const dto = new NearbyNodeResponseDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.address = row.address;
    dto.city = row.city;
    dto.state = row.state;
    dto.country = row.country;
    dto.latitude = row.latitude;
    dto.longitude = row.longitude;
    dto.capacity = row.capacity;
    dto.status = row.status;
    dto.onboardingType = row.onboardingType;
    dto.operatingHours = row.operatingHours;
    dto.createdAt = row.createdAt;
    dto.distanceMeters = row.distance;
    return dto;
  }
}
