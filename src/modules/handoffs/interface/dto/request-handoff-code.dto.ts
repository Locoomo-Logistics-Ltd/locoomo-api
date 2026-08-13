import { IsIn } from 'class-validator';
import { HandoffCodeType } from '../../domain/handoff-code-type.enum';

const RIDER_REQUESTABLE_TYPES = [
  HandoffCodeType.RIDER_PICKUP,
  HandoffCodeType.RIDER_ARRIVAL,
];

export class RequestHandoffCodeDto {
  // RECEIVER_COLLECTION deliberately excluded — that code is
  // system-generated at READY_FOR_COLLECTION (Phase 4), never requestable
  // by a rider.
  @IsIn(RIDER_REQUESTABLE_TYPES, {
    message: `type must be one of: ${RIDER_REQUESTABLE_TYPES.join(', ')}`,
  })
  type!: HandoffCodeType.RIDER_PICKUP | HandoffCodeType.RIDER_ARRIVAL;
}
