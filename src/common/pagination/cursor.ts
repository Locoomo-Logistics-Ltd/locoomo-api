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
