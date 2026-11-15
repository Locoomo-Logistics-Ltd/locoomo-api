// Merchant return batches (plan §6.3; MERCHANT_API.md §11.3): one code
// hands back every return in the batch at its Node.

import { randomInt } from 'crypto';

export type ReturnBatchStatus = 'open' | 'collected' | 'cancelled';

export const MAX_RETURN_BATCH_SIZE = 200;
// Same lifetime and lockout as a single parcel's merchant return code.
export const RETURN_BATCH_CODE_WORKING_DAYS = 10;
export const MAX_RETURN_BATCH_CODE_ATTEMPTS = 5;

// What a shipment can't go into a batch for.
export type ReturnBatchProblem =
  'not_found' | 'not_ready' | 'other_node' | 'in_batch';

// Crockford base32 without I, L, O, U: read off a screen, typed at a Node.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// RB-7KQ2-M9XD
export function newReturnBatchReference(): string {
  const part = (): string =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      '',
    );
  return `RB-${part()}-${part()}`;
}

// 6 digits, like every other handoff code.
export function newReturnBatchCode(): string {
  return randomInt(1_000_000).toString().padStart(6, '0');
}

// Accepts "rb-7kq2-m9xd", "RB 7KQ2 M9XD", "RB7KQ2M9XD".
export function normaliseReturnBatchReference(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  const match = /^RB([0-9A-Z]{4})([0-9A-Z]{4})$/.exec(compact);
  return match ? `RB-${match[1]}-${match[2]}` : null;
}
