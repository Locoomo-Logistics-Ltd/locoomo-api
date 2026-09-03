import { NodeOnboardingType } from '../../domain/node-onboarding-type.enum';
import { NodeStatus } from '../../domain/node-status.enum';
import { NodeEntity } from '../../infrastructure/entities/node.entity';

export class NodeResponseDto {
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
  isPubliclyVisible!: boolean;
  createdAt!: Date;

  static fromEntity(node: NodeEntity): NodeResponseDto {
    const dto = new NodeResponseDto();
    dto.id = node.id;
    dto.name = node.name;
    dto.address = node.address;
    dto.city = node.city;
    dto.state = node.state;
    dto.country = node.country;
    dto.latitude = node.latitude;
    dto.longitude = node.longitude;
    dto.capacity = node.capacity;
    dto.status = node.status;
    dto.onboardingType = node.onboardingType;
    dto.operatingHours = node.operatingHours;
    dto.isPubliclyVisible = node.isPubliclyVisible;
    dto.createdAt = node.createdAt;
    return dto;
  }
}
