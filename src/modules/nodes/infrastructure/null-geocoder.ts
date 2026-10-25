import {
  Geocoder,
  GeocoderUnavailableError,
} from '../domain/ports/geocoder.port';

// Bound when no GOOGLE_MAPS_API_KEY is set, and always under NODE_ENV=test
// (e2e suites must never call Google — the one that tests this flow swaps in
// a fake). Every check then resolves to "unverified", so Node creation keeps
// working without a geocoder, just unconfirmed.
export class NullGeocoder implements Geocoder {
  geocode(): Promise<null> {
    return Promise.reject(new GeocoderUnavailableError('not configured'));
  }
}
