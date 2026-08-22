import { IsNumber, Min } from 'class-validator';

// Naira, not kobo — kobo is an internal representation (Paystack's minorunit)
export class CreatePricingRuleDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseFeeNaira!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  perKmRateNaira!: number;

  // Flat, paid entirely to the destination Node on completion — required
  // (not defaulted) so a new rule can't silently zero out destination Nodes'
  // earnings by omission.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  destinationFeeNaira!: number;
}
