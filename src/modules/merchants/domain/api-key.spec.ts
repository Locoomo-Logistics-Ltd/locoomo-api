import { API_KEY_PATTERN } from '../../../common/auth/principal';
import {
  ApiKeyScope,
  DEFAULT_SECRET_SCOPES,
  effectiveScopes,
  generateApiKey,
  hashApiKey,
} from './api-key';

describe('API keys', () => {
  it('generates prefixed base62 keys the auth guard recognises', () => {
    const seen = new Set<string>();
    for (const [kind, mode, prefix] of [
      ['secret', 'live', 'sk_live_'],
      ['secret', 'test', 'sk_test_'],
      ['publishable', 'live', 'pk_live_'],
      ['publishable', 'test', 'pk_test_'],
    ] as const) {
      const key = generateApiKey(kind, mode);
      expect(key.startsWith(prefix)).toBe(true);
      expect(key).toHaveLength(prefix.length + 43);
      expect(API_KEY_PATTERN.test(key)).toBe(true);
      seen.add(key);
    }
    expect(seen.size).toBe(4);
  });

  it('hashes deterministically', () => {
    expect(hashApiKey('sk_test_abc')).toBe(hashApiKey('sk_test_abc'));
    expect(hashApiKey('sk_test_abc')).not.toBe(hashApiKey('sk_test_abd'));
  });

  it('leaves webhook management out of the default scopes', () => {
    expect(DEFAULT_SECRET_SCOPES).not.toContain(ApiKeyScope.WEBHOOKS_MANAGE);
    expect(DEFAULT_SECRET_SCOPES).toContain(ApiKeyScope.SHIPMENTS_WRITE);
  });

  it('gives every key the checkout read scopes, and publishable keys only those', () => {
    expect(effectiveScopes('secret', ['shipments:read'])).toEqual([
      'shipments:read',
      'nodes:read',
      'quotes:read',
    ]);
    expect(effectiveScopes('publishable', ['shipments:write'])).toEqual([
      'nodes:read',
      'quotes:read',
    ]);
  });
});
