import { VehicleClass } from './delivery-leg';

export interface VehicleClassRule {
  vehicleClass: VehicleClass;
  rank: number;
  enabled: boolean;
  parcelSizes: string[];
  maxWeightKg: number;
  maxLongestSideCm: number;
}

export interface ParcelToCarry {
  parcelSize: string;
  weightKg?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
}

// The smallest enabled vehicle class the parcel fits: its size is one the
// class takes, and (when given) its weight and longest side are within the
// class's limits. null = nothing we run can carry it.
export function chooseVehicleClass(
  rules: readonly VehicleClassRule[],
  parcel: ParcelToCarry,
): VehicleClass | null {
  const longestSide = Math.max(
    parcel.lengthCm ?? 0,
    parcel.widthCm ?? 0,
    parcel.heightCm ?? 0,
  );
  const fitting = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.rank - b.rank)
    .find(
      (rule) =>
        rule.parcelSizes.includes(parcel.parcelSize) &&
        (parcel.weightKg == null || parcel.weightKg <= rule.maxWeightKg) &&
        longestSide <= rule.maxLongestSideCm,
    );
  return fitting?.vehicleClass ?? null;
}
