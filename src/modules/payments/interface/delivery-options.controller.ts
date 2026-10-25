import { Controller, Get } from '@nestjs/common';
import { HANDLING_FLAGS } from '../../../common/parcel/parcel-details.dto';
import { ParcelSize } from '../../../common/parcel-size.enum';
import { VehicleSelectionService } from '../../logistics/application/vehicle-selection.service';

export interface DeliveryOptionsResponse {
  parcelSizes: string[];
  handlingFlags: string[];
  // Input bounds the API validates (anything a vehicle can't carry is a
  // separate 422 NO_DELIVERY_OPTION from the quote).
  limits: {
    weightKg: { min: number; max: number; decimals: number };
    dimensionCm: { min: number; max: number };
  };
  // What each available vehicle carries, smallest first — e.g. to tell the
  // sender "up to 20 kg goes by motorbike".
  vehicles: {
    vehicleClass: string;
    parcelSizes: string[];
    maxWeightKg: number;
    maxLongestSideCm: number;
  }[];
}

// Everything the checkout form needs to build its parcel inputs, so the
// frontend doesn't hard-code sizes, flags or vehicle limits (Admins can
// change the vehicle rules at any time). Any signed-in role.
@Controller('delivery-options')
export class DeliveryOptionsController {
  constructor(
    private readonly vehicleSelectionService: VehicleSelectionService,
  ) {}

  @Get()
  async options(): Promise<DeliveryOptionsResponse> {
    const rules = await this.vehicleSelectionService.enabledRules();
    return {
      parcelSizes: Object.values(ParcelSize),
      handlingFlags: [...HANDLING_FLAGS],
      limits: {
        weightKg: { min: 0.1, max: 1000, decimals: 1 },
        dimensionCm: { min: 1, max: 500 },
      },
      vehicles: rules.map((rule) => ({
        vehicleClass: rule.vehicleClass,
        parcelSizes: rule.parcelSizes,
        maxWeightKg: rule.maxWeightKg,
        maxLongestSideCm: rule.maxLongestSideCm,
      })),
    };
  }
}
