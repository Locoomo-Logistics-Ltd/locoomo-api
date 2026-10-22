// The `parcel` object on order and payment-intent responses. Accepts rows
// from raw SQL too, where numeric weightKg arrives as a string.
export interface ParcelView {
  parcelSize: string;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  handling: string[];
  vehicleClass: string | null;
}

export function toParcelView(row: {
  parcelSize: string;
  weightKg?: number | string | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  handling?: string[] | null;
  vehicleClass?: string | null;
}): ParcelView {
  return {
    parcelSize: row.parcelSize,
    weightKg:
      row.weightKg === null || row.weightKg === undefined
        ? null
        : Number(row.weightKg),
    lengthCm: row.lengthCm ?? null,
    widthCm: row.widthCm ?? null,
    heightCm: row.heightCm ?? null,
    handling: row.handling ?? [],
    vehicleClass: row.vehicleClass ?? null,
  };
}
