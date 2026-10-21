import { BusinessException } from '../../../../common/exceptions';

// The Node's map pin is far from where its address geocodes to — almost
// always a pin dropped in the wrong place, or coordinates typed by hand.
// Couriers navigate by the pin, so a wrong one means failed pickups.
export class NodeLocationMismatchException extends BusinessException {
  readonly errorCode = 'NODE_LOCATION_MISMATCH';
  readonly httpStatus = 400;

  constructor(
    distanceMeters: number,
    geocodedAddress: string,
    suggested: { latitude: number; longitude: number },
  ) {
    super(
      `The map pin is ${(distanceMeters / 1000).toFixed(1)} km from "${geocodedAddress}". ` +
        "Move the pin to the Node's real location, or correct the address.",
      {
        distanceMeters: Math.round(distanceMeters),
        geocodedAddress,
        suggested,
      },
    );
  }
}
