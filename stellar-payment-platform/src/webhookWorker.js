const crypto = require('crypto');
const cron = require('node-cron');
const { logger } = require('./logger');

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RETRY_BACKLOG_DAYS = 3;
const RETRY_JOB_CRON = '*/5 * * * *'; // every 5 minutes

const shouldFallbackToLocalRegistry = (error) => {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return (
    code.startsWith('P10') ||
    ['P2021', 'P2023', 'P2028', 'P2001'].includes(code) ||
    /DATABASE_URL|connect|relation|table|timeout/i.test(message)
  );
};

const computeSignature = (secret, rawBody) => {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
};

const fetchWebhooksForAddress = async (prisma, poolGetFn, stellarAddress) => {
  try {
    return await prisma.webhook.findMany({
      where: {
        user: { address: stellarAddress },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
        failingSince: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;

    const rows = await poolGetFn(
      `SELECT w.id, w.username, w.url, w.secret, w.failing_since
       FROM webhooks w
       INNER JOIN username_registry u ON u.username = w.username
       WHERE u.address = ?`,
      [stellarAddress],
    );
    return (rows || []).map((r) => ({
      id: r.id,
      username: r.username,
      url: r.url,
      secret: r.secret,
      failingSince: r.failing_since ? new Date(r.failing_since) : null,
    }));
  }
};

const sendWebhook = async (url, payload, secret) => {
  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(secret, rawBody);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Primary header per issue #496 spec.
        'X-Webhook-Signature': signature,
        // Legacy alias kept for backward compatibility.
        'X-Stellar-Tags-Signature': signature,
        'X-Webhook-Timestamp': payload.timestamp,
      },
      body: rawBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`Webhook responded with HTTP ${res.status}`);
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
};

const markWebhookSuccess = async (prisma, poolRunFn, webhookId, now) => {
  try {
    await prisma.webhook.update({
      where: { id: webhookId },
      data: { lastSentAt: now, failingSince: null },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `UPDATE webhooks SET last_sent_at = ?, failing_since = NULL WHERE id = ?`,
      [now.toISOString(), webhookId],
    );
  }
};

const markWebhookFailure = async (prisma, poolRunFn, webhookId, now) => {
  try {
    const current = await prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { failingSince: true },
    });
    await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        lastSentAt: now,
        failingSince: current?.failingSince || now,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    await poolRunFn(
      `UPDATE webhooks
       SET last_sent_at = ?,
           failing_since = COALESCE(failing_since, ?)
       WHERE id = ?`,
      [now.toISOString(), now.toISOString(), webhookId],
    );
  }
};

const formatAsset = (payment) => {
  if (!payment) return 'native';
  if (payment.asset_type === 'native') return 'native';
  return `${payment.asset_code}:${payment.asset_issuer}`;
};

const dispatchPaymentWebhooks = async ({
  prisma,
  poolGetFn,
  poolRunFn,
  payment,
}) => {
  if (!payment) return;
  if (payment.type !== 'payment' && payment.type_i !== 1) return;

  const recipientAddress = payment.to;
  if (!recipientAddress) return;

  let webhooks;
  try {
    webhooks = await fetchWebhooksForAddress(prisma, poolGetFn, recipientAddress);
  } catch (err) {
    logger.error(`[webhook-worker] Failed to fetch webhooks for ${recipientAddress}:`, err.message);
    return;
  }

  if (!webhooks || webhooks.length === 0) return;

  const payload = {
    event: 'payment.received',
    event_id: `${payment.transaction_hash || ''}-${payment.id || crypto.randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    network: process.env.HORIZON_NETWORK || 'testnet',
    data: {
      transaction_hash: payment.transaction_hash || null,
      from: payment.from || null,
      to: recipientAddress,
      amount: payment.amount || null,
      asset: formatAsset(payment),
      asset_type: payment.asset_type || 'native',
      asset_code: payment.asset_code || null,
      asset_issuer: payment.asset_issuer || null,
      created_at: payment.created_at || null,
      paging_token: payment.paging_token || null,
    },
  };

  for (const wh of webhooks) {
    const now = new Date();
    try {
      await sendWebhook(wh.url, payload, wh.secret);
      try {
        await markWebhookSuccess(prisma, poolRunFn, wh.id, now);
      } catch (dbErr) {
        logger.error(`[webhook-worker] Failed to mark success for webhook ${wh.id}:`, dbErr.message);
      }
      logger.info(`[webhook-worker] Dispatched payment webhook id=${wh.id} url=${wh.url} recipient=${recipientAddress}`);
    } catch (err) {
      try {
        await markWebhookFailure(prisma, poolRunFn, wh.id, now);
      } catch (dbErr) {
        logger.error(`[webhook-worker] Failed to mark failure for webhook ${wh.id}:`, dbErr.message);
      }
      logger.error(`[webhook-worker] Webhook delivery failed id=${wh.id} url=${wh.url}:`, err.message);
    }
  }
};

const listStaleFailingWebhooks = async (prisma, poolAllFn) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_RETRY_BACKLOG_DAYS);
  try {
    return await prisma.webhook.findMany({
      where: {
        failingSince: { not: null, gte: cutoff },
      },
      select: {
        id: true,
        username: true,
        url: true,
        secret: true,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;
    const rows = await poolAllFn(
      `SELECT id, username, url, secret FROM webhooks
       WHERE failing_since IS NOT NULL AND failing_since >= ?`,
      [cutoff.toISOString()],
    );
    return (rows || []).map((r) => ({
      id: r.id,
      username: r.username,
      url: r.url,
      secret: r.secret,
    }));
  }
};

const sendLivenessPing = async (prisma, poolRunFn, webhook) => {
  const payload = {
    event: 'webhook.ping',
    event_id: `ping-${crypto.randomBytes(16).toString('hex')}`,
    timestamp: new Date().toISOString(),
    data: { message: 'ping' },
  };
  const now = new Date();
  try {
    await sendWebhook(webhook.url, payload, webhook.secret);
    await markWebhookSuccess(prisma, poolRunFn, webhook.id, now);
    return true;
  } catch (err) {
    await markWebhookFailure(prisma, poolRunFn, webhook.id, now);
    return false;
  }
};

const scheduleWebhookRetryJob = ({ prisma, poolAllFn, poolRunFn }) => {
  cron.schedule(RETRY_JOB_CRON, async () => {
    logger.info('[webhook-worker] Running periodic liveness pings for failing webhooks…');
    try {
      const hooks = await listStaleFailingWebhooks(prisma, poolAllFn);
      if (hooks.length === 0) return;
      let recovered = 0;
      for (const wh of hooks) {
        const ok = await sendLivenessPing(prisma, poolRunFn, wh);
        if (ok) recovered += 1;
      }
      logger.info(
        `[webhook-worker] Liveness pings done. total=${hooks.length}, recovered=${recovered}`,
      );
    } catch (err) {
      logger.error('[webhook-worker] Retry job failed:', err.message);
    }
  });
  logger.info(`[webhook-worker] Retry/liveness job scheduled (cron: ${RETRY_JOB_CRON}).`);
};

module.exports = {
  dispatchPaymentWebhooks,
  scheduleWebhookRetryJob,
  sendWebhook,
  computeSignature,
  WEBHOOK_TIMEOUT_MS,
};
