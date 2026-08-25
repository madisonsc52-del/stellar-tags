const express = require('express');
const xss = require('xss');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { verifyMultiSignerThreshold } = require('../../multisigner-verifier');
const { poolGet, poolRun, poolAll } = require('../../db');
const { logger } = require('../../logger');
const { lookupCached, invalidateFederationCache } = require('../../cache');
const {
  paginatedResponse,
  parsePagination,
  parseCursorQuery,
  keysetWhereDesc,
  paginateByKeyset,
  cursorPaginatedResponse,
} = require('../../pagination');
const { asyncHandler } = require('../../middleware/asyncHandler');
const {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  shouldFallbackToLocalRegistry,
} = require('../../utils');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const {
  registerBodySchema,
  lookupQuerySchema,
  usersQuerySchema,
} = require('../../schemas');

const router = express.Router();

const buildUserSearchWhere = (search) => {
  if (!search) return {};
  return {
    deletedAt: null,
    OR: [
      { username: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } },
    ],
  };
};

const serializeUser = (user) => ({
  username: user.username,
  address: user.address,
  created_at: user.createdAt ? user.createdAt.toISOString() : undefined,
});

const getLocalUserByAddress = async (address) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE address = ? LIMIT 1',
    [address],
  );

const getLocalUserByUsername = async (username) =>
  poolGet(
    'SELECT username, address FROM username_registry WHERE username = ? LIMIT 1',
    [username],
  );

const listLocalUsers = async (search, page, limit) => {
  const searchPattern = `%${search}%`;
  const skip = (page - 1) * limit;
  const rows = await poolAll(
    `SELECT username, address, created_at
     FROM username_registry
     WHERE username LIKE ? COLLATE NOCASE OR address LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [searchPattern, searchPattern, limit, skip],
  );

  const countRow = await poolGet(
    `SELECT COUNT(*) AS totalCount
     FROM username_registry
     WHERE username LIKE ? COLLATE NOCASE OR address LIKE ? COLLATE NOCASE`,
    [searchPattern, searchPattern],
  );

  const totalCount = Number(countRow?.totalCount || 0);
  return paginatedResponse(
    rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.created_at,
    })),
    totalCount,
    { page, limit },
  );
};

const registerLocalUser = async ({ username, address }) => {
  const existingByAddress = await getLocalUserByAddress(address);
  if (existingByAddress) {
    const conflictError = new Error('Address already registered');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  const existingByUsername = await getLocalUserByUsername(username);
  if (existingByUsername) {
    const conflictError = new Error('Username is already taken. Please choose another.');
    conflictError.statusCode = 409;
    throw conflictError;
  }

  await poolRun(
    `INSERT INTO username_registry (username, address, created_at)
     VALUES (?, ?, ?)`,
    [username, address, new Date().toISOString()],
  );
};

router.post('/register', requireJson, validateSchema({ body: registerBodySchema }), asyncHandler(async (req, res, next) => {
  const safeUsername = xss(req.body.username);
  const username = normalizeNameTag(safeUsername);
  const { address, memo_type: memoType, memo, signature = '', signerAddress = '' } = req.body;

  if (address.toUpperCase().startsWith('S')) {
    return next(
      new ApiError(
        'INVALID_INPUT',
        'Never share your Secret Key. Please register using your Public Key (starts with G).',
      ),
    );
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    const error = new Error('Invalid Stellar Public Key format.');
    error.statusCode = 400;
    return next(error);
  }

  const memoError = validateMemo(memoType, memo);
  if (memoError) {
    return next(new ApiError('INVALID_INPUT', memoError));
  }



  const normalizedUsername = username.toLowerCase();

  if (RESERVED_NAMES.includes(normalizedUsername)) {
    return next(new ApiError('FORBIDDEN', 'This username is reserved and cannot be registered.'));
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { address, deletedAt: null }
    });

    if (existing) {
      const conflictError = new Error('Address already registered');
      conflictError.statusCode = 409;
      return next(conflictError);
    }

    let verificationResult = null;
    const signerToVerify = signerAddress || address;
    if (signerToVerify) {
      verificationResult = await verifyMultiSignerThreshold(address, [signerToVerify], {
        operationType: 'management',
      });

      if (!verificationResult.success) {
        const verificationError = new Error(
          verificationResult.errorMessage || 'Signature verification failed'
        );
        verificationError.statusCode = 401;
        throw verificationError;
      }
    }

    await prisma.user.create({
      data: {
        username: normalizedUsername,
        address,
        ...(memoType && { memoType, memo }),
      },
    });
    // Invalidate any stale federation cache entries for this username/address
    invalidateFederationCache(normalizedUsername, address);

    return res.status(201).json({
      ok: true,
      username: normalizedUsername,
      address,
      federation_address: `${normalizedUsername}*${process.env.DOMAIN || 'localhost'}`,
      ...(verificationResult && {
        verification: {
          accountId: verificationResult.accountId,
          signerCount: verificationResult.signerCount,
          thresholdMet: verificationResult.success,
          requiredThreshold: verificationResult.requiredThreshold,
          providedWeight: verificationResult.totalWeight,
        },
      }),
      ...(memoType && { memo_type: memoType, memo }),
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT' || (error.message && error.message.includes('UNIQUE'))) {
      return next(new ApiError('CONFLICT', 'Username is already taken. Please choose another.'));
    }
    
    if (error.message && error.message.includes('Account not found')) {
      const notFoundError = new Error(`Account not found on Horizon: ${address}`);
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    if (error.statusCode === 401) {
      return next(error);
    }

    logger.error('Registration error:', error.message);
    const registrationError = new Error(`Registration verification failed: ${error.message}`, { cause: error });
    registrationError.statusCode = 500;
    return next(registrationError);
  }
}));

router.all('/register', (req, res, next) => next(new ApiError('METHOD_NOT_ALLOWED')));

// #18 — Soft-delete endpoint. Sets deleted_at to now() instead of running a
// hard DELETE so the row is preserved for historical auditing.
router.delete('/register/:username', asyncHandler(async (req, res, next) => {
  const username = normalizeNameTag(
    typeof req.params.username === 'string' ? req.params.username.trim() : '',
  ).toLowerCase();

  if (!username) {
    const error = new Error('Missing username parameter');
    error.statusCode = 400;
    return next(error);
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { username, deletedAt: null },
    });

    if (!existing) {
      const notFoundError = new Error('Username not found or already deleted');
      notFoundError.statusCode = 404;
      return next(notFoundError);
    }

    await prisma.user.update({
      where: { username },
      data: { deletedAt: new Date() },
    });
    
    // Invalidate any stale federation cache entries
    invalidateFederationCache(username, existing.address);

    return res.status(200).json({ ok: true, username, deleted: true });
  } catch (error) {
    logger.error('Failed to unregister account:', error);
    const dbError = new Error('Failed to unregister account', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
}));

router.get('/lookup', validateSchema({ query: lookupQuerySchema }), asyncHandler(async (req, res, next) => {
  const { address = '', search = '' } = req.query;

  if (address) {
    try {
      const result = await lookupCached(address, async () => {
        const row = await prisma.user.findFirst({
          where: { address, deletedAt: null },
          select: { username: true },
        });
        return row ? { username: row.username, address } : null;
      });

      if (!result) {
        const notFoundError = new Error('Username not found for this address');
        notFoundError.statusCode = 404;
        return next(notFoundError);
      }

      return res.json(result);
    } catch (error) {
      console.warn('USER ROUTES ERROR:', error);
      const dbError = new Error('Database lookup failed', { cause: error });
      dbError.statusCode = 500;
      return next(dbError);
    }
  }

  const { limit: cursorLimit, cursor, invalid: invalidCursor } = parseCursorQuery(req.query);
  const { page, limit, skip } = parsePagination(req.query);
  if (invalidCursor) {
    return next(new ApiError('INVALID_INPUT', 'Invalid cursor parameter'));
  }
  const where = buildUserSearchWhere(search);

  try {
    if (cursor) {
      // Keyset mode: seek straight past the cursor row instead of skipping
      // every preceding row, so deep pages cost the same as page one.
      const candidates = await prisma.user.findMany({
        where: { AND: [where, keysetWhereDesc(cursor)] },
        orderBy: [
          { createdAt: 'desc' },
          { username: 'desc' },
        ],
        take: cursorLimit + 1,
      });
      const { rows, hasMore, nextCursor } = paginateByKeyset(candidates, cursorLimit);
      const data = rows.map((user) => ({
        username: user.username,
        address: user.address,
        created_at: user.createdAt.toISOString(),
      }));
      return res.json(cursorPaginatedResponse(data, { limit: cursorLimit, nextCursor, hasMore }));
    }

    const [totalCount, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [
          { createdAt: 'desc' },
          { username: 'desc' },
        ],
        skip,
        take: limit,
      }),
    ]);

const totalPages = Math.ceil(totalCount / limit);
    const data = rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.createdAt.toISOString(),
    }));

    return res.json({ data, totalCount, totalPages, currentPage: page });
  } catch (error) {
    const dbError = new Error('Database lookup failed', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
}));

router.get('/users', validateSchema({ query: usersQuerySchema }), asyncHandler(async (req, res, next) => {
  const { limit: cursorLimit, cursor, invalid: invalidCursor } = parseCursorQuery(req.query);
  const { page, limit, skip } = parsePagination(req.query);
  if (invalidCursor) {
    return next(new ApiError('INVALID_INPUT', 'Invalid cursor parameter'));
  }
  const search = req.query.search ?? null;
  const where = search ? buildUserSearchWhere(search) : { deletedAt: null };

  try {
    if (cursor) {
      // Keyset mode: seek straight past the cursor row instead of skipping
      // every preceding row, so deep pages cost the same as page one.
      const candidates = await prisma.user.findMany({
        where: { AND: [where, keysetWhereDesc(cursor)] },
        orderBy: [
          { createdAt: 'desc' },
          { username: 'desc' },
        ],
        take: cursorLimit + 1,
      });
      const { rows, hasMore, nextCursor } = paginateByKeyset(candidates, cursorLimit);
      const data = rows.map((user) => ({
        username: user.username,
        address: user.address,
        created_at: user.createdAt ? user.createdAt.toISOString() : undefined,
      }));
      return res.json(cursorPaginatedResponse(data, { limit: cursorLimit, nextCursor, hasMore }));
    }

    const [totalCount, rows] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [
          { createdAt: 'desc' },
          { username: 'desc' },
        ],
        skip,
        take: limit,
      }),
    ]);

const totalPages = Math.ceil(totalCount / limit);
    const data = rows.map((user) => ({
      username: user.username,
      address: user.address,
      created_at: user.createdAt ? user.createdAt.toISOString() : undefined,
    }));

    res.json({
      data,
      meta: {
        total: totalCount,
        totalCount,
        page,
        currentPage: page,
        limit,
        totalPages,
      },
      totalCount,
      totalPages,
      currentPage: page,
    });
  } catch (error) {
    const dbError = new Error('Database error', { cause: error });
    dbError.statusCode = 500;
    return next(dbError);
  }
}));

module.exports = router;
