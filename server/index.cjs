require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  signAuthToken,
  verifyAuthToken,
  isBcryptHash,
  hashPassword,
  verifyPassword
} = require('./auth.cjs');

const app = express();
const server = http.createServer(app);

// Environment & Config
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV || 'development';
const INTERNAL_WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || '';
const ALLOW_LEGACY_TOKEN = process.env.ALLOW_LEGACY_TOKEN !== 'false';

// Meta (Facebook/Instagram) Webhooks
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_APP_ID = process.env.META_APP_ID || '';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_WEBHOOK_DEBUG = process.env.META_WEBHOOK_DEBUG === 'true';
const META_EVENT_PROCESSOR_ENABLED = process.env.META_EVENT_PROCESSOR_ENABLED !== 'false';
const META_EVENT_PROCESSOR_BATCH = parseInt(process.env.META_EVENT_PROCESSOR_BATCH || '20', 10);
const META_EVENT_PROCESSOR_INTERVAL_MS = parseInt(process.env.META_EVENT_PROCESSOR_INTERVAL_MS || '1500', 10);

const META_OUTBOX_ENABLED = process.env.META_OUTBOX_ENABLED !== 'false';
const META_OUTBOX_BATCH = parseInt(process.env.META_OUTBOX_BATCH || '15', 10);
const META_OUTBOX_INTERVAL_MS = parseInt(process.env.META_OUTBOX_INTERVAL_MS || '1200', 10);
const META_OUTBOX_MAX_ATTEMPTS = parseInt(process.env.META_OUTBOX_MAX_ATTEMPTS || '8', 10);

// Telegram notifications (optional)
const TELEGRAM_NOTIFICATIONS_ENABLED = process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== 'false';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const telegramDedup = new Map();
function shouldSendTelegramDedup(key, ttlMs = 60000) {
  const now = Date.now();
  const prev = telegramDedup.get(key);
  if (prev && (now - prev) < ttlMs) return false;
  telegramDedup.set(key, now);
  // opportunistic cleanup
  if (telegramDedup.size > 2000) {
    for (const [k, t] of telegramDedup.entries()) {
      if ((now - t) > ttlMs) telegramDedup.delete(k);
    }
  }
  return true;
}

const telegramConfigCache = new Map();
const TELEGRAM_CONFIG_TTL_MS = 15000;

function normalizeTelegramChatId(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^@\w{3,}$/i.test(v)) return v;
  if (/^-?\d+$/.test(v)) return v;
  return v; // keep as-is; Telegram accepts some non-numeric ids
}

function normalizeTelegramBotToken(raw) {
  return String(raw || '').trim();
}

async function getTelegramConfigForTenant(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';

  const cached = telegramConfigCache.get(t);
  if (cached && cached.expiresAt && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  // DB-backed per-tenant config (preferred)
  try {
    if (process.env.DATABASE_URL && db && typeof db.getTelegramIntegration === 'function') {
      const row = await db.getTelegramIntegration(t).catch(() => null);
      if (row) {
        const cfg = {
          enabled: row.enabled !== false,
          botToken: normalizeTelegramBotToken(row.bot_token || ''),
          chatId: normalizeTelegramChatId(row.chat_id || '')
        };
        telegramConfigCache.set(t, { expiresAt: Date.now() + TELEGRAM_CONFIG_TTL_MS, value: cfg });
        return cfg;
      }
    }
  } catch {
    // ignore and fall back
  }

  // Env fallback (single-tenant / legacy)
  const envCfg = {
    enabled: true,
    botToken: normalizeTelegramBotToken(TELEGRAM_BOT_TOKEN),
    chatId: normalizeTelegramChatId(TELEGRAM_CHAT_ID)
  };
  telegramConfigCache.set(t, { expiresAt: Date.now() + TELEGRAM_CONFIG_TTL_MS, value: envCfg });
  return envCfg;
}

async function sendTelegramTextWithConfig({ botToken, chatId, text }) {
  if (!TELEGRAM_NOTIFICATIONS_ENABLED) return { ok: false, skipped: 'disabled' };
  const token = normalizeTelegramBotToken(botToken);
  const chat = normalizeTelegramChatId(chatId);
  if (!token || !chat) return { ok: false, skipped: 'missing_config' };

  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const payload = {
    chat_id: chat,
    text: String(text || '').slice(0, 3500),
    disable_web_page_preview: true
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Telegram send failed (${res.status}): ${raw.slice(0, 200)}`);
  }
  return { ok: true };
}

async function notifyTelegramInbound({ tenantId, source, phone, name, message, externalId }) {
  try {
    if (!TELEGRAM_NOTIFICATIONS_ENABLED) return;
    const t = String(tenantId || '').trim() || 'admin';
    const src = String(source || '').trim() || 'unknown';
    const p = String(phone || '').trim();
    const m = String(message || '').trim();
    if (!p || !m) return;

    const dedupKey = `tg:${t}:${externalId || p}:${m.slice(0, 40)}`;
    if (!shouldSendTelegramDedup(dedupKey, 60000)) return;

    const header = `📩 New ${src} message [${t}]`;
    const who = name ? `${name} (${p})` : p;
    const body = m.length > 900 ? (m.slice(0, 900) + '…') : m;
    const cfg = await getTelegramConfigForTenant(t);
    if (!cfg || cfg.enabled === false) return;
    if (!cfg.botToken || !cfg.chatId) return;

    await sendTelegramTextWithConfig({ botToken: cfg.botToken, chatId: cfg.chatId, text: `${header}\nFrom: ${who}\n\n${body}` });

    try {
      if (process.env.DATABASE_URL && db && typeof db.setTelegramIntegrationStatus === 'function') {
        await db.setTelegramIntegrationStatus(t, { last_error: null, last_sent_at: new Date().toISOString() });
      }
    } catch {
      // ignore
    }
  } catch (e) {
    // never throw from alerts
    try {
      const t = String(tenantId || '').trim() || 'admin';
      if (process.env.DATABASE_URL && db && typeof db.setTelegramIntegrationStatus === 'function') {
        await db.setTelegramIntegrationStatus(t, { last_error: String(e?.message || 'notify_failed') });
      }
    } catch {
      // ignore
    }
    try { console.warn('⚠️ Telegram notify failed:', e.message); } catch { }
  }
}

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is missing. The app will run in file-based fallback mode.');
}

if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is missing. Compatibility fallback will be used. Set JWT_SECRET in production.');
}

async function fetchJsonWithRetry(url, options = {}, retryOptions = {}) {
  const retries = retryOptions.retries ?? 2;
  const timeoutMs = retryOptions.timeoutMs ?? 5000;
  const baseDelayMs = retryOptions.baseDelayMs ?? 300;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        let detail = '';
        try {
          const text = await response.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              const msg = parsed?.error?.message || parsed?.message || '';
              const code = parsed?.error?.code || parsed?.code || '';
              detail = msg ? `${msg}${code ? ` (code ${code})` : ''}` : text;
            } catch {
              detail = text;
            }
          }
        } catch {
          // ignore
        }
        const suffix = detail ? `: ${String(detail).slice(0, 600)}` : '';
        throw new Error(`HTTP ${response.status}${suffix}`);
      }
      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt < retries) {
        const jitter = Math.floor(Math.random() * 120);
        const backoff = baseDelayMs * (2 ** attempt) + jitter;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function decodeLegacyToken(token) {
  try {
    const raw = Buffer.from(String(token), 'base64').toString('utf-8');
    const data = JSON.parse(raw);
    if (!data || !data.tenantId) return null;
    return data;
  } catch {
    return null;
  }
}

function verifyAnyToken(token) {
  try {
    return verifyAuthToken(token);
  } catch (err) {
    if (!ALLOW_LEGACY_TOKEN) throw err;
    const legacy = decodeLegacyToken(token);
    if (!legacy) throw err;
    return legacy;
  }
}
// Middleware
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174'
].filter(Boolean);

function normalizeOrigin(value) {
  return String(value || '').replace(/\/$/, '');
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedAllowed = allowedOrigins.map(normalizeOrigin);
  if (normalizedAllowed.includes(normalizedOrigin)) return true;
  // Allow all Render-hosted origins regardless of NODE_ENV to avoid production misconfig lockouts
  if (normalizedOrigin.includes('.onrender.com')) return true;
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true);
    // Do not throw (which causes 500 + HTML fallback for JS/CSS requests).
    // Simply disable CORS headers for unknown origins.
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// JSON parser with optional raw-body capture for Meta webhook signature checks.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    try {
      // Meta requires verifying signature against the exact raw bytes.
      if (req.originalUrl) {
        const p = String(req.originalUrl);
        if (p.startsWith('/api/webhooks/meta') || p.startsWith('/webhooks/meta')) {
          req.rawBody = buf;
        }
      }
    } catch {
      // ignore
    }
  }
}));

// Socket.IO Setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 CRM BACKEND INITIALIZING...');
console.log(`📋 Environment: ${NODE_ENV}`);
console.log(`📋 Port: ${PORT}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Initialize Database
let db = require('./database');
if (!process.env.DATABASE_URL) {
  console.log('ℹ️  No DATABASE_URL found, switching to FILE-BASED STORAGE (leads.json)');
  db = require('./simple_db');
}

// ═══════════════════════════════════════════════════════════════
// META (FACEBOOK/INSTAGRAM) WEBHOOKS
// ═══════════════════════════════════════════════════════════════

const metaWebhookStats = {
  total: 0,
  accepted: 0,
  rejected: 0,
  queued: 0,
  processed_ok: 0,
  processed_failed: 0,
  last_processed_at: null,
  last_at: null,
  last_error: null,
  by_source: { facebook: 0, instagram: 0 },
  by_kind: { dm: 0, comment: 0 },
};

function metaDebugLog(...args) {
  if (!META_WEBHOOK_DEBUG) return;
  try { console.log('[META]', ...args); } catch { /* ignore */ }
}

function computeMetaSignature(rawBodyBuffer) {
  if (!META_APP_SECRET) return null;
  const h = crypto.createHmac('sha256', META_APP_SECRET);
  h.update(rawBodyBuffer);
  return 'sha256=' + h.digest('hex');
}

function parseMetaBody(req) {
  // For signature checks we need the raw bytes (captured by express.json verify).
  const buf = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}));

  const json = (req.body && typeof req.body === 'object') ? req.body : {};
  return { buf, json };
}

function toIsoFromMetaTimestamp(ts) {
  // Messenger webhooks: ms epoch
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  // heuristic: seconds vs ms
  const ms = n < 5e11 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

async function upsertMetaInbound({ tenantId, source, contactKey, displayName, text, msgId, direction, createdAtIso, meta }) {
  if (!process.env.DATABASE_URL || !db || typeof db.createLead !== 'function') {
    return;
  }

  const safeText = String(text || '').trim() || '[Unsupported message]';
  const safeKey = String(contactKey || '').trim();
  if (!safeKey) return;

  const metaId = String(msgId || '').trim() || `${source}:${Date.now()}`;
  const dir = direction === 'out' ? 'out' : 'in';

  // Idempotency: if this external message id already exists, don't bump unread_count or update lead.
  try {
    if (typeof db.messageExists === 'function') {
      const exists = await db.messageExists(metaId, tenantId);
      if (exists) return;
    } else if (db.pool) {
      const ex = await db.pool.query('SELECT 1 FROM messages WHERE whatsapp_id = $1 AND tenant_id = $2 LIMIT 1', [metaId, tenantId]);
      if (ex.rowCount > 0) return;
    }
  } catch {
    // If the check fails, continue (better to accept than to drop).
  }

  const lead = await db.createLead({
    phone: safeKey,
    name: displayName || safeKey,
    last_message: safeText,
    whatsapp_id: metaId,
    source: source,
    status: 'new',
    extra_data: { meta: meta || {} }
  }, tenantId);

  const updatedLead = await db.updateLeadMessage(lead.phone, safeText, metaId, displayName || null, tenantId, dir).catch(() => null);
  const finalLead = updatedLead || lead;

  await db.appendMessage({
    leadId: finalLead.id,
    phone: finalLead.phone,
    body: safeText,
    direction: dir,
    whatsappId: metaId,
    metadata: meta || {},
    createdAt: createdAtIso ? Math.floor(Date.parse(createdAtIso) / 1000) : null,
    tenantId
  });

  // Optional: Telegram notifications for inbound only
  if (dir === 'in') {
    notifyTelegramInbound({
      tenantId,
      source,
      phone: finalLead.phone,
      name: finalLead.name || displayName || null,
      message: safeText,
      externalId: metaId
    });
  }

  // Apply routing rules for inbound only
  if (dir === 'in') {
    try {
      const routed = await maybeApplyRoutingRulesToLead(tenantId, finalLead, safeText, { whatsapp_id: metaId, fromMe: false });
      if (routed) {
        io.to(tenantId).emit('lead_updated', routed);
      }
    } catch {
      // ignore
    }
  }

  io.to(tenantId).emit('new_message', {
    phone: finalLead.phone,
    name: finalLead.name || displayName || safeKey,
    message: safeText,
    whatsapp_id: metaId,
    fromMe: dir === 'out',
    timestamp: createdAtIso || new Date().toISOString(),
    source
  });
}

function handleMetaWebhookVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && META_VERIFY_TOKEN && safeEqual(String(token || ''), String(META_VERIFY_TOKEN))) {
    return res.status(200).send(String(challenge || ''));
  }
  return res.sendStatus(403);
}

async function processMetaWebhookPayload(json) {
  const payload = json || {};
  const objectType = String(payload.object || '').toLowerCase();
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  if (!objectType || entries.length === 0) {
    metaDebugLog('Webhook payload missing object/entry');
    return { processed: 0 };
  }

  let processed = 0;

  for (const entry of entries) {
    const entryId = entry && entry.id ? String(entry.id) : '';
    if (!entryId) continue;

    // Resolve tenant + token by page_id or ig_business_id
    let integration = null;
    try {
      if (!process.env.DATABASE_URL || !db || !db.pool) continue;
      if (objectType === 'page' && typeof db.getMetaPageByPageId === 'function') {
        integration = await db.getMetaPageByPageId(entryId);
      } else if (objectType === 'instagram' && typeof db.getMetaPageByIgBusinessId === 'function') {
        integration = await db.getMetaPageByIgBusinessId(entryId);
      }
    } catch (e) {
      console.warn('⚠️ Meta integration lookup failed:', e.message);
    }
    if (!integration || !integration.tenant_id || !integration.page_access_token) {
      metaDebugLog('No integration match', { objectType, entryId });
      continue;
    }

    const tenantId = integration.tenant_id;
    const pageId = integration.page_id;
    const pageToken = integration.page_access_token;
    const igBusinessId = integration.ig_business_id || null;

    const source = objectType === 'instagram' ? 'instagram' : 'facebook';
    if (source === 'instagram' || source === 'facebook') {
      metaWebhookStats.by_source[source] = (metaWebhookStats.by_source[source] || 0) + 1;
    }
    metaDebugLog('Webhook processing', { objectType, entryId, tenantId, pageId, igBusinessId });

    // Messaging (DM)
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const ev of messaging) {
      const senderId = ev?.sender?.id ? String(ev.sender.id) : '';
      const recipientId = ev?.recipient?.id ? String(ev.recipient.id) : '';
      // Facebook: entry.id is Page ID. Instagram: entry.id is IG Business Account ID.
      const threadOwnerId = source === 'instagram'
        ? (igBusinessId ? String(igBusinessId) : entryId)
        : String(pageId);
      const isFromPage = senderId && threadOwnerId && senderId === String(threadOwnerId);

      const contactId = isFromPage ? recipientId : senderId;
      if (!contactId) continue;

      const contactKey = (source === 'instagram' ? 'ig:' : 'fb:') + contactId;
      const text = ev?.message?.text || '';

      const attachments = Array.isArray(ev?.message?.attachments) ? ev.message.attachments : [];
      let safeText = String(text || '').trim();
      if (!safeText && attachments.length > 0) {
        safeText = '[Attachment]';
      }

      const mid = ev?.message?.mid ? String(ev.message.mid) : '';
      const msgId = (source === 'instagram' ? 'igmid:' : 'fbmid:') + (mid || (String(ev?.timestamp || '') || String(Date.now())));
      const createdAtIso = toIsoFromMetaTimestamp(ev?.timestamp || Date.now());
      const direction = isFromPage ? 'out' : 'in';

      await upsertMetaInbound({
        tenantId,
        source,
        contactKey,
        displayName: null,
        text: safeText,
        msgId,
        direction,
        createdAtIso,
        meta: {
          platform: source,
          kind: 'dm',
          page_id: pageId,
          ig_business_id: igBusinessId,
          sender_id: senderId || null,
          recipient_id: recipientId || null,
          attachments: attachments.length > 0 ? attachments : null
        }
      });

      metaWebhookStats.by_kind.dm = (metaWebhookStats.by_kind.dm || 0) + 1;
      processed++;
    }

    // Comments / feed changes
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const ch of changes) {
      const value = ch && ch.value ? ch.value : {};
      const verb = String(value.verb || '').toLowerCase();
      if (verb && verb !== 'add') continue;

      const commentId = value.comment_id || value.id || null;
      const postId = value.post_id || value.post || null;
      const messageText = value.message || value.text || '';

      if (!commentId && !messageText) continue;

      let fromId = value?.from?.id ? String(value.from.id) : null;
      let fromName = value?.from?.name ? String(value.from.name) : null;
      if (!fromName && value?.from?.username) fromName = String(value.from.username);

      // Try to enrich comment via Graph API when possible
      let finalText = String(messageText || '').trim();
      let permalink = null;
      let createdAtIso = new Date().toISOString();
      if (commentId) {
        try {
          const fields = source === 'instagram'
            ? 'text,username,timestamp,media{id,permalink},user{id,username}'
            : 'message,from,created_time,permalink_url';
          const url = `https://graph.facebook.com/v19.0/${commentId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken)}`;
          const data = await fetchJsonWithRetry(url, {}, { retries: 0, timeoutMs: 4000 }).catch(() => null);
          if (data) {
            if (source === 'instagram') {
              if (!finalText) finalText = String(data.text || '').trim();
              fromName = fromName || data.username || null;
              // Prefer stable author id if available
              if (!fromId) fromId = data?.user?.id ? String(data.user.id) : null;
              permalink = data?.media?.permalink || null;
              if (data.timestamp) createdAtIso = new Date(String(data.timestamp)).toISOString();
            } else {
              if (!finalText) finalText = String(data.message || '').trim();
              fromId = fromId || (data?.from?.id ? String(data.from.id) : null);
              fromName = fromName || (data?.from?.name ? String(data.from.name) : null);
              permalink = data?.permalink_url || null;
              if (data.created_time) createdAtIso = new Date(String(data.created_time)).toISOString();
            }
          }
        } catch {
          // ignore
        }
      }

      if (!finalText) finalText = '[Comment]';

      // Lead key: platform + author id (preferred). Fallback to comment id to avoid collisions.
      const authorKey = fromId ? String(fromId) : (commentId ? `comment:${String(commentId)}` : (fromName || 'comment'));
      const contactKey = (source === 'instagram' ? 'ig:' : 'fb:') + authorKey;

      const msgId = (source === 'instagram' ? 'igcmt:' : 'fbcmt:') + (commentId ? String(commentId) : String(Date.now()));

      await upsertMetaInbound({
        tenantId,
        source,
        contactKey,
        displayName: fromName,
        text: finalText,
        msgId,
        direction: 'in',
        createdAtIso,
        meta: {
          platform: source,
          kind: 'comment',
          page_id: pageId,
          ig_business_id: igBusinessId,
          comment_id: commentId ? String(commentId) : null,
          post_id: postId ? String(postId) : null,
          permalink: permalink
        }
      });

      metaWebhookStats.by_kind.comment = (metaWebhookStats.by_kind.comment || 0) + 1;
      processed++;
    }
  }

  return { processed };
}

function computeMetaBackoffSeconds(attempts) {
  const a = Number(attempts || 0);
  const exp = Math.min(7, Math.max(0, a));
  const base = 3 * (2 ** exp);
  const jitter = Math.floor(Math.random() * 3);
  return Math.min(300, base + jitter);
}

function computeMetaOutboxBackoffSeconds(attempts, errMsg) {
  const msg = String(errMsg || '').toLowerCase();
  if (msg.includes('http 429') || msg.includes('rate limit') || msg.includes('code 4')) {
    return 60 + Math.floor(Math.random() * 10);
  }
  const a = Number(attempts || 0);
  const exp = Math.min(7, Math.max(0, a));
  const base = 5 * (2 ** exp);
  const jitter = Math.floor(Math.random() * 5);
  return Math.min(600, base + jitter);
}

async function pollMetaOutbox() {
  if (!META_OUTBOX_ENABLED) return;
  if (!process.env.DATABASE_URL) return;
  if (!db || !db.pool) return;

  const batchSize = Number.isFinite(META_OUTBOX_BATCH) ? Math.max(1, Math.min(META_OUTBOX_BATCH, 50)) : 15;
  const owner = `meta-outbox:${process.pid}`;

  // Claim pending meta outbound messages and mark as sending
  const claimRes = await db.pool.query(
    `UPDATE messages
     SET status = 'sending'
     WHERE id IN (
       SELECT m.id
       FROM messages m
       WHERE m.direction = 'out'
         AND m.status = 'pending'
         AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= NOW())
         AND (m.metadata->>'platform') IN ('facebook', 'instagram')
         AND (m.metadata->'dispatch') IS NOT NULL
       ORDER BY m.created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, tenant_id, lead_id, phone, body, whatsapp_id, metadata, attempts`,
    [batchSize]
  );

  const rows = claimRes.rows || [];
  if (rows.length === 0) return;

  for (const row of rows) {
    const tenantId = row.tenant_id;
    const leadId = row.lead_id;
    const platform = String(row?.metadata?.platform || '').toLowerCase();
    const dispatch = row?.metadata?.dispatch || {};
    const mode = String(dispatch?.mode || '');
    const pageId = String(row?.metadata?.page_id || '');

    if (!tenantId || !leadId || (platform !== 'facebook' && platform !== 'instagram') || !mode || !pageId) {
      await db.pool.query(
        "UPDATE messages SET status = 'failed', last_error = $1 WHERE id = $2 AND tenant_id = $3",
        ['invalid_dispatch', row.id, tenantId]
      ).catch(() => null);
      continue;
    }

    // Load integration token scoped to tenant
    let integration = null;
    try {
      const r = await db.pool.query(
        'SELECT tenant_id, page_id, page_access_token, ig_business_id, status FROM meta_pages WHERE tenant_id = $1 AND page_id = $2 LIMIT 1',
        [tenantId, pageId]
      );
      integration = r.rows[0] || null;
    } catch {
      integration = null;
    }

    if (!integration || !integration.page_access_token || String(integration.status || 'connected') === 'disconnected') {
      await db.pool.query(
        "UPDATE messages SET status = 'failed', last_error = $1 WHERE id = $2 AND tenant_id = $3",
        ['integration_missing_or_disconnected', row.id, tenantId]
      ).catch(() => null);
      continue;
    }

    const pageToken = integration.page_access_token;
    const igBusinessId = integration.ig_business_id || null;

    let graphResult = null;
    let outId = null;
    let sendError = null;

    try {
      if (mode === 'comment') {
        const commentId = dispatch?.comment_id ? String(dispatch.comment_id) : '';
        if (!commentId) throw new Error('Missing comment_id');
        if (platform === 'instagram') {
          graphResult = await postGraphForm(`${commentId}/replies`, { message: row.body, access_token: pageToken });
          outId = graphResult?.id || null;
        } else {
          graphResult = await postGraphForm(`${commentId}/comments`, { message: row.body, access_token: pageToken });
          outId = graphResult?.id || null;
        }
      } else if (mode === 'private') {
        const commentId = dispatch?.comment_id ? String(dispatch.comment_id) : '';
        if (!commentId) throw new Error('Missing comment_id');
        graphResult = await postGraphForm(`${commentId}/private_replies`, { message: row.body, access_token: pageToken });
        outId = graphResult?.id || graphResult?.message_id || null;
      } else if (mode === 'dm') {
        const userId = dispatch?.user_id ? String(dispatch.user_id) : '';
        if (!userId) throw new Error('Missing user_id');
        if (platform === 'instagram') {
          const igId = dispatch?.ig_id ? String(dispatch.ig_id) : (igBusinessId ? String(igBusinessId) : '');
          if (!igId) throw new Error('Missing ig_id');
          graphResult = await postGraphJson(`${igId}/messages`, { recipient: { id: userId }, message: { text: row.body } }, pageToken);
          outId = graphResult?.message_id || graphResult?.id || null;
        } else {
          graphResult = await postGraphJson(`me/messages`, { recipient: { id: userId }, message: { text: row.body } }, pageToken);
          outId = graphResult?.message_id || graphResult?.id || null;
        }
      } else {
        throw new Error('Invalid mode');
      }
    } catch (e) {
      sendError = e;
    }

    if (sendError) {
      const errMsg = String(sendError?.message || 'Send failed').slice(0, 800);
      const attemptNow = Number(row.attempts || 0) + 1;

      // Token/permission errors -> disconnect integration
      try {
        const lower = errMsg.toLowerCase();
        if (lower.includes('code 190') || lower.includes('oauth') || lower.includes('access token')) {
          await db.pool.query(
            "UPDATE meta_pages SET status = 'disconnected', last_error = $1, last_checked_at = NOW(), updated_at = NOW() WHERE tenant_id = $2 AND page_id = $3",
            [errMsg.slice(0, 240), tenantId, pageId]
          );
        }
      } catch {
        // ignore
      }

      if (attemptNow >= Math.max(1, META_OUTBOX_MAX_ATTEMPTS || 8)) {
        await db.pool.query(
          "UPDATE messages SET status = 'failed', attempts = $1, last_error = $2, next_attempt_at = NULL WHERE id = $3 AND tenant_id = $4",
          [attemptNow, errMsg, row.id, tenantId]
        ).catch(() => null);
      } else {
        const backoff = computeMetaOutboxBackoffSeconds(attemptNow, errMsg);
        await db.pool.query(
          "UPDATE messages SET status = 'pending', attempts = $1, last_error = $2, next_attempt_at = NOW() + ($3::int * INTERVAL '1 second') WHERE id = $4 AND tenant_id = $5",
          [attemptNow, errMsg, backoff, row.id, tenantId]
        ).catch(() => null);
      }

      await db.logAuditAction({
        tenantId,
        userId: row?.metadata?.operator_id || null,
        action: 'SEND_META_FAILED',
        entityType: 'lead',
        entityId: leadId,
        details: { mode, error: errMsg }
      }).catch(() => null);

      continue;
    }

    const finalKey = outId ? `metaout:${outId}` : String(row.whatsapp_id || '');
    const nowIso = new Date().toISOString();

    await db.pool.query(
      "UPDATE messages SET status = 'sent', whatsapp_id = $1, metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, next_attempt_at = NULL, last_error = NULL WHERE id = $3 AND tenant_id = $4",
      [finalKey, { graph: graphResult || null, sent_at: nowIso }, row.id, tenantId]
    ).catch(() => null);

    await db.updateLeadMessage(row.phone, row.body, finalKey, null, tenantId, 'out').catch(() => null);

    // Notify UI so chat can reload
    try {
      io.to(tenantId).emit('new_message', {
        phone: row.phone,
        name: null,
        message: row.body,
        whatsapp_id: finalKey,
        fromMe: true,
        timestamp: nowIso,
        source: platform
      });
    } catch {
      // ignore
    }

    await db.logAuditAction({
      tenantId,
      userId: row?.metadata?.operator_id || null,
      action: 'SEND_META',
      entityType: 'lead',
      entityId: leadId,
      details: { mode, id: outId || null, platform }
    }).catch(() => null);
  }
}

let metaQueueTimer = null;
let metaOutboxTimer = null;
async function pollMetaWebhookQueue() {
  if (!META_EVENT_PROCESSOR_ENABLED) return;
  if (!process.env.DATABASE_URL) return;
  if (!db || typeof db.claimMetaWebhookEvents !== 'function') return;

  const batchSize = Number.isFinite(META_EVENT_PROCESSOR_BATCH) ? META_EVENT_PROCESSOR_BATCH : 20;
  const lockOwner = `api:${process.pid}`;

  let rows = [];
  try {
    rows = await db.claimMetaWebhookEvents(batchSize, lockOwner);
  } catch (e) {
    metaWebhookStats.last_error = e?.message || 'queue_claim_failed';
    return;
  }

  if (!rows || rows.length === 0) return;

  for (const r of rows) {
    try {
      await processMetaWebhookPayload(r.payload);
      if (typeof db.completeMetaWebhookEvent === 'function') {
        await db.completeMetaWebhookEvent(r.id);
      }
      metaWebhookStats.processed_ok++;
      metaWebhookStats.last_processed_at = new Date().toISOString();
    } catch (e) {
      metaWebhookStats.processed_failed++;
      metaWebhookStats.last_error = e?.message || 'processing_error';
      if (typeof db.failMetaWebhookEvent === 'function') {
        await db.failMetaWebhookEvent(r.id, metaWebhookStats.last_error, computeMetaBackoffSeconds(r.attempts));
      }
    }
  }
}

app.get('/api/webhooks/meta', handleMetaWebhookVerify);
app.get('/webhooks/meta', handleMetaWebhookVerify);

function handleMetaWebhookPost(req, res) {
  try {
    if (!META_APP_SECRET) {
      console.warn('⚠️ META_APP_SECRET missing; refusing to accept Meta webhooks.');
      metaWebhookStats.total++;
      metaWebhookStats.rejected++;
      metaWebhookStats.last_at = new Date().toISOString();
      metaWebhookStats.last_error = 'META_APP_SECRET missing';
      return res.sendStatus(500);
    }

    const headerSig = req.headers['x-hub-signature-256'];
    const { buf, json } = parseMetaBody(req);
    const expected = computeMetaSignature(buf);

    if (!expected || !safeEqual(String(headerSig || ''), expected)) {
      metaWebhookStats.total++;
      metaWebhookStats.rejected++;
      metaWebhookStats.last_at = new Date().toISOString();
      metaWebhookStats.last_error = 'signature_mismatch';
      metaDebugLog('Signature mismatch', {
        hasHeader: Boolean(headerSig),
        headerLen: String(headerSig || '').length,
        expectedLen: String(expected || '').length,
      });
      return res.sendStatus(401);
    }

    // Respond fast; queue/process async
    res.status(200).send('EVENT_RECEIVED');

    metaWebhookStats.total++;
    metaWebhookStats.accepted++;
    metaWebhookStats.last_at = new Date().toISOString();
    metaWebhookStats.last_error = null;

    setImmediate(async () => {
      try {
        if (process.env.DATABASE_URL && db && typeof db.insertMetaWebhookEvent === 'function') {
          await db.insertMetaWebhookEvent({
            objectType: String((json && json.object) || ''),
            payload: json || {},
            signature: String(headerSig || ''),
            signatureOk: true
          });
          metaWebhookStats.queued++;
          return;
        }
      } catch (err) {
        metaDebugLog('Queue insert failed, falling back to inline processing:', err?.message);
      }

      // Fallback: process inline (dev/no-db)
      try {
        await processMetaWebhookPayload(json || {});
        metaWebhookStats.processed_ok++;
        metaWebhookStats.last_processed_at = new Date().toISOString();
      } catch (err) {
        metaWebhookStats.processed_failed++;
        metaWebhookStats.last_error = err?.message || 'processing_error';
      }
    });
  } catch (e) {
    console.error('Meta webhook handler error:', e.message);
    metaWebhookStats.total++;
    metaWebhookStats.rejected++;
    metaWebhookStats.last_at = new Date().toISOString();
    metaWebhookStats.last_error = e?.message || 'handler_error';
    return res.sendStatus(400);
  }
}

app.post('/api/webhooks/meta', handleMetaWebhookPost);
app.post('/webhooks/meta', handleMetaWebhookPost);

db.initDb()
  .then(() => {
    console.log('✅ Storage initialized successfully');
  })
  .catch(err => {
    console.error('⚠️ Storage initialization failed:', err.message);
    console.error('⚠️ Server will start anyway — DB operations may fail until resolved.');
  })
  .finally(() => {
    // Start HTTP Server ALWAYS — even if DB init fails.
    // Previously server.listen was only inside .then(), meaning a DB error
    // caused "Cannot GET /" because the HTTP server never started.
    server.listen(PORT, '0.0.0.0', async () => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🚀 Server running on port ${PORT}`);
      try {
        if (db.pool) {
          console.log('✅ Waiting for frontend UI login to instantiate specific Baileys clients.');
        }
      } catch (err) {
        console.error('Boot err', err);
      }

      // Start Meta webhook queue processor (durable; survives restarts)
      try {
        if (META_EVENT_PROCESSOR_ENABLED && process.env.DATABASE_URL && db && typeof db.claimMetaWebhookEvents === 'function') {
          if (!metaQueueTimer) {
            metaQueueTimer = setInterval(() => {
              pollMetaWebhookQueue().catch(() => { /* handled inside */ });
            }, Math.max(500, META_EVENT_PROCESSOR_INTERVAL_MS || 1500));
            // kick once
            setTimeout(() => {
              pollMetaWebhookQueue().catch(() => { /* ignore */ });
            }, 800);
            console.log('🤖 Meta webhook processor: enabled');
          }
        } else {
          console.log('ℹ️ Meta webhook processor: disabled (no DB or META_EVENT_PROCESSOR_ENABLED=false)');
        }
      } catch (e) {
        console.warn('⚠️ Failed to start Meta webhook processor:', e.message);
      }

      // Start Meta outbox sender (reliable outbound with retries)
      try {
        if (META_OUTBOX_ENABLED && process.env.DATABASE_URL && db && db.pool) {
          if (!metaOutboxTimer) {
            metaOutboxTimer = setInterval(() => {
              pollMetaOutbox().catch(() => { /* handled inside */ });
            }, Math.max(500, META_OUTBOX_INTERVAL_MS || 1200));
            setTimeout(() => {
              pollMetaOutbox().catch(() => { /* ignore */ });
            }, 1000);
            console.log('📤 Meta outbox: enabled');
          }
        } else {
          console.log('ℹ️ Meta outbox: disabled (no DB or META_OUTBOX_ENABLED=false)');
        }
      } catch (e) {
        console.warn('⚠️ Failed to start Meta outbox:', e.message);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    });
  });

// ═══════════════════════════════════════════════════════════════
// 🛡️ Error Handlers & Graceful Shutdown
// ═══════════════════════════════════════════════════════════════

process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err.message);
  console.error('Stack:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

    try {
      try {
        if (metaQueueTimer) {
          clearInterval(metaQueueTimer);
          metaQueueTimer = null;
        }
      } catch {
        // ignore
      }

      try {
        if (metaOutboxTimer) {
          clearInterval(metaOutboxTimer);
          metaOutboxTimer = null;
        }
      } catch {
        // ignore
      }

      server.close(() => {
        console.log('✅ HTTP server closed');
      });

    if (db.closePool) {
      await db.closePool();
      console.log('✅ Database connections closed');
    }

    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ═══════════════════════════════════════════════════════════════
// 🔌 SOCKET.IO CONNECTION
// ═══════════════════════════════════════════════════════════════

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (!token) {
    return next(new Error('Authentication error: Token required'));
  }
  try {
    const data = verifyAnyToken(token);
    if (!data.tenantId) throw new Error();
    socket.tenantId = data.tenantId;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

io.on('connection', (socket) => {
  const tenantId = socket.tenantId;
  socket.join(tenantId);
  console.log(`👤 NEW UI CLIENT CONNECTED [${tenantId}]: ${socket.id} (Total: ${io.engine.clientsCount})`);

  // Async fetch health from worker
  fetchJsonWithRetry(`http://localhost:4001/api/internal/status/${tenantId}`, {
    headers: { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET }
  }, { retries: 1, timeoutMs: 4000 })
    .then(data => {
      let status = 'OFFLINE';
      if (data.isReady) status = 'CONNECTED';
      else if (data.qr) status = 'SYNCING';

      socket.emit('crm:health_check', {
        whatsapp: status,
        connectedNumber: data.number,
        error: data.error,
        socket_clients: io.engine.clientsCount,
        timestamp: new Date().toISOString()
      });

      if (data.qr && !data.isReady) {
        // Not returning the whole QR string in health status usually, so wait for the worker to broadcast qr via webhook
      }

      if (data.isReady) {
        socket.emit('authenticated', { status: 'authenticated' });
        socket.emit('ready', { status: 'connected' });
      }
    })
    .catch(err => {
      console.warn(`⚠️ Worker status fetch failed [${tenantId}]:`, err.message);
      socket.emit('crm:health_check', { whatsapp: 'OFFLINE', socket_clients: io.engine.clientsCount });
    });

  socket.on('disconnect', (reason) => {
    console.log(`👤 UI CLIENT DISCONNECTED [${tenantId}]: ${socket.id} (${reason})`);
  });
});

// ═══════════════════════════════════════════════════════════════
// 🪝 INTERNAL WEBHOOK (From WhatsApp Worker to UI)
// ═══════════════════════════════════════════════════════════════

function normalizeText(text, caseSensitive) {
  const raw = String(text || '');
  return caseSensitive ? raw : raw.toLowerCase();
}

function matchRoutingRule(rule, message) {
  if (!rule || !rule.enabled) return false;
  if (!rule.fieldId || !rule.setValue) return false;
  const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
  const kws = keywords.map(k => String(k || '').trim()).filter(Boolean);
  if (kws.length === 0) return false;

  const matchMode = rule.matchMode === 'all' ? 'all' : 'any';
  const matchType = rule.matchType || 'contains';
  const caseSensitive = Boolean(rule.caseSensitive);

  const rawMsg = String(message || '');
  const trimmed = rawMsg.trim();
  if (!trimmed) return false;

  // Ignore non-text placeholders emitted by the WhatsApp worker
  if (/^\[(?:Image|Video|Document|Audio|Sticker|Location|Contact|Reaction|Button|List|Template|Unsupported message)\]$/i.test(trimmed)) {
    return false;
  }
  const msg = normalizeText(rawMsg, caseSensitive);

  // Excludes: always treated as simple contains
  const excludes = Array.isArray(rule.excludeKeywords) ? rule.excludeKeywords : [];
  const ex = excludes.map(k => String(k || '').trim()).filter(Boolean);
  if (ex.length > 0) {
    const hasExcluded = ex.some(x => msg.includes(normalizeText(x, caseSensitive)));
    if (hasExcluded) return false;
  }

  function matchOne(kwRaw) {
    const kw = String(kwRaw || '').trim();
    if (!kw) return false;

    if (matchType === 'regex') {
      try {
        const re = new RegExp(kw, caseSensitive ? '' : 'i');
        return re.test(rawMsg);
      } catch {
        return false;
      }
    }

    const needle = normalizeText(kw, caseSensitive);
    if (matchType === 'startsWith') return msg.startsWith(needle);
    if (matchType === 'exact') return msg === needle;
    // default: contains
    return msg.includes(needle);
  }

  const matched = matchMode === 'all'
    ? kws.every(matchOne)
    : kws.some(matchOne);

  return Boolean(matched);
}

async function maybeApplyRoutingRulesToLead(tenantId, lead, message, meta) {
  if (!process.env.DATABASE_URL) return null;
  if (!db || typeof db.getCRMSettings !== 'function' || typeof db.updateLeadFields !== 'function') return null;
  if (!lead || !lead.id) return null;

  const settings = await db.getCRMSettings(tenantId).catch(() => null);
  const rules = settings && Array.isArray(settings.routingRules) ? settings.routingRules : [];
  if (!rules || rules.length === 0) return null;

  const extra = (lead.extra_data && typeof lead.extra_data === 'object') ? lead.extra_data : {};

  for (const rule of rules) {
    if (!rule || !rule.enabled) continue;
    if (!rule.fieldId || !rule.setValue) continue;

    const fieldAlreadySet = extra && extra[rule.fieldId] !== undefined && String(extra[rule.fieldId] || '').trim() !== '';
    const lock = rule.lockFieldAfterMatch !== false;
    if (lock && fieldAlreadySet) {
      continue; // don't re-apply / don't overwrite
    }

    if (!matchRoutingRule(rule, message)) continue;

    const updates = {
      extra_data: { [rule.fieldId]: rule.setValue }
    };
    if (rule.targetStage) {
      updates.status = rule.targetStage;
    }

    const updated = await db.updateLeadFields(lead.id, updates, tenantId).catch(() => null);
    if (updated) {
      // Audit log (system action)
      if (typeof db.logAuditAction === 'function') {
        db.logAuditAction({
          tenantId,
          userId: null,
          action: 'ROUTING_MATCH',
          entityType: 'lead',
          entityId: lead.id,
          details: {
            ruleId: rule.id,
            fieldId: rule.fieldId,
            setValue: rule.setValue,
            targetStage: rule.targetStage || null,
            whatsapp_id: meta && meta.whatsapp_id ? meta.whatsapp_id : null,
            fromMe: meta && meta.fromMe ? true : false
          }
        });
      }
    }

    return updated;
  }

  return null;
}

app.post('/api/internal/webhook', async (req, res) => {
  if (INTERNAL_WEBHOOK_SECRET) {
    const incomingSecret = req.headers['x-internal-secret'];
    if (!safeEqual(incomingSecret, INTERNAL_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized internal webhook' });
    }
  } else {
    console.warn('⚠️ INTERNAL_WEBHOOK_SECRET is not set; internal webhook is running in compatibility mode');
  }

  const { tenantId, event, payload } = req.body;
  if (!tenantId || !event) return res.status(400).json({ error: 'Invalid payload' });

  // Apply routing rules server-side (both incoming and outgoing)
  // This ensures first matching message assigns the field and won't change later.
  if (event === 'new_message' && process.env.DATABASE_URL && payload && payload.phone && payload.message) {
    try {
      const lead = (db && typeof db.findLeadByPhone === 'function')
        ? await db.findLeadByPhone(payload.phone, tenantId)
        : null;
      if (lead) {
        const updated = await maybeApplyRoutingRulesToLead(tenantId, lead, payload.message, payload);
        if (updated) {
          io.to(tenantId).emit('lead_updated', updated);
        }
      }
    } catch (e) {
      console.warn('⚠️ Routing apply failed (internal webhook):', e.message);
    }

    // Telegram notifications for inbound WhatsApp messages
    try {
      if (payload && payload.fromMe === false) {
        notifyTelegramInbound({
          tenantId,
          source: payload.source || 'whatsapp',
          phone: payload.phone,
          name: payload.name || null,
          message: payload.message,
          externalId: payload.whatsapp_id || null
        });
      }
    } catch {
      // ignore
    }
  }

  // Forward the event to the tenant's WebSocket room
  // Events: 'new_message', 'qr_code', 'ready', 'authenticated', 'auth_failure', 'message_sent'
  io.to(tenantId).emit(event, payload);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// 🛠️ API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// 🔐 AUTHENTICATION API
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ALLOW_LEGACY_MASTER_PASSWORD = process.env.ALLOW_LEGACY_MASTER_PASSWORD === 'true';

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || username.trim() === '') {
    return res.status(400).json({ success: false, error: 'İstifadəçi adı daxil edilməlidir' });
  }

  const normalizedUsername = username.toLowerCase().trim();

  if (!password || password.trim() === '') {
    return res.status(400).json({ success: false, error: 'Şifrə daxil edilməlidir' });
  }

  if (!process.env.DATABASE_URL || typeof db.findUserByUsername !== 'function') {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Render Environment-da DATABASE_URL əlavə edin.'
    });
  }

  // Find user in database to determine role and tenant mapping
  let user = await db.findUserByUsername(normalizedUsername);

  if (!user) {
    return res.status(401).json({ success: false, error: 'İstifadəçi tapılmadı' });
  }

  let validPassword = await verifyPassword(password, user.password_hash);

  if (!validPassword && ALLOW_LEGACY_MASTER_PASSWORD && ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    validPassword = true;
  }

  if (!validPassword) {
    return res.status(401).json({ success: false, error: 'Şifrə yalnışdır' });
  }

  // One-time migration: if plaintext was used previously, upgrade to bcrypt hash after successful login
  if (!isBcryptHash(user.password_hash) && typeof db.updateUserPasswordHash === 'function') {
    try {
      const upgradedHash = await hashPassword(password);
      await db.updateUserPasswordHash(user.id, upgradedHash);
      user.password_hash = upgradedHash;
    } catch (err) {
      console.warn('⚠️ Password hash upgrade failed:', err.message);
    }
  }

  // Ensure WhatsApp session is pre-initialized for their tenant cleanly via worker
  fetchJsonWithRetry(`http://localhost:4001/api/internal/start/${user.tenant_id}`, {
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET }
  }, { retries: 1, timeoutMs: 4000 })
    .catch((err) => {
      console.warn(`⚠️ Worker start request failed [${user.tenant_id}]:`, err.message);
    });

  // Generate simple token (In production, use true JWT with signing secret)
  const tokenPayload = {
    id: user.id,
    username: user.username,
    tenantId: user.tenant_id,
    role: user.role,
    permissions: user.permissions || {},
    displayName: user.display_name || null
  };
  const token = signAuthToken(tokenPayload);

  res.json({
    success: true,
    token,
    tenantId: user.tenant_id,
    role: user.role,
    id: user.id,
    username: user.username,
    permissions: user.permissions || {},
    displayName: user.display_name || null
  });
}));

app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body;
  try {
    const data = verifyAnyToken(token);
    if (data.tenantId) {
      res.json({
        success: true,
        valid: true,
        tenantId: data.tenantId,
        id: data.id,
        role: data.role,
        username: data.username,
        permissions: data.permissions || {},
        displayName: data.displayName || null
      });
    } else {
      throw new Error();
    }
  } catch (err) {
    res.status(401).json({ success: false, valid: false });
  }
});

// Middleware for API routes
const requireTenantAuth = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

  try {
    const data = verifyAnyToken(token);
    if (!data.tenantId) throw new Error();
    req.tenantId = data.tenantId;
    req.userRole = data.role; // Extract role from token
    req.userId = data.id;     // Extract ID from token
    req.userPermissions = data.permissions || {}; // Extract permissions
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

function toSafeTenantId(tenantId) {
  return String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Media embeds (img/audio/video) cannot reliably send Authorization headers.
// For media routes we also accept `?token=...` as a compatibility path.
const requireTenantAuthFlexible = (req, res, next) => {
  const headerToken = req.headers['authorization']?.replace('Bearer ', '') || '';
  const queryToken = (req.query && req.query.token) ? String(req.query.token) : '';
  const token = headerToken || queryToken;
  if (!token) return res.status(401).send('Unauthorized');

  try {
    const data = verifyAnyToken(token);
    if (!data.tenantId) throw new Error();
    req.tenantId = data.tenantId;
    req.userRole = data.role;
    req.userId = data.id;
    req.userPermissions = data.permissions || {};
    next();
  } catch {
    res.status(401).send('Unauthorized');
  }
};

const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════
// 📎 MEDIA SERVING (WhatsApp attachments)
// ═══════════════════════════════════════════════════════════════

const MEDIA_ROOT = path.join(__dirname, 'media');

app.use('/api/media', requireTenantAuthFlexible, (req, res, next) => {
  // URL shape: /api/media/:tenantSafe/:file
  const parts = String(req.path || '').split('/').filter(Boolean);
  const tenantFromUrl = parts[0] ? String(parts[0]) : '';
  if (!tenantFromUrl) return res.status(400).send('Missing tenant');

  const safeFromToken = toSafeTenantId(req.tenantId);
  const safeFromUrl = toSafeTenantId(tenantFromUrl);
  if (safeFromToken !== safeFromUrl) return res.status(403).send('Forbidden');

  // Basic hardening (express.static also prevents path traversal)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static(MEDIA_ROOT, {
  index: false,
  fallthrough: false,
  etag: true,
  maxAge: NODE_ENV === 'production' ? '7d' : 0,
  setHeaders: (res) => {
    if (NODE_ENV !== 'production') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Tenant profile (display name, etc.)
app.get('/api/tenant/profile', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const adminUser = await db.getTenantAdmin(req.tenantId);
  res.json({
    tenantId: req.tenantId,
    displayName: adminUser?.display_name || null
  });
}));

// 👥 USER MANAGEMENT API (Phase 2)
app.get('/api/users', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  // Superadmin can see all, regular admin/worker only sees their tenant's users
  const targetTenant = req.userRole === 'superadmin' ? null : req.tenantId;
  const users = await db.getUsers(targetTenant);
  res.json(users);
}));

app.post('/api/users', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const { username, password, role, permissions } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' });
  }

  if (role !== 'admin' && role !== 'worker') {
    return res.status(400).json({ error: 'Invalid role. Must be admin or worker' });
  }

  // Regular admins cannot create users for other tenants
  const tenantId = req.tenantId;

  try {
    const passwordHash = await hashPassword(password);
    // Note: User creation receives permissions via arguments
    const newUser = await db.createUser(username.toLowerCase(), passwordHash, role, permissions, tenantId);
    res.status(201).json(newUser);
  } catch (err) {
    if (err.message === 'Username already exists') {
      res.status(409).json({ error: 'İstifadəçi adı artıq mövcuddur' });
    } else {
      throw err;
    }
  }
}));

app.put('/api/users/:id/role', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const { role } = req.body;

  if (role !== 'admin' && role !== 'worker') {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const updatedUser = await db.updateUserRole(req.params.id, role, req.tenantId);
  res.json(updatedUser);
}));

app.put('/api/users/:id/permissions', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const { permissions } = req.body;

  const updatedUser = await db.updateUserPermissions(req.params.id, permissions, req.tenantId);
  res.json(updatedUser);
}));

app.delete('/api/users/:id', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  await db.deleteUser(req.params.id, req.tenantId);
  res.json({ success: true });
}));

// 📋 AUDIT LOGS API (Phase 3)
app.get('/api/audit-logs', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const logs = await db.getAuditLogs(req.tenantId, 100);
  res.json(logs);
}));

// � SUPER ADMIN API (Phase 3)
app.get('/api/admin/tenants', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }
  const tenants = await db.getSuperAdminTenants();

  // Assume connected for now, real status checked on dashboard load via healthchecks
  const tenantsWithStatus = tenants.map(t => {
    return { ...t, whatsapp_status: 'connected' };
  });

  res.json(tenantsWithStatus);
}));

app.post('/api/admin/tenants', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }

  const { tenantId, adminUsername, adminPassword, displayName } = req.body;

  if (!tenantId || !tenantId.trim() || !adminUsername || !adminPassword) {
    return res.status(400).json({ error: 'Müştəri ID-si, admin adı və şifrə mütləqdir' });
  }

  const cleanTenantId = tenantId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

  try {
    const adminPasswordHash = await hashPassword(adminPassword);
    const newAdmin = await db.createUser(adminUsername.toLowerCase(), adminPasswordHash, 'admin', {}, cleanTenantId, displayName);

    // Auto-init WhatsApp session for the new tenant via worker
    fetchJsonWithRetry(`http://localhost:4001/api/internal/start/${cleanTenantId}`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET }
    }, { retries: 1, timeoutMs: 4000 })
      .catch((err) => {
        console.warn(`⚠️ Worker start request failed [${cleanTenantId}]:`, err.message);
      });

    res.status(201).json({ success: true, tenant: newAdmin });
  } catch (err) {
    if (err.message === 'Username already exists') {
      res.status(409).json({ error: 'Bu admin istifadəçi adı artıq mövcuddur' });
    } else {
      throw err;
    }
  }
}));

app.delete('/api/admin/tenants/:id', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }

  const targetTenantId = req.params.id;
  if (!targetTenantId || targetTenantId === 'admin') {
    return res.status(400).json({ error: 'Yanlış şirkət ID-si və ya əsas admin silinə bilməz' });
  }

  try {
    const success = await db.deleteTenant(targetTenantId);
    if (success) {
      res.json({ success: true, message: 'Şirkət uğurla silindi' });
    } else {
      res.status(400).json({ error: 'Şirkət silinə bilmədi' });
    }
  } catch (err) {
    console.error('Error deleting tenant:', err);
    res.status(500).json({ error: 'Server xətası: Şirkət silinə bilmədi' });
  }
}));

app.get('/api/admin/tenants/:id/details', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }

  const targetTenantId = req.params.id;
  if (!targetTenantId) return res.status(400).json({ error: 'Tenant ID required' });

  try {
    const users = await db.getUsers(targetTenantId);
    const leadStats = await db.getLeadStats(targetTenantId);
    // Fetch the 10 most recent leads
    const recentLeads = await db.getLeads({ limit: 10 }, targetTenantId);

    res.json({
      tenantId: targetTenantId,
      users,
      leadStats,
      recentLeads
    });
  } catch (err) {
    console.error('Error fetching tenant details:', err);
    res.status(500).json({ error: 'Failed to fetch tenant details' });
  }
}));

app.post('/api/admin/impersonate/:tenantId', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }

  const targetTenantId = req.params.tenantId;
  const adminUser = await db.getTenantAdmin(targetTenantId);

  if (!adminUser) {
    return res.status(404).json({ error: 'Bu şirkət üçün aktiv admin tapılmadı' });
  }

  const tokenPayload = {
    id: adminUser.id,
    role: adminUser.role,
    tenantId: adminUser.tenant_id,
    username: adminUser.username,
    permissions: adminUser.permissions || {},
    displayName: adminUser.display_name || null
  };
  const token = signAuthToken(tokenPayload);

  res.json({
    success: true,
    token,
    tenantId: adminUser.tenant_id,
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role,
    permissions: adminUser.permissions || {},
    displayName: adminUser.display_name || null
  });
}));

// 🚀 WHATSAPP CONTROL API
app.post('/api/whatsapp/start', requireTenantAuth, asyncHandler(async (req, res) => {
  console.log(`🚀 Manual WhatsApp Start Requested via CRM UI [${req.tenantId}]`);
  try {
    const data = await fetchJsonWithRetry(`http://localhost:4001/api/internal/start/${req.tenantId}`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET }
    }, { retries: 1, timeoutMs: 5000 });
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, message: 'Worker is unavailable' });
  }
}));

// 🗄️ LEADS API
app.get('/api/leads', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const { status, startDate, endDate, limit, offset } = req.query;
  const leads = await db.getLeads({ status, startDate, endDate, limit: limit ? parseInt(limit) : undefined, offset: offset ? parseInt(offset) : undefined }, req.tenantId);
  res.json(leads);
}));

app.post('/api/leads', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.createLead(req.body, req.tenantId);
  res.status(201).json(lead);
}));

app.put('/api/leads/:id/status', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const beforeRes = await db.pool.query(
    'SELECT status FROM leads WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  const oldStatus = beforeRes.rows[0]?.status || null;
  const lead = await db.updateLeadStatus(req.params.id, req.body.status, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.to(req.tenantId).emit('lead_updated', lead);

  // Audit Log
  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'UPDATE_STATUS',
    entityType: 'lead',
    entityId: req.params.id,
    details: { oldStatus, newStatus: req.body.status }
  });

  res.json(lead);
}));

app.put('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  // Field-Level Security: Prevent budget edits if permission is missing (default true for backwards compatibility if not explicitly false)
  if (req.body.value !== undefined && req.userPermissions.view_budget === false) {
    return res.status(403).json({ error: 'Büdcəni dəyişmək üçün icazəniz yoxdur' });
  }

  const beforeRes = await db.pool.query(
    'SELECT name, value, product_name, assignee_id, status, extra_data FROM leads WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  const before = beforeRes.rows[0] || null;

  const lead = await db.updateLeadFields(req.params.id, req.body, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.to(req.tenantId).emit('lead_updated', lead);

  // Audit Log
  const changed = {};
  const isSame = (a, b) => {
    if (a === b) return true;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  };
  const putChange = (key, fromV, toV) => {
    if (isSame(fromV, toV)) return;
    changed[key] = { from: fromV, to: toV };
  };

  if (before) {
    putChange('status', before.status ?? null, lead.status ?? null);
    putChange('name', before.name ?? null, lead.name ?? null);
    putChange('product_name', before.product_name ?? null, lead.product_name ?? null);
    putChange('assignee_id', before.assignee_id ?? null, lead.assignee_id ?? null);
    putChange('value', before.value ?? null, lead.value ?? null);
  }

  const isSimple = (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true;
    if (Array.isArray(v)) {
      if (v.length > 12) return false;
      return v.every((x) => x === null || x === undefined || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
    }
    return false;
  };

  const changedExtra = {};
  if (before && before.extra_data && lead.extra_data && typeof before.extra_data === 'object' && typeof lead.extra_data === 'object') {
    const keys = new Set([...(Object.keys(before.extra_data || {})), ...(Object.keys(lead.extra_data || {}))]);
    let n = 0;
    for (const k of keys) {
      if (n >= 30) break;
      if (k === 'ad' || k === 'quotedAd' || k === 'ctwa') continue;
      const fromV = before.extra_data ? before.extra_data[k] : null;
      const toV = lead.extra_data ? lead.extra_data[k] : null;
      if (isSame(fromV, toV)) continue;
      if (!isSimple(fromV) || !isSimple(toV)) continue;
      changedExtra[k] = { from: fromV ?? null, to: toV ?? null };
      n++;
    }
  }

  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'UPDATE_FIELDS',
    entityType: 'lead',
    entityId: req.params.id,
    details: {
      fields: Object.keys(req.body),
      changed,
      changedExtra
    }
  });

  res.json(lead);
}));

// Lead Story / Timeline (messages + audit events)
app.get('/api/leads/:id/story', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const leadId = req.params.id;

  const includeMessages = String(req.query.includeMessages || '').trim() === '1';

  let limit = parseInt(String(req.query.limit || '800'), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 800;
  if (limit > 2500) limit = 2500;

  const leadRes = await db.pool.query(
    'SELECT id, phone, source, created_at, updated_at, last_message, source_message FROM leads WHERE id = $1 AND tenant_id = $2',
    [leadId, req.tenantId]
  );
  if (leadRes.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
  const lead = leadRes.rows[0];

  const msgsRes = includeMessages
    ? await db.pool.query(
        `SELECT id, body, direction, metadata, status, created_at
         FROM messages
         WHERE tenant_id = $1 AND (lead_id = $2 OR phone = $3)
         ORDER BY created_at DESC
         LIMIT $4`,
        [req.tenantId, leadId, lead.phone, limit]
      )
    : { rows: [] };

  const auditsRes = await db.pool.query(
    `SELECT a.id, a.action, a.details, a.created_at, a.user_id,
            u.username, u.display_name
     FROM audit_logs a
     LEFT JOIN users u ON a.user_id = u.id
     WHERE a.tenant_id = $1
       AND a.entity_type = 'lead'
       AND a.entity_id = $2
     ORDER BY a.created_at DESC
     LIMIT $3`,
    [req.tenantId, leadId, limit]
  );

  const events = [];

  // Synthetic: lead created
  if (lead.created_at) {
    events.push({
      id: `a:created:${leadId}`,
      kind: 'audit',
      at: new Date(lead.created_at).toISOString(),
      action: 'LEAD_CREATED',
      user: null,
      details: { source: lead.source || null }
    });
  }

  if (includeMessages) {
    for (const m of (msgsRes.rows || [])) {
      events.push({
        id: `m:${m.id}`,
        kind: 'message',
        at: m.created_at ? new Date(m.created_at).toISOString() : new Date().toISOString(),
        message: {
          id: m.id,
          body: m.body,
          direction: m.direction,
          status: m.status,
          metadata: m.metadata || {}
        }
      });
    }
  }

  for (const a of (auditsRes.rows || [])) {
    events.push({
      id: `a:${a.id}`,
      kind: 'audit',
      at: a.created_at ? new Date(a.created_at).toISOString() : new Date().toISOString(),
      action: a.action,
      user: a.user_id ? { id: a.user_id, username: a.username || null, displayName: a.display_name || null } : null,
      details: a.details || {}
    });
  }

  events.sort((x, y) => {
    const ax = Date.parse(x.at || '');
    const ay = Date.parse(y.at || '');
    return (Number.isFinite(ax) ? ax : 0) - (Number.isFinite(ay) ? ay : 0);
  });

  res.json({ leadId, count: events.length, events });
}));

// Internal note for the lead (adds a timeline entry)
app.post('/api/leads/:id/notes', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const leadId = req.params.id;
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note is required' });

  const leadRes = await db.pool.query('SELECT id FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, req.tenantId]);
  if (leadRes.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });

  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'LEAD_NOTE',
    entityType: 'lead',
    entityId: leadId,
    details: { note }
  });

  res.status(201).json({ success: true });
}));

// 🗑️ FACTORY RESET — delete ALL leads and messages FOR TENANT
// NOTE: This route MUST appear before /api/leads/:id to avoid being shadowed.
app.delete('/api/leads/all', requireTenantAuth, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'alnız SuperAdmin məlumatları sıfırlaya bilər' });
  }
  const { password } = req.body;

  const user = await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!user.rows[0]) return res.status(404).json({ error: 'İstifadəçi tapılmadı' });

  const validPass = await verifyPassword(password, user.rows[0].password_hash);
  if (!validPass) return res.status(401).json({ error: 'Şifrə yalnışdır' });

  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  await db.deleteAllLeads(req.tenantId);
  io.to(req.tenantId).emit('leads_reset', {});

  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'FACTORY_RESET',
    entityType: 'tenant',
    entityId: null,
    details: {}
  });

  res.json({ success: true, message: 'All leads and messages deleted for tenant' });
}));

app.delete('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.deleteLead(req.params.id, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // Broadcast deletion to tenant clients
  io.to(req.tenantId).emit('lead_deleted', lead.id);

  // Audit Log
  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'DELETE_LEAD',
    entityType: 'lead',
    entityId: req.params.id,
    details: { phone: lead.phone }
  });

  res.json(lead);
}));

// 🧹 CLEANUP: Merge duplicate leads with same last 9 phone digits (Global Script - Can be secured in phase 2)
app.post('/api/leads/cleanup-duplicates', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  const result = await db.pool.query('SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at ASC', [req.tenantId]);
  const leads = result.rows;
  const merged = [];
  const seenSuffixes = new Map(); // suffix -> lead_id

  for (const lead of leads) {
    const rawPhone = String(lead.phone || '').trim();
    const lower = rawPhone.toLowerCase();
    // Only merge WhatsApp-style numeric leads; skip external IDs like fb:/ig:
    if (lower.startsWith('fb:') || lower.startsWith('ig:') || lower.startsWith('meta:')) {
      continue;
    }
    const phone = rawPhone.replace(/\D/g, '');
    if (!phone || phone.length < 7 || phone.length > 15) continue;

    const suffix = phone.length >= 9 ? phone.slice(-9) : phone;

    if (seenSuffixes.has(suffix)) {
      // This is a duplicate – merge into the first lead seen with same suffix
      const canonicalId = seenSuffixes.get(suffix);
      // Merge: update the canonical lead's last_message if empty, then delete duplicate
      await db.pool.query(`
        UPDATE leads
        SET
          last_message = COALESCE(leads.last_message, $1),
          name = COALESCE(leads.name, $2),
          updated_at = NOW()
        WHERE id = $3 AND tenant_id = $4
      `, [lead.last_message, lead.name, canonicalId, req.tenantId]);

      await db.pool.query('DELETE FROM leads WHERE id = $1 AND tenant_id = $2', [lead.id, req.tenantId]);
      merged.push({ deleted: lead.id, mergedInto: canonicalId, phone: lead.phone });
      console.log(`🧹 Merged duplicate: ${lead.phone} → ${canonicalId}`);
    } else {
      seenSuffixes.set(suffix, lead.id);
    }
  }

  // Broadcast updated lead list to the tenant
  const updatedLeads = await db.getLeads({}, req.tenantId);
  io.to(req.tenantId).emit('leads_updated', updatedLeads);

  res.json({ merged, count: merged.length, message: `Merged ${merged.length} duplicate leads` });
}));

app.get('/api/leads/:id/messages', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const leadRes = await db.pool.query(
    'SELECT id, phone, last_message, source_message, created_at, updated_at FROM leads WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  if (leadRes.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
  const lead = leadRes.rows[0];

  let messages = await db.getMessages(req.params.id, req.tenantId);

  // Fallback: if messages are attached to a different lead_id (duplicate/merge), fetch by phone
  if (!messages || messages.length === 0) {
    const byPhone = await db.pool.query(
      'SELECT * FROM messages WHERE phone = $1 AND tenant_id = $2 ORDER BY created_at ASC',
      [lead.phone, req.tenantId]
    );
    messages = byPhone.rows || [];
  }

  // If still empty or missing snapshot fields, synthesize from lead columns
  const out = Array.isArray(messages) ? [...messages] : [];
  const bodies = new Set(out.map(m => String(m?.body || '').trim()));

  if (lead.source_message && !bodies.has(String(lead.source_message).trim())) {
    out.unshift({
      id: 'synthetic-source',
      lead_id: lead.id,
      phone: lead.phone,
      body: lead.source_message,
      direction: 'out',
      whatsapp_id: null,
      metadata: { synthetic: true, kind: 'source_message' },
      tenant_id: req.tenantId,
      status: 'delivered',
      created_at: lead.created_at
    });
  }

  if (lead.last_message && !bodies.has(String(lead.last_message).trim())) {
    out.push({
      id: 'synthetic-last',
      lead_id: lead.id,
      phone: lead.phone,
      body: lead.last_message,
      direction: 'in',
      whatsapp_id: null,
      metadata: { synthetic: true, kind: 'last_message' },
      tenant_id: req.tenantId,
      status: 'delivered',
      created_at: lead.updated_at || lead.created_at
    });
  }

  res.json(out);
}));

// Mark lead as read (shared across tenant)
app.post('/api/leads/:id/read', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.markLeadRead(req.params.id, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.to(req.tenantId).emit('lead_read', { leadId: req.params.id, timestamp: new Date().toISOString() });
  res.json({ success: true });
}));

// ADDED IN PHASE 6: Sending Messages directly to DB Queue
app.post('/api/leads/:id/messages', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  if (req.userPermissions.send_messages === false) {
    return res.status(403).json({ error: 'Sizə mesaj göndərmək icazəsi verilməyib' });
  }

  const leadId = req.params.id;
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'Message body is required' });

  // Get lead to know the phone number
  const fullLead = await db.pool.query('SELECT id, phone, name, status, source, extra_data FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, req.tenantId]);
  if (fullLead.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
  const lead = fullLead.rows[0];

  // Outgoing send is currently supported only for WhatsApp leads (Baileys worker).
  const phoneDigits = String(lead.phone || '').replace(/\D/g, '');
  const isWhatsAppLead = String(lead.source || '').toLowerCase() === 'whatsapp' && /^\d{7,15}$/.test(phoneDigits);
  if (!isWhatsAppLead) {
    return res.status(400).json({ error: 'Only WhatsApp leads can be messaged from CRM right now' });
  }

  // Insert into messages as pending
  // Compatibility: older DBs might not have sender_user_id yet.
  let insertResult = null;
  try {
    insertResult = await db.pool.query(`
      INSERT INTO messages (lead_id, phone, body, direction, status, tenant_id, sender_user_id)
      VALUES ($1, $2, $3, 'out', 'pending', $4, $5)
      RETURNING id, created_at
    `, [leadId, lead.phone, body, req.tenantId, req.userId || null]);
  } catch (e) {
    const msg = String(e?.message || 'insert_failed');
    if (msg.includes('sender_user_id') && msg.includes('does not exist')) {
      try {
        await db.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL;');
      } catch { }
      insertResult = await db.pool.query(`
        INSERT INTO messages (lead_id, phone, body, direction, status, tenant_id)
        VALUES ($1, $2, $3, 'out', 'pending', $4)
        RETURNING id, created_at
      `, [leadId, lead.phone, body, req.tenantId]);
    } else {
      throw e;
    }
  }

  const newMsg = insertResult.rows[0];

  // Optimmistically emit to UI
  const payload = {
    phone: lead.phone,
    name: lead.name,
    message: body,
    whatsapp_id: 'pending-' + newMsg.id, // temporary UI anchor
    fromMe: true,
    timestamp: newMsg.created_at.toISOString(),
    is_fast_emit: true
  };
  io.to(req.tenantId).emit('new_message', payload);

  // Apply routing rules immediately for outgoing messages as well
  try {
    const updated = await maybeApplyRoutingRulesToLead(req.tenantId, lead, body, payload);
    if (updated) {
      io.to(req.tenantId).emit('lead_updated', updated);
    }
  } catch (e) {
    console.warn('⚠️ Routing apply failed (outgoing):', e.message);
  }

  res.status(201).json(newMsg);
}));

app.get('/api/stats', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const stats = await db.getLeadStats(req.tenantId);
  res.json(stats);
}));

// ═══════════════════════════════════════════════════════════════
// ⏱️ RESPONSE TIME ANALYTICS
// ═══════════════════════════════════════════════════════════════

function parseIsoDateOrNull(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toStageIdForConversion(settings) {
  const stages = Array.isArray(settings?.pipelineStages) ? settings.pipelineStages : [];
  const byId = stages.find((s) => String(s?.id || '').toLowerCase() === 'won');
  if (byId) return String(byId.id);
  const byLabel = stages.find((s) => /sat|sale|won/i.test(String(s?.label || '')));
  if (byLabel) return String(byLabel.id);
  const byGreen = stages.find((s) => String(s?.color || '').toLowerCase() === 'green');
  if (byGreen) return String(byGreen.id);
  return null;
}

app.get('/api/analytics/response-times', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || !db.pool) return res.status(503).json({ error: 'Database not ready' });

  const end = parseIsoDateOrNull(req.query.end) || new Date();
  const start = parseIsoDateOrNull(req.query.start) || new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  const channelsRaw = String(req.query.channels || '').trim();
  const requestedChannels = channelsRaw
    ? channelsRaw.split(',').map(s => String(s || '').trim().toLowerCase()).filter(Boolean)
    : [];

  // SLA is evaluated only for First Response Time
  const slaMinutes = (() => {
    const n = parseInt(String(req.query.sla_minutes || ''), 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 240);
    return 10;
  })();

  // Clamp: max 90 days
  const maxSpanMs = 90 * 24 * 60 * 60 * 1000;
  if ((end.getTime() - start.getTime()) > maxSpanMs) {
    return res.status(400).json({ error: 'Date range too large (max 90 days)' });
  }

  const tenantId = req.tenantId;

  // Compatibility: older DBs might not have messages.sender_user_id yet.
  // Try to add it, but also be able to run without it.
  let hasSenderUserId = false;
  try {
    const chk = await db.pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'messages'
         AND column_name = 'sender_user_id'
       LIMIT 1`
    );
    hasSenderUserId = chk.rowCount > 0;
  } catch {
    hasSenderUserId = false;
  }

  if (!hasSenderUserId) {
    try {
      await db.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL;');
      await db.pool.query('CREATE INDEX IF NOT EXISTS idx_messages_tenant_sender_created_at ON messages (tenant_id, sender_user_id, created_at);');
      const chk2 = await db.pool.query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'messages'
           AND column_name = 'sender_user_id'
         LIMIT 1`
      );
      hasSenderUserId = chk2.rowCount > 0;
    } catch {
      hasSenderUserId = false;
    }
  }

  const pick = (arr, q) => {
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))));
    return arr[idx];
  };

  const makeStats = (arr) => {
    const a = arr.slice().filter((n) => Number.isFinite(n) && n >= 0).sort((x, y) => x - y);
    return {
      count: a.length,
      avg_minutes: a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : null,
      min_minutes: a.length ? a[0] : null,
      max_minutes: a.length ? a[a.length - 1] : null,
      p50_minutes: pick(a, 0.50),
      p90_minutes: pick(a, 0.90),
    };
  };

  const uuidFromMetaExpr = `CASE
    WHEN (m.metadata->>'operator_id') ~ '^[0-9a-fA-F-]{36}$' THEN (m.metadata->>'operator_id')::uuid
    ELSE NULL
  END`;
  const responderExpr = hasSenderUserId
    ? `COALESCE(m.sender_user_id, ${uuidFromMetaExpr})`
    : `${uuidFromMetaExpr}`;

  // Default channels if none specified
  const allChannels = ['whatsapp', 'instagram', 'facebook', 'telegram', 'manual'];
  const channels = requestedChannels.length ? requestedChannels : allChannels;

  const baseCte = `
    WITH filtered AS (
      SELECT
        m.id,
        m.lead_id,
        m.direction,
        m.created_at,
        ${responderExpr} AS responder_user_id,
        l.source
      FROM messages m
      JOIN leads l ON l.id = m.lead_id AND l.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1
        AND m.created_at <= $3::timestamptz
        AND l.source = ANY($4::text[])
        AND COALESCE((m.metadata->>'synthetic')::boolean, false) = false
        AND COALESCE((m.metadata->>'bot')::boolean, false) = false
        AND COALESCE((m.metadata->>'automated')::boolean, false) = false
    ),
    ordered1 AS (
      SELECT
        f.*,
        lag(f.direction) OVER (PARTITION BY f.lead_id ORDER BY f.created_at, f.id) AS prev_dir
      FROM filtered f
    ),
    ordered AS (
      SELECT
        o.*,
        SUM(
          CASE
            WHEN o.direction = 'in' AND (o.prev_dir IS DISTINCT FROM 'in') THEN 1
            ELSE 0
          END
        ) OVER (PARTITION BY o.lead_id ORDER BY o.created_at, o.id) AS in_block
      FROM ordered1 o
    ),
    inbound_ends AS (
      SELECT lead_id, in_block, MAX(created_at) AS inbound_end_at
      FROM ordered
      WHERE direction = 'in'
      GROUP BY lead_id, in_block
    ),
    lead_first_inbound AS (
      SELECT lead_id, MIN(created_at) AS first_inbound_at
      FROM ordered
      WHERE direction = 'in'
      GROUP BY lead_id
    ),
    lead_first_block AS (
      SELECT ie.lead_id, MIN(ie.inbound_end_at) AS first_block_end_at
      FROM inbound_ends ie
      GROUP BY ie.lead_id
    ),
    frt_events AS (
      SELECT
        fi.lead_id,
        fi.first_inbound_at,
        fb.first_block_end_at AS inbound_end_at,
        o_out.created_at AS replied_at,
        o_out.responder_user_id,
        EXTRACT(EPOCH FROM (o_out.created_at - fb.first_block_end_at)) / 60.0 AS frt_minutes
      FROM lead_first_inbound fi
      JOIN lead_first_block fb ON fb.lead_id = fi.lead_id
      JOIN LATERAL (
        SELECT id, created_at, responder_user_id
        FROM ordered o
        WHERE o.lead_id = fb.lead_id
          AND o.direction = 'out'
          AND o.created_at > fb.first_block_end_at
        ORDER BY o.created_at ASC, o.id ASC
        LIMIT 1
      ) o_out ON true
      WHERE fi.first_inbound_at BETWEEN $2::timestamptz AND $3::timestamptz
        AND o_out.created_at <= $3::timestamptz
    ),
    cgt_cycles AS (
      SELECT
        ie.lead_id,
        ie.in_block,
        ie.inbound_end_at,
        o_out.created_at AS replied_at,
        o_out.responder_user_id,
        EXTRACT(EPOCH FROM (o_out.created_at - ie.inbound_end_at)) / 60.0 AS cgt_minutes
      FROM inbound_ends ie
      JOIN LATERAL (
        SELECT id, created_at, responder_user_id
        FROM ordered o
        WHERE o.lead_id = ie.lead_id
          AND o.direction = 'out'
          AND o.created_at > ie.inbound_end_at
        ORDER BY o.created_at ASC, o.id ASC
        LIMIT 1
      ) o_out ON true
      WHERE ie.inbound_end_at BETWEEN $2::timestamptz AND $3::timestamptz
        AND o_out.created_at <= $3::timestamptz
    )
  `;

  const frtSql = `${baseCte}
    SELECT lead_id, responder_user_id, frt_minutes
    FROM frt_events;
  `;
  const cgtSql = `${baseCte}
    SELECT lead_id, responder_user_id, cgt_minutes
    FROM cgt_cycles;
  `;

  const [frtRes, cgtRes] = await Promise.all([
    db.pool.query(frtSql, [tenantId, start.toISOString(), end.toISOString(), channels]),
    db.pool.query(cgtSql, [tenantId, start.toISOString(), end.toISOString(), channels])
  ]);

  const frtRows = frtRes.rows || [];
  const cgtRows = cgtRes.rows || [];

  const frtMinutes = frtRows.map(r => Number(r.frt_minutes)).filter(n => Number.isFinite(n) && n >= 0);
  const cgtMinutes = cgtRows.map(r => Number(r.cgt_minutes)).filter(n => Number.isFinite(n) && n >= 0);

  const frt = makeStats(frtMinutes);
  const cgt = makeStats(cgtMinutes);
  const art = { avg_minutes: cgt.count ? cgt.avg_minutes : null, count: cgt.count };

  const slaWithin = frtRows.filter(r => Number.isFinite(Number(r.frt_minutes)) && Number(r.frt_minutes) <= slaMinutes).length;
  const slaOutside = frt.count - slaWithin;
  const sla = {
    sla_minutes: slaMinutes,
    within_count: slaWithin,
    outside_count: slaOutside,
    within_pct: frt.count ? (slaWithin / frt.count) : null,
    outside_pct: frt.count ? (slaOutside / frt.count) : null,
  };

  // Operator aggregation
  const op = new Map();
  const toKey = (uid) => uid ? String(uid) : 'unknown';

  for (const r of frtRows) {
    const k = toKey(r.responder_user_id);
    if (!op.has(k)) op.set(k, { frt: [], cgt: [] });
    const m = Number(r.frt_minutes);
    if (Number.isFinite(m) && m >= 0) op.get(k).frt.push(m);
  }
  for (const r of cgtRows) {
    const k = toKey(r.responder_user_id);
    if (!op.has(k)) op.set(k, { frt: [], cgt: [] });
    const m = Number(r.cgt_minutes);
    if (Number.isFinite(m) && m >= 0) op.get(k).cgt.push(m);
  }

  const userIds = Array.from(op.keys()).filter((id) => id !== 'unknown');
  let usersById = {};
  if (userIds.length > 0) {
    const ures = await db.pool.query(
      'SELECT id, username, display_name FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [tenantId, userIds]
    );
    for (const u of (ures.rows || [])) {
      usersById[String(u.id)] = u.display_name || u.username || String(u.id);
    }
  }

  const by_operator = Array.from(op.entries()).map(([id, data]) => {
    const fr = makeStats(data.frt);
    const cg = makeStats(data.cgt);
    return {
      user_id: id === 'unknown' ? null : id,
      name: id === 'unknown' ? 'Unknown' : (usersById[id] || id),
      frt_count: fr.count,
      frt_avg_minutes: fr.avg_minutes,
      art_avg_minutes: cg.avg_minutes,
      cgt_count: cg.count,
      cgt_max_minutes: cg.max_minutes,
    };
  }).sort((a, b) => (b.frt_count || 0) - (a.frt_count || 0));

  res.json({
    range: { start: start.toISOString(), end: end.toISOString() },
    filters: { channels, sla_minutes: slaMinutes },
    frt,
    cgt,
    art,
    sla,
    by_operator,
  });
}));

// Routing rules stats (derived from audit_logs)
app.get('/api/routing-rules/stats', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const daysRaw = req.query.days;
  let days = parseInt(String(daysRaw || '7'), 10);
  if (!Number.isFinite(days) || days <= 0) days = 7;
  if (days > 90) days = 90;

  const result = await db.pool.query(
    `SELECT
       COALESCE(details->>'ruleId', '') AS rule_id,
       COUNT(*)::int AS count,
       MAX(created_at) AS last_at
     FROM audit_logs
     WHERE tenant_id = $1
       AND action = 'ROUTING_MATCH'
       AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
     GROUP BY COALESCE(details->>'ruleId', '')`,
    [req.tenantId, days]
  );

  const stats = {};
  for (const row of (result.rows || [])) {
    const ruleId = String(row.rule_id || '').trim();
    if (!ruleId) continue;
    stats[ruleId] = {
      count: Number(row.count || 0),
      last_at: row.last_at ? new Date(row.last_at).toISOString() : undefined
    };
  }

  res.json({ days, stats });
}));

app.get('/health', requireTenantAuth, asyncHandler(async (req, res) => {
  try {
    const data = await fetchJsonWithRetry(`http://localhost:4001/api/internal/status/${req.tenantId}`, {
      headers: { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET }
    }, { retries: 1, timeoutMs: 5000 });
    const status = data.isReady ? 'CONNECTED' : (data.qr ? 'SYNCING' : 'OFFLINE');

    let dbStatus = undefined;
    if (db.healthCheck) {
      dbStatus = await db.healthCheck(req.tenantId).catch(() => ({ status: 'error' }));
    }

    res.json({
      whatsapp: status,
      connectedNumber: data.number,
      socket_clients: io.engine.clientsCount,
      timestamp: new Date().toISOString(),
      database: dbStatus
    });
  } catch (err) {
    res.json({ whatsapp: 'OFFLINE', socket_clients: io.engine.clientsCount, timestamp: new Date().toISOString() });
  }
}));

// Public liveness probe (for Render health checks / keepalive)
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime_seconds: Math.round(process.uptime()) });
});

// Public readiness probe (checks DB + worker endpoint reachability)
app.get('/readyz', async (req, res) => {
  try {
    const checks = { db: 'unknown', worker: 'unknown' };
    if (db.healthCheck) {
      const dbHealth = await db.healthCheck().catch(() => ({ status: 'error' }));
      checks.db = dbHealth.status === 'healthy' ? 'ok' : 'error';
    } else {
      checks.db = 'ok';
    }

    await fetchJsonWithRetry('http://localhost:4001/api/internal/status/admin', {
      headers: { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET }
    }, { retries: 0, timeoutMs: 2500 });
    checks.worker = 'ok';

    const ready = checks.db === 'ok' && checks.worker === 'ok';
    return res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  } catch (err) {
    return res.status(503).json({ status: 'not_ready', checks: { db: 'unknown', worker: 'error' } });
  }
});

app.get('/chats/recent', requireTenantAuth, asyncHandler(async (req, res) => {
  console.log(`📂 RECENT CHATS REQUESTED [${req.tenantId}]`);

  // Step 1: Always load from DB first (persistent/resilient to restarts)
  let dbChats = [];
  if (process.env.DATABASE_URL && db && db.getRecentLeadsWithLatestMessage) {
    dbChats = await db.getRecentLeadsWithLatestMessage(req.tenantId, 50);
  }

  // Build a map of phone → data from DB results
  const merged = new Map();
  for (const row of dbChats) {
    merged.set(row.phone, {
      name: row.name || `+${row.phone}`,
      lastMessage: row.lastmessage || '',
      timestamp: row.timestamp ? new Date(row.timestamp).getTime() / 1000 : 0,
      phone: row.phone,
      unread: 0,
      lead_id: row.lead_id,
      status: row.status,
    });
  }

  // Step 2: Because we are fully DB-backed now, we just sort and respond
  const chatsArray = Array.from(merged.values());
  chatsArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  res.json(chatsArray.slice(0, 30));
}));

// ═══════════════════════════════════════════════════════════════
// ⚙️ CRM SETTINGS API (Phase 4)
// ═══════════════════════════════════════════════════════════════

app.get('/api/settings', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const settings = await db.getCRMSettings(req.tenantId);
  res.json({ settings }); // Returns null if no settings found, frontend will use defaults
}));

app.post('/api/settings', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  const { settings } = req.body;
  if (!settings) return res.status(400).json({ error: 'Settings object is required' });

  const updatedSettings = await db.updateCRMSettings(req.tenantId, settings);

  // Optionally, let all UI clients in the tenant know settings updated so they can reload
  io.to(req.tenantId).emit('settings_updated', updatedSettings);

  res.json({ success: true, settings: updatedSettings });
}));

// ═══════════════════════════════════════════════════════════════
// 📣 TELEGRAM NOTIFICATIONS API (per-tenant)
// ═══════════════════════════════════════════════════════════════

function maskTelegramToken(token) {
  const t = String(token || '');
  if (!t) return '';
  if (t.length <= 10) return '********';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

app.get('/api/telegram/config', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.getTelegramIntegration !== 'function') return res.status(501).json({ error: 'Telegram integration not available' });

  const row = await db.getTelegramIntegration(req.tenantId).catch(() => null);
  res.json({
    enabled: row ? (row.enabled !== false) : false,
    chat_id: row?.chat_id ? String(row.chat_id) : '',
    has_bot_token: Boolean(row?.bot_token),
    bot_token_masked: row?.bot_token ? maskTelegramToken(row.bot_token) : '',
    last_error: row?.last_error ? String(row.last_error) : null,
    last_sent_at: row?.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    last_test_at: row?.last_test_at ? new Date(row.last_test_at).toISOString() : null,
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    enabled_global: TELEGRAM_NOTIFICATIONS_ENABLED
  });
}));

app.post('/api/telegram/config', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.upsertTelegramIntegration !== 'function' || typeof db.getTelegramIntegration !== 'function') {
    return res.status(501).json({ error: 'Telegram integration not available' });
  }

  const enabled = req.body?.enabled === false ? false : true;
  const chatId = req.body?.chat_id !== undefined ? normalizeTelegramChatId(req.body.chat_id) : '';
  const botTokenRaw = req.body?.bot_token !== undefined ? normalizeTelegramBotToken(req.body.bot_token) : '';
  const clearToken = req.body?.clear_token === true;

  const existing = await db.getTelegramIntegration(req.tenantId).catch(() => null);
  const nextToken = clearToken
    ? ''
    : (botTokenRaw ? botTokenRaw : (existing?.bot_token ? String(existing.bot_token) : ''));

  const nextChat = chatId !== undefined && chatId !== null && String(chatId).trim() !== ''
    ? String(chatId).trim()
    : (existing?.chat_id ? String(existing.chat_id) : '');

  if (enabled) {
    if (!nextChat) return res.status(400).json({ error: 'chat_id is required when enabled' });
    if (!nextToken) return res.status(400).json({ error: 'bot_token is required when enabled' });
  }

  const saved = await db.upsertTelegramIntegration(req.tenantId, {
    enabled,
    chat_id: nextChat || null,
    bot_token: nextToken || null
  });

  // Bust cache for this tenant
  try { telegramConfigCache.delete(String(req.tenantId)); } catch { }

  res.json({
    success: true,
    enabled: saved.enabled !== false,
    chat_id: saved.chat_id ? String(saved.chat_id) : '',
    has_bot_token: Boolean(saved.bot_token),
    bot_token_masked: saved.bot_token ? maskTelegramToken(saved.bot_token) : ''
  });
}));

app.post('/api/telegram/test', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.getTelegramIntegration !== 'function' || typeof db.setTelegramIntegrationStatus !== 'function') {
    return res.status(501).json({ error: 'Telegram integration not available' });
  }

  const row = await db.getTelegramIntegration(req.tenantId).catch(() => null);
  const enabledStored = row ? (row.enabled !== false) : false;
  const storedToken = row?.bot_token ? String(row.bot_token) : '';
  const storedChat = row?.chat_id ? String(row.chat_id) : '';

  const overrideToken = req.body?.bot_token ? normalizeTelegramBotToken(req.body.bot_token) : '';
  const overrideChat = req.body?.chat_id ? normalizeTelegramChatId(req.body.chat_id) : '';
  const overrideTextRaw = req.body?.text ? String(req.body.text) : '';

  const allowOverride = Boolean(overrideToken || overrideChat || overrideTextRaw);
  if (!allowOverride && !enabledStored) {
    return res.status(400).json({ error: 'Telegram notifications are disabled for this tenant' });
  }

  const botToken = overrideToken || storedToken;
  const chatId = overrideChat || storedChat;
  if (!botToken || !chatId) return res.status(400).json({ error: 'Telegram bot_token/chat_id is missing' });

  const text = (overrideTextRaw || `✅ Telegram test ok\nTenant: ${String(req.tenantId)}\nTime: ${new Date().toISOString()}`).slice(0, 3500);
  try {
    await sendTelegramTextWithConfig({ botToken, chatId, text });
    if (row) {
      await db.setTelegramIntegrationStatus(req.tenantId, { last_error: null, last_test_at: new Date().toISOString() }).catch(() => null);
    }
    res.json({ ok: true, used_override: { bot_token: Boolean(overrideToken), chat_id: Boolean(overrideChat), text: Boolean(overrideTextRaw) } });
  } catch (e) {
    const msg = String(e?.message || 'test_failed');
    if (row) {
      await db.setTelegramIntegrationStatus(req.tenantId, { last_error: msg, last_test_at: new Date().toISOString() }).catch(() => null);
    }
    res.status(400).json({ error: msg });
  }
}));

app.post('/api/telegram/diagnose', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.getTelegramIntegration !== 'function') return res.status(501).json({ error: 'Telegram integration not available' });

  const row = await db.getTelegramIntegration(req.tenantId).catch(() => null);
  const stored = {
    enabled: row ? (row.enabled !== false) : false,
    chat_id: row?.chat_id ? String(row.chat_id) : '',
    has_bot_token: Boolean(row?.bot_token),
    bot_token_masked: row?.bot_token ? maskTelegramToken(row.bot_token) : '',
    last_error: row?.last_error ? String(row.last_error) : null,
    last_sent_at: row?.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    last_test_at: row?.last_test_at ? new Date(row.last_test_at).toISOString() : null,
  };

  if (!TELEGRAM_NOTIFICATIONS_ENABLED) {
    return res.json({ ok: false, enabled_global: false, stored, bot: null, chat_candidates: [] });
  }

  const botToken = row?.bot_token ? String(row.bot_token) : '';
  if (!botToken) {
    return res.json({ ok: false, enabled_global: true, stored, bot: null, chat_candidates: [] });
  }

  const base = `https://api.telegram.org/bot${encodeURIComponent(normalizeTelegramBotToken(botToken))}`;

  let bot = null;
  try {
    const me = await fetchJsonWithRetry(`${base}/getMe`, {}, { retries: 0, timeoutMs: 6000 });
    if (me && me.ok && me.result) {
      bot = {
        id: me.result.id,
        username: me.result.username || null,
        first_name: me.result.first_name || null,
        can_join_groups: Boolean(me.result.can_join_groups),
        can_read_all_group_messages: Boolean(me.result.can_read_all_group_messages),
        supports_inline_queries: Boolean(me.result.supports_inline_queries)
      };
    }
  } catch (e) {
    return res.json({ ok: false, enabled_global: true, stored, bot: null, chat_candidates: [], error: String(e?.message || 'getMe failed') });
  }

  const chat_candidates = [];
  try {
    const updates = await fetchJsonWithRetry(`${base}/getUpdates?limit=25`, {}, { retries: 0, timeoutMs: 6000 });
    const items = updates && updates.ok && Array.isArray(updates.result) ? updates.result : [];

    const seen = new Map();
    for (const u of items) {
      const msg = u?.message || u?.channel_post || null;
      const chat = msg?.chat || null;
      if (!chat || chat.id === undefined || chat.id === null) continue;
      const id = String(chat.id);
      const prev = seen.get(id);
      const date = msg?.date ? Number(msg.date) : null;
      if (prev && prev.last_date && date && date <= prev.last_date) continue;
      seen.set(id, {
        chat_id: id,
        type: chat.type ? String(chat.type) : null,
        title: chat.title ? String(chat.title) : null,
        username: chat.username ? String(chat.username) : null,
        last_date: date || null
      });
    }

    const rows = Array.from(seen.values());
    rows.sort((a, b) => (b.last_date || 0) - (a.last_date || 0));
    for (const r of rows.slice(0, 8)) {
      chat_candidates.push({
        chat_id: r.chat_id,
        type: r.type,
        title: r.title,
        username: r.username,
        last_at: r.last_date ? new Date(r.last_date * 1000).toISOString() : null
      });
    }
  } catch {
    // ignore updates failures
  }

  res.json({ ok: true, enabled_global: true, stored, bot, chat_candidates });
}));

// ═══════════════════════════════════════════════════════════════
// META (FACEBOOK/INSTAGRAM) CONNECTION API
// ═══════════════════════════════════════════════════════════════

async function exchangeForLongLivedUserToken(userAccessToken) {
  const token = String(userAccessToken || '').trim();
  if (!token) throw new Error('Token is required');
  if (!META_APP_ID || !META_APP_SECRET) {
    return { access_token: token, expires_in: null, exchanged: false };
  }

  // https://developers.facebook.com/docs/facebook-login/access-tokens/refreshing
  const url = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(String(META_APP_ID))}&client_secret=${encodeURIComponent(String(META_APP_SECRET))}&fb_exchange_token=${encodeURIComponent(token)}`;
  const data = await fetchJsonWithRetry(url, {}, { retries: 0, timeoutMs: 6000 }).catch((e) => {
    throw new Error(e?.message || 'Token exchange failed');
  });
  const outToken = data?.access_token ? String(data.access_token) : '';
  const expiresIn = data?.expires_in ? Number(data.expires_in) : null;
  if (!outToken) {
    return { access_token: token, expires_in: null, exchanged: false };
  }
  return { access_token: outToken, expires_in: Number.isFinite(expiresIn) ? expiresIn : null, exchanged: true };
}

async function fetchMetaPagesForToken(userAccessToken) {
  const token = String(userAccessToken || '').trim();
  if (!token) throw new Error('Token is required');

  const url = `https://graph.facebook.com/v19.0/me/accounts?fields=${encodeURIComponent(
    'id,name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}'
  )}&limit=200&access_token=${encodeURIComponent(token)}`;

  const data = await fetchJsonWithRetry(url, {}, { retries: 1, timeoutMs: 6000 });
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.map((p) => {
    const ig = p?.instagram_business_account || p?.connected_instagram_account || null;
    return {
      pageId: String(p?.id || ''),
      pageName: p?.name ? String(p.name) : null,
      pageAccessToken: p?.access_token ? String(p.access_token) : null,
      igBusinessId: ig?.id ? String(ig.id) : null,
      igUsername: ig?.username ? String(ig.username) : null,
    };
  }).filter((p) => p.pageId && p.pageAccessToken);
}

async function subscribeMetaWebhooks({ pageId, pageAccessToken, igBusinessId }) {
  const page = String(pageId || '').trim();
  const token = String(pageAccessToken || '').trim();
  const ig = igBusinessId ? String(igBusinessId).trim() : '';

  const out = {
    page: { ok: false, error: null },
    instagram: ig ? { ok: false, error: null } : null,
  };

  if (!page || !token) {
    out.page.error = 'Missing pageId/pageAccessToken';
    return out;
  }

  // Subscribe Page webhooks (messages + comments/feed)
  try {
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(page)}/subscribed_apps`;
    const body = new URLSearchParams({
      subscribed_fields: 'messages,feed',
      access_token: token,
    });
    await fetchJsonWithRetry(url, { method: 'POST', body }, { retries: 0, timeoutMs: 6000 });
    out.page.ok = true;
  } catch (e) {
    out.page.error = e?.message || 'Page subscribe failed';
  }

  // Subscribe IG webhooks (DM + comments)
  if (ig) {
    try {
      const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(ig)}/subscribed_apps`;
      const body = new URLSearchParams({
        subscribed_fields: 'messages,comments',
        access_token: token,
      });
      await fetchJsonWithRetry(url, { method: 'POST', body }, { retries: 0, timeoutMs: 6000 });
      out.instagram.ok = true;
    } catch (e) {
      out.instagram.error = e?.message || 'Instagram subscribe failed';
    }
  }

  return out;
}

app.post('/api/meta/discover', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });
  const ex = await exchangeForLongLivedUserToken(token).catch(() => ({ access_token: token, expires_in: null, exchanged: false }));
  const pages = await fetchMetaPagesForToken(ex.access_token);
  res.json({ pages, exchanged: Boolean(ex.exchanged), expires_in: ex.expires_in });
}));

app.post('/api/meta/connect', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.upsertMetaPage !== 'function') return res.status(501).json({ error: 'Meta integration is unavailable' });

  const token = String(req.body?.token || '').trim();
  const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!token) return res.status(400).json({ error: 'token is required' });
  if (pageIds.length === 0) return res.status(400).json({ error: 'pageIds is required' });

  const ex = await exchangeForLongLivedUserToken(token).catch((e) => ({ access_token: token, expires_in: null, exchanged: false, error: e?.message }));
  const effectiveToken = ex && ex.access_token ? ex.access_token : token;

  // Persist user token for this tenant (used for later re-connect/debug flows)
  try {
    if (typeof db.upsertMetaUserToken === 'function') {
      const expiresAt = (ex && ex.expires_in && Number.isFinite(ex.expires_in))
        ? new Date(Date.now() + (Number(ex.expires_in) * 1000))
        : null;
      await db.upsertMetaUserToken(req.tenantId, {
        user_access_token: effectiveToken,
        expires_at: expiresAt,
        debug_info: { exchanged: Boolean(ex.exchanged), source: 'connect' },
        status: 'active',
        last_error: ex?.error || null
      });
    }
  } catch {
    // non-fatal
  }

  const discovered = await fetchMetaPagesForToken(effectiveToken);
  const byId = new Map(discovered.map((p) => [p.pageId, p]));

  const saved = [];
  const subscribe = [];
  for (const pid of pageIds) {
    const p = byId.get(pid);
    if (!p || !p.pageAccessToken) continue;
    const row = await db.upsertMetaPage(req.tenantId, {
      page_id: p.pageId,
      page_name: p.pageName || null,
      page_access_token: p.pageAccessToken,
      ig_business_id: p.igBusinessId || null
    });
    if (row) saved.push(row);

    // Best-effort: subscribe app to the Page/IG for webhook delivery
    const sub = await subscribeMetaWebhooks({
      pageId: p.pageId,
      pageAccessToken: p.pageAccessToken,
      igBusinessId: p.igBusinessId || null,
    });
    subscribe.push({ pageId: p.pageId, igBusinessId: p.igBusinessId || null, result: sub });
  }

  res.status(201).json({ success: true, savedCount: saved.length, pages: saved, subscribe, exchanged: Boolean(ex.exchanged), expires_in: ex.expires_in || null });
}));

app.post('/api/meta/pages/:pageId/subscribe', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const pageId = String(req.params.pageId || '').trim();
  if (!pageId) return res.status(400).json({ error: 'pageId is required' });

  const integration = await db.getMetaPageByPageId(pageId);
  if (!integration || integration.tenant_id !== req.tenantId) {
    return res.status(404).json({ error: 'Connected page not found' });
  }

  const result = await subscribeMetaWebhooks({
    pageId: integration.page_id,
    pageAccessToken: integration.page_access_token,
    igBusinessId: integration.ig_business_id || null,
  });

  res.json({ success: true, result });
}));

// Manual retry for failed Meta outbound messages
app.post('/api/meta/messages/:id/retry', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (req.userPermissions && req.userPermissions.send_messages === false) {
    return res.status(403).json({ error: 'Sizə mesaj göndərmək icazəsi verilməyib' });
  }

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id is required' });

  const r = await db.pool.query(
    "SELECT id, tenant_id, status, direction, metadata FROM messages WHERE id = $1 AND tenant_id = $2 LIMIT 1",
    [id, req.tenantId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Message not found' });

  const msg = r.rows[0];
  const platform = String(msg?.metadata?.platform || '').toLowerCase();
  if (msg.direction !== 'out' || (platform !== 'facebook' && platform !== 'instagram')) {
    return res.status(400).json({ error: 'Not a Meta outbound message' });
  }

  await db.pool.query(
    "UPDATE messages SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = NULL WHERE id = $1 AND tenant_id = $2",
    [id, req.tenantId]
  );

  res.json({ success: true });
}));

app.get('/api/meta/pages', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.getMetaPages !== 'function') return res.status(501).json({ error: 'Meta integration is unavailable' });
  const pages = await db.getMetaPages(req.tenantId);
  res.json({ pages });
}));

app.get('/api/meta/config', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({
    hasAppId: Boolean(META_APP_ID),
    hasAppSecret: Boolean(META_APP_SECRET),
    hasVerifyToken: Boolean(META_VERIFY_TOKEN),
    dbEnabled: Boolean(process.env.DATABASE_URL),
    callbackPath: '/api/webhooks/meta'
  });
}));

app.get('/api/meta/webhook/status', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  let backlog = null;
  let outboxPending = null;
  try {
    if (process.env.DATABASE_URL && db && db.pool) {
      const r = await db.pool.query('SELECT COUNT(*)::int AS n FROM meta_webhook_events WHERE processed_at IS NULL');
      backlog = r.rows[0]?.n ?? null;

      const o = await db.pool.query(
        "SELECT COUNT(*)::int AS n FROM messages WHERE direction = 'out' AND status = 'pending' AND (metadata->>'platform') IN ('facebook','instagram')"
      );
      outboxPending = o.rows[0]?.n ?? null;
    }
  } catch {
    backlog = null;
    outboxPending = null;
  }
  res.json({ stats: { ...metaWebhookStats, backlog, outbox_pending: outboxPending } });
}));

async function postGraphForm(path, form, timeoutMs = 7000) {
  const url = `https://graph.facebook.com/v19.0/${String(path).replace(/^\//, '')}`;
  const body = form instanceof URLSearchParams ? form : new URLSearchParams(form || {});
  const json = await fetchJsonWithRetry(url, { method: 'POST', body }, { retries: 0, timeoutMs });
  return json;
}

async function postGraphJson(path, payload, accessToken, timeoutMs = 7000) {
  const url = `https://graph.facebook.com/v19.0/${String(path).replace(/^\//, '')}?access_token=${encodeURIComponent(String(accessToken || ''))}`;
  const json = await fetchJsonWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    },
    { retries: 0, timeoutMs }
  );
  return json;
}

app.post('/api/meta/leads/:id/reply', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const leadId = String(req.params.id || '').trim();
  const bodyText = String(req.body?.body || '').trim();
  const mode = String(req.body?.mode || '').trim(); // dm | comment | private
  if (!leadId) return res.status(400).json({ error: 'lead id is required' });
  if (!bodyText) return res.status(400).json({ error: 'body is required' });

  if (req.userPermissions && req.userPermissions.send_messages === false) {
    return res.status(403).json({ error: 'Sizə mesaj göndərmək icazəsi verilməyib' });
  }

  const leadRes = await db.pool.query('SELECT id, phone, name, source FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, req.tenantId]);
  if (leadRes.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
  const lead = leadRes.rows[0];

  const src = String(lead.source || '').toLowerCase();
  if (src !== 'facebook' && src !== 'instagram') {
    return res.status(400).json({ error: 'Lead is not a Meta (FB/IG) lead' });
  }

  // Find the most recent relevant inbound event metadata
  const lastCommentRes = await db.pool.query(
    "SELECT metadata FROM messages WHERE lead_id = $1 AND tenant_id = $2 AND (metadata->>'kind') = 'comment' ORDER BY created_at DESC LIMIT 1",
    [leadId, req.tenantId]
  );
  const lastDmRes = await db.pool.query(
    "SELECT metadata, direction FROM messages WHERE lead_id = $1 AND tenant_id = $2 AND (metadata->>'kind') = 'dm' ORDER BY created_at DESC LIMIT 1",
    [leadId, req.tenantId]
  );

  const commentMeta = lastCommentRes.rows[0]?.metadata || null;
  const dmMeta = lastDmRes.rows[0]?.metadata || null;
  const dmDirection = lastDmRes.rows[0]?.direction || 'in';

  const pageIdFromMeta = (commentMeta?.page_id || dmMeta?.page_id || null);
  const igFromMeta = (commentMeta?.ig_business_id || dmMeta?.ig_business_id || null);

  let integration = null;
  if (pageIdFromMeta && typeof db.getMetaPageByPageId === 'function') {
    integration = await db.getMetaPageByPageId(String(pageIdFromMeta));
  }
  if (!integration && igFromMeta && typeof db.getMetaPageByIgBusinessId === 'function') {
    integration = await db.getMetaPageByIgBusinessId(String(igFromMeta));
  }

  if (!integration || integration.tenant_id !== req.tenantId || !integration.page_access_token) {
    return res.status(400).json({ error: 'Connected Meta Page not found for this lead' });
  }

  const pageToken = integration.page_access_token;
  const igBusinessId = integration.ig_business_id || null;
  const pageId = integration.page_id;


  const nowIso = new Date().toISOString();
  let commentId = null;
  let userId = null;
  let igId = null;

  if (mode === 'comment') {
    commentId = commentMeta?.comment_id ? String(commentMeta.comment_id) : '';
    if (!commentId) return res.status(400).json({ error: 'No comment_id found to reply' });
  } else if (mode === 'private') {
    commentId = commentMeta?.comment_id ? String(commentMeta.comment_id) : '';
    if (!commentId) return res.status(400).json({ error: 'No comment_id found for private reply' });
  } else if (mode === 'dm') {
    if (!dmMeta) return res.status(400).json({ error: 'No DM thread found for this lead yet' });
    const senderId = dmMeta?.sender_id ? String(dmMeta.sender_id) : '';
    const recipientId = dmMeta?.recipient_id ? String(dmMeta.recipient_id) : '';
    userId = (dmDirection === 'in') ? senderId : recipientId;
    if (!userId) return res.status(400).json({ error: 'No recipient id found for DM' });
    if (src === 'instagram') {
      igId = igBusinessId ? String(igBusinessId) : (igFromMeta ? String(igFromMeta) : '');
      if (!igId) return res.status(400).json({ error: 'IG business id is missing for DM send' });
    }
  } else {
    return res.status(400).json({ error: "mode must be one of: 'dm', 'comment', 'private'" });
  }

  const pendingKey = `metaout:pending:${crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2))}`;

  const baseMeta = {
    platform: src,
    kind: mode === 'comment' ? 'comment_reply' : mode === 'private' ? 'private_reply' : 'dm_out',
    page_id: pageId,
    ig_business_id: igBusinessId,
    operator_id: req.userId || null,
    dispatch: {
      mode,
      comment_id: commentId || null,
      user_id: userId || null,
      ig_id: igId || null
    }
  };

  const insertRes = await db.pool.query(
    `INSERT INTO messages (lead_id, phone, body, direction, whatsapp_id, metadata, status, created_at, tenant_id)
     VALUES ($1, $2, $3, 'out', $4, $5::jsonb, 'pending', NOW(), $6)
     RETURNING id, created_at`,
    [lead.id, lead.phone, bodyText, pendingKey, baseMeta, req.tenantId]
  );
  const rowId = insertRes.rows[0]?.id;

  // Instant UI feedback: show the outgoing message as "sending"
  io.to(req.tenantId).emit('new_message', {
    phone: lead.phone,
    name: lead.name,
    message: bodyText,
    whatsapp_id: pendingKey,
    fromMe: true,
    timestamp: new Date().toISOString(),
    source: src,
    is_fast_emit: true
  });

  // Queue-only: a background outbox worker will send to Graph API.
  res.status(201).json({ success: true, queued: true, messageId: rowId, whatsapp_id: pendingKey });
}));

app.post('/api/meta/pages', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.upsertMetaPage !== 'function') return res.status(501).json({ error: 'Meta integration is unavailable' });

  const pageId = String(req.body?.pageId || '').trim();
  const pageAccessToken = String(req.body?.pageAccessToken || '').trim();
  const pageName = String(req.body?.pageName || '').trim();
  const igBusinessId = String(req.body?.igBusinessId || '').trim();

  if (!pageId || !pageAccessToken) {
    return res.status(400).json({ error: 'pageId and pageAccessToken are required' });
  }

  const saved = await db.upsertMetaPage(req.tenantId, {
    page_id: pageId,
    page_name: pageName || null,
    page_access_token: pageAccessToken,
    ig_business_id: igBusinessId || null
  });

  res.status(201).json({ success: true, page: saved });
}));

app.delete('/api/meta/pages/:pageId', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.deleteMetaPage !== 'function') return res.status(501).json({ error: 'Meta integration is unavailable' });
  const ok = await db.deleteMetaPage(req.tenantId, req.params.pageId);
  res.json({ success: ok });
}));

// ═══════════════════════════════════════════════════════════════
// 📊 ANALYTICS LAYOUT API (per-user)
// ═══════════════════════════════════════════════════════════════

app.get('/api/analytics/layout', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const layout = await db.getAnalyticsLayout(req.tenantId, req.userId);
  res.json({ layout });
}));

app.post('/api/analytics/layout', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const { layout } = req.body;
  if (!layout || typeof layout !== 'object') return res.status(400).json({ error: 'Layout object is required' });
  const saved = await db.upsertAnalyticsLayout(req.tenantId, req.userId, layout);
  res.json({ success: true, layout: saved });
}));

app.get(['/api/debug', '/api/debug/:tenantId'], (req, res) => {
  const mem = process.memoryUsage();

  res.json({
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    environment: {
      node_version: process.version,
      platform: process.platform,
      has_database_url: !!process.env.DATABASE_URL,
    }
  });
});

setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`📊 API Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS`);
}, 60000);

// Central API error responder (prevents opaque HTML 500s on API routes)
app.use((err, req, res, next) => {
  console.error(`❌ ${req.method} ${req.originalUrl}:`, (err && (err.stack || err.message)) || err);
  if (res.headersSent) return next(err);

  if (req.originalUrl.startsWith('/api/')) {
    return res.status(500).json({ success: false, error: 'Server xətası' });
  }

  return res.status(500).send('Server error');
});

// SERVE FRONTEND (Monolith Mode)
const DIST_PATH = path.join(__dirname, '../dist');
const distExists = fs.existsSync(DIST_PATH);
console.log(`🔍 Checking Frontend Build Directory: ${DIST_PATH} -> Exists: ${distExists}`);
if (distExists) {
  try {
    const files = fs.readdirSync(DIST_PATH);
    console.log(`📂 dist/ contents: [${files.join(', ')}]`);
    const hasIndex = fs.existsSync(path.join(DIST_PATH, 'index.html'));
    console.log(`📄 dist/index.html exists: ${hasIndex}`);
  } catch (e) {
    console.error('⚠️ Error reading dist/:', e.message);
  }
}

if (distExists) {
  app.use(express.static(DIST_PATH));
  app.use((req, res, next) => {
    const file = req.path.split('/').pop();
    if (file && file.includes('.')) return res.status(404).send('Not found');
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
} else {
  // Graceful fallback warning if user forgot to configure the Build Command in Render
  app.use((req, res) => {
    res.status(404).send(`
      <div style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1 style="color: #ff4444;">Frontend Build Missing!</h1>
        <p>The <b>dist</b> folder was not found at <code>${DIST_PATH}</code>.</p>
        <p>This means your Server started, but the Frontend interface hasn't been compiled.</p>
        <h3 style="color: #333;">How to fix this in Render.com:</h3>
        <p>Go to your service Settings and ensure your <b>Build Command</b> is exactly:</p>
        <code style="background: #eee; padding: 10px; border-radius: 4px; display: inline-block;">npm install && npm run build</code>
      </div>
    `);
  });
}

// ═══════════════════════════════════════════════════════════════
// 🤖 EMBED WHATSAPP WORKER IN SAME PROCESS
// On Render Free tier, only one service runs. We start the Worker
// in-process so both API (:4000) and Worker (:4001) share one Node.
// ═══════════════════════════════════════════════════════════════

try {
  require('./worker.cjs');
  console.log('🤖 WhatsApp Worker embedded in same process (single-service mode).');
} catch (err) {
  console.error('⚠️ Failed to start embedded Worker:', err.message);
}
