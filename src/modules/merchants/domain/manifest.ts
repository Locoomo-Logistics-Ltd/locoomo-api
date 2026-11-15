// Manifests: a merchant's declaration of the shipments it will drop at a
// hub together (plan §7.1; MERCHANT_API.md §10).

import { newShortReference, normaliseShortReference } from './short-reference';

// open: shipments can be added. closed: the truck has left; the hub
// expects it. received: the hub finished checking it in. cancelled.
export type ManifestStatus = 'open' | 'closed' | 'received' | 'cancelled';

export const MAX_MANIFEST_SHIPMENTS = 10_000;
export const MAX_MANIFEST_ADD = 1_000;

export type ManifestProblem =
  'not_found' | 'not_awaiting_drop_off' | 'in_another_manifest';

export function newManifestReference(): string {
  return newShortReference('MF');
}

export function normaliseManifestReference(input: string): string | null {
  return normaliseShortReference('MF', input);
}
