'use strict';

const { z } = require('zod');

// Query values arrive as strings. Page and limit clamp rather than reject, so
// `?limit=1000` keeps returning the maximum page size instead of erroring.
const clampedInt = (fallback, min, max) =>
  z.preprocess((value) => {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }, z.number().int());

const paginationFields = {
  page: clampedInt(1, 1, Number.MAX_SAFE_INTEGER),
  limit: clampedInt(10, 1, 100),
};

// Opaque keyset-pagination continuation token. Only shape-checked here; the
// handlers own decoding and answer 400 on an unparseable cursor.
const cursorField = {
  cursor: z.string().trim().min(1).max(512).optional(),
};

// Lookup keys are passed to the database as-is, so they are only checked for
// type and length here. Format checking of addresses stays with StrKey in the
// handlers, which knows the real Stellar base32 alphabet and checksum.
const lookupString = z.string().trim().min(1).max(256);

const optionalLookupString = lookupString.optional();

/**
 * POST /register body.
 *
 * The bare username is validated here; the server appends the federation
 * suffix afterwards. Addresses are only required to be non-empty strings at
 * this layer because the handler runs the authoritative StrKey check and
 * answers 400 with a Stellar-specific message.
 */
const registerBodySchema = z
  .object({
    username: z
      .string({ error: 'username is required' })
      .trim()
      .min(3, 'username must be between 3 and 20 characters')
      .max(20, 'username must be between 3 and 20 characters')
      .regex(/^[a-zA-Z0-9]+$/, 'username must contain only letters and numbers'),
    // Only required to be a non-empty string: StrKey in the handler is the
    // authoritative format check and answers 400 with a Stellar-specific
    // message. Adding a length bound here would reject payloads before they
    // reach that check, which the injection-safety tests rely on.
    address: z
      .string({ error: 'address is required' })
      .trim()
      .min(1, 'address cannot be empty'),
    // Memo and signature fields are only shape-checked here. validateMemo owns
    // the cross-field pairing and per-type format rules (and their 400
    // responses), and an empty signature legitimately means "unsigned".
    memo_type: z.string().trim().optional(),
    memo: z.string().trim().optional(),
    signature: z.string().trim().optional(),
    signerAddress: z.string().trim().optional(),
  })
  .loose();

/** GET /federation query. */
const federationQuerySchema = z
  .object({
    q: z
      .string({ error: "Missing 'q' parameter" })
      .trim()
      .min(1, "Missing 'q' parameter")
      .max(256),
    type: z
      .enum(['id', 'name'], "Unsupported query type. Supported types: 'id', 'name'")
      .optional(),
  })
  .loose();

/**
 * GET /lookup query. Exactly one of `address` (exact match) or `search`
 * (paginated) drives the handler, so at least one must be present.
 */
const lookupQuerySchema = z
  .object({
    address: optionalLookupString,
    search: optionalLookupString,
    ...paginationFields,
    ...cursorField,
  })
  .loose()
  .refine((value) => Boolean(value.address || value.search), {
    error:
      "Missing required parameter: provide 'address' for exact lookup or 'search' for paginated search",
    path: ['address'],
  });

/** GET /users query. Both filters are optional; listing everything is valid. */
const usersQuerySchema = z
  .object({
    search: optionalLookupString,
    ...paginationFields,
    ...cursorField,
  })
  .loose();

/** GET /accounts/:account/payments query. The account itself is checked with
 * StrKey in the handler, which knows the real Stellar key format. */
const accountPaymentsQuerySchema = z
  .object({
    limit: clampedInt(25, 1, 100),
    cursor: z.string().trim().min(1).optional(),
    order: z.enum(['asc', 'desc']).catch('desc'),
  })
  .loose();

/** POST /auth/verify-email and /auth/verify-email/confirm */
const verifyEmailBodySchema = z
  .object({
    email: z.string({ error: 'email is required' }).trim().email('a valid email is required'),
  })
  .loose();

const verifyEmailConfirmBodySchema = verifyEmailBodySchema.extend({
  code: z
    .string({ error: 'code is required' })
    .trim()
    .regex(/^\d{6}$/, 'code must be a 6-digit number'),
});

/** GET /transactions/export query. */
const exportQuerySchema = z
  .object({
    address: z.string({ error: 'address is required' }).trim().min(1, 'address is required'),
    order: z.enum(['asc', 'desc']).catch('desc'),
  })
  .loose();

/** POST /admin/block */
const adminBlockBodySchema = z
  .object({
    address: z.string({ error: 'Missing or invalid address' }).trim().min(1, 'Missing or invalid address'),
  })
  .loose();

/**
 * GET /admin/export query.
 *
 * - `format`    csv (default) | json
 * - `startDate` optional ISO date string (YYYY-MM-DD), inclusive lower bound
 * - `endDate`   optional ISO date string (YYYY-MM-DD), inclusive upper bound
 */
const adminExportQuerySchema = z
  .object({
    format: z.enum(['csv', 'json']).catch('csv'),
    startDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
      .optional(),
    endDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD')
      .optional(),
  })
  .loose()
  .refine(
    (value) => {
      if (value.startDate && value.endDate) {
        return new Date(value.startDate) <= new Date(value.endDate);
      }
      return true;
    },
    { error: 'startDate must be on or before endDate', path: ['startDate'] },
  );

module.exports = {
  registerBodySchema,
  federationQuerySchema,
  lookupQuerySchema,
  usersQuerySchema,
  accountPaymentsQuerySchema,
  verifyEmailBodySchema,
  verifyEmailConfirmBodySchema,
  adminBlockBodySchema,
  exportQuerySchema,
  adminExportQuerySchema,
};
