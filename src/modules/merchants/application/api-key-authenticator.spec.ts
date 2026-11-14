import { isPublishableKeyPath, trustProxyHops } from '../../../bootstrap';
import { ipAllowed } from './api-key-authenticator.service';
import { windowsFor } from './api-rate-limiter';

describe('API key checks', () => {
  it('matches IPs against addresses and CIDR ranges (v4 and v6)', () => {
    expect(ipAllowed('203.0.113.9', [])).toBe(true);
    expect(ipAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.114.9', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('198.51.100.7', ['198.51.100.7'])).toBe(true);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('', ['0.0.0.0/0'])).toBe(false);
  });

  it('uses the contract’s rate limits per key type', () => {
    expect(windowsFor('secret', 'live').map((w) => w.limit)).toEqual([
      3_000, 50,
    ]);
    expect(windowsFor('secret', 'test').map((w) => w.limit)).toEqual([25]);
    expect(windowsFor('publishable', 'live').map((w) => w.limit)).toEqual([30]);
  });

  it('opens CORS only on the publishable-key endpoints', () => {
    expect(isPublishableKeyPath('/api/v1/merchant/nodes')).toBe(true);
    expect(isPublishableKeyPath('/api/v1/merchant/nodes/abc')).toBe(true);
    expect(isPublishableKeyPath('/api/v1/merchant/quotes?x=1')).toBe(true);
    expect(isPublishableKeyPath('/api/v1/merchant/nodesx')).toBe(false);
    expect(isPublishableKeyPath('/api/v1/merchant/shipments')).toBe(false);
    expect(isPublishableKeyPath('/api/v1/merchant/api-keys')).toBe(false);
  });
});

describe('trust proxy hops', () => {
  const config = (hops?: number) =>
    ({ get: () => hops }) as unknown as Parameters<typeof trustProxyHops>[0];

  it('trusts Railway’s one proxy hop when running there, and nothing locally', () => {
    expect(trustProxyHops(config(), { RAILWAY_PROJECT_ID: 'p' })).toBe(1);
    expect(trustProxyHops(config(), { RAILWAY_ENVIRONMENT_ID: 'e' })).toBe(1);
    expect(trustProxyHops(config(), {})).toBe(0);
    expect(trustProxyHops(config(2), { RAILWAY_PROJECT_ID: 'p' })).toBe(2);
    expect(trustProxyHops(config(0), { RAILWAY_PROJECT_ID: 'p' })).toBe(0);
  });
});
