// Merchant return batches (plan §6.3; MERCHANT_API.md §11.3): one code
// hands back every return in the batch at its Node.

import { randomInt } from 'crypto';
import { newShortReference, normaliseShortReference } from './short-reference';

export type ReturnBatchStatus = 'open' | 'collected' | 'cancelled';

export const MAX_RETURN_BATCH_SIZE = 200;
// Same lifetime and lockout as a single parcel's merchant return code.
export const RETURN_BATCH_CODE_WORKING_DAYS = 10;
export const MAX_RETURN_BATCH_CODE_ATTEMPTS = 5;

// What a shipment can't go into a batch for.
export type ReturnBatchProblem =
  'not_found' | 'not_ready' | 'other_node' | 'in_batch';

// RB-7KQ2-M9XD
export function newReturnBatchReference(): string {
  return newShortReference('RB');
}

// 6 digits, like every other handoff code.
export function newReturnBatchCode(): string {
  return randomInt(1_000_000).toString().padStart(6, '0');
}

export function normaliseReturnBatchReference(input: string): string | null {
  return normaliseShortReference('RB', input);
}
