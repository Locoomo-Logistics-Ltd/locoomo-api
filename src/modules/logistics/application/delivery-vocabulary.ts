// Cross-module entry point for the courier-neutral delivery vocabulary
// (event and status names) — callers outside logistics need the values,
// but the module boundary rule keeps them out of logistics' domain/.
export {
  DeliveryEventType,
  DeliveryLegStatus,
  DeliveryLegType,
  VehicleClass,
} from '../domain/delivery-leg';
