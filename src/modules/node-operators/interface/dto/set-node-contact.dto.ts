import { IsOptional } from 'class-validator';
import { IsOpeningHours } from '../../../../common/opening-hours/opening-hours';
import type { OpeningHours } from '../../../../common/opening-hours/opening-hours';
import {
  IsPhoneE164,
  NormalizePhone,
} from '../../../../common/phone/phone-number';

// Either or both — an omitted field is left unchanged.
export class SetNodeContactDto {
  @IsOptional()
  @NormalizePhone()
  @IsPhoneE164()
  contactPhone?: string;

  @IsOptional()
  @IsOpeningHours()
  openingHours?: OpeningHours;
}
