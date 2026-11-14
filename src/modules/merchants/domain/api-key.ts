import { createHash, randomBytes } from 'crypto';
import type { ApiKeyKind, ApiKeyMode } from '../../../common/auth/principal';

export type { ApiKeyKind, ApiKeyMode };

// Secret-key scopes (MERCHANT_API.md §4). The values are the public
// contract: add new ones, never rename.
export enum ApiKeyScope {
  SHIPMENTS_READ = 'shipments:read',
  SHIPMENTS_WRITE = 'shipments:write',
  MANIFESTS_WRITE = 'manifests:write',
  WEBHOOKS_MANAGE = 'webhooks:manage',
  WALLET_READ = 'wallet:read',
  CLAIMS_WRITE = 'claims:write',
  // Not selectable: every key (secret or publishable) has these.
  NODES_READ = 'nodes:read',
  QUOTES_READ = 'quotes:read',
}

export const SELECTABLE_SECRET_SCOPES: readonly ApiKeyScope[] = [
  ApiKeyScope.SHIPMENTS_READ,
  ApiKeyScope.SHIPMENTS_WRITE,
  ApiKeyScope.MANIFESTS_WRITE,
  ApiKeyScope.WEBHOOKS_MANAGE,
  ApiKeyScope.WALLET_READ,
  ApiKeyScope.CLAIMS_WRITE,
];

// New secret keys get everything except webhook management: a leaked
// server key then can't silently redirect your event stream.
export const DEFAULT_SECRET_SCOPES: readonly ApiKeyScope[] =
  SELECTABLE_SECRET_SCOPES.filter((s) => s !== ApiKeyScope.WEBHOOKS_MANAGE);

const ALWAYS: readonly ApiKeyScope[] = [
  ApiKeyScope.NODES_READ,
  ApiKeyScope.QUOTES_READ,
];

// What the key may actually do: stored scopes plus the read-only checkout
// scopes every key has. Publishable keys are fixed to those.
export function effectiveScopes(
  kind: ApiKeyKind,
  stored: readonly string[],
): string[] {
  return kind === 'publishable'
    ? [...ALWAYS]
    : [...new Set([...stored, ...ALWAYS])];
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// 43 base62 chars ≈ 256 bits.
const SECRET_LENGTH = 43;

export function keyPrefix(kind: ApiKeyKind, mode: ApiKeyMode): string {
  return `${kind === 'secret' ? 'sk' : 'pk'}_${mode}_`;
}

export function generateApiKey(kind: ApiKeyKind, mode: ApiKeyMode): string {
  // Rejection sampling: no modulo bias.
  let body = '';
  while (body.length < SECRET_LENGTH) {
    for (const byte of randomBytes(64)) {
      if (byte < 248 && body.length < SECRET_LENGTH) {
        body += BASE62[byte % 62];
      }
    }
  }
  return `${keyPrefix(kind, mode)}${body}`;
}

// Keys are high-entropy random values: a fast hash is the right tool (a
// slow KDF adds latency to every API call and no security).
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export const MAX_ACTIVE_KEYS_PER_MODE = 20;

// Roll: how long the old key keeps working next to the new one.
export const ROLL_OVERLAP_SECONDS = {
  now: 0,
  '1h': 3_600,
  '24h': 86_400,
  '7d': 604_800,
} as const;
export type RollOverlap = keyof typeof ROLL_OVERLAP_SECONDS;
