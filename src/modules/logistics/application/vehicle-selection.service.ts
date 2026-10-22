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
    const rules = await this.dataSource.query<VehicleClassRule[]>(
      `SELECT "vehicleClass", rank, enabled, "parcelSizes", "maxWeightKg",
              "maxLongestSideCm"
         FROM vehicle_class_rules`,
    );
    return chooseVehicleClass(
      rules.map((rule) => ({ ...rule, maxWeightKg: Number(rule.maxWeightKg) })),
      parcel,
    );
  }
}
