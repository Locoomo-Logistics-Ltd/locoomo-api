import { IsIn, IsString, Length } from 'class-validator';
import { HandoffCodeType } from '../../domain/handoff-code-type.enum';

const RIDER_HANDOFF_TYPES = [
  HandoffCodeType.RIDER_PICKUP,
  HandoffCodeType.RIDER_ARRIVAL,
];

export class ConfirmHandoffDto {
  @IsIn(RIDER_HANDOFF_TYPES, {
    message: `type must be one of: ${RIDER_HANDOFF_TYPES.join(', ')}`,
  })
  type!: HandoffCodeType.RIDER_PICKUP | HandoffCodeType.RIDER_ARRIVAL;

  @IsString()
  @Length(6, 6)
  code!: string;
}
