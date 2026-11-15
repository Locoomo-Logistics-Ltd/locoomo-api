import { randomInt } from 'crypto';

// Bags (plan §7.2, D17): a hub sorts merchant parcels into one bag per
// destination Node; a sealed bag travels as one courier leg.
//
// open → sealed (no more parcels; courier booked) → in_transit (picked up)
// → arrived (handed over at the destination) → unpacked (every parcel
// scanned in). cancelled: sealed empty.
export enum BagStatus {
  OPEN = 'open',
  SEALED = 'sealed',
  IN_TRANSIT = 'in_transit',
  ARRIVED = 'arrived',
  UNPACKED = 'unpacked',
  CANCELLED = 'cancelled',
}

// A bag seals itself at this many parcels; the next one opens a new bag.
export const BAG_MAX_PARCELS = 50;

// Parcels not scanned in this long after their bag arrived are flagged.
export const MISSING_FROM_BAG_AFTER_HOURS = 24;

// Crockford base32 without I, L, O, U: read off a tag, typed at a counter.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// BAG-7KQ2-M9XD: written on the bag's tag.
export function newBagCode(): string {
  const part = (): string =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      '',
    );
  return `BAG-${part()}-${part()}`;
}

// Accepts any case, spaces or no dashes.
export function normaliseBagCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  const match = /^BAG([0-9A-Z]{4})([0-9A-Z]{4})$/.exec(compact);
  return match ? `BAG-${match[1]}-${match[2]}` : null;
}
