import { BusinessException } from '../exceptions';

// Cursor pagination for merchant list endpoints (plan E8): stable while
// rows are being inserted, unlike offset paging. The cursor is opaque to
// clients: base64url JSON of the last row's sort key.

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CursorPosition {
  // ISO timestamp of the sort column.
  t: string;
  id: string;
}

export class InvalidCursorException extends BusinessException {
  readonly errorCode = 'INVALID_CURSOR';
  readonly httpStatus = 400;

  constructor() {
    super('The cursor is invalid. Start again without one.');
  }
}

// SQL for a timestamp column as cursors see it. Cursors carry JS
// (millisecond) times while Postgres stores microseconds, and rows written
// in one transaction share an exact timestamp. Sort and compare on this, or
// a page boundary inside such a group skips rows (newest-first lists) or
// repeats them forever (oldest-first sync).
export function cursorTime(column: string): string {
  return `date_trunc('milliseconds', ${column})`;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
): CursorPosition | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<CursorPosition>;
    if (
      typeof parsed.t === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.t))
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorException();
}

// For small, slow-changing lists sorted by something other than time (Nodes
// by distance): the cursor is just "how many already seen". Same opaque
// shape to clients.
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { o?: unknown };
    if (
      typeof parsed.o === 'number' &&
      Number.isInteger(parsed.o) &&
      parsed.o >= 0 &&
      parsed.o <= 100_000
    ) {
      return parsed.o;
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorException();
}

// Rows fetched with `limit + 1`: the extra one only says "there's more".
export function toCursorPage<R, T>(
  rows: R[],
  limit: number,
  position: (row: R) => CursorPosition,
  map: (row: R) => T,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(map),
    nextCursor:
      hasMore && page.length > 0
        ? encodeCursor(position(page[page.length - 1]))
        : null,
    hasMore,
  };
}
