// Turns a typed address into coordinates, so a Node's map pin can be checked
// against what its address says. Adapters return this normalised shape,
// never a provider's raw response (same rule as PaymentProvider).
export interface GeocodeResult {
  latitude: number;
  longitude: number;
  // How fuzzy the result is: half the diagonal of the area the provider
  // says the address covers. A street address is tens of metres; a match
  // that only resolved to a neighbourhood or city is kilometres.
  uncertaintyMeters: number;
  formattedAddress: string;
}

export interface Geocoder {
  // null = the provider answered but found nothing for this address
  // (common for informal Nigerian addresses) — not an error.
  // Throws GeocoderUnavailableError when the provider couldn't answer.
  geocode(query: {
    address: string;
    city: string;
    state: string;
    country: string;
  }): Promise<GeocodeResult | null>;
}

export class GeocoderUnavailableError extends Error {
  constructor(reason: string) {
    super(`Geocoder unavailable: ${reason}`);
    this.name = 'GeocoderUnavailableError';
  }
}
