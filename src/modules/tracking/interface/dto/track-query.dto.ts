import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Exactly one of the two must be sent (checked in PublicTrackingService).
export class TrackQueryDto {
  // Token from the tracking link in an email.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  t?: string;

  // Last four digits of the receiver's phone — for someone who only has
  // the tracking code (e.g. off the handwritten label).
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'phoneLast4 must be exactly 4 digits' })
  phoneLast4?: string;
}
