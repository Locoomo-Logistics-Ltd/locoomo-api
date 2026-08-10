import { IsNumber, Min } from 'class-validator';

// Naira, not kobo — kobo is an internal representation (Paystack's minorunit)
export class CreatePricingRuleDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseFeeNaira!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  perKmRateNaira!: number;
}
