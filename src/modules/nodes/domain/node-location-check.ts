// Outcome of checking a Node's map pin against its address, stored on the
// Node so Admins can find ones nobody could confirm.
export enum NodeLocationCheck {
  // The pin is consistent with the geocoded address.
  VERIFIED = 'verified',
  // Couldn't be checked — geocoder not configured, unavailable, or it found
  // nothing for the address. Accepted, but worth an Admin look.
  UNVERIFIED = 'unverified',
  // An Admin deliberately kept a pin the geocoder disagreed with (new
  // estates and informal addresses Google doesn't know yet).
  ADMIN_OVERRIDE = 'admin_override',
}

// Minimum allowed gap between pin and geocoded address. Anything closer is
// fine even for a precise street match — Nigerian addressing and Google's
// coverage are too rough to demand more.
export const LOCATION_TOLERANCE_METERS = 2_000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

// Great-circle distance in metres (haversine).
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(toRad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(toRad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// The pin matches when it's within the tolerance or within the geocoded
// area's own uncertainty, whichever is larger — so an address Google could
// only place at neighbourhood level isn't held to street-level precision,
// while a pin in the wrong city still fails.
export function pinMatchesAddress(
  pin: Coordinates,
  geocoded: Coordinates & { uncertaintyMeters: number },
): { matches: boolean; distanceMeters: number; allowedMeters: number } {
  const distance = distanceMeters(pin, geocoded);
  const allowed = Math.max(
    LOCATION_TOLERANCE_METERS,
    geocoded.uncertaintyMeters,
  );
  return {
    matches: distance <= allowed,
    distanceMeters: distance,
    allowedMeters: allowed,
  };
}
