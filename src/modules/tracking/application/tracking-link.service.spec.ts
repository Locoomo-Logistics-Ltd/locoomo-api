import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.validation';
import { TrackingLinkService } from './tracking-link.service';

describe('TrackingLinkService', () => {
  const config = (secret: string) =>
    ({
      get: jest.fn((key: string) =>
        key === 'TRACKING_LINK_SECRET' ? secret : 'https://app.locoomo.test/',
      ),
    }) as unknown as ConfigService<Env, true>;
  const service = new TrackingLinkService(config('a'.repeat(64)));

  it('builds a frontend link carrying a verifiable token', () => {
    const url = new URL(service.urlFor('LCM-4F2K-9XPT'));
    expect(url.origin + url.pathname).toBe(
      'https://app.locoomo.test/track/LCM-4F2K-9XPT',
    );
    const token = url.searchParams.get('t')!;
    expect(token).toHaveLength(22);
    expect(service.isValidToken('LCM-4F2K-9XPT', token)).toBe(true);
  });

  it("rejects another parcel's token, a tampered token, and a different secret's token", () => {
    const token = service.tokenFor('LCM-4F2K-9XPT');
    expect(service.isValidToken('LCM-4F2K-9XPV', token)).toBe(false);
    expect(
      service.isValidToken('LCM-4F2K-9XPT', token.slice(0, -1) + 'x'),
    ).toBe(false);
    expect(service.isValidToken('LCM-4F2K-9XPT', 'short')).toBe(false);
    const rotated = new TrackingLinkService(config('b'.repeat(64)));
    expect(rotated.isValidToken('LCM-4F2K-9XPT', token)).toBe(false);
  });
});
