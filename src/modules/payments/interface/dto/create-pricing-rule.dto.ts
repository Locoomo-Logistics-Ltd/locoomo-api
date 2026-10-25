import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  Max,
  Min,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

const PRICED_VEHICLE_CLASSES = ['bicycle', 'car', 'van', 'truck'];

export interface VehicleRateInput {
  baseFeeNaira: number;
  perKmRateNaira: number;
}

function isMoney(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    Math.round(value * 100) === value * 100
  );
}

// { car: { baseFeeNaira, perKmRateNaira }, … } — only non-motorbike
// classes (the motorbike rate is the rule's own baseFee/perKmRate).
function IsVehicleRates(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsVehicleRates',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must map ${PRICED_VEHICLE_CLASSES.join('/')} to { baseFeeNaira, perKmRateNaira } amounts`,
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
          ) {
            return false;
          }
          return Object.entries(value).every(([vehicleClass, rate]) => {
            if (!PRICED_VEHICLE_CLASSES.includes(vehicleClass)) {
              return false;
            }
            const { baseFeeNaira, perKmRateNaira, ...rest } = (rate ??
              {}) as Record<string, unknown>;
            return (
              Object.keys(rest).length === 0 &&
              isMoney(baseFeeNaira) &&
              isMoney(perKmRateNaira)
            );
          });
        },
      },
    });
  };
}

export class CreatePricingRuleDto {
  // The motorbike rate. Recommended placeholder: ₦1,100 + ₦320 per road-km.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseFeeNaira!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  perKmRateNaira!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  destinationFeeNaira!: number;

  // Road km ≈ straight-line km × this until a courier has measured the
  // route. Default 1.4.
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(3)
  roadDistanceFactor?: number;

  // Optional explicit rates for other vehicles; unlisted classes use the
  // default multipliers on the motorbike rate (car 2.4×, bicycle 0.7×, …).
  @IsOptional()
  @IsVehicleRates()
  vehicleRates?: Record<string, VehicleRateInput>;
}
