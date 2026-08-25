'use strict';

const {
  parsePagination,
  paginatedResponse,
  encodeCursor,
  decodeCursor,
  parseCursorQuery,
  keysetWhereDesc,
  paginateByKeyset,
  cursorPaginatedResponse,
} = require('../src/pagination');

describe('offset pagination (legacy)', () => {
  test('parsePagination computes skip from page and limit', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
  });

  test('paginatedResponse keeps its historical shape', () => {
    expect(paginatedResponse(['a'], 21, { page: 2, limit: 10 })).toMatchObject({
      data: ['a'],
      totalCount: 21,
      totalPages: 3,
      currentPage: 2,
      meta: { total: 21, page: 2, limit: 10, totalPages: 3 },
    });
  });
});

describe('cursor encoding', () => {
  test('round-trips a sort-key tuple', () => {
    const point = { createdAt: '2026-08-24T00:00:00.000Z', username: 'alice' };
    expect(decodeCursor(encodeCursor(point))).toEqual(point);
  });

  test('normalises Date objects to ISO strings', () => {
    const date = new Date('2026-08-24T12:34:56.000Z');
    const decoded = decodeCursor(encodeCursor({ createdAt: date, username: 'bob' }));
    expect(decoded).toEqual({ createdAt: '2026-08-24T12:34:56.000Z', username: 'bob' });
  });

  test.each([
    ['garbage text', 'not-a-cursor'],
    ['an empty string', ''],
    ['a valid b64 payload with the wrong version', Buffer.from(JSON.stringify(['v0', {}]), 'utf8').toString('base64url')],
    ['a non-object payload', Buffer.from(JSON.stringify(['v1', 42]), 'utf8').toString('base64url')],
    ['a payload missing the username', Buffer.from(JSON.stringify(['v1', { createdAt: '2026-08-24T00:00:00.000Z' }]), 'utf8').toString('base64url')],
    ['a payload with an unparsable timestamp', Buffer.from(JSON.stringify(['v1', { createdAt: 'whenever', username: 'alice' }]), 'utf8').toString('base64url')],
  ])('rejects %s', (_label, bad) => {
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('parseCursorQuery', () => {
  test('returns no cursor and no error when the parameter is absent', () => {
    expect(parseCursorQuery({})).toEqual({ limit: 10, cursor: null, invalid: false });
  });

  test('treats a blank cursor as absent', () => {
    expect(parseCursorQuery({ cursor: '   ' })).toMatchObject({ cursor: null, invalid: false });
  });

  test('decodes a valid cursor and honours its limit', () => {
    const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.000Z', username: 'zoe' });
    const parsed = parseCursorQuery({ cursor, limit: '25' });
    expect(parsed.limit).toBe(25);
    expect(parsed.cursor).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', username: 'zoe' });
    expect(parsed.invalid).toBe(false);
  });

  test('flags an unparseable cursor instead of throwing', () => {
    expect(parseCursorQuery({ cursor: '@@@' })).toMatchObject({ cursor: null, invalid: true });
  });

  test('clamps the limit like the offset path does', () => {
    expect(parseCursorQuery({ limit: '1000' }).limit).toBe(100);
    expect(parseCursorQuery({ limit: '-5' }).limit).toBe(1);
    expect(parseCursorQuery({ limit: 'abc' }).limit).toBe(10);
  });
});

describe('keysetWhereDesc', () => {
  test('selects strictly older rows, with ties broken by username', () => {
    const where = keysetWhereDesc({ createdAt: '2026-05-05T05:05:05.000Z', username: 'mia' });
    const ts = new Date('2026-05-05T05:05:05.000Z');
    expect(where).toEqual({
      OR: [
        { createdAt: { lt: ts } },
        { AND: [{ createdAt: { equals: ts } }, { username: { lt: 'mia' } }] },
      ],
    });
  });
});

describe('paginateByKeyset', () => {
  const row = (n) => ({ createdAt: new Date(2026, 0, n), username: `user${n}` });

  test('trims the over-fetch row and emits nextCursor when more pages exist', () => {
    const candidates = [row(9), row(8), row(7)];
    const result = paginateByKeyset(candidates, 2);
    expect(result.rows).toEqual([row(9), row(8)]);
    expect(result.hasMore).toBe(true);
    expect(decodeCursor(result.nextCursor)).toEqual({
      createdAt: new Date(2026, 0, 8).toISOString(),
      username: 'user8',
    });
  });

  test('reports no continuation on the final page', () => {
    const result = paginateByKeyset([row(2)], 2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.rows).toHaveLength(1);
  });

  test('handles an empty result set', () => {
    const result = paginateByKeyset([], 5);
    expect(result).toEqual({ rows: [], hasMore: false, nextCursor: null });
  });
});

describe('cursorPaginatedResponse', () => {
  test('exposes nextCursor both at the top level and in meta', () => {
    const body = cursorPaginatedResponse(['x'], { limit: 10, nextCursor: 'cur', hasMore: true });
    expect(body).toEqual({
      data: ['x'],
      meta: { limit: 10, nextCursor: 'cur', hasMore: true },
      nextCursor: 'cur',
      hasMore: true,
    });
  });
});
