import {
  decodeCursor,
  encodeCursor,
  InvalidCursorException,
  toCursorPage,
} from './cursor';

describe('cursor pagination', () => {
  it('round-trips a position', () => {
    const position = { t: '2026-11-14T10:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('rejects tampered cursors', () => {
    expect(() => decodeCursor('not-json')).toThrow(InvalidCursorException);
    expect(() =>
      decodeCursor(Buffer.from('{"t":"nope","id":"x"}').toString('base64url')),
    ).toThrow(InvalidCursorException);
  });

  it('uses the extra row only to say there is more', () => {
    const rows = [1, 2, 3].map((n) => ({ n, at: new Date(n * 1000) }));
    const page = toCursorPage(
      rows,
      2,
      (r) => ({ t: r.at.toISOString(), id: String(r.n) }),
      (r) => r.n,
    );
    expect(page.items).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      t: new Date(2000).toISOString(),
      id: '2',
    });
    expect(
      toCursorPage(
        rows,
        5,
        () => ({ t: '', id: '' }),
        (r) => r.n,
      ),
    ).toEqual({ items: [1, 2, 3], nextCursor: null, hasMore: false });
  });
});
