import { VehicleClass } from './delivery-leg';
import { chooseVehicleClass, VehicleClassRule } from './vehicle-selection';

// The seeded placeholder rules.
const rules: VehicleClassRule[] = [
  {
    vehicleClass: VehicleClass.BICYCLE,
    rank: 1,
    enabled: false,
    parcelSizes: ['small'],
    maxWeightKg: 5,
    maxLongestSideCm: 40,
  },
  {
    vehicleClass: VehicleClass.MOTORBIKE,
    rank: 2,
    enabled: true,
    parcelSizes: ['small', 'medium'],
    maxWeightKg: 20,
    maxLongestSideCm: 60,
  },
  {
    vehicleClass: VehicleClass.CAR,
    rank: 3,
    enabled: true,
    parcelSizes: ['small', 'medium', 'large', 'extra_large'],
    maxWeightKg: 50,
    maxLongestSideCm: 120,
  },
  {
    vehicleClass: VehicleClass.VAN,
    rank: 4,
    enabled: false,
    parcelSizes: ['small', 'medium', 'large', 'extra_large'],
    maxWeightKg: 500,
    maxLongestSideCm: 250,
  },
];

describe('chooseVehicleClass', () => {
  it('puts small and medium parcels on a motorbike', () => {
    expect(chooseVehicleClass(rules, { parcelSize: 'small' })).toBe(
      'motorbike',
    );
    expect(
      chooseVehicleClass(rules, { parcelSize: 'medium', weightKg: 12 }),
    ).toBe('motorbike');
  });

  it('moves up to a car for large parcels, heavy ones, or long ones', () => {
    expect(chooseVehicleClass(rules, { parcelSize: 'large' })).toBe('car');
    expect(
      chooseVehicleClass(rules, { parcelSize: 'small', weightKg: 25 }),
    ).toBe('car');
    expect(
      chooseVehicleClass(rules, {
        parcelSize: 'medium',
        lengthCm: 90,
        widthCm: 30,
        heightCm: 20,
      }),
    ).toBe('car');
  });

  it('skips disabled classes', () => {
    expect(
      chooseVehicleClass(rules, { parcelSize: 'small', weightKg: 2 }),
    ).toBe(
      'motorbike', // bicycle is disabled
    );
  });

  it('returns null when nothing enabled can carry it', () => {
    expect(
      chooseVehicleClass(rules, { parcelSize: 'large', weightKg: 80 }),
    ).toBeNull();
    expect(
      chooseVehicleClass(rules, {
        parcelSize: 'extra_large',
        lengthCm: 200,
        widthCm: 50,
        heightCm: 50,
      }),
    ).toBeNull();
  });
});
