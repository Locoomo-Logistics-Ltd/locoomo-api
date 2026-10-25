import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.validation';
import { GeocoderUnavailableError } from '../domain/ports/geocoder.port';
import { GoogleGeocoder } from './google-geocoder';

describe('GoogleGeocoder', () => {
  const configService = {
    get: jest.fn(() => 'maps_test_key'),
  } as unknown as ConfigService<Env, true>;
  const geocoder = new GoogleGeocoder(configService);
  const query = {
    address: '45 Admiralty Way',
    city: 'Lekki',
    state: 'Lagos',
    country: 'Nigeria',
  };
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('restricts the lookup to Nigeria and returns the best match with its uncertainty', async () => {
    fetchSpy.mockResolvedValue(
      Response.json({
        status: 'OK',
        results: [
          {
            formatted_address: 'Admiralty Way, Lekki Phase 1, Lagos, Nigeria',
            geometry: {
              location: { lat: 6.4474, lng: 3.4723 },
              viewport: {
                northeast: { lat: 6.4484, lng: 3.4733 },
                southwest: { lat: 6.4464, lng: 3.4713 },
              },
            },
          },
        ],
      }),
    );

    const result = await geocoder.geocode(query);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('address')).toBe(
      '45 Admiralty Way, Lekki, Lagos',
    );
    expect(url.searchParams.get('components')).toBe('country:NG');
    expect(url.searchParams.get('key')).toBe('maps_test_key');
    expect(result).toMatchObject({
      latitude: 6.4474,
      longitude: 3.4723,
      formattedAddress: 'Admiralty Way, Lekki Phase 1, Lagos, Nigeria',
    });
    // Viewport diagonal is ~313 m, so half is ~157 m.
    expect(result!.uncertaintyMeters).toBeGreaterThan(140);
    expect(result!.uncertaintyMeters).toBeLessThan(170);
  });

  it('returns null when Google finds nothing', async () => {
    fetchSpy.mockResolvedValue(
      Response.json({ status: 'ZERO_RESULTS', results: [] }),
    );

    await expect(geocoder.geocode(query)).resolves.toBeNull();
  });

  it('throws GeocoderUnavailableError when the key is rejected', async () => {
    fetchSpy.mockResolvedValue(
      Response.json({
        status: 'REQUEST_DENIED',
        error_message: 'You must enable Billing',
        results: [],
      }),
    );

    const error = await geocoder.geocode(query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect((error as Error).message).toContain('REQUEST_DENIED');
  });

  it('throws GeocoderUnavailableError on a network failure', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    await expect(geocoder.geocode(query)).rejects.toBeInstanceOf(
      GeocoderUnavailableError,
    );
  });
});
