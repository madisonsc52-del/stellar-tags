'use strict';

/**
 * tests/admin-export.test.js
 *
 * Tests for GET /admin/export (issue #489).
 */

const request = require('supertest');

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockFindMany = jest.fn();
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: { findMany: mockFindMany },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

// Load app after mocks are in place.
const { app } = require('../server');

// ── helpers ──────────────────────────────────────────────────────────────────

const makeRecord = (i) => ({
  id: `txn-${i}`,
  createdAt: new Date('2026-01-15T12:00:00Z'),
  fromAddress: `GSENDER${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  toAddress: `GRECIPIENT${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  amount: String(i * 100),
  assetCode: 'XLM',
  transactionHash: `hash${i}`,
  status: 'completed',
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('GET /admin/export', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/admin/export');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('streams CSV with correct headers (default format)', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1), makeRecord(2)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/\.csv/);
    // Header row present — json2csv quotes field names by default
    expect(res.text).toMatch(/"id"/);
    expect(res.text).toMatch(/"createdAt"/);
    // Data rows present
    expect(res.text).toMatch(/txn-1/);
    expect(res.text).toMatch(/txn-2/);
  });

  it('streams JSON with correct headers when format=json', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['content-disposition']).toMatch(/\.ndjson/);
    // Each line is valid JSON
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe('txn-1');
  });

  it('accepts explicit format=csv', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=csv')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('returns empty CSV (headers only) when no records found', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    // No data rows — response may be empty or contain only a newline
    expect(res.text.trim()).toBe('');
  });

  it('returns empty NDJSON when no records found with format=json', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe('');
  });

  it('passes startDate and endDate as date filters', async () => {
    mockFindMany.mockResolvedValueOnce([makeRecord(1)]).mockResolvedValueOnce([]);

    await request(app)
      .get('/api/v1/admin/export?startDate=2026-01-01&endDate=2026-01-31')
      .set('x-api-key', 'test-admin-key');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it('rejects startDate after endDate with 400', async () => {
    const res = await request(app)
      .get('/api/v1/admin/export?startDate=2026-02-01&endDate=2026-01-01')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(400);
  });

  it('handles multiple pages correctly', async () => {
    // First page: 500 records; second page: 2 records; third page: empty.
    const page1 = Array.from({ length: 500 }, (_, i) => makeRecord(i));
    const page2 = [makeRecord(500), makeRecord(501)];
    mockFindMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(502);
  });
});
