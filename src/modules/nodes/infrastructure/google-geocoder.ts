import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchWithPolicy } from '../../../common/http/fetch-with-policy';
import { Env } from '../../../config/env.validation';
import { distanceMeters } from '../domain/node-location-check';
import {
  GeocodeResult,
  Geocoder,
  GeocoderUnavailableError,
} from '../domain/ports/geocoder.port';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

interface GoogleLatLng {
  lat: number;
  lng: number;
}

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results: {
    formatted_address: string;
    geometry: {
      location: GoogleLatLng;
      viewport: { northeast: GoogleLatLng; southwest: GoogleLatLng };
    };
  }[];
}

// Google Geocoding API (address → coordinates). Plain fetch, no SDK, same
// pattern as the Paystack adapters.
@Injectable()
export class GoogleGeocoder implements Geocoder {
  private readonly logger = new Logger(GoogleGeocoder.name);

  constructor(private readonly configService: ConfigService<Env, true>) {}

  async geocode(query: {
    address: string;
    city: string;
    state: string;
    country: string;
  }): Promise<GeocodeResult | null> {
    const isNigeria = query.country.trim().toLowerCase() === 'nigeria';
    const params = new URLSearchParams({
      address: [query.address, query.city, query.state]
        .concat(isNigeria ? [] : [query.country])
        .join(', '),
      // Bias and restrict to Nigeria so "Ikeja" can't resolve abroad.
      region: 'ng',
      key: this.configService.get('GOOGLE_MAPS_API_KEY', { infer: true }) ?? '',
    });
    if (isNigeria) {
      params.set('components', 'country:NG');
    }

    let body: GoogleGeocodeResponse;
    try {
      // A read — safe to retry once. Short timeout: this runs while an
      // operator waits on the onboarding form.
      const response = await fetchWithPolicy(
        `${GEOCODE_URL}?${params.toString()}`,
        {},
        { timeoutMs: 5_000, retries: 1 },
      );
      body = (await response.json()) as GoogleGeocodeResponse;
    } catch (error) {
      throw new GeocoderUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }

    if (body.status === 'ZERO_RESULTS') {
      return null;
    }
    if (body.status !== 'OK' || body.results.length === 0) {
      // REQUEST_DENIED / OVER_DAILY_LIMIT mean the key or billing is
      // misconfigured — every check is silently degrading to "unverified"
      // until someone fixes it, so make it loud.
      const reason = `${body.status}${body.error_message ? `: ${body.error_message}` : ''}`;
      if (
        body.status === 'REQUEST_DENIED' ||
        body.status === 'OVER_DAILY_LIMIT'
      ) {
        this.logger.error(`Google geocoding misconfigured — ${reason}`);
      }
      throw new GeocoderUnavailableError(reason);
    }

    const [best] = body.results;
    const { location, viewport } = best.geometry;
    const toCoordinates = (point: GoogleLatLng) => ({
      latitude: point.lat,
      longitude: point.lng,
    });
    return {
      ...toCoordinates(location),
      uncertaintyMeters:
        distanceMeters(
          toCoordinates(viewport.northeast),
          toCoordinates(viewport.southwest),
        ) / 2,
      formattedAddress: best.formatted_address,
    };
  }
}
