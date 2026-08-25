'use strict';

const CURSOR_VERSION = 'v1';

function parsePagination(query, defaultLimit = 10, maxLimit = 100) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function paginatedResponse(data, totalCount, { page, limit }) {
  const totalPages = Math.ceil(totalCount / limit);
  return {
    data,
    meta: { total: totalCount, page, limit, totalPages },
    totalCount,
    totalPages,
    currentPage: page,
  };
}

// --- Keyset (cursor-based) pagination ---
//
// Offset pagination (`skip`) degrades linearly with page depth because the
// database still walks every skipped row. Keyset pagination instead seeks
// directly past the last row of the previous page using its sort key, so page
// N costs the same as page 1 regardless of depth.
//
// The cursor is an opaque base64url blob encoding the sort-key tuple of the
// last row on a page (createdAt + username, the deterministic tie-breaker).
// Clients never inspect it; they just echo back `nextCursor`.

/**
 * Serialise a cursor point (sort-key tuple) to an opaque cursor string.
 * @param {{ createdAt: string|Date, username: string }} point
 * @returns {string} base64url-encoded cursor
 */
function encodeCursor(point) {
  const payload =
    typeof point.createdAt === 'string'
      ? { createdAt: point.createdAt, username: String(point.username) }
      : { createdAt: new Date(point.createdAt).toISOString(), username: String(point.username) };
  return Buffer.from(JSON.stringify([CURSOR_VERSION, payload]), 'utf8').toString('base64url');
}

/**
 * Parse an opaque cursor string back into its sort-key tuple.
 * @param {string} cursor
 * @returns {{ createdAt: string, username: string } | null} null when the
 *   value is malformed, truncated, or produced by another cursor version.
 */
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed[0] !== CURSOR_VERSION) return null;
    const [version, point] = parsed;
    if (
      version !== CURSOR_VERSION ||
      !point ||
      typeof point !== 'object' ||
      typeof point.createdAt !== 'string' ||
      Number.isNaN(Date.parse(point.createdAt)) ||
      typeof point.username !== 'string'
    ) {
      return null;
    }
    return { createdAt: point.createdAt, username: point.username };
  } catch {
    return null;
  }
}

/**
 * Extract keyset-pagination options from a validated query object.
 * @returns {{ limit: number, cursor: object|null, invalid: boolean }}
 *   `invalid` is true when a cursor was supplied but could not be decoded.
 */
function parseCursorQuery(query, defaultLimit = 10, maxLimit = 100) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const raw = typeof query.cursor === 'string' ? query.cursor.trim() : '';
  if (!raw) return { limit, cursor: null, invalid: false };
  const cursor = decodeCursor(raw);
  return { limit, cursor, invalid: !cursor };
}

/**
 * Prisma `where` fragment selecting rows strictly after `point` for a
 * `(createdAt DESC, username DESC)` ordering — i.e. everything older than the
 * cursor row, with ties broken by username. Pure keyset seek, no OFFSET.
 */
function keysetWhereDesc({ createdAt, username }) {
  const timestamp = new Date(createdAt);
  return {
    OR: [
      { createdAt: { lt: timestamp } },
      { AND: [{ createdAt: { equals: timestamp } }, { username: { lt: String(username) } }] },
    ],
  };
}

/**
 * Split a fetch of `limit + 1` candidate rows into a page plus continuation
 * info. An extra row is requested so "has more" is exact; it is trimmed here.
 * @returns {{ rows: object[], hasMore: boolean, nextCursor: string|null }}
 */
function paginateByKeyset(rows, limit) {
  const hasMore = Array.isArray(rows) && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows || [];
  const last = page.length > 0 ? page[page.length - 1] : null;
  const nextCursor =
    hasMore && last && last.createdAt ? encodeCursor({ createdAt: last.createdAt, username: last.username }) : null;
  return { rows: page, hasMore, nextCursor };
}

/**
 * Response body for a cursor-paginated listing. `nextCursor` is echoed at the
 * top level and inside `meta`; clients pass it back as `?cursor=`.
 */
function cursorPaginatedResponse(data, { limit, nextCursor, hasMore }) {
  return {
    data,
    meta: { limit, nextCursor, hasMore },
    nextCursor,
    hasMore,
  };
}

module.exports = {
  parsePagination,
  paginatedResponse,
  encodeCursor,
  decodeCursor,
  parseCursorQuery,
  keysetWhereDesc,
  paginateByKeyset,
  cursorPaginatedResponse,
};
