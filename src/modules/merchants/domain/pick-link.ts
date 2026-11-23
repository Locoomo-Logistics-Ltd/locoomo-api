import { randomBytes } from 'crypto';

// Pick links (plan §2.3, §12.3): the seller shares a link, the buyer picks
// the Node; the shipment is created then. Single use.
export const PICK_LINK_DAYS = 7;

// What the merchant sees. `expired` is an open link past its date.
export type PickLinkStatus = 'open' | 'used' | 'cancelled' | 'expired';

// 32 url-safe characters: unguessable, short enough for WhatsApp.
export function newPickToken(): string {
  return randomBytes(24).toString('base64url');
}

export function pickLinkStatus(
  stored: 'open' | 'used' | 'cancelled',
  expiresAt: Date,
  now = new Date(),
): PickLinkStatus {
  return stored === 'open' && expiresAt <= now ? 'expired' : stored;
}

// "Chioma Okafor" → "Chioma": the public page shows no more than that.
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? '';
}
