'use strict';

/**
 * src/utils/exporter.js
 *
 * Streams admin transaction records from the database to an HTTP response in
 * either CSV or JSON format.
 *
 * Design goals (issue #489):
 *  - Accept `format` (csv | json), optional `startDate` / `endDate` filters.
 *  - Stream records in pages so heap use is bounded regardless of export size.
 *  - Write JSON as a newline-delimited stream (one object per line) to avoid
 *    buffering the full array before the first byte is flushed.
 *  - Respect socket backpressure by awaiting drain when needed.
 */

const { once } = require('events');
const { Transform } = require('stream');
const { Parser: CsvParser } = require('json2csv');

/** Number of rows fetched from the database per round-trip. */
const PAGE_SIZE = 500;

/** Maximum pages streamed in a single export request. */
const MAX_PAGES = Number(process.env.EXPORT_MAX_PAGES) || 200;

/**
 * Column names exported in the CSV/JSON response.
 * Mirrors the Prisma `payment` model fields relevant for accounting.
 */
const EXPORT_FIELDS = [
  'id',
  'createdAt',
  'fromAddress',
  'toAddress',
  'amount',
  'assetCode',
  'transactionHash',
  'status',
];

/**
 * Writes `chunk` to `res`, waiting for a drain event if the write buffer is
 * full (i.e. the socket is applying backpressure).
 *
 * @param {import('http').ServerResponse} res
 * @param {string|Buffer} chunk
 */
const writeChunk = async (res, chunk) => {
  if (!res.write(chunk)) {
    await once(res, 'drain');
  }
};

/**
 * Builds the Prisma `where` clause for the optional date-range filters.
 *
 * @param {string|undefined} startDate - ISO date string (inclusive lower bound).
 * @param {string|undefined} endDate   - ISO date string (inclusive upper bound).
 * @returns {object} Prisma where clause fragment.
 */
const buildDateFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return {};

  const filter = {};
  if (startDate) filter.gte = new Date(startDate);
  if (endDate) {
    // Include the whole end day by advancing to midnight of the next day.
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return { createdAt: filter };
};

/**
 * Streams admin transaction records to `res` as CSV.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} prisma     - Prisma client instance.
 * @param {object} filter     - Prisma `where` clause.
 * @param {object} logger     - Winston logger.
 * @param {string} correlationId
 * @returns {Promise<number>} Total rows written.
 */
const streamCsv = async (res, prisma, filter, logger, correlationId) => {
  let page = 0;
  let totalRows = 0;
  let truncated = false;
  let headerWritten = false;

  for (; page < MAX_PAGES; page++) {
    if (res.writableEnded) break;

    const records = await prisma.payment.findMany({
      where: filter,
      select: {
        id: true,
        createdAt: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        assetCode: true,
        transactionHash: true,
        status: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    if (records.length === 0) break;

    try {
      const parser = new CsvParser({
        fields: EXPORT_FIELDS,
        // Only emit the header on the first page.
        header: !headerWritten,
        // Append a trailing newline so pages concatenate correctly.
        withBOM: false,
      });
      const chunk = parser.parse(records) + '\n';
      await writeChunk(res, chunk);
      headerWritten = true;
    } catch (parseErr) {
      logger.error(`[exporter][${correlationId}] CSV parse error on page ${page}:`, parseErr.message);
      throw parseErr;
    }

    totalRows += records.length;

    if (records.length < PAGE_SIZE) break; // last page

    if (page === MAX_PAGES - 1) {
      truncated = true;
    }
  }

  if (truncated) {
    logger.warn(
      `[exporter][${correlationId}] CSV export hit ${MAX_PAGES}-page cap after ${totalRows} rows — truncated`,
    );
  }

  return totalRows;
};

/**
 * Streams admin transaction records to `res` as newline-delimited JSON
 * (one JSON object per line, no wrapping array).  This keeps memory use
 * bounded while producing a valid machine-readable format.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} prisma     - Prisma client instance.
 * @param {object} filter     - Prisma `where` clause.
 * @param {object} logger     - Winston logger.
 * @param {string} correlationId
 * @returns {Promise<number>} Total rows written.
 */
const streamJson = async (res, prisma, filter, logger, correlationId) => {
  let page = 0;
  let totalRows = 0;
  let truncated = false;

  for (; page < MAX_PAGES; page++) {
    if (res.writableEnded) break;

    const records = await prisma.payment.findMany({
      where: filter,
      select: {
        id: true,
        createdAt: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        assetCode: true,
        transactionHash: true,
        status: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    if (records.length === 0) break;

    for (const record of records) {
      if (res.writableEnded) return totalRows;
      await writeChunk(res, JSON.stringify(record) + '\n');
      totalRows += 1;
    }

    if (records.length < PAGE_SIZE) break;

    if (page === MAX_PAGES - 1) {
      truncated = true;
    }
  }

  if (truncated) {
    logger.warn(
      `[exporter][${correlationId}] JSON export hit ${MAX_PAGES}-page cap after ${totalRows} rows — truncated`,
    );
  }

  return totalRows;
};

/**
 * Main entry point used by the admin export route handler.
 *
 * Sets the correct Content-Type / Content-Disposition headers and delegates
 * to the format-specific streamer.  The response is committed before streaming
 * begins, so mid-stream errors can only be logged and the connection cut.
 *
 * @param {object}  opts
 * @param {import('http').ServerResponse} opts.res
 * @param {object}  opts.prisma
 * @param {string}  opts.format      - 'csv' or 'json'
 * @param {string}  [opts.startDate]
 * @param {string}  [opts.endDate]
 * @param {object}  opts.logger
 * @param {string}  opts.correlationId
 */
const streamAdminExport = async ({
  res,
  prisma,
  format,
  startDate,
  endDate,
  logger,
  correlationId,
}) => {
  const dateFilter = buildDateFilter(startDate, endDate);
  const now = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${now}.ndjson"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);

    const rows = await streamJson(res, prisma, dateFilter, logger, correlationId);
    logger.info(`[exporter][${correlationId}] JSON export complete — ${rows} rows`);
  } else {
    // Default: CSV
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${now}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);

    const rows = await streamCsv(res, prisma, dateFilter, logger, correlationId);
    logger.info(`[exporter][${correlationId}] CSV export complete — ${rows} rows`);
  }

  res.end();
};

module.exports = {
  streamAdminExport,
  buildDateFilter,
  EXPORT_FIELDS,
  PAGE_SIZE,
};
