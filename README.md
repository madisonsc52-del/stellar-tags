# Stellar Tags

Stellar Tags is a payment platform that combines a Soroban smart contract, a Node.js server, and a React dashboard. It is structured as a small mono-repo so each piece can be developed and deployed independently while still working together as a single product.

## What is inside

- `payment-dashboard/` - React + Vite frontend dashboard.
- `stellar-payment-platform/` - Node.js server for API and business logic.
- `payment_router/` - Rust/Soroban contract.

## Key features

- Desired specific username
- Fast transfer
- Secured payment flows

## Architecture Map

The following diagram maps exactly how data flows between the user, Render, and the Stellar network.

```text
[ User / Browser ]
       |
       | (Vite App hosted on Vercel)
       v
[ payment-dashboard ]
  (src/App.jsx: Wallet connections & UI)
       |
       | HTTP API Calls (via VITE_API_BASE)
       v
[ stellar-payment-platform ] <---> [ PostgreSQL Database ]
  (server.js: Server router on Render)        (via Prisma ORM: User/payment layout)
       |
       | Stellar Network / RPC
       v
[ payment_router ]
  (src/lib.rs: Soroban smart contract routing logic)
```

**Data Flow:**
1. **User** accesses the `payment-dashboard` and connects their Stellar wallet.
2. The dashboard queries the `stellar-payment-platform` server for user registrations and payment routing information.
3. The server interacts with its PostgreSQL database (via the Prisma ORM) to resolve usernames to addresses using the endpoints documented below.
4. When a payment is initiated, it's routed through the `payment_router` Soroban contract on the Stellar network.

## Repository structure

```text
.
├── payment-dashboard/
│   ├── .env                 # Frontend environment variables
│   └── src/
│       └── App.jsx          # Wallet connections and React UI
├── payment_router/
│   └── src/
│       └── lib.rs           # Soroban smart contract logic
└── stellar-payment-platform/
    ├── server.js            # Server router (Express API endpoints)
    └── prisma/
        └── schema.prisma    # Prisma schema for the PostgreSQL database
```

## Getting started

> These steps are split by module so you can run only what you need.

### Frontend dashboard

```bash
cd payment-dashboard
npm install
npm run dev
```

### Server

The server uses **PostgreSQL** as its database, accessed through the
[Prisma ORM](https://www.prisma.io/). You need a running Postgres instance
(local install, Docker, or a hosted provider) before starting the server.

```bash
cd stellar-payment-platform
npm install

# 1. Create your local env file and point DATABASE_URL at your Postgres DB
cp .env.example .env
#    then edit .env (see "Database setup" below)

# 2. Apply the schema to your database
npm run prisma:migrate

# 3. Start the server
npm run dev
```

#### Database setup

The connection string lives in `stellar-payment-platform/.env` as `DATABASE_URL`.
Copy `.env.example` to `.env` and set it to your own Postgres database:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
```

For a typical local install that becomes, for example:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/stellar_tags?schema=public"
```

The quickest way to get a local database is Docker:

```bash
docker run --name stellar-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=stellar_tags -p 5432:5432 -d postgres:16
```

Useful Prisma commands (run from `stellar-payment-platform/`):

| Command | Description |
| --- | --- |
| `npm run prisma:migrate` | Create/apply migrations against your dev database |
| `npm run prisma:deploy` | Apply existing migrations (CI / production) |
| `npm run prisma:generate` | Regenerate the Prisma Client after schema changes |
| `npm run prisma:studio` | Open Prisma Studio to browse the data |

> `.env` is gitignored — never commit real credentials. Each contributor keeps
> their own local `DATABASE_URL`.

### Render deployment

The repository includes a [render.yaml](render.yaml) blueprint for the backend API and its PostgreSQL database. When you deploy from Render, import the blueprint or create the service from the repo so `DATABASE_URL` is injected automatically from the managed database.

If you deploy the backend without the blueprint, make sure the web service has a PostgreSQL `DATABASE_URL` secret configured before startup. The container runs Prisma migrations on boot, so the variable must already exist.

### Smart contract (Soroban)

```bash
cd payment_router
cargo build
```

## Webhook signature verification

Every webhook delivery includes an HMAC-SHA256 signature in the
`X-Webhook-Signature` header (and the backward-compatible alias
`X-Stellar-Tags-Signature`). Merchants must verify this signature before
trusting the payload.

See [docs/webhook-signature-verification.md](docs/webhook-signature-verification.md)
for step-by-step verification examples in Node.js, Python, and Go.

## Tests

```bash
# frontend
cd payment-dashboard
npm test

# server
cd ../stellar-payment-platform
npm test

# contract
cd ../payment_router
cargo test
```

## Environment variables

To ensure a seamless local developer installation requiring zero guesswork, please configure the following environment variables in their respective directories:

### Frontend (`payment-dashboard/.env`)
- `VITE_API_BASE` - The base URL where the frontend expects the Node.js server API to be running (e.g., `http://localhost:5000`).

### Server (`stellar-payment-platform/.env` or exported directly)
- `DATABASE_URL` - **(Required)** PostgreSQL connection string used by Prisma (see [Database setup](#database-setup)).
- `PORT` - (Optional) The port for the Node.js server to listen on. Defaults to `5000`.
- `HORIZON_NETWORK` - (Optional) Stellar network for the payment listener: `testnet` (default) or `public`.
- `STELLAR_TAG_DOMAIN` - (Optional) Extra origin to add to the CORS allow-list.
- `LOG_DIR` - (Optional) Directory for the rotating log files. Defaults to `stellar-payment-platform/logs`.
- `LOG_LEVEL` - (Optional) Minimum level to record. Defaults to `info` in production and `debug` elsewhere.
- `LOG_MAX_SIZE` - (Optional) Size at which the active log file rotates. Defaults to `20m`.
- `LOG_MAX_FILES` - (Optional) Retention for rotated files, as a count (`30`) or an age (`14d`). Defaults to `14d`.

For Render deployments, make sure the web service has `DATABASE_URL` set in its environment or linked from a Render PostgreSQL instance before startup. The container runs `prisma migrate deploy` during boot, so the variable must be available at runtime.

## Logging

The server logs through a shared [Winston](https://github.com/winstonjs/winston) logger
(`stellar-payment-platform/src/logger.js`). Import it instead of calling `console` directly:

```js
const { logger } = require('./src/logger');

logger.info('Registered tag', { correlationId: req.correlationId, tag });
logger.error(err);
```

Log records are written as JSON to `stellar-payment-platform/logs/`:

- `application-YYYY-MM-DD.log` - everything at `LOG_LEVEL` and above.
- `error-YYYY-MM-DD.log` - errors only, so incidents are easy to find.

Both files rotate **daily and whenever they pass 20MB**, older files are gzipped, and
anything beyond the retention window is deleted, so logs cannot exhaust the disk. A
human-readable copy is also printed to the console (silenced when `NODE_ENV=test`, which
also disables file output so test runs leave no logs behind).

## Error responses

Every API error leaves the server in one shape, produced by a single terminal
handler (`stellar-payment-platform/src/middleware/errorHandler.js`):

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid request body",
    "details": [{ "field": "username", "message": "username is required" }]
  },
  "correlation_id": "3f2a…",
  "reference_id": "9b41…"
}
```

`error.code` is the stable part of the contract — branch on it rather than on
the status or the message text, which may be reworded. `details` appears only
when the failure is field-level. `correlation_id` is on every error;
`reference_id` is added on `5xx` and matches the logged stack.

| Code | Status | Raised when |
| --- | --- | --- |
| `INVALID_INPUT` | 400 | Malformed query, JSON, or a rejected value |
| `UNAUTHENTICATED` | 401 | Missing or failed signature verification |
| `FORBIDDEN` | 403 | Reserved name, blocked address |
| `NOT_FOUND` | 404 | No such tag, address, or route |
| `METHOD_NOT_ALLOWED` | 405 | Wrong verb on a known path |
| `CONFLICT` | 409 | Username or address already registered |
| `PAYLOAD_TOO_LARGE` | 413 | Body over the 10kb cap |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Non-JSON body on a JSON endpoint |
| `VALIDATION_FAILED` | 422 | Body failed its schema |
| `RATE_LIMITED` | 429 | Rate limit exhausted |
| `INTERNAL_ERROR` | 500 | Unhandled failure |
| `UPSTREAM_ERROR` | 502 | Horizon or another upstream failed |
| `SERVICE_UNAVAILABLE` | 503 | Database or Redis unreachable, request timeout |

To raise one, throw or pass an `ApiError` — the handler is the only place that
turns an error into a response:

```js
const { ApiError } = require('./src/errors');

return next(new ApiError('CONFLICT', 'Address already registered'));
```

A `5xx` from an unexpected throw always reports the generic message so
internals are never leaked; the real error goes to the log under
`reference_id`. A message passed deliberately to `ApiError` is sent as written.

`GET /health` is exempt: it reports component status (`{ status, database,
redis }`) rather than an API error.

## Request validation

Incoming request bodies and query strings are validated by
[zod](https://zod.dev) schemas before any route handler runs. Schemas live in
`stellar-payment-platform/src/schemas/index.js`, and
`src/middleware/validateSchema.js` turns them into route middleware:

```js
const { validateSchema } = require('./src/middleware/validateSchema');
const { registerBodySchema, usersQuerySchema } = require('./src/schemas');

app.post('/register', validateSchema({ body: registerBodySchema }), handler);
app.get('/users', validateSchema({ query: usersQuerySchema }), handler);
```

The validated part is replaced with the parsed result, so handlers receive
values that are already trimmed and coerced — `req.query.limit` is a number,
not a string — and never re-check types themselves.

Failures short-circuit before the handler and respond with the field-level
errors, using the status that matches where the bad input came from:

| Failure | Status | Body |
| --- | --- | --- |
| Invalid `req.body` | `422 Unprocessable Entity` | `{ success: false, errors: [{ field, message }] }` |
| Invalid `req.query` | `400 Bad Request` | `{ success: false, errors: [{ field, message }] }` |

Two rules are deliberately *not* in the schemas, because the handlers own them
and answer `400` with their own domain-specific messages: Stellar address
format (checked with `StrKey`) and memo pairing/format (checked with
`validateMemo`). `page` and `limit` clamp to their bounds rather than being
rejected, so `?limit=1000` still returns the maximum page size.

## Detailed Endpoint Documentation

The Node.js server (`stellar-payment-platform/server.js`) exposes the following endpoints for username and payment lookups:

### `GET /federation`
Resolves a given username tag to a Stellar address.
- **Query Parameter:** `q` (string) - The username tag to lookup (e.g., `alice*localhost`).
- **Returns:** A JSON object with `stellar_address`, `account_id`, `memo_type`, and `memo`.
- **Status Codes:**
  - `200 OK`: Address found.
  - `400 Bad Request`: Missing `q` parameter.
  - `404 Not Found`: Name tag not found.
  - `500 Internal Server Error`: Database lookup failed.

### `POST /register`
Registers a new username and associates it with a Stellar address.
- **Body Parameters (JSON):** 
  - `username` (string) - The desired username.
  - `address` (string) - The user's Stellar address.
- **Returns:** A JSON object with registration details `{ ok: true, username, address }`.
- **Status Codes:**
  - `200 OK`: Registration successful.
  - `400 Bad Request`: Missing `username` or `address`.
  - `409 Conflict`: Address or username already registered.
  - `500 Internal Server Error`: Database lookup or insertion failed.

### `GET /lookup`
Resolves a given Stellar address to its registered username.
- **Query Parameter:** `address` (string) - The Stellar address to lookup.
- **Returns:** A JSON object with `username` and `address`.
- **Status Codes:**
  - `200 OK`: Username found.
  - `400 Bad Request`: Missing `address` parameter.
  - `404 Not Found`: Username not found for this address.
  - `500 Internal Server Error`: Database lookup failed.

### `GET /health`
A simple health check endpoint.
- **Returns:** `{ status: 'ok' }`
- **Status Codes:** `200 OK`.

### `GET /transactions/export`
Streams the account's payment history as a CSV download.
- **Query Parameters:** `address` (required) - Stellar public key. `order` (optional) - `desc` (default) or `asc`.
- **Returns:** `text/csv` with a `Content-Disposition` attachment header. Columns: `id`, `created_at`, `type`, `from`, `to`, `amount`, `asset_type`, `asset_code`, `asset_issuer`, `transaction_hash`.
- **Status Codes:**
  - `200 OK`: Stream started. Sent chunked, so there is no `Content-Length`.
  - `400 Bad Request`: Missing or invalid `address`.
  - `404 Not Found`: Account not found on Horizon.
  - `502 Bad Gateway`: Horizon request failed.

Pages of 200 records are fetched from Horizon with its cursor, converted, and
flushed as they arrive, so neither the full result set nor the full CSV is held
in memory: heap use plateaus around 18MB whether the export is 5,000 rows or
100,000. Writes respect socket backpressure, and `EXPORT_MAX_PAGES`
(default 500) bounds a single export — a truncated export is logged as a
warning. Because the response is committed once streaming starts, a mid-stream
failure can only be logged and the connection cut, since the JSON error
envelope needs unsent headers.

The `/payments` collection mixes operation types that name the same concepts
differently, so participant and amount columns are normalised per type: a
`create_account` reports `funder`/`account`/`starting_balance` and an
`account_merge` reports `account`/`into`.

### `GET /admin/export`
Streams transaction records from the database as a CSV or NDJSON download for external accounting.
- **Query Parameters:**
  - `format` (optional) – `csv` (default) or `json`.
  - `startDate` (optional) – `YYYY-MM-DD` inclusive lower bound on `createdAt`.
  - `endDate` (optional) – `YYYY-MM-DD` inclusive upper bound on `createdAt`.
- **Headers:** `x-api-key` (required) – must match `ADMIN_API_KEY`.
- **Returns:** `text/csv` or `application/x-ndjson` with a `Content-Disposition: attachment` header.
- **Status Codes:**
  - `200 OK`: Stream started.
  - `400 Bad Request`: Invalid date format or `startDate` after `endDate`.
  - `401 Unauthorized`: Missing or invalid API key.

Records are fetched 500 at a time and written directly to the response, so heap use stays bounded regardless of export size. JSON output is newline-delimited (one object per line) for easy streaming parsing.

### `GET /metrics`
Prometheus scrape endpoint, served in the Prometheus text format. Exempt from the
rate limiter so a scraper on a fixed interval is never throttled.
- **Returns:** all metrics below, prefixed `stellar_tags_`.
- **Status Codes:** `200 OK`.

| Metric | Type | Description |
| --- | --- | --- |
| `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, ... | gauge | Memory usage |
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | CPU usage |
| `http_requests_total` | counter | Requests by `method`, `route`, `status_code` |
| `http_request_duration_seconds` | histogram | Request latency by `method`, `route`, `status_code` |
| `db_pool_connections_open` | gauge | Connections open in the Prisma pool |
| `db_pool_connections_busy` | gauge | Connections executing a query |
| `db_pool_connections_idle` | gauge | Connections open but unused |
| `db_pool_queries_waiting` | gauge | Queries queued waiting for a connection |
| `redis_connections_active` | gauge | `1` while Redis is ready for commands, else `0` |

Memory and CPU come from `prom-client`'s default collectors. The pool gauges read
Prisma's `$metrics` (which requires the `metrics` preview feature in
`schema.prisma`) and report `0` when it is unavailable.

## Architecture notes

- The React dashboard runs on `http://localhost:3000` in dev (Vite) and provides the UI.
- The dashboard calls the Node.js API at `http://localhost:5000` via `VITE_API_BASE` and a `/api` proxy.
- The Soroban contract handles on-chain payment routing logic.

## License

See [LICENSE](LICENSE).
