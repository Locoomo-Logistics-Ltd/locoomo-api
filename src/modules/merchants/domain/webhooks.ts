import { createHmac, randomBytes, randomInt } from 'crypto';
import { isIP } from 'net';

// Event types we send (MERCHANT_API.md §12.6). Public contract: add, never
// rename. manifest.*, claim.* and wallet.* arrive with their features.
export const WEBHOOK_EVENT_TYPES = [
  'shipment.created',
  'shipment.updated',
  'shipment.cancelled',
  'shipment.expired',
  'shipment.refused',
  'shipment.received',
  'shipment.fee_adjusted',
  'shipment.in_transit',
  'shipment.destination_changed',
  'shipment.ready_for_collection',
  'shipment.collection_reminder',
  'shipment.collected',
  'shipment.returning',
  'shipment.return_ready',
  'shipment.returned',
  'shipment.disposed',
  'shipment.exception',
  'merchant.status_changed',
] as const;
export type WebhookEventType =
  | (typeof WEBHOOK_EVENT_TYPES)[number]
  // Only ever sent by "Send test event" to one endpoint.
  | 'webhook.test';

export const MAX_ENDPOINTS_PER_MODE = 5;
export const MAX_IN_FLIGHT_PER_ENDPOINT = 4;
export const DELIVERY_TIMEOUT_MS = 10_000;
// An endpoint failing every delivery this long is disabled.
export const DISABLE_AFTER_FAILING_HOURS = 36;
export const SECRET_ROLL_OVERLAP_HOURS = 24;
export const WEBHOOK_RETENTION_DAYS = 30;

// Waits before each retry (§12.5): ~1.5 days in total, 10 attempts.
export const RETRY_DELAYS_SECONDS = [
  5, 60, 300, 1_800, 7_200, 18_000, 36_000, 36_000, 36_000,
] as const;

export function nextRetryDelaySeconds(failedAttempts: number): number | null {
  return RETRY_DELAYS_SECONDS[failedAttempts - 1] ?? null;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// The webhook-id header and the event's `id`.
export function newWebhookMessageId(): string {
  let id = '';
  for (let i = 0; i < 24; i++) {
    id += BASE62[randomInt(62)];
  }
  return `msg_${id}`;
}

// Standard Webhooks secret: "whsec_" + base64 of 32 random bytes.
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

// v1 signature: base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}")), keyed
// with the base64-decoded bytes after "whsec_" (§12.3).
export function signWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestampSeconds}.${body}`)
    .digest('base64');
  return `v1,${signature}`;
}

// ---- Where we're willing to send requests ----

function ipv4ToInt(ip: string): number {
  return (
    ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  );
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

// True only for addresses on the public internet. Webhooks must never
// reach our own network, cloud metadata or a merchant's LAN (SSRF).
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    return !PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) {
      return isPublicAddress(mapped[1]);
    }
    return !(
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') || // link-local fe80::/10
      lower.startsWith('fc') ||
      lower.startsWith('fd') || // unique local fc00::/7
      lower.startsWith('ff') || // multicast
      lower.startsWith('64:ff9b:') || // NAT64
      lower.startsWith('2001:db8') // documentation
    );
  }
  return false;
}

// Checked when an endpoint is saved. Hostnames are checked again at
// connection time against what they resolve to (webhook-transport.ts).
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be a valid URL';
  }
  if (url.protocol !== 'https:') {
    return 'url must use https';
  }
  if (url.username || url.password) {
    return 'url must not contain credentials';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return 'url must be a public address';
  }
  if (isIP(host) && !isPublicAddress(host)) {
    return 'url must be a public address';
  }
  return null;
}
