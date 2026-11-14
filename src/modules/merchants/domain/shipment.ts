import { randomInt } from 'crypto';

// Merchant-facing shipment statuses (MERCHANT_API.md §8). Values are the
// public contract: add, never rename.
export enum ShipmentStatus {
  CREATED = 'created',
  RECEIVED = 'received',
  IN_TRANSIT = 'in_transit',
  READY_FOR_COLLECTION = 'ready_for_collection',
  COLLECTED = 'collected',
  RETURNING = 'returning',
  RETURN_READY = 'return_ready',
  RETURNED = 'returned',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  REFUSED = 'refused',
  EXCEPTION = 'exception',
  DISPOSED = 'disposed',
}

const S = ShipmentStatus;

export type NotifyReceiver = 'locoomo' | 'merchant' | 'both';
export const NOTIFY_RECEIVER_VALUES: readonly NotifyReceiver[] = [
  'locoomo',
  'merchant',
  'both',
];

export type FeeState = 'held' | 'charged' | 'released';
export type ReturnReason =
  'not_collected' | 'delivery_failed' | 'merchant_request';
export type ExceptionType = 'lost' | 'damaged';

// Event types recorded on a shipment's history (and, from M2d, sent as
// `shipment.<type>` webhooks). Status events share the status's name.
export type ShipmentEventType =
  | `${ShipmentStatus}`
  | 'updated'
  | 'fee_adjusted'
  | 'destination_changed'
  | 'collection_reminder';

const TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> =
  {
    [S.CREATED]: [S.RECEIVED, S.CANCELLED, S.EXPIRED, S.REFUSED],
    [S.RECEIVED]: [S.IN_TRANSIT, S.RETURNING, S.EXCEPTION],
    [S.IN_TRANSIT]: [S.READY_FOR_COLLECTION, S.RETURNING, S.EXCEPTION],
    [S.READY_FOR_COLLECTION]: [S.COLLECTED, S.RETURNING, S.EXCEPTION],
    [S.RETURNING]: [S.RETURN_READY, S.EXCEPTION],
    [S.RETURN_READY]: [S.RETURNED, S.DISPOSED, S.EXCEPTION],
    [S.COLLECTED]: [],
    [S.RETURNED]: [],
    [S.CANCELLED]: [],
    [S.EXPIRED]: [],
    [S.REFUSED]: [],
    [S.EXCEPTION]: [],
    [S.DISPOSED]: [],
  };

export function canTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(status: ShipmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

// The normal order of things. The simulator walks it to reach a target,
// firing every intermediate step like live would.
const FORWARD: readonly ShipmentStatus[] = [
  S.CREATED,
  S.RECEIVED,
  S.IN_TRANSIT,
  S.READY_FOR_COLLECTION,
  S.COLLECTED,
];
const RETURN_PATH: readonly ShipmentStatus[] = [S.RETURNING, S.RETURN_READY];

// Steps from `from` to `to` (excluding `from`), or null if `to` can't be
// reached. Returns go via ready_for_collection (buyer didn't collect), the
// way most do; exceptions happen right after drop-off.
export function simulationPath(
  from: ShipmentStatus,
  to: ShipmentStatus,
): ShipmentStatus[] | null {
  if (from === to) {
    return null;
  }
  const forwardIndex = FORWARD.indexOf(from);
  const walkForward = (target: ShipmentStatus): ShipmentStatus[] | null => {
    const targetIndex = FORWARD.indexOf(target);
    if (forwardIndex < 0 || targetIndex <= forwardIndex) {
      return target === from ? [] : null;
    }
    return FORWARD.slice(forwardIndex + 1, targetIndex + 1);
  };

  if (FORWARD.includes(to)) {
    return walkForward(to);
  }
  if (to === S.CANCELLED || to === S.EXPIRED || to === S.REFUSED) {
    return from === S.CREATED ? [to] : null;
  }
  if (to === S.EXCEPTION) {
    if (isFinal(from)) {
      return null;
    }
    return from === S.CREATED ? [S.RECEIVED, S.EXCEPTION] : [S.EXCEPTION];
  }
  // Return path targets.
  const finalReturn = to === S.RETURNED || to === S.DISPOSED;
  if (!RETURN_PATH.includes(to) && !finalReturn) {
    return null;
  }
  const lead: ShipmentStatus[] = [];
  if (from === S.RETURNING || from === S.RETURN_READY) {
    const index = RETURN_PATH.indexOf(from);
    lead.push(...RETURN_PATH.slice(index + 1));
  } else {
    const toShelf =
      from === S.READY_FOR_COLLECTION
        ? []
        : walkForward(S.READY_FOR_COLLECTION);
    if (toShelf === null) {
      return null;
    }
    lead.push(...toShelf, ...RETURN_PATH);
  }
  const steps = finalReturn
    ? [...lead, to]
    : lead.slice(0, lead.indexOf(to) + 1);
  return steps.length > 0 && steps[steps.length - 1] === to ? steps : null;
}

// Test-mode tracking codes: LCT-XXXX-XXXX (E14). Same alphabet as live
// LCM- codes (Crockford Base32, no 0/O or 1/I/L confusion); real Nodes
// refuse LCT codes and public tracking ignores them.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateTestTrackingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `LCT-${code.slice(0, 4)}-${code.slice(4)}`;
}

// 6-digit one-time collection code shown to the buyer.
export function generateCollectionCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// Collection window (D15): 7 working days, Monday–Friday in Lagos time
// (UTC+1, no DST), ending at 23:59:59 local on the last day. Public
// holidays are added with the logistics core (M3).
export const COLLECTION_WORKING_DAYS = 7;
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

export function addWorkingDays(from: Date, days: number): Date {
  const local = new Date(from.getTime() + LAGOS_OFFSET_MS);
  let added = 0;
  while (added < days) {
    local.setUTCDate(local.getUTCDate() + 1);
    const weekday = local.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      added++;
    }
  }
  local.setUTCHours(23, 59, 59, 0);
  return new Date(local.getTime() - LAGOS_OFFSET_MS);
}

// Drop-off deadline before an unreceived shipment expires (§7.1).
export const DROP_DEADLINE_DAYS = { hub: 60, node: 14 } as const;
