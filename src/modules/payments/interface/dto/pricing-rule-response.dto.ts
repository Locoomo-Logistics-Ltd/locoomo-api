import { koboToNaira } from '../../domain/money';
import { PricingRuleEntity } from '../../infrastructure/entities/pricing-rule.entity';

export class PricingRuleResponseDto {
  id!: string;
  // Naira for human readability (what the Admin typed); kobo alongside it
  // since that's the value actually stored and what feeds PaymentIntent
  // calculations — both shown so nothing about the conversion is hidden.
  baseFeeNaira!: number;
  baseFeeKobo!: number;
  perKmRateNaira!: number;
  perKmRateKobo!: number;
  destinationFeeNaira!: number;
  destinationFeeKobo!: number;
  roadDistanceFactor!: number;
  // Explicit per-vehicle overrides only; others use the default multipliers.
  vehicleRates!: Record<
    string,
    {
      baseFeeNaira: number;
      baseFeeKobo: number;
      perKmRateNaira: number;
      perKmRateKobo: number;
    }
  >;
  effectiveFrom!: Date;
  createdByAdminId!: string;

  static fromEntity(rule: PricingRuleEntity): PricingRuleResponseDto {
    const dto = new PricingRuleResponseDto();
    dto.id = rule.id;
    dto.baseFeeNaira = koboToNaira(rule.baseFeeKobo);
    dto.baseFeeKobo = rule.baseFeeKobo;
    dto.perKmRateNaira = koboToNaira(rule.perKmRateKobo);
    dto.perKmRateKobo = rule.perKmRateKobo;
    dto.destinationFeeNaira = koboToNaira(rule.destinationFeeKobo);
    dto.destinationFeeKobo = rule.destinationFeeKobo;
    dto.roadDistanceFactor = rule.roadDistanceFactor;
    dto.vehicleRates = Object.fromEntries(
      Object.entries(rule.vehicleRates ?? {}).map(([vehicleClass, rate]) => [
        vehicleClass,
        {
          baseFeeNaira: koboToNaira(rate!.baseFeeKobo),
          baseFeeKobo: rate!.baseFeeKobo,
          perKmRateNaira: koboToNaira(rate!.perKmRateKobo),
          perKmRateKobo: rate!.perKmRateKobo,
        },
      ]),
    );
    dto.effectiveFrom = rule.effectiveFrom;
    dto.createdByAdminId = rule.createdByAdminId;
    return dto;
  }
}
