import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { VehicleClass } from '../domain/delivery-leg';
import {
  chooseVehicleClass,
  ParcelToCarry,
  VehicleClassRule,
} from '../domain/vehicle-selection';

// Which vehicle a parcel needs, from the configurable vehicle_class_rules
// table (seeded with placeholder limits until couriers confirm theirs).
@Injectable()
export class VehicleSelectionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async vehicleFor(parcel: ParcelToCarry): Promise<VehicleClass | null> {
    return chooseVehicleClass(await this.rules(), parcel);
  }

  // The enabled classes, smallest first — what checkout can offer.
  async enabledRules(): Promise<VehicleClassRule[]> {
    return (await this.rules())
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.rank - b.rank);
  }

  private async rules(): Promise<VehicleClassRule[]> {
    const rows = await this.dataSource.query<VehicleClassRule[]>(
      `SELECT "vehicleClass", rank, enabled, "parcelSizes", "maxWeightKg",
              "maxLongestSideCm"
         FROM vehicle_class_rules`,
    );
    return rows.map((rule) => ({
      ...rule,
      maxWeightKg: Number(rule.maxWeightKg),
    }));
  }
}
