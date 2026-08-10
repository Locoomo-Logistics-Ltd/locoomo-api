import { ParcelSize } from '../../../../common/parcel-size.enum';
import { FeeBreakdown } from '../../domain/fee-breakdown';
import { PaymentIntentStatus } from '../../domain/payment-intent-status.enum';
import { PaymentIntentEntity } from '../../infrastructure/entities/payment-intent.entity';

export class PaymentIntentResponseDto {
  id!: string;
  originNodeId!: string;
  destinationNodeId!: string;
  receiverFullName!: string;
  receiverEmail!: string;
  receiverPhone!: string;
  parcelDescription!: string;
  parcelSize!: ParcelSize;
  feeBreakdown!: FeeBreakdown;
  amountKobo!: number;
  status!: PaymentIntentStatus;
  expiresAt!: Date;
  authorizationUrl?: string;

  static fromEntity(
    intent: PaymentIntentEntity,
    authorizationUrl?: string,
  ): PaymentIntentResponseDto {
    const dto = new PaymentIntentResponseDto();
    dto.id = intent.id;
    dto.originNodeId = intent.originNodeId;
    dto.destinationNodeId = intent.destinationNodeId;
    dto.receiverFullName = intent.receiverFullName;
    dto.receiverEmail = intent.receiverEmail;
    dto.receiverPhone = intent.receiverPhone;
    dto.parcelDescription = intent.parcelDescription;
    dto.parcelSize = intent.parcelSize;
    dto.feeBreakdown = intent.feeBreakdown;
    dto.amountKobo = intent.amountKobo;
    dto.status = intent.status;
    dto.expiresAt = intent.expiresAt;
    dto.authorizationUrl = authorizationUrl;
    return dto;
  }
}
