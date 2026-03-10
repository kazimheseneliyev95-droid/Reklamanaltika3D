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
const hadInternalWebhookSecret = Boolean(process.env.INTERNAL_WEBHOOK_SECRET);
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV || 'development';
if (!process.env.INTERNAL_WEBHOOK_SECRET) {
  process.env.INTERNAL_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');
}
const INTERNAL_WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || '';
const ALLOW_LEGACY_TOKEN = process.env.ALLOW_LEGACY_TOKEN === 'true';
const HAS_DATABASE = Boolean(process.env.DATABASE_URL);
const EMBEDDED_WORKER_ENABLED = !process.argv.includes('--no-embedded-worker');

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

if (!HAS_DATABASE) {
  console.warn('⚠️ DATABASE_URL is missing. The app will run in limited file-based fallback mode.');
}

if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is missing. An ephemeral in-memory secret will be used until restart. Set JWT_SECRET in production.');
}

if (!hadInternalWebhookSecret) {
  console.warn('⚠️ INTERNAL_WEBHOOK_SECRET was missing. Generated an in-memory secret for this process. Configure it explicitly for multi-process deployments.');
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

function safeInternalHeaders() {
  return INTERNAL_WEBHOOK_SECRET ? { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET } : {};
}

function requireInternalRequest(req, res, next) {
  const incomingSecret = req.headers['x-internal-secret'];
  if (safeEqual(incomingSecret, INTERNAL_WEBHOOK_SECRET)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized internal request' });
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
if (!HAS_DATABASE) {
  console.log('ℹ️  No DATABASE_URL found, switching to FILE-BASED STORAGE (leads.json)');
  db = require('./simple_db');
}

// ═══════════════════════════════════════════════════════════════
// FOLLOW-UP SCHEDULER (in-app notifications)
// ═══════════════════════════════════════════════════════════════

let followUpTimer = null;
let followUpTickBusy = false;

// Light caching to avoid hammering DB every 20s
const tenantSettingsCache = new Map(); // tenantId -> { atMs, settings }
const tenantAdminIdsCache = new Map(); // tenantId -> { atMs, userIds }
const tenantAutomationCache = new Map(); // tenantId -> { atMs, settings }
const SETTINGS_CACHE_TTL_MS = 60 * 1000;

function pickAutomationSettingsFromCrmSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const a = (s.automation && typeof s.automation === 'object') ? s.automation : {};
  const reopen = (a.reopenOnInbound && typeof a.reopenOnInbound === 'object') ? a.reopenOnInbound : {};
  const close = (a.closeMovesToStage && typeof a.closeMovesToStage === 'object') ? a.closeMovesToStage : {};

  const fromStages = Array.isArray(reopen.fromStages)
    ? reopen.fromStages.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  const hasExcludeKey = Object.prototype.hasOwnProperty.call(reopen || {}, 'excludeStages');
  const excludeStages = Array.isArray(reopen.excludeStages)
    ? reopen.excludeStages.map((x) => String(x || '').trim()).filter(Boolean)
    : (hasExcludeKey ? [] : ['won']);

  return {
    reopenOnInbound: {
      enabled: reopen.enabled === true,
      onlyWhenClosed: reopen.onlyWhenClosed !== false,
      fromStages,
      excludeStages,
      targetStage: reopen.targetStage ? String(reopen.targetStage).trim() : ''
    },
    closeMovesToStage: {
      enabled: close.enabled === true,
      targetStage: close.targetStage ? String(close.targetStage).trim() : ''
    }
  };
}

async function getTenantAutomationSettings(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  const cached = tenantAutomationCache.get(t);
  if (cached && (Date.now() - cached.atMs) < SETTINGS_CACHE_TTL_MS) return cached.settings;
  let raw = null;
  try {
    if (db && typeof db.getCRMSettings === 'function') {
      raw = await db.getCRMSettings(t);
    }
  } catch {
    raw = null;
  }
  const picked = pickAutomationSettingsFromCrmSettings(raw || {});
  tenantAutomationCache.set(t, { atMs: Date.now(), settings: picked });
  return picked;
}

function pickNotificationSettingsFromCrmSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const n = (s.notifications && typeof s.notifications === 'object') ? s.notifications : {};
  const delay = (s.ui && typeof s.ui === 'object' && s.ui.delayDots && typeof s.ui.delayDots === 'object')
    ? s.ui.delayDots
    : {};

  const replySlaMinutes = (() => {
    const v = Number(n.replySlaMinutes);
    if (Number.isFinite(v) && v > 0) return Math.max(1, Math.min(240, Math.round(v)));
    return 5;
  })();

  const followupOverdueMinutes = (() => {
    const v = Number(n.followupOverdueMinutes);
    if (Number.isFinite(v) && v >= 0) return Math.max(0, Math.min(7 * 24 * 60, Math.round(v)));
    return 15;
  })();

  const notifyAdmins = n.notifyAdmins !== false;
  const notifyAssignee = n.notifyAssignee !== false;
  const notifyCreator = n.notifyCreator !== false;

  const hasIgnoreKey = Object.prototype.hasOwnProperty.call(n || {}, 'slaIgnoreStages');
  const slaIgnoreStages = Array.isArray(n.slaIgnoreStages)
    ? n.slaIgnoreStages.map((x) => String(x || '').trim()).filter(Boolean)
    : (hasIgnoreKey ? [] : ['won']);

  const bh = (n.businessHours && typeof n.businessHours === 'object') ? n.businessHours : {};
  const bhEnabled = bh.enabled === true;
  const bhTimezone = bh.timezone ? String(bh.timezone).trim() : 'Asia/Baku';
  const bhStart = bh.start ? String(bh.start).trim() : '09:00';
  const bhEnd = bh.end ? String(bh.end).trim() : '18:00';
  const bhDays = Array.isArray(bh.days)
    ? bh.days.map((x) => Number(x)).filter((x) => Number.isFinite(x))
    : [1, 2, 3, 4, 5];

  const delayGreenMaxMinutes = (() => {
    const v = Number(delay.greenMaxMinutes);
    if (Number.isFinite(v) && v > 0) return Math.max(1, Math.min(240, Math.round(v)));
    return 10;
  })();
  const delayYellowMaxMinutes = (() => {
    const v = Number(delay.yellowMaxMinutes);
    if (Number.isFinite(v) && v > 0) return Math.max(delayGreenMaxMinutes + 1, Math.min(24 * 60, Math.round(v)));
    return 30;
  })();

  return {
    replySlaMinutes,
    slaIgnoreStages,
    businessHours: {
      enabled: bhEnabled,
      timezone: bhTimezone || 'Asia/Baku',
      start: bhStart || '09:00',
      end: bhEnd || '18:00',
      days: bhDays,
    },
    followupOverdueMinutes,
    notifyAdmins,
    notifyAssignee,
    notifyCreator,
    delayGreenMaxMinutes,
    delayYellowMaxMinutes,
  };
}

async function logLeadAudit(tenantId, userId, action, leadId, details) {
  try {
    if (!db || typeof db.logAuditAction !== 'function') return;
    await db.logAuditAction({
      tenantId,
      userId: userId || null,
      action,
      entityType: 'lead',
      entityId: leadId,
      details: details && typeof details === 'object' ? details : {}
    });
  } catch {
    // ignore audit failures
  }
}

async function getTenantNotificationSettings(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  const cached = tenantSettingsCache.get(t);
  if (cached && (Date.now() - cached.atMs) < SETTINGS_CACHE_TTL_MS) return cached.settings;
  let raw = null;
  try {
    if (db && typeof db.getCRMSettings === 'function') {
      raw = await db.getCRMSettings(t);
    }
  } catch {
    raw = null;
  }
  const picked = pickNotificationSettingsFromCrmSettings(raw || {});
  tenantSettingsCache.set(t, { atMs: Date.now(), settings: picked });
  return picked;
}

async function getTenantAdminUserIds(tenantId) {
  const t = String(tenantId || '').trim() || 'admin';
  const cached = tenantAdminIdsCache.get(t);
  if (cached && (Date.now() - cached.atMs) < SETTINGS_CACHE_TTL_MS) return cached.userIds;
  try {
    const r = await db.pool.query(
      "SELECT id FROM users WHERE tenant_id = $1 AND role IN ('admin','manager','superadmin')",
      [t]
    );
    const ids = (r.rows || []).map((x) => x.id).filter(Boolean);
    tenantAdminIdsCache.set(t, { atMs: Date.now(), userIds: ids });
    return ids;
  } catch {
    tenantAdminIdsCache.set(t, { atMs: Date.now(), userIds: [] });
    return [];
  }
}

async function insertNotificationsForUsers({ tenantId, userIds, type, title, body, dedupeKey, leadId, followupId, payload }) {
  const t = String(tenantId || '').trim() || 'admin';
  const ids = Array.from(new Set((userIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (ids.length === 0) return [];

  const p = (payload && typeof payload === 'object') ? payload : {};
  const q = `
    INSERT INTO notifications (tenant_id, user_id, type, title, body, payload, dedupe_key, lead_id, followup_id)
    SELECT $1, u::uuid, $3, $4, $5, $6::jsonb, $2, $7::uuid, $8::uuid
    FROM unnest($9::text[]) AS u
    ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING
    RETURNING id, tenant_id, user_id, type, title, body, payload, dedupe_key, lead_id, followup_id, created_at, read_at;
  `;
  const res = await db.pool.query(q, [t, String(dedupeKey || ''), String(type || ''), title || null, body || null, JSON.stringify(p), leadId || null, followupId || null, ids]);
  return res.rows || [];
}

function emitNotification(tenantId, userId, notif) {
  try {
    const t = String(tenantId || '').trim() || 'admin';
    const uid = String(userId || '').trim();
    if (!uid) return;
    io.to(`${t}:user:${uid}`).emit('notification:new', notif);
  } catch {
    // ignore
  }
}

async function followUpTick() {
  if (followUpTickBusy) return;
  if (!process.env.DATABASE_URL || !db || !db.pool) return;
  followUpTickBusy = true;

  try {
    // 1) Follow-up DUE notifications (one-time)
    const dueResult = await db.pool.query(
      `UPDATE follow_ups f
       SET notified_at = NOW(), updated_at = NOW()
       FROM leads l
       WHERE f.lead_id = l.id
         AND f.tenant_id = l.tenant_id
         AND f.id IN (
           SELECT id
           FROM follow_ups
           WHERE status = 'open'
             AND notified_at IS NULL
             AND due_at <= NOW()
           ORDER BY due_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 50
         )
       RETURNING f.id, f.tenant_id, f.lead_id, f.assignee_id, f.created_by, f.due_at, f.note, l.phone, l.name, l.assignee_id AS lead_assignee_id;`
    );

    for (const row of (dueResult.rows || [])) {
      const tenantId = String(row.tenant_id || '').trim() || 'admin';
      const cfg = await getTenantNotificationSettings(tenantId);
      const admins = cfg.notifyAdmins ? await getTenantAdminUserIds(tenantId) : [];

      const recipients = new Set();
      if (cfg.notifyAssignee) {
        const a = row.assignee_id || row.lead_assignee_id;
        if (a) recipients.add(String(a));
      }
      if (cfg.notifyCreator && row.created_by) {
        recipients.add(String(row.created_by));
      }
      for (const a of (admins || [])) recipients.add(String(a));

      const dueIso = row.due_at ? new Date(row.due_at).toISOString() : null;
      const leadName = row.name || row.phone || null;
      const note = row.note || null;

      const inserted = await insertNotificationsForUsers({
        tenantId,
        userIds: Array.from(recipients),
        type: 'followup_due',
        title: 'Follow-up vaxti geldi',
        body: leadName ? `Lead: ${leadName}${note ? `\nQeyd: ${note}` : ''}` : (note ? `Qeyd: ${note}` : null),
        dedupeKey: `followup_due:${row.id}`,
        leadId: row.lead_id,
        followupId: row.id,
        payload: {
          lead: { id: row.lead_id, phone: row.phone || null, name: row.name || null },
          followup: { id: row.id, due_at: dueIso, note }
        }
      });

      for (const n of (inserted || [])) {
        emitNotification(tenantId, n.user_id, n);
        // Back-compat: targeted followup_due event (no tenant broadcast)
        try {
          io.to(`${tenantId}:user:${String(n.user_id)}`).emit('followup_due', {
            followup_id: row.id,
            lead_id: row.lead_id,
            assignee_id: row.assignee_id || row.lead_assignee_id || null,
            due_at: dueIso,
            note,
            phone: row.phone || null,
            name: row.name || null,
          });
        } catch {
          // ignore
        }
      }
    }

    // 2) Follow-up OVERDUE notifications (one-time, configurable minutes)
    const overdueCandidates = await db.pool.query(
      `SELECT f.id, f.tenant_id, f.lead_id, f.assignee_id, f.created_by, f.due_at, f.note,
              l.phone, l.name, l.assignee_id AS lead_assignee_id
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id AND l.tenant_id = f.tenant_id
       WHERE f.status = 'open'
         AND f.overdue_notified_at IS NULL
         AND f.due_at <= NOW()
       ORDER BY f.due_at ASC
       LIMIT 50;`
    );

    const nowMs = Date.now();
    for (const row of (overdueCandidates.rows || [])) {
      const tenantId = String(row.tenant_id || '').trim() || 'admin';
      const cfg = await getTenantNotificationSettings(tenantId);
      const overdueMin = Number(cfg.followupOverdueMinutes || 0);
      const dueMs = row.due_at ? new Date(row.due_at).getTime() : null;
      if (!dueMs || !Number.isFinite(dueMs)) continue;
      if ((nowMs - dueMs) < overdueMin * 60 * 1000) continue;

      const admins = cfg.notifyAdmins ? await getTenantAdminUserIds(tenantId) : [];
      const recipients = new Set();
      if (cfg.notifyAssignee) {
        const a = row.assignee_id || row.lead_assignee_id;
        if (a) recipients.add(String(a));
      }
      if (cfg.notifyCreator && row.created_by) {
        recipients.add(String(row.created_by));
      }
      for (const a of (admins || [])) recipients.add(String(a));

      const dueIso = row.due_at ? new Date(row.due_at).toISOString() : null;
      const leadName = row.name || row.phone || null;
      const note = row.note || null;

      const inserted = await insertNotificationsForUsers({
        tenantId,
        userIds: Array.from(recipients),
        type: 'followup_overdue',
        title: 'Follow-up gecikib',
        body: leadName ? `Lead: ${leadName}${note ? `\nQeyd: ${note}` : ''}` : (note ? `Qeyd: ${note}` : null),
        dedupeKey: `followup_overdue:${row.id}`,
        leadId: row.lead_id,
        followupId: row.id,
        payload: {
          lead: { id: row.lead_id, phone: row.phone || null, name: row.name || null },
          followup: { id: row.id, due_at: dueIso, note, overdue_minutes: overdueMin }
        }
      });

      if (inserted && inserted.length > 0) {
        await db.pool.query(
          'UPDATE follow_ups SET overdue_notified_at = NOW(), updated_at = NOW() WHERE tenant_id = $1 AND id = $2 AND overdue_notified_at IS NULL',
          [tenantId, row.id]
        ).catch(() => null);
      }

      for (const n of (inserted || [])) {
        emitNotification(tenantId, n.user_id, n);
      }
    }

    // 3) SLA reply warning: last inbound unanswered for N minutes
    const slaCandidates = await db.pool.query(
      `SELECT id, tenant_id, phone, name, assignee_id, status, last_inbound_at, last_outbound_at
       FROM leads
       WHERE conversation_closed = false
         AND last_inbound_at IS NOT NULL
         AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)
         AND last_inbound_at <= NOW() - INTERVAL '1 minute'
       ORDER BY last_inbound_at ASC
       LIMIT 80;`
    );

    for (const l of (slaCandidates.rows || [])) {
      const tenantId = String(l.tenant_id || '').trim() || 'admin';
      const cfg = await getTenantNotificationSettings(tenantId);
      const status = l && l.status ? String(l.status).trim() : '';
      if (status && Array.isArray(cfg.slaIgnoreStages) && cfg.slaIgnoreStages.includes(status)) continue;
      const slaMin = Number(cfg.replySlaMinutes || 5);
      const inMs = l.last_inbound_at ? new Date(l.last_inbound_at).getTime() : null;
      if (!inMs || !Number.isFinite(inMs)) continue;
      const waitedMin = businessMinutesBetween(inMs, nowMs, cfg.businessHours || null);
      if (waitedMin < slaMin) continue;

      const admins = cfg.notifyAdmins ? await getTenantAdminUserIds(tenantId) : [];
      const recipients = new Set();
      if (cfg.notifyAssignee && l.assignee_id) recipients.add(String(l.assignee_id));
      for (const a of (admins || [])) recipients.add(String(a));

      const leadName = l.name || l.phone || null;
      const minutes = Math.max(0, Math.floor(waitedMin));
      const dedupeKey = `sla_reply:${l.id}:${new Date(inMs).toISOString()}`;

      const inserted = await insertNotificationsForUsers({
        tenantId,
        userIds: Array.from(recipients),
        type: 'sla_reply',
        title: 'Cavab gecikir',
        body: leadName ? `Lead: ${leadName}\nGecikme: ${minutes} dk` : `Gecikme: ${minutes} dk`,
        dedupeKey,
        leadId: l.id,
        followupId: null,
        payload: {
          lead: { id: l.id, phone: l.phone || null, name: l.name || null },
          sla: { minutes: slaMin, waited_minutes: minutes, last_inbound_at: new Date(inMs).toISOString() }
        }
      });

      for (const n of (inserted || [])) {
        emitNotification(tenantId, n.user_id, n);
      }
    }
  } catch (e) {
    // non-fatal
    try { console.warn('⚠️ followUpTick failed:', e?.message || e); } catch { }
  } finally {
    followUpTickBusy = false;
  }
}

function startFollowUpScheduler() {
  if (followUpTimer) return;
  // Every 20s: pick up due follow-ups
  followUpTimer = setInterval(() => {
    followUpTick().catch(() => { });
  }, 20000);
}

function parseTimeToMinutes(hhmm, fallbackMin) {
  const s = String(hhmm || '').trim();
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return fallbackMin;
  return Number(m[1]) * 60 + Number(m[2]);
}

function getZonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function getTimeZoneOffsetMs(ms, timeZone) {
  const p = getZonedParts(ms, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - ms;
}

function zonedLocalToUtcMs(y, m, d, hh, mm, timeZone) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const off = getTimeZoneOffsetMs(guess, timeZone);
    const next = Date.UTC(y, m - 1, d, hh, mm, 0) - off;
    if (Math.abs(next - guess) < 1000) {
      guess = next;
      break;
    }
    guess = next;
  }
  return guess;
}

function addDaysYMD(y, m, d, days) {
  const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + days);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayInZone(ms, timeZone) {
  const w = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms));
  switch (w) {
    case 'Sun': return 0;
    case 'Mon': return 1;
    case 'Tue': return 2;
    case 'Wed': return 3;
    case 'Thu': return 4;
    case 'Fri': return 5;
    case 'Sat': return 6;
    default: return 0;
  }
}

function businessMinutesBetween(startMs, endMs, cfg) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  if (!cfg || cfg.enabled !== true) return (endMs - startMs) / 60000;

  const tz = (() => {
    const s = String((cfg && cfg.timezone) || 'Asia/Baku').trim() || 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s }).format(0);
      return s;
    } catch {
      return 'UTC';
    }
  })();
  const days = Array.isArray(cfg.days) ? cfg.days.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [1, 2, 3, 4, 5];
  const daySet = new Set(days);
  const startMin = parseTimeToMinutes(cfg.start || '09:00', 9 * 60);
  const endMin = parseTimeToMinutes(cfg.end || '18:00', 18 * 60);
  if (startMin === endMin) return 0;

  let total = 0;
  let cursor = startMs;
  for (let i = 0; i < 370; i++) {
    if (cursor >= endMs) break;
    const p = getZonedParts(cursor, tz);
    const y = p.year;
    const m = p.month;
    const d = p.day;
    const dow = weekdayInZone(cursor, tz);
    const nextYMD = addDaysYMD(y, m, d, 1);
    const dayStartUtc = zonedLocalToUtcMs(y, m, d, 0, 0, tz);
    const nextDayStartUtc = zonedLocalToUtcMs(nextYMD.y, nextYMD.m, nextYMD.d, 0, 0, tz);

    if (!daySet.has(dow)) {
      cursor = nextDayStartUtc;
      continue;
    }

    const winStartUtc = zonedLocalToUtcMs(y, m, d, Math.floor(startMin / 60), startMin % 60, tz);
    let winEndUtc = zonedLocalToUtcMs(y, m, d, Math.floor(endMin / 60), endMin % 60, tz);
    if (endMin < startMin) {
      winEndUtc = zonedLocalToUtcMs(nextYMD.y, nextYMD.m, nextYMD.d, Math.floor(endMin / 60), endMin % 60, tz);
    }

    const a0 = Math.max(startMs, winStartUtc);
    const a1 = Math.min(endMs, winEndUtc);
    if (a1 > a0) total += (a1 - a0) / 60000;

    cursor = Math.max(nextDayStartUtc, dayStartUtc + 24 * 60 * 60 * 1000);
  }
  return total;
}

startFollowUpScheduler();

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
    status: null,
    extra_data: { meta: meta || {} }
  }, tenantId);

  const closedBefore = Boolean(lead && lead.conversation_closed);
  const statusBefore = lead && lead.status ? String(lead.status).trim() : '';

  const updatedLead = await db.updateLeadMessage(lead.phone, safeText, metaId, displayName || null, tenantId, dir).catch(() => null);
  const finalLead = updatedLead || lead;

  if (dir === 'in' && closedBefore) {
    await logLeadAudit(tenantId, null, 'CONVERSATION_REOPENED', finalLead.id, {
      reason: 'inbound_message',
      auto: true,
      previous_status: statusBefore || null,
      source,
      whatsapp_id: metaId
    });
  }

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
        Object.assign(finalLead, routed);
        await emitLeadUpdatedScoped(tenantId, routed);
      }
    } catch {
      // ignore
    }
  }

  // Auto return-to-stage on inbound message (configurable per tenant)
  if (dir === 'in') {
    try {
      const auto = await getTenantAutomationSettings(tenantId);
      const cfg = auto && auto.reopenOnInbound ? auto.reopenOnInbound : null;
      const enabled = cfg && cfg.enabled === true;
      const onlyWhenClosed = cfg && cfg.onlyWhenClosed !== false;
      const targetStage = cfg && cfg.targetStage ? String(cfg.targetStage).trim() : '';
      const fromStages = cfg && Array.isArray(cfg.fromStages) ? cfg.fromStages : [];
      const excludeStages = cfg && Array.isArray(cfg.excludeStages) ? cfg.excludeStages : [];
      const okClosed = onlyWhenClosed ? closedBefore : true;
      const okFromStages = fromStages.length > 0 ? fromStages.includes(statusBefore) : true;
      const okExclude = excludeStages.includes(statusBefore) ? false : true;
        if (enabled && okClosed && targetStage && statusBefore && okFromStages && okExclude && statusBefore !== targetStage) {
          const moved = await db.updateLeadStatus(finalLead.id, targetStage, tenantId).catch(() => null);
          if (moved) {
            Object.assign(finalLead, moved);
            await logLeadAudit(tenantId, null, 'AUTO_STAGE_RETURN', finalLead.id, {
            from_status: statusBefore,
            to_status: targetStage,
            reason: 'inbound_message',
            auto: true,
            reopened_from_closed: closedBefore,
            source,
            whatsapp_id: metaId
          });
          await emitLeadUpdatedScoped(tenantId, moved);
        }
      }
    } catch {
      // ignore
    }
  }

  if (dir === 'in') {
    try {
      const automated = await maybeApplyAutoRulesToLead(tenantId, finalLead, safeText, { whatsapp_id: metaId, source });
      if (automated) {
        Object.assign(finalLead, automated);
        await emitLeadUpdatedScoped(tenantId, automated);
      }
    } catch {
      // ignore
    }
  }

  await emitLeadUpdatedScoped(tenantId, finalLead);
  await emitNewMessageScoped(tenantId, finalLead, {
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

    const updatedLead = await db.updateLeadMessage(row.phone, row.body, finalKey, null, tenantId, 'out').catch(() => null);

    // Notify UI so chat can reload
    try {
      await emitNewMessageScoped(tenantId, updatedLead, {
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
    socket.userId = data.id || null;
    socket.userRole = data.role || null;
    socket.userPermissions = data.permissions || {};
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
});

io.on('connection', (socket) => {
  const tenantId = socket.tenantId;
  socket.join(tenantId);
  try {
    const uid = socket.userId ? String(socket.userId) : '';
    if (uid) {
      socket.join(`${tenantId}:user:${uid}`);
    }
  } catch {
    // ignore
  }
  console.log(`👤 NEW UI CLIENT CONNECTED [${tenantId}]: ${socket.id} (Total: ${io.engine.clientsCount})`);

  // Async fetch health from worker
  fetchJsonWithRetry(`http://localhost:4001/api/internal/status/${tenantId}`, {
    headers: safeInternalHeaders()
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

function socketCanViewAllLeads(socket) {
  if (!socket) return false;
  const permissions = getEffectivePermissions(socket.userRole, socket.userPermissions || {});
  return permissions.view_all_leads !== false;
}

function socketCanAccessLead(socket, lead) {
  if (!socket || !lead) return false;
  if (socketCanViewAllLeads(socket)) return true;
  const assigneeId = lead.assignee_id ? String(lead.assignee_id) : '';
  const userId = socket.userId ? String(socket.userId) : '';
  return Boolean(assigneeId && userId && assigneeId === userId);
}

async function emitLeadUpdatedScoped(tenantId, lead) {
  if (!lead) return;
  const sockets = await io.in(tenantId).fetchSockets().catch(() => []);
  for (const socket of sockets) {
    if (socketCanAccessLead(socket, lead)) {
      const decorated = (process.env.DATABASE_URL && typeof db.getLeadById === 'function')
        ? await db.getLeadById(lead.id, tenantId, socket.userId).catch(() => lead)
        : lead;
      socket.emit('lead_updated', decorated || lead);
    } else if (lead.id) {
      socket.emit('lead_deleted', lead.id);
    }
  }
}

async function emitLeadDeletedScoped(tenantId, lead) {
  if (!lead || !lead.id) return;
  const sockets = await io.in(tenantId).fetchSockets().catch(() => []);
  for (const socket of sockets) {
    if (socketCanAccessLead(socket, lead)) {
      socket.emit('lead_deleted', lead.id);
    }
  }
}

async function emitNewMessageScoped(tenantId, lead, payload) {
  const sockets = await io.in(tenantId).fetchSockets().catch(() => []);
  for (const socket of sockets) {
    if (!lead || socketCanAccessLead(socket, lead)) {
      socket.emit('new_message', {
        ...(payload || {}),
        lead_id: lead?.id || payload?.lead_id || null,
      });
    }
  }
}

async function emitScopedLeadList(tenantId) {
  if (!db || typeof db.getLeads !== 'function') return;
  const sockets = await io.in(tenantId).fetchSockets().catch(() => []);
  await Promise.all(sockets.map(async (socket) => {
    const filters = socketCanViewAllLeads(socket)
      ? { userId: socket.userId || null }
      : { assigneeId: socket.userId, userId: socket.userId || null };
    const leads = await db.getLeads(filters, tenantId).catch(() => []);
    socket.emit('leads_updated', leads);
  }));
}

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

function matchAutoRule(rule, message) {
  if (!rule || !rule.enabled) return null;
  const keyword = String(rule.keyword || '').trim();
  if (!keyword) return null;

  const rawMessage = String(message || '');
  if (!rawMessage.trim()) return null;
  if (!rawMessage.toLowerCase().includes(keyword.toLowerCase())) return null;

  let extractedValue = null;
  if (rule.fixedValue !== undefined && rule.fixedValue !== null && String(rule.fixedValue).trim() !== '') {
    const fixed = Number(String(rule.fixedValue).replace(',', '.'));
    extractedValue = Number.isFinite(fixed) ? fixed : null;
  } else if (rule.extractValue) {
    const currencyTag = String(rule.currencyTag || '').trim();
    if (currencyTag) {
      const tag = currencyTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:${tag}\\s*(\\d+(?:[.,]\\d+)?))|(?:(\\d+(?:[.,]\\d+)?)\\s*${tag})`, 'i');
      const match = rawMessage.match(regex);
      const valueStr = match ? (match[1] || match[2]) : '';
      if (valueStr) {
        const parsed = parseFloat(valueStr.replace(',', '.'));
        extractedValue = Number.isFinite(parsed) ? parsed : null;
      }
    } else {
      const match = rawMessage.match(/[\d]+(?:[.,]\d+)?/);
      if (match) {
        const parsed = parseFloat(String(match[0] || '').replace(',', '.'));
        extractedValue = Number.isFinite(parsed) ? parsed : null;
      }
    }
  }

  return {
    targetStage: String(rule.targetStage || '').trim(),
    extractedValue,
    ruleId: rule.id || null,
  };
}

async function maybeApplyAutoRulesToLead(tenantId, lead, message, meta) {
  if (!process.env.DATABASE_URL) return null;
  if (!db || typeof db.getCRMSettings !== 'function' || typeof db.updateLeadFields !== 'function') return null;
  if (!lead || !lead.id) return null;

  const settings = await db.getCRMSettings(tenantId).catch(() => null);
  const rules = settings && Array.isArray(settings.autoRules) ? settings.autoRules : [];
  const stages = settings && Array.isArray(settings.pipelineStages) ? settings.pipelineStages : [];
  if (!rules.length) return null;

  for (const rule of rules) {
    const matched = matchAutoRule(rule, message);
    if (!matched) continue;

    const updates = {};
    if (matched.targetStage && stages.some((stage) => String(stage.id) === matched.targetStage) && String(lead.status || '') !== matched.targetStage) {
      updates.status = matched.targetStage;
    }
    if (matched.extractedValue !== null && matched.extractedValue !== undefined) {
      updates.value = matched.extractedValue;
    }
    if (Object.keys(updates).length === 0) return null;

    const updated = await db.updateLeadFields(lead.id, updates, tenantId).catch(() => null);
    if (updated && typeof db.logAuditAction === 'function') {
      await db.logAuditAction({
        tenantId,
        userId: null,
        action: 'AUTO_RULE_MATCH',
        entityType: 'lead',
        entityId: lead.id,
        details: {
          ruleId: matched.ruleId,
          targetStage: updates.status || null,
          extractedValue: updates.value ?? null,
          whatsapp_id: meta && meta.whatsapp_id ? meta.whatsapp_id : null,
          source: meta && meta.source ? meta.source : null,
        }
      }).catch(() => null);
    }
    return updated;
  }

  return null;
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

app.post('/api/internal/webhook', async (req, res) => requireInternalRequest(req, res, async () => {
  const { tenantId, event, payload } = req.body;
  if (!tenantId || !event) return res.status(400).json({ error: 'Invalid payload' });

  // Apply routing rules server-side (both incoming and outgoing)
  // This ensures first matching message assigns the field and won't change later.
  if (event === 'new_message' && process.env.DATABASE_URL && payload && payload.phone && payload.message) {
    let leadForAutomation = null;
    let statusBefore = '';
    try {
      const lead = (db && typeof db.findLeadByPhone === 'function')
        ? await db.findLeadByPhone(payload.phone, tenantId)
        : null;
      if (lead) {
        leadForAutomation = lead;
        statusBefore = lead && lead.status ? String(lead.status).trim() : '';
        if (payload && payload.status_before !== undefined && payload.status_before !== null) {
          const sb = String(payload.status_before || '').trim();
          if (sb) statusBefore = sb;
        }
        const updated = await maybeApplyRoutingRulesToLead(tenantId, lead, payload.message, payload);
        if (updated) {
          leadForAutomation = updated;
          await emitLeadUpdatedScoped(tenantId, updated);
        }
      }
    } catch (e) {
      console.warn('⚠️ Routing apply failed (internal webhook):', e.message);
    }

    // Auto return-to-stage on inbound message (closed conversations -> Yeni)
    try {
      const isInbound = payload && payload.fromMe === false;
      if (isInbound && leadForAutomation && statusBefore) {
        const closedBefore = (payload && payload.was_closed === true)
          ? true
          : Boolean(leadForAutomation && leadForAutomation.conversation_closed);

        if (closedBefore) {
          await logLeadAudit(tenantId, null, 'CONVERSATION_REOPENED', leadForAutomation.id, {
            reason: 'inbound_message',
            auto: true,
            previous_status: statusBefore || null,
            source: payload.source || 'whatsapp',
            whatsapp_id: payload.whatsapp_id || null
          });
        }

        const auto = await getTenantAutomationSettings(tenantId);
        const cfg = auto && auto.reopenOnInbound ? auto.reopenOnInbound : null;
        const enabled = cfg && cfg.enabled === true;
        const onlyWhenClosed = cfg && cfg.onlyWhenClosed !== false;
        const targetStage = cfg && cfg.targetStage ? String(cfg.targetStage).trim() : '';
        const fromStages = cfg && Array.isArray(cfg.fromStages) ? cfg.fromStages : [];
        const excludeStages = cfg && Array.isArray(cfg.excludeStages) ? cfg.excludeStages : [];
        const okClosed = onlyWhenClosed ? closedBefore : true;
        const okFromStages = fromStages.length > 0 ? fromStages.includes(statusBefore) : true;
        const okExclude = excludeStages.includes(statusBefore) ? false : true;
        if (enabled && okClosed && targetStage && okFromStages && okExclude && statusBefore !== targetStage) {
          const moved = await db.updateLeadStatus(leadForAutomation.id, targetStage, tenantId).catch(() => null);
          if (moved) {
            leadForAutomation = moved;
            await logLeadAudit(tenantId, null, 'AUTO_STAGE_RETURN', leadForAutomation.id, {
              from_status: statusBefore,
              to_status: targetStage,
              reason: 'inbound_message',
              auto: true,
              reopened_from_closed: closedBefore,
              source: payload.source || 'whatsapp',
              whatsapp_id: payload.whatsapp_id || null
            });
            await emitLeadUpdatedScoped(tenantId, moved);
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      if (leadForAutomation) {
        const automated = await maybeApplyAutoRulesToLead(tenantId, leadForAutomation, payload.message, payload);
        if (automated) {
          await emitLeadUpdatedScoped(tenantId, automated);
        }
      }
    } catch {
      // ignore
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

  if (event === 'new_message' && payload && payload.phone) {
    const currentLead = (db && typeof db.findLeadByPhone === 'function')
      ? await db.findLeadByPhone(payload.phone, tenantId).catch(() => null)
      : null;
    if (currentLead) {
      await emitLeadUpdatedScoped(tenantId, currentLead);
      await emitNewMessageScoped(tenantId, currentLead, payload);
    }
  } else {
    io.to(tenantId).emit(event, payload);
  }
  res.json({ success: true });
}));

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

  if (!HAS_DATABASE || typeof db.findUserByUsername !== 'function') {
    const fallbackUser = typeof db.findUserByUsername === 'function'
      ? await db.findUserByUsername(normalizedUsername)
      : null;

    if (!fallbackUser) {
      return res.status(503).json({
        success: false,
        error: 'Fallback login üçün ADMIN_PASSWORD konfiqurasiya edilməlidir.'
      });
    }

    const validFallbackPassword = await verifyPassword(password, fallbackUser.password_hash);
    if (!validFallbackPassword) {
      return res.status(401).json({ success: false, error: 'Şifrə yalnışdır' });
    }

    const tokenPayload = {
      id: fallbackUser.id,
      username: fallbackUser.username,
      tenantId: fallbackUser.tenant_id,
      role: fallbackUser.role,
      permissions: fallbackUser.permissions || {},
      displayName: fallbackUser.display_name || null
    };

    return res.json({
      success: true,
      token: signAuthToken(tokenPayload),
      tenantId: fallbackUser.tenant_id,
      role: fallbackUser.role,
      id: fallbackUser.id,
      username: fallbackUser.username,
      permissions: fallbackUser.permissions || {},
      displayName: fallbackUser.display_name || null
    });
  }

  // Find user in database to determine role and tenant mapping
  let user = await db.findUserByUsername(normalizedUsername);

  if (!user) {
    return res.status(401).json({ success: false, error: 'İstifadəçi tapılmadı' });
  }

  if (user.tenant_id !== 'admin' && user.tenant_status === 'archived') {
    return res.status(403).json({ success: false, error: 'Bu şirkət arxivdədir. Giriş üçün əvvəl super admin tərəfindən bərpa edilməlidir.' });
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
    headers: safeInternalHeaders()
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
    req.userPermissions = getEffectivePermissions(data.role, data.permissions || {});
    req.username = data.username || null;
    req.displayName = data.displayName || null;
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
    req.userPermissions = getEffectivePermissions(data.role, data.permissions || {});
    req.username = data.username || null;
    req.displayName = data.displayName || null;
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

const ROLE_PERMISSION_DEFAULTS = {
  superadmin: {
    view_all_leads: true,
    create_lead: true,
    delete_lead: true,
    change_status: true,
    view_budget: true,
    edit_budget: true,
    send_messages: true,
    view_stats: true,
    view_other_operator_stats: true,
    manage_users: true,
    factory_reset: true,
  },
  admin: {
    view_all_leads: true,
    create_lead: true,
    delete_lead: true,
    change_status: true,
    view_budget: true,
    edit_budget: true,
    send_messages: true,
    view_stats: true,
    view_other_operator_stats: true,
    manage_users: true,
  },
  manager: {
    view_all_leads: true,
    create_lead: true,
    delete_lead: false,
    change_status: true,
    view_budget: true,
    edit_budget: false,
    send_messages: true,
    view_stats: true,
    view_other_operator_stats: true,
    manage_users: false,
  },
  worker: {
    view_all_leads: false,
    create_lead: true,
    delete_lead: false,
    change_status: true,
    view_budget: false,
    edit_budget: false,
    send_messages: true,
    view_stats: false,
    view_other_operator_stats: false,
    manage_users: false,
  },
  viewer: {
    view_all_leads: true,
    create_lead: false,
    delete_lead: false,
    change_status: false,
    view_budget: false,
    edit_budget: false,
    send_messages: false,
    view_stats: false,
    view_other_operator_stats: false,
    manage_users: false,
  }
};

function getEffectivePermissions(role, permissions) {
  const base = ROLE_PERMISSION_DEFAULTS[role] || {};
  const incoming = permissions && typeof permissions === 'object' ? permissions : {};
  return { ...base, ...incoming };
}

function hasPermission(req, permission) {
  if (req.userRole === 'superadmin') return true;
  return req.userPermissions?.[permission] !== false;
}

function canViewAllLeads(req) {
  return hasPermission(req, 'view_all_leads');
}

function requirePermission(permission, errorMessage) {
  return (req, res, next) => {
    if (!hasPermission(req, permission)) {
      return res.status(403).json({ error: errorMessage || 'Forbidden' });
    }
    next();
  };
}

async function loadAccessibleLead(req, leadId) {
  if (!process.env.DATABASE_URL || !db || !db.pool) return null;
  const values = [leadId, req.tenantId];
  let query = 'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2';
  if (!canViewAllLeads(req)) {
    query += ' AND assignee_id = $3';
    values.push(req.userId);
  }
  const result = await db.pool.query(query, values);
  return result.rows[0] || null;
}

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
  const adminUser = typeof db.getTenantAdmin === 'function' ? await db.getTenantAdmin(req.tenantId) : null;
  res.json({
    tenantId: req.tenantId,
    displayName: adminUser?.display_name || req.displayName || null
  });
}));

// 👥 USER MANAGEMENT API (Phase 2)
app.get('/api/users', requireTenantAuth, asyncHandler(async (req, res) => {
  if (typeof db.getUsers !== 'function') {
    return res.status(503).json({ error: 'User storage not configured' });
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

  if (!['admin', 'worker', 'manager', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, manager, viewer, or worker' });
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

  if (!['admin', 'worker', 'manager', 'viewer'].includes(role)) {
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
  const includeArchived = String(req.query.includeArchived || '').trim() === '1';
  const search = String(req.query.search || '').trim();
  const tenants = await db.getSuperAdminTenants({ includeArchived, search });

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
      headers: safeInternalHeaders()
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

app.post('/api/admin/tenants/import', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.status(400).json({ error: 'Import rows are required' });
  if (rows.length > 250) return res.status(400).json({ error: 'Bir importda maksimum 250 sətir göndərin' });

  const prepared = [];
  for (const raw of rows) {
    const tenantId = String(raw?.tenantId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const adminUsername = String(raw?.adminUsername || '').trim().toLowerCase();
    const adminPassword = String(raw?.adminPassword || '').trim();
    const displayName = String(raw?.displayName || '').trim() || null;
    if (!tenantId || !adminUsername || !adminPassword) {
      prepared.push({ tenantId, adminUsername, passwordHash: null, displayName });
      continue;
    }
    prepared.push({
      tenantId,
      adminUsername,
      passwordHash: await hashPassword(adminPassword),
      displayName,
      role: 'admin'
    });
  }

  const result = await db.bulkImportTenants(prepared);
  res.status(201).json({ success: true, ...result });
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
    const archived = await db.archiveTenant(targetTenantId, req.userId);
    if (archived) {
      res.json({ success: true, message: 'Şirkət arxivə göndərildi', archived });
    } else {
      res.status(400).json({ error: 'Şirkət arxivə göndərilə bilmədi' });
    }
  } catch (err) {
    console.error('Error deleting tenant:', err);
    res.status(500).json({ error: 'Server xətası: Şirkət arxivləşdirilə bilmədi' });
  }
}));

app.post('/api/admin/tenants/:id/restore', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }
  const targetTenantId = String(req.params.id || '').trim();
  if (!targetTenantId || targetTenantId === 'admin') {
    return res.status(400).json({ error: 'Yanlış şirkət ID-si' });
  }

  const restored = await db.restoreTenant(targetTenantId);
  if (!restored) return res.status(404).json({ error: 'Şirkət tapılmadı' });
  res.json({ success: true, message: 'Şirkət bərpa edildi', restored });
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
      tenant: await db.getTenantRecord(targetTenantId).catch(() => null),
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
  if (adminUser.tenant_status === 'archived') {
    return res.status(403).json({ error: 'Arxivdə olan şirkətə Login As edilə bilməz. Əvvəl bərpa edin.' });
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
      headers: safeInternalHeaders()
    }, { retries: 1, timeoutMs: 5000 });
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, message: 'Worker is unavailable' });
  }
}));

// 🗄️ LEADS API
app.get('/api/leads', requireTenantAuth, asyncHandler(async (req, res) => {
  if (typeof db.getLeads !== 'function') return res.status(503).json({ error: 'Lead storage not configured' });
  const { status, startDate, endDate, limit, offset } = req.query;
  const leads = await db.getLeads({
    status,
    startDate,
    endDate,
    limit: limit ? parseInt(limit) : undefined,
    offset: offset ? parseInt(offset) : undefined,
    assigneeId: canViewAllLeads(req) ? undefined : req.userId,
    userId: req.userId || null,
  }, req.tenantId);
  res.json(leads);
}));

app.post('/api/leads', requireTenantAuth, requirePermission('create_lead', 'Lead yaratmaq icazəniz yoxdur'), asyncHandler(async (req, res) => {
  if (typeof db.createLead !== 'function') return res.status(503).json({ error: 'Lead storage not configured' });
  const lead = await db.createLead(req.body, req.tenantId);
  let finalLead = lead;

  try {
    const message = String(req.body?.last_message || '').trim();
    if (message) {
      const routed = await maybeApplyRoutingRulesToLead(req.tenantId, finalLead, message, { source: req.body?.source || 'manual' });
      if (routed) finalLead = routed;
      const automated = await maybeApplyAutoRulesToLead(req.tenantId, finalLead, message, { source: req.body?.source || 'manual' });
      if (automated) finalLead = automated;
    }
  } catch {
    // ignore
  }

  res.status(201).json(finalLead);
}));

app.put('/api/leads/:id/status', requireTenantAuth, requirePermission('change_status', 'Status dəyişmək icazəniz yoxdur'), asyncHandler(async (req, res) => {
  if (typeof db.updateLeadStatus !== 'function') return res.status(503).json({ error: 'Lead storage not configured' });
  const visibleLead = HAS_DATABASE ? await loadAccessibleLead(req, req.params.id) : { id: req.params.id };
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
  let oldStatus = null;
  if (HAS_DATABASE && db.pool) {
    const beforeRes = await db.pool.query(
      'SELECT status FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    oldStatus = beforeRes.rows[0]?.status || null;
  }
  const lead = await db.updateLeadStatus(req.params.id, req.body.status, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  await emitLeadUpdatedScoped(req.tenantId, lead);

  // Audit Log
  if (typeof db.logAuditAction === 'function') {
    await db.logAuditAction({
      tenantId: req.tenantId,
      userId: req.userId,
      action: 'UPDATE_STATUS',
      entityType: 'lead',
      entityId: req.params.id,
      details: { oldStatus, newStatus: req.body.status }
    });
  }

  res.json(lead);
}));

app.put('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const visibleLead = await loadAccessibleLead(req, req.params.id);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });

  if (req.body.status !== undefined && !hasPermission(req, 'change_status')) {
    return res.status(403).json({ error: 'Status dəyişmək icazəniz yoxdur' });
  }

  if (req.body.value !== undefined && !hasPermission(req, 'edit_budget')) {
    return res.status(403).json({ error: 'Büdcəni dəyişmək üçün icazəniz yoxdur' });
  }

  if (req.body.assignee_id !== undefined) {
    const nextAssignee = req.body.assignee_id ? String(req.body.assignee_id) : null;
    const canReassign = req.userRole === 'admin' || req.userRole === 'superadmin' || req.userRole === 'manager';
    const assigningSelf = nextAssignee && String(req.userId || '') === nextAssignee;
    if (!canReassign && !assigningSelf) {
      return res.status(403).json({ error: 'Lead təyinatını dəyişmək icazəniz yoxdur' });
    }
  }

  const beforeRes = await db.pool.query(
    'SELECT name, value, product_name, assignee_id, status, extra_data FROM leads WHERE id = $1 AND tenant_id = $2',
    [req.params.id, req.tenantId]
  );
  const before = beforeRes.rows[0] || null;

  const lead = await db.updateLeadFields(req.params.id, req.body, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  await emitLeadUpdatedScoped(req.tenantId, lead);

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
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });

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
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
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

  let storedPasswordHash = '';
  if (HAS_DATABASE && db.pool) {
    const user = await db.pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!user.rows[0]) return res.status(404).json({ error: 'İstifadəçi tapılmadı' });
    storedPasswordHash = user.rows[0].password_hash;
  } else {
    storedPasswordHash = String(process.env.ADMIN_PASSWORD || '');
  }

  const validPass = await verifyPassword(password, storedPasswordHash);
  if (!validPass) return res.status(401).json({ error: 'Şifrə yalnışdır' });

  if (typeof db.deleteAllLeads !== 'function') return res.status(503).json({ error: 'Lead storage not configured' });
  await db.deleteAllLeads(req.tenantId);
  io.to(req.tenantId).emit('leads_reset', {});

  if (typeof db.logAuditAction === 'function') {
    await db.logAuditAction({
      tenantId: req.tenantId,
      userId: req.userId,
      action: 'FACTORY_RESET',
      entityType: 'tenant',
      entityId: null,
      details: {}
    });
  }

  res.json({ success: true, message: 'All leads and messages deleted for tenant' });
}));

app.delete('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (typeof db.deleteLead !== 'function') return res.status(503).json({ error: 'Lead storage not configured' });
  if (!hasPermission(req, 'delete_lead')) return res.status(403).json({ error: 'Lead silmək icazəniz yoxdur' });
  const visibleLead = HAS_DATABASE ? await loadAccessibleLead(req, req.params.id) : { id: req.params.id };
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
  const lead = await db.deleteLead(req.params.id, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // Broadcast deletion to tenant clients
  await emitLeadDeletedScoped(req.tenantId, lead);

  // Audit Log
  if (typeof db.logAuditAction === 'function') {
    await db.logAuditAction({
      tenantId: req.tenantId,
      userId: req.userId,
      action: 'DELETE_LEAD',
      entityType: 'lead',
      entityId: req.params.id,
      details: { phone: lead.phone }
    });
  }

  res.json(lead);
}));

// 🧹 CLEANUP: Merge duplicate leads with same last 9 phone digits (Global Script - Can be secured in phase 2)
app.post('/api/leads/cleanup-duplicates', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  const client = await db.pool.connect();
  const merged = [];
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at ASC FOR UPDATE', [req.tenantId]);
    const leads = result.rows;
    const seenSuffixes = new Map();

    for (const lead of leads) {
      const rawPhone = String(lead.phone || '').trim();
      const lower = rawPhone.toLowerCase();
      if (lower.startsWith('fb:') || lower.startsWith('ig:') || lower.startsWith('meta:')) continue;
      const phone = rawPhone.replace(/\D/g, '');
      if (!phone || phone.length < 7 || phone.length > 15) continue;

      const suffix = phone.length >= 9 ? phone.slice(-9) : phone;
      if (!seenSuffixes.has(suffix)) {
        seenSuffixes.set(suffix, lead.id);
        continue;
      }

      const canonicalId = seenSuffixes.get(suffix);
      const canonicalRes = await client.query('SELECT * FROM leads WHERE id = $1 AND tenant_id = $2', [canonicalId, req.tenantId]);
      const canonical = canonicalRes.rows[0];
      if (!canonical) continue;

      await client.query(`
        UPDATE leads
        SET
          last_message = COALESCE(leads.last_message, $1),
          source_message = COALESCE(leads.source_message, $2),
          source_contact_name = COALESCE(leads.source_contact_name, $3),
          name = COALESCE(leads.name, $4),
          whatsapp_id = COALESCE(leads.whatsapp_id, $5),
          value = GREATEST(COALESCE(leads.value, 0), COALESCE($6, 0)),
          product_name = COALESCE(leads.product_name, $7),
          extra_data = COALESCE(leads.extra_data, '{}'::jsonb) || COALESCE($8::jsonb, '{}'::jsonb),
          updated_at = NOW()
        WHERE id = $9 AND tenant_id = $10
      `, [
        lead.last_message || null,
        lead.source_message || null,
        lead.source_contact_name || null,
        lead.name || null,
        lead.whatsapp_id || null,
        lead.value || 0,
        lead.product_name || null,
        lead.extra_data || {},
        canonicalId,
        req.tenantId,
      ]);

      await client.query('UPDATE messages SET lead_id = $1, phone = $2 WHERE tenant_id = $3 AND lead_id = $4', [canonicalId, canonical.phone, req.tenantId, lead.id]);
      await client.query('UPDATE follow_ups SET lead_id = $1, updated_at = NOW() WHERE tenant_id = $2 AND lead_id = $3', [canonicalId, req.tenantId, lead.id]);
      await client.query('UPDATE notifications SET lead_id = $1 WHERE tenant_id = $2 AND lead_id = $3', [canonicalId, req.tenantId, lead.id]);
      await client.query("UPDATE audit_logs SET entity_id = $1 WHERE tenant_id = $2 AND entity_type = 'lead' AND entity_id = $3", [canonicalId, req.tenantId, lead.id]);
      await client.query(`
        INSERT INTO lead_reads (tenant_id, lead_id, user_id, last_read_at, updated_at)
        SELECT tenant_id, $1, user_id, MAX(last_read_at) AS last_read_at, NOW()
        FROM lead_reads
        WHERE tenant_id = $2 AND lead_id = $3
        GROUP BY tenant_id, user_id
        ON CONFLICT (tenant_id, lead_id, user_id)
        DO UPDATE SET
          last_read_at = GREATEST(lead_reads.last_read_at, EXCLUDED.last_read_at),
          updated_at = NOW()
      `, [canonicalId, req.tenantId, lead.id]);
      await client.query('DELETE FROM lead_reads WHERE tenant_id = $1 AND lead_id = $2', [req.tenantId, lead.id]);
      await client.query('DELETE FROM leads WHERE id = $1 AND tenant_id = $2', [lead.id, req.tenantId]);

      merged.push({ deleted: lead.id, mergedInto: canonicalId, phone: lead.phone });
      console.log(`🧹 Merged duplicate safely: ${lead.phone} → ${canonicalId}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await emitScopedLeadList(req.tenantId);

  res.json({ merged, count: merged.length, message: `Merged ${merged.length} duplicate leads` });
}));

app.get('/api/leads/:id/messages', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const visibleLead = await loadAccessibleLead(req, req.params.id);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
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
  const visibleLead = await loadAccessibleLead(req, req.params.id);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
  const lead = await db.markLeadRead(req.params.id, req.tenantId, req.userId || null);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const room = req.userId ? `${req.tenantId}:user:${req.userId}` : req.tenantId;
  io.to(room).emit('lead_read', {
    leadId: req.params.id,
    timestamp: lead.last_read_at || new Date().toISOString(),
    unread_count: lead.unread_count ?? 0,
  });
  res.json({ success: true, lead });
}));

// Close/reopen conversation (pauses delay/SLA until next inbound message)
app.post('/api/leads/:id/close', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!hasPermission(req, 'change_status')) return res.status(403).json({ error: 'Status dəyişmək icazəniz yoxdur' });
  const leadId = String(req.params.id || '').trim();
  if (!leadId) return res.status(400).json({ error: 'Lead id is required' });
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });

  const upd = await db.pool.query(
    'UPDATE leads SET conversation_closed = true, conversation_closed_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id',
    [leadId, req.tenantId]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });

  const beforeLeadRes = await db.pool.query(
    'SELECT status FROM leads WHERE id = $1 AND tenant_id = $2',
    [leadId, req.tenantId]
  ).catch(() => ({ rows: [] }));
  const statusBeforeCloseMove = beforeLeadRes.rows?.[0]?.status ? String(beforeLeadRes.rows[0].status).trim() : '';

  // Optional: also move to a dedicated stage when closed (configurable in CRM settings)
  let movedToStage = '';
  try {
    const auto = await getTenantAutomationSettings(req.tenantId);
    const cfg = auto && auto.closeMovesToStage ? auto.closeMovesToStage : null;
    const enabled = cfg && cfg.enabled === true;
    const targetStage = cfg && cfg.targetStage ? String(cfg.targetStage).trim() : '';
    if (enabled && targetStage) {
      const moved = await db.updateLeadStatus(leadId, targetStage, req.tenantId).catch(() => null);
      if (moved) {
        movedToStage = targetStage;
        if (statusBeforeCloseMove && statusBeforeCloseMove !== targetStage) {
          await logLeadAudit(req.tenantId, req.userId, 'AUTO_STAGE_ON_CLOSE', leadId, {
            from_status: statusBeforeCloseMove,
            to_status: targetStage,
            reason: 'conversation_closed',
            auto: true
          });
        }
      }
    }
  } catch {
    // ignore
  }

  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'CONVERSATION_CLOSED',
    entityType: 'lead',
    entityId: leadId,
    details: movedToStage ? { moved_to_stage: movedToStage } : {}
  }).catch(() => null);

  const decorated = await db.pool.query(
    `SELECT l.*, fu.next_due_at AS next_followup_due_at
     FROM leads l
     LEFT JOIN LATERAL (
       SELECT MIN(due_at) AS next_due_at
       FROM follow_ups f
       WHERE f.tenant_id = l.tenant_id
         AND f.lead_id = l.id
         AND f.status = 'open'
     ) fu ON true
     WHERE l.id = $1 AND l.tenant_id = $2`,
    [leadId, req.tenantId]
  );

  const lead = decorated.rows?.[0] || null;
  if (lead) await emitLeadUpdatedScoped(req.tenantId, lead);
  res.json(lead || { success: true });
}));

app.post('/api/leads/:id/reopen', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!hasPermission(req, 'change_status')) return res.status(403).json({ error: 'Status dəyişmək icazəniz yoxdur' });
  const leadId = String(req.params.id || '').trim();
  if (!leadId) return res.status(400).json({ error: 'Lead id is required' });
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });

  const upd = await db.pool.query(
    'UPDATE leads SET conversation_closed = false, conversation_closed_at = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id',
    [leadId, req.tenantId]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });

  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'CONVERSATION_REOPENED',
    entityType: 'lead',
    entityId: leadId,
    details: {}
  }).catch(() => null);

  const decorated = await db.pool.query(
    `SELECT l.*, fu.next_due_at AS next_followup_due_at
     FROM leads l
     LEFT JOIN LATERAL (
       SELECT MIN(due_at) AS next_due_at
       FROM follow_ups f
       WHERE f.tenant_id = l.tenant_id
         AND f.lead_id = l.id
         AND f.status = 'open'
     ) fu ON true
     WHERE l.id = $1 AND l.tenant_id = $2`,
    [leadId, req.tenantId]
  );

  const lead = decorated.rows?.[0] || null;
  if (lead) await emitLeadUpdatedScoped(req.tenantId, lead);
  res.json(lead || { success: true });
}));

// ═══════════════════════════════════════════════════════════════
// 📌 FOLLOW-UPS (Tasks / Reminders)
// ═══════════════════════════════════════════════════════════════

function parseDateTimeInput(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

app.get('/api/leads/:id/follow-ups', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const leadId = String(req.params.id || '').trim();
  if (!leadId) return res.status(400).json({ error: 'Lead id is required' });
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });

  const rows = await db.pool.query(
    `SELECT id, lead_id, assignee_id, created_by, status, due_at, note, notified_at, done_at, created_at, updated_at
     FROM follow_ups
     WHERE tenant_id = $1 AND lead_id = $2
     ORDER BY due_at ASC`,
    [req.tenantId, leadId]
  );
  res.json(rows.rows || []);
}));

app.post('/api/leads/:id/follow-ups', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const leadId = String(req.params.id || '').trim();
  const due = parseDateTimeInput(req.body?.due_at);
  const note = String(req.body?.note || '').trim();
  const assigneeIdRaw = req.body?.assignee_id;
  const assigneeId = assigneeIdRaw ? String(assigneeIdRaw).trim() : null;

  if (!leadId) return res.status(400).json({ error: 'Lead id is required' });
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
  if (!due) return res.status(400).json({ error: 'due_at is required' });
  if (due.getTime() < Date.now() - 5 * 60 * 1000) {
    return res.status(400).json({ error: 'due_at cannot be in the past' });
  }

  const leadRes = await db.pool.query('SELECT id, assignee_id FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, req.tenantId]);
  if (leadRes.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
  const lead = leadRes.rows[0];
  const targetAssignee = assigneeId || lead.assignee_id || null;

  const ins = await db.pool.query(
    `INSERT INTO follow_ups (tenant_id, lead_id, assignee_id, created_by, status, due_at, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, NOW(), NOW())
     RETURNING *`,
    [req.tenantId, leadId, targetAssignee, req.userId || null, due.toISOString(), note || null]
  );

  // Timeline entry
  try {
    await db.logAuditAction({
      tenantId: req.tenantId,
      userId: req.userId,
      action: 'FOLLOWUP_CREATED',
      entityType: 'lead',
      entityId: leadId,
      details: {
        followup_id: ins.rows[0]?.id || null,
        assignee_id: targetAssignee,
        due_at: due.toISOString(),
        note: note || null
      }
    });
  } catch { }

  // Broadcast lead updated (so UI can show next_followup_due_at)
  try {
    await emitScopedLeadList(req.tenantId);
  } catch { }

  res.status(201).json(ins.rows[0]);
}));

app.patch('/api/follow-ups/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Follow-up id is required' });

  const statusRaw = req.body?.status;
  const status = statusRaw ? String(statusRaw).trim().toLowerCase() : null;
  const due = req.body?.due_at !== undefined ? parseDateTimeInput(req.body?.due_at) : undefined;
  const note = req.body?.note !== undefined ? String(req.body?.note || '').trim() : undefined;
  const assigneeId = req.body?.assignee_id !== undefined ? (req.body?.assignee_id ? String(req.body.assignee_id).trim() : null) : undefined;

  const allowed = new Set(['open', 'done', 'cancelled']);
  if (status !== null && !allowed.has(status)) return res.status(400).json({ error: 'Invalid status' });
  if (due === null) return res.status(400).json({ error: 'Invalid due_at' });

  const sets = [];
  const values = [];
  let i = 1;

  if (status !== null) {
    sets.push(`status = $${i++}`);
    values.push(status);
    if (status === 'done') {
      sets.push(`done_at = NOW()`);
    }
    if (status !== 'open') {
      sets.push(`notified_at = COALESCE(notified_at, NOW())`);
      sets.push(`overdue_notified_at = COALESCE(overdue_notified_at, NOW())`);
    }
  }
  if (due !== undefined) {
    sets.push(`due_at = $${i++}`);
    values.push(due ? due.toISOString() : null);
    // If rescheduled, allow re-notify
    sets.push(`notified_at = NULL`);
    sets.push(`overdue_notified_at = NULL`);
  }
  if (note !== undefined) {
    sets.push(`note = $${i++}`);
    values.push(note || null);
  }
  if (assigneeId !== undefined) {
    sets.push(`assignee_id = $${i++}`);
    values.push(assigneeId);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

  sets.push('updated_at = NOW()');
  values.push(req.tenantId);
  values.push(id);

  const q = `
    UPDATE follow_ups
    SET ${sets.join(', ')}
    WHERE tenant_id = $${i++} AND id = $${i}
    RETURNING *
  `;
  const upd = await db.pool.query(q, values);
  if (upd.rowCount === 0) return res.status(404).json({ error: 'Follow-up not found' });

  // Timeline entry
  try {
    const after = upd.rows[0] || {};
    let action = 'FOLLOWUP_UPDATED';
    if (status === 'done') action = 'FOLLOWUP_DONE';
    else if (status === 'cancelled') action = 'FOLLOWUP_CANCELLED';
    else if (due !== undefined) action = 'FOLLOWUP_RESCHEDULED';
    else if (assigneeId !== undefined) action = 'FOLLOWUP_REASSIGNED';
    else if (note !== undefined) action = 'FOLLOWUP_NOTE';
    await db.logAuditAction({
      tenantId: req.tenantId,
      userId: req.userId,
      action,
      entityType: 'lead',
      entityId: after.lead_id,
      details: {
        followup_id: after.id,
        status: after.status,
        due_at: after.due_at ? new Date(after.due_at).toISOString() : null,
        assignee_id: after.assignee_id || null,
        note: after.note || null
      }
    });
  } catch { }

  // Broadcast lead list refresh (next due might change)
  try {
    await emitScopedLeadList(req.tenantId);
  } catch { }

  res.json(upd.rows[0]);
}));

// ═══════════════════════════════════════════════════════════════
// 🔔 NOTIFICATIONS (persistent in-app alerts)
// ═══════════════════════════════════════════════════════════════

app.get('/api/notifications', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!req.userId) return res.json({ notifications: [], unread_count: 0 });

  let limit = parseInt(String(req.query.limit || '60'), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 60;
  if (limit > 200) limit = 200;

  const unreadOnly = String(req.query.unread || '').trim() === '1';

  const whereUnread = unreadOnly ? 'AND n.read_at IS NULL' : '';

  const list = await db.pool.query(
    `SELECT n.id, n.tenant_id, n.user_id, n.type, n.title, n.body, n.payload, n.dedupe_key, n.lead_id, n.followup_id,
            n.created_at, n.read_at,
            l.phone AS lead_phone, l.name AS lead_name
     FROM notifications n
     LEFT JOIN leads l ON l.id = n.lead_id AND l.tenant_id = n.tenant_id
     WHERE n.tenant_id = $1 AND n.user_id = $2
     ${whereUnread}
     ORDER BY n.created_at DESC
     LIMIT $3`,
    [req.tenantId, req.userId, limit]
  );

  const unreadCountRes = await db.pool.query(
    'SELECT COUNT(*)::int AS c FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL',
    [req.tenantId, req.userId]
  );
  const unread_count = unreadCountRes.rows?.[0]?.c || 0;

  res.json({ notifications: list.rows || [], unread_count });
}));

app.post('/api/notifications/:id/read', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Notification id is required' });

  const upd = await db.pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING id, read_at',
    [req.tenantId, req.userId, id]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
  res.json({ success: true, id, read_at: upd.rows[0].read_at ? new Date(upd.rows[0].read_at).toISOString() : null });
}));

app.post('/api/notifications/read-all', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  await db.pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL',
    [req.tenantId, req.userId]
  );
  res.json({ success: true });
}));

// ADDED IN PHASE 6: Sending Messages directly to DB Queue
app.post('/api/leads/:id/messages', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  if (!hasPermission(req, 'send_messages')) {
    return res.status(403).json({ error: 'Sizə mesaj göndərmək icazəsi verilməyib' });
  }

  const leadId = req.params.id;
  const visibleLead = await loadAccessibleLead(req, leadId);
  if (!visibleLead) return res.status(404).json({ error: 'Lead not found' });
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
  await emitNewMessageScoped(req.tenantId, lead, payload);

  // Update last_outbound_at immediately so "gecikme" dot doesn't stay on
  try {
    await db.pool.query(
      'UPDATE leads SET last_outbound_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2',
      [leadId, req.tenantId]
    );
    const decorated = await db.pool.query(
      `SELECT l.*, fu.next_due_at AS next_followup_due_at
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT MIN(due_at) AS next_due_at
         FROM follow_ups f
         WHERE f.tenant_id = l.tenant_id
           AND f.lead_id = l.id
           AND f.status = 'open'
       ) fu ON true
       WHERE l.id = $1 AND l.tenant_id = $2`,
      [leadId, req.tenantId]
    );
    const updatedLead = decorated.rows?.[0] || null;
    if (updatedLead) await emitLeadUpdatedScoped(req.tenantId, updatedLead);
  } catch {
    // ignore
  }

  // Apply routing rules immediately for outgoing messages as well
  try {
    const updated = await maybeApplyRoutingRulesToLead(req.tenantId, lead, body, payload);
    if (updated) {
      await emitLeadUpdatedScoped(req.tenantId, updated);
    }
  } catch (e) {
    console.warn('⚠️ Routing apply failed (outgoing):', e.message);
  }

  res.status(201).json(newMsg);
}));

app.get('/api/stats', requireTenantAuth, requirePermission('view_stats', 'Statistikanı görmək icazəniz yoxdur'), asyncHandler(async (req, res) => {
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

app.get('/api/analytics/response-times', requireTenantAuth, requirePermission('view_stats', 'Statistikanı görmək icazəniz yoxdur'), asyncHandler(async (req, res) => {
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

  let by_operator = Array.from(op.entries()).map(([id, data]) => {
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

  if (!hasPermission(req, 'view_other_operator_stats')) {
    by_operator = by_operator.filter((row) => row.user_id && String(row.user_id) === String(req.userId || ''));
  }

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
      headers: safeInternalHeaders()
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
      headers: safeInternalHeaders()
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

  // Bust per-tenant caches (settings affect automation/notifications)
  try { tenantSettingsCache.delete(String(req.tenantId)); } catch { }
  try { tenantAutomationCache.delete(String(req.tenantId)); } catch { }

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

function normalizeFacebookAdAccount(row) {
  const id = String(row?.id || '').trim();
  const accountId = String(row?.account_id || '').trim() || id.replace(/^act_/, '');
  const apiId = id || (accountId ? `act_${accountId}` : '');
  return {
    id,
    api_id: apiId,
    account_id: accountId,
    name: row?.name ? String(row.name) : (accountId ? `Ad Account ${accountId}` : 'Ad Account'),
    account_status: row?.account_status != null ? Number(row.account_status) : null,
    currency: row?.currency ? String(row.currency) : null,
    timezone_name: row?.timezone_name ? String(row.timezone_name) : null,
    timezone_offset_hours_utc: row?.timezone_offset_hours_utc != null ? Number(row.timezone_offset_hours_utc) : null,
    business_name: row?.business?.name ? String(row.business.name) : null,
    business_id: row?.business?.id ? String(row.business.id) : null,
  };
}

async function fetchFacebookAdAccountsForToken(userAccessToken) {
  const token = String(userAccessToken || '').trim();
  if (!token) throw new Error('Token is required');

  const out = [];
  let nextUrl = `https://graph.facebook.com/v19.0/me/adaccounts?fields=${encodeURIComponent(
    'id,account_id,name,account_status,currency,timezone_name,timezone_offset_hours_utc,business{id,name}'
  )}&limit=200&access_token=${encodeURIComponent(token)}`;

  for (let i = 0; i < 10 && nextUrl; i++) {
    const data = await fetchJsonWithRetry(nextUrl, {}, { retries: 1, timeoutMs: 7000 });
    const rows = Array.isArray(data?.data) ? data.data : [];
    for (const row of rows) {
      const normalized = normalizeFacebookAdAccount(row);
      if (normalized.account_id || normalized.id) out.push(normalized);
    }
    nextUrl = data?.paging?.next ? String(data.paging.next) : '';
  }

  return out;
}

function sanitizeFacebookAdImportConfig(row) {
  const raw = row && typeof row === 'object' ? row : {};
  const accountCache = Array.isArray(raw.account_cache) ? raw.account_cache.map(normalizeFacebookAdAccount) : [];
  const campaignCache = Array.isArray(raw.campaign_cache) ? raw.campaign_cache.map(normalizeFacebookCampaign) : [];
  const selectedAccountIds = Array.isArray(raw.selected_account_ids)
    ? raw.selected_account_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const selectedCampaignIds = Array.isArray(raw.selected_campaign_ids)
    ? raw.selected_campaign_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const selectedSet = new Set(selectedAccountIds);
  const selectedCampaignSet = new Set(selectedCampaignIds);
  const selectedAccounts = accountCache.filter((a) => selectedSet.has(a.account_id) || selectedSet.has(a.id) || selectedSet.has(a.api_id));
  const selectedCampaigns = campaignCache.filter((c) => selectedCampaignSet.has(c.id));
  return {
    hasToken: Boolean(raw.access_token),
    tokenHint: raw.token_hint ? String(raw.token_hint) : null,
    selectedAccountIds,
    selectedCampaignIds,
    selectedAccounts,
    selectedCampaigns,
    accountCache,
    campaignCache,
    lastSyncAt: raw.last_sync_at || null,
    lastError: raw.last_error || null,
    updatedAt: raw.updated_at || null,
  };
}

function normalizeFacebookCampaign(row) {
  return {
    id: String(row?.id || '').trim(),
    account_id: String(row?.account_id || '').trim(),
    account_api_id: String(row?.account_api_id || '').trim(),
    account_name: row?.account_name ? String(row.account_name) : null,
    name: row?.name ? String(row.name) : 'Campaign',
    status: row?.status ? String(row.status) : null,
    effective_status: Array.isArray(row?.effective_status)
      ? row.effective_status.map((x) => String(x || '').trim()).filter(Boolean)
      : (row?.effective_status ? [String(row.effective_status)] : []),
    objective: row?.objective ? String(row.objective) : null,
    updated_time: row?.updated_time ? String(row.updated_time) : null,
  };
}

async function fetchFacebookCampaignsForAccounts(userAccessToken, accounts = []) {
  const token = String(userAccessToken || '').trim();
  if (!token) throw new Error('Token is required');
  const out = [];

  for (const a of accounts) {
    const accountId = String(a?.account_id || '').trim();
    const accountApiId = String(a?.api_id || '').trim() || (accountId ? `act_${accountId}` : '');
    if (!accountApiId) continue;

    let nextUrl = `https://graph.facebook.com/v19.0/${encodeURIComponent(accountApiId)}/campaigns?fields=${encodeURIComponent(
      'id,name,status,effective_status,objective,updated_time'
    )}&limit=200&access_token=${encodeURIComponent(token)}`;

    for (let i = 0; i < 10 && nextUrl; i++) {
      const data = await fetchJsonWithRetry(nextUrl, {}, { retries: 1, timeoutMs: 7000 });
      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const row of rows) {
        const normalized = normalizeFacebookCampaign({
          ...row,
          account_id: accountId,
          account_api_id: accountApiId,
          account_name: a?.name || null,
        });
        if (normalized.id) out.push(normalized);
      }
      nextUrl = data?.paging?.next ? String(data.paging.next) : '';
    }
  }

  return out;
}

const FACEBOOK_RESULT_ACTION_PRESETS = {
  message: [
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.total_messaging_connection',
    'onsite_conversion.messaging_first_reply',
  ],
  lead: [
    'onsite_conversion.lead_grouped',
    'lead',
    'offsite_conversion.fb_pixel_lead',
    'omni_lead',
  ],
  purchase: [
    'omni_purchase',
    'purchase',
    'offsite_conversion.fb_pixel_purchase',
    'onsite_web_purchase',
  ]
};

function toNumberSafe(value, fallback = 0) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function pickFacebookResult(actions = [], costs = [], metric = 'message') {
  const actionRows = Array.isArray(actions) ? actions : [];
  const costRows = Array.isArray(costs) ? costs : [];
  const map = new Map(actionRows.map((a) => [String(a?.action_type || ''), toNumberSafe(a?.value, 0)]));
  const costMap = new Map(costRows.map((a) => [String(a?.action_type || ''), toNumberSafe(a?.value, 0)]));
  const metricKey = String(metric || 'message').trim().toLowerCase();
  const priority = FACEBOOK_RESULT_ACTION_PRESETS[metricKey] || FACEBOOK_RESULT_ACTION_PRESETS.message;

  for (const key of priority) {
    const value = map.get(key);
    if (Number.isFinite(value) && value > 0) {
      return {
        resultType: key,
        results: value,
        costPerResult: costMap.get(key) ?? null,
      };
    }
  }

  for (const [key, value] of map.entries()) {
    const pattern = metricKey === 'purchase' ? /purchas|checkout/i : (metricKey === 'lead' ? /lead|submit/i : /messag|chat|conversation/i);
    if (pattern.test(key) && Number.isFinite(value) && value > 0) {
      return {
        resultType: key,
        results: value,
        costPerResult: costMap.get(key) ?? null,
      };
    }
  }

  return { resultType: null, results: 0, costPerResult: null };
}

function normalizeFacebookInsightRow(row, campaignMeta, metric = 'message') {
  const spend = toNumberSafe(row?.spend, 0);
  const impressions = toNumberSafe(row?.impressions, 0);
  const clicks = toNumberSafe(row?.clicks, 0);
  const ctr = row?.ctr != null ? toNumberSafe(row.ctr, 0) : (impressions > 0 ? (clicks / impressions) * 100 : 0);
  const cpm = row?.cpm != null ? toNumberSafe(row.cpm, 0) : (impressions > 0 ? (spend / impressions) * 1000 : 0);
  const picked = pickFacebookResult(row?.actions, row?.cost_per_action_type, metric);
  const results = toNumberSafe(picked.results, 0);
  const costPerResult = picked.costPerResult != null
    ? toNumberSafe(picked.costPerResult, 0)
    : (results > 0 ? spend / results : 0);

  return {
    campaign_id: String(campaignMeta?.id || row?.campaign_id || '').trim(),
    campaign_name: String(campaignMeta?.name || row?.campaign_name || 'Campaign'),
    account_id: String(campaignMeta?.account_id || '').trim(),
    account_name: campaignMeta?.account_name ? String(campaignMeta.account_name) : null,
    date_start: row?.date_start ? String(row.date_start) : null,
    date_stop: row?.date_stop ? String(row.date_stop) : null,
    spend,
    impressions,
    clicks,
    ctr,
    cpm,
    results,
    result_type: picked.resultType,
    cost_per_result: costPerResult,
  };
}

function aggregateFacebookInsightRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const spend = safeRows.reduce((s, r) => s + toNumberSafe(r?.spend, 0), 0);
  const impressions = safeRows.reduce((s, r) => s + toNumberSafe(r?.impressions, 0), 0);
  const clicks = safeRows.reduce((s, r) => s + toNumberSafe(r?.clicks, 0), 0);
  const results = safeRows.reduce((s, r) => s + toNumberSafe(r?.results, 0), 0);
  return {
    spend,
    impressions,
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    results,
    cost_per_result: results > 0 ? spend / results : 0,
  };
}

function normalizeDashboardText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDashboardWonStageId(settings) {
  const stages = Array.isArray(settings?.pipelineStages) ? settings.pipelineStages : [];
  const byId = stages.find((stage) => String(stage?.id || '').trim() === 'won');
  if (byId) return String(byId.id);
  const byLabel = stages.find((stage) => {
    const label = normalizeDashboardText(stage?.label || '');
    return label === 'satis' || label === 'satış' || label === 'sale';
  });
  return byLabel ? String(byLabel.id) : 'won';
}

function findDashboardStage(settings, matcher) {
  const stages = Array.isArray(settings?.pipelineStages) ? settings.pipelineStages : [];
  return stages.find((stage) => matcher(normalizeDashboardText(stage?.id || ''), normalizeDashboardText(stage?.label || ''))) || null;
}

function getDashboardSummaryStageIds(settings) {
  const potential = findDashboardStage(settings, (id, label) => (
    id === 'potential' || label.includes('potential') || label.includes('kvalifikasiya') || label.includes('potensial')
  ));
  const unanswered = findDashboardStage(settings, (id, label) => (
    id.includes('cavabsiz') || label.includes('cavabsiz') || label.includes('unanswered') || label.includes('no answer')
  ));
  const lost = findDashboardStage(settings, (id, label) => (
    id === 'lost' || label.includes('ugursuz') || label.includes('uğursuz') || label.includes('satıs olmadi') || label.includes('satış olmadı') || label.includes('unsuccessful')
  ));
  const won = findDashboardStage(settings, (id, label) => (
    id === 'won' || label === 'satis' || label === 'satış' || label === 'sale'
  ));
  return {
    potential: potential ? String(potential.id) : null,
    unanswered: unanswered ? String(unanswered.id) : null,
    lost: lost ? String(lost.id) : null,
    won: won ? String(won.id) : getDashboardWonStageId(settings),
  };
}

function normalizeDashboardMappings(settings) {
  const dashboard = settings && typeof settings === 'object' ? settings.dashboard || {} : {};
  const fieldId = String(dashboard?.fieldId || '').trim();
  const customFields = Array.isArray(settings?.customFields) ? settings.customFields : [];
  const field = customFields.find((item) => item && item.id === fieldId && item.type === 'select') || null;
  const allowedValues = new Set((field?.options || []).map((item) => String(item || '').trim()).filter(Boolean));
  const rows = Array.isArray(dashboard?.mappings) ? dashboard.mappings : [];
  return {
    field,
    mappings: rows
      .map((row) => ({
        value: String(row?.value || '').trim(),
        campaignIds: Array.isArray(row?.campaignIds)
          ? row.campaignIds.map((id) => String(id || '').trim()).filter(Boolean)
          : []
      }))
      .filter((row) => row.value && (!field || allowedValues.has(row.value)))
  };
}

async function fetchFacebookInsightsForCampaigns(userAccessToken, campaigns = [], dateRange = {}, metric = 'message') {
  const token = String(userAccessToken || '').trim();
  if (!token) throw new Error('Token is required');
  const out = [];

  const since = String(dateRange?.start || '').trim();
  const until = String(dateRange?.end || '').trim();
  const hasRange = Boolean(since && until);

  for (const campaign of campaigns) {
    const campaignId = String(campaign?.id || '').trim();
    if (!campaignId) continue;

    let nextUrl = `https://graph.facebook.com/v19.0/${encodeURIComponent(campaignId)}/insights?fields=${encodeURIComponent(
      'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,actions,cost_per_action_type,date_start,date_stop'
    )}&limit=200&access_token=${encodeURIComponent(token)}`;
    if (hasRange) nextUrl += `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;
    else nextUrl += '&date_preset=maximum';

    for (let i = 0; i < 10 && nextUrl; i++) {
      const data = await fetchJsonWithRetry(nextUrl, {}, { retries: 1, timeoutMs: 8000 });
      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const row of rows) {
        out.push(normalizeFacebookInsightRow(row, campaign, metric));
      }
      nextUrl = data?.paging?.next ? String(data.paging.next) : '';
    }
  }

  return out;
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
  if (!hasPermission(req, 'send_messages')) {
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

app.get('/api/facebook-import/config', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const row = await db.getFacebookAdImport(req.tenantId).catch(() => null);
  res.json(sanitizeFacebookAdImportConfig(row));
}));

app.post('/api/facebook-import/fetch', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });

  const ex = await exchangeForLongLivedUserToken(token).catch(() => ({ access_token: token, expires_in: null, exchanged: false }));
  const effectiveToken = ex?.access_token ? String(ex.access_token) : token;
  const accounts = await fetchFacebookAdAccountsForToken(effectiveToken);
  res.json({
    exchanged: Boolean(ex?.exchanged),
    expires_in: ex?.expires_in || null,
    tokenHint: `${effectiveToken.slice(0, 6)}...${effectiveToken.slice(-4)}`,
    accounts,
  });
}));

app.post('/api/facebook-import/campaigns', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  const existing = await db.getFacebookAdImport(req.tenantId).catch(() => null);
  const token = String(req.body?.token || existing?.access_token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });

  const accountIds = Array.isArray(req.body?.accountIds)
    ? req.body.accountIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (accountIds.length === 0) return res.status(400).json({ error: 'accountIds is required' });

  const accountsSource = Array.isArray(req.body?.accounts) && req.body.accounts.length > 0
    ? req.body.accounts
    : (Array.isArray(existing?.account_cache) ? existing.account_cache : []);
  const normalizedAccounts = accountsSource.map(normalizeFacebookAdAccount);
  const selectedAccounts = normalizedAccounts.filter((a) => accountIds.includes(a.account_id) || accountIds.includes(a.id) || accountIds.includes(a.api_id));
  const campaigns = await fetchFacebookCampaignsForAccounts(token, selectedAccounts);
  res.json({ campaigns, accountIds, count: campaigns.length });
}));

app.post('/api/facebook-import/save', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.upsertFacebookAdImport !== 'function') return res.status(501).json({ error: 'Facebook import storage unavailable' });

  const existing = await db.getFacebookAdImport(req.tenantId).catch(() => null);
  const token = String(req.body?.token || existing?.access_token || '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });

  const accountsInput = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
  const accounts = accountsInput.length > 0
    ? accountsInput.map(normalizeFacebookAdAccount).filter((a) => a.account_id || a.id)
    : await fetchFacebookAdAccountsForToken(token);
  const selectedRaw = Array.isArray(req.body?.selectedAccountIds) ? req.body.selectedAccountIds : [];
  const selectedSet = new Set(selectedRaw.map((x) => String(x || '').trim()).filter(Boolean));
  const selectedAccountIds = accounts
    .filter((a) => selectedSet.has(a.account_id) || selectedSet.has(a.id) || selectedSet.has(a.api_id))
    .map((a) => a.account_id || a.id);
  const campaignInput = Array.isArray(req.body?.campaigns) ? req.body.campaigns : (Array.isArray(existing?.campaign_cache) ? existing.campaign_cache : []);
  const campaigns = campaignInput.map(normalizeFacebookCampaign).filter((c) => c.id);
  const selectedCampaignIds = Array.isArray(req.body?.selectedCampaignIds)
    ? req.body.selectedCampaignIds.map((x) => String(x || '').trim()).filter(Boolean)
    : (Array.isArray(existing?.selected_campaign_ids) ? existing.selected_campaign_ids.map((x) => String(x || '').trim()).filter(Boolean) : []);

  const saved = await db.upsertFacebookAdImport(req.tenantId, {
    access_token: token,
    selected_account_ids: selectedAccountIds,
    selected_campaign_ids: selectedCampaignIds,
    account_cache: accounts,
    campaign_cache: campaigns,
    last_error: null,
  });

  res.status(201).json({ success: true, config: sanitizeFacebookAdImportConfig({ ...saved, access_token: token }) });
}));

app.post('/api/facebook-import/refresh', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const existing = await db.getFacebookAdImport(req.tenantId).catch(() => null);
  if (!existing?.access_token) return res.status(404).json({ error: 'Saved Facebook token not found' });

  const accounts = await fetchFacebookAdAccountsForToken(existing.access_token);
  const selectedAccountIds = Array.isArray(existing.selected_account_ids)
    ? existing.selected_account_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const selectedAccounts = accounts.filter((a) => selectedAccountIds.includes(a.account_id) || selectedAccountIds.includes(a.id) || selectedAccountIds.includes(a.api_id));
  const campaigns = selectedAccounts.length > 0
    ? await fetchFacebookCampaignsForAccounts(existing.access_token, selectedAccounts)
    : [];
  const selectedCampaignIds = Array.isArray(existing.selected_campaign_ids)
    ? existing.selected_campaign_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  const saved = await db.upsertFacebookAdImport(req.tenantId, {
    access_token: existing.access_token,
    selected_account_ids: selectedAccountIds,
    selected_campaign_ids: selectedCampaignIds,
    account_cache: accounts,
    campaign_cache: campaigns,
    last_error: null,
  });
  res.json({ success: true, config: sanitizeFacebookAdImportConfig({ ...saved, access_token: existing.access_token }) });
}));

app.get('/api/facebook-import/insights', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const existing = await db.getFacebookAdImport(req.tenantId).catch(() => null);
  if (!existing?.access_token) return res.status(404).json({ error: 'Saved Facebook token not found' });

  const metric = String(req.query.metric || 'message').trim().toLowerCase();
  const selectedCampaignIds = Array.isArray(existing.selected_campaign_ids)
    ? existing.selected_campaign_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const campaignCache = Array.isArray(existing.campaign_cache)
    ? existing.campaign_cache.map(normalizeFacebookCampaign).filter((c) => c.id)
    : [];
  const selectedCampaigns = campaignCache.filter((c) => selectedCampaignIds.includes(c.id));
  if (selectedCampaigns.length === 0) {
    return res.json({
      summary: { spend: 0, results: 0, ctr: 0, cpm: 0, cost_per_result: 0 },
      daily: [],
      campaigns: [],
      selectedCampaignIds,
      metric,
      range: { start: req.query.start || null, end: req.query.end || null }
    });
  }

  const dateRange = {
    start: String(req.query.start || '').trim() || null,
    end: String(req.query.end || '').trim() || null,
  };

  const insightRows = await fetchFacebookInsightsForCampaigns(existing.access_token, selectedCampaigns, dateRange, metric);

  const dailyMap = new Map();
  for (const row of insightRows) {
    const key = String(row.date_start || 'unknown');
    const arr = dailyMap.get(key) || [];
    arr.push(row);
    dailyMap.set(key, arr);
  }
  const daily = Array.from(dailyMap.entries())
    .map(([date, rows]) => ({ date, ...aggregateFacebookInsightRows(rows) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const campaignMap = new Map();
  for (const campaign of selectedCampaigns) campaignMap.set(campaign.id, []);
  for (const row of insightRows) {
    const arr = campaignMap.get(row.campaign_id) || [];
    arr.push(row);
    campaignMap.set(row.campaign_id, arr);
  }
  const campaigns = selectedCampaigns.map((campaign) => {
    const rows = campaignMap.get(campaign.id) || [];
    return {
      ...campaign,
      metrics: aggregateFacebookInsightRows(rows),
      daily: rows,
    };
  }).sort((a, b) => b.metrics.spend - a.metrics.spend);

  res.json({
    summary: aggregateFacebookInsightRows(insightRows),
    daily,
    campaigns,
    selectedCampaignIds,
    metric,
    range: dateRange,
  });
}));

app.get('/api/dashboard/combined', requireTenantAuth, requirePermission('view_stats', 'Dashboard görmək icazəniz yoxdur'), asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  const settings = await db.getCRMSettings(req.tenantId).catch(() => null);
  const { field, mappings } = normalizeDashboardMappings(settings || {});
  const stageLegend = Array.isArray(settings?.pipelineStages) ? settings.pipelineStages : [];
  const stageIds = getDashboardSummaryStageIds(settings || {});
  const wonStageId = stageIds.won;
  const metric = String(req.query.metric || 'message').trim().toLowerCase();
  const facebookConfig = await db.getFacebookAdImport(req.tenantId).catch(() => null);
  const campaignCache = Array.isArray(facebookConfig?.campaign_cache)
    ? facebookConfig.campaign_cache.map(normalizeFacebookCampaign).filter((c) => c.id)
    : [];
  const importedCampaignIds = Array.isArray(facebookConfig?.selected_campaign_ids)
    ? facebookConfig.selected_campaign_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const importedCampaigns = campaignCache.filter((campaign) => importedCampaignIds.includes(campaign.id));

  const dateRange = {
    start: String(req.query.start || '').trim() || null,
    end: String(req.query.end || '').trim() || null,
  };

  const warnings = [];
  const allCampaignIds = Array.from(new Set(mappings.flatMap((row) => row.campaignIds)));
  const selectedCampaigns = campaignCache.filter((campaign) => allCampaignIds.includes(campaign.id));

  let mappedInsightRows = [];
  let importedInsightRows = [];
  if (importedCampaigns.length > 0 && facebookConfig?.access_token) {
    try {
      importedInsightRows = await fetchFacebookInsightsForCampaigns(facebookConfig.access_token, importedCampaigns, dateRange, metric);
      const selectedIdSet = new Set(selectedCampaigns.map((campaign) => campaign.id));
      mappedInsightRows = importedInsightRows.filter((row) => selectedIdSet.has(String(row.campaign_id)));
    } catch (error) {
      warnings.push(`Facebook insight alınmadı: ${String(error?.message || 'unknown_error')}`);
    }
  } else if (mappings.some((row) => row.campaignIds.length > 0)) {
    warnings.push('Facebook token və ya kampaniya cache tapılmadı; yalnız CRM nəticələri göstərilir.');
  }

  const insightsByCampaignId = new Map();
  for (const row of mappedInsightRows) {
    insightsByCampaignId.set(String(row.campaign_id), row);
  }

  const mappingValues = mappings.map((row) => row.value);
  const crmByValue = new Map();
  const makeEmptyStages = () => stageLegend.map((stage) => ({
    id: stage.id,
    label: stage.label,
    color: stage.color,
    count: 0,
    revenue: 0,
  }));

  if (field && mappingValues.length > 0) {
    const values = [req.tenantId, field.id, mappingValues];
    let where = `tenant_id = $1 AND COALESCE(extra_data->>$2, '') = ANY($3::text[])`;
    let paramCount = 4;
    if (!canViewAllLeads(req)) {
      where += ` AND assignee_id = $${paramCount}`;
      values.push(req.userId);
      paramCount++;
    }
    if (dateRange.start) {
      where += ` AND created_at >= $${paramCount}`;
      values.push(new Date(`${dateRange.start}T00:00:00.000Z`));
      paramCount++;
    }
    if (dateRange.end) {
      where += ` AND created_at < $${paramCount}`;
      values.push(new Date(`${dateRange.end}T23:59:59.999Z`));
      paramCount++;
    }

    const crmRes = await db.pool.query(
      `SELECT
         COALESCE(extra_data->>$2, '') AS field_value,
         status,
         COUNT(*)::int AS lead_count,
         COALESCE(SUM(COALESCE(value, 0)), 0)::float AS value_sum
       FROM leads
       WHERE ${where}
       GROUP BY 1, 2`,
      values
    );

    for (const row of crmRes.rows || []) {
      const fieldValue = String(row.field_value || '');
      if (!crmByValue.has(fieldValue)) {
        crmByValue.set(fieldValue, {
          leads: 0,
          won_count: 0,
          pipeline_value: 0,
          won_revenue: 0,
          stages: makeEmptyStages(),
        });
      }
      const bucket = crmByValue.get(fieldValue);
      const leadCount = Number(row.lead_count || 0);
      const valueSum = Number(row.value_sum || 0);
      bucket.leads += leadCount;
      bucket.pipeline_value += valueSum;
      if (String(row.status || '') === wonStageId) {
        bucket.won_count += leadCount;
        bucket.won_revenue += valueSum;
      }
      const stage = bucket.stages.find((item) => String(item.id) === String(row.status || ''));
      if (stage) {
        stage.count += leadCount;
        stage.revenue += valueSum;
      }
    }
  }

  const overallValues = [req.tenantId];
  let overallWhere = 'tenant_id = $1';
  let overallParamCount = 2;
  if (!canViewAllLeads(req)) {
    overallWhere += ` AND assignee_id = $${overallParamCount}`;
    overallValues.push(req.userId);
    overallParamCount++;
  }
  if (dateRange.start) {
    overallWhere += ` AND created_at >= $${overallParamCount}`;
    overallValues.push(new Date(`${dateRange.start}T00:00:00.000Z`));
    overallParamCount++;
  }
  if (dateRange.end) {
    overallWhere += ` AND created_at < $${overallParamCount}`;
    overallValues.push(new Date(`${dateRange.end}T23:59:59.999Z`));
    overallParamCount++;
  }

  const overallRes = await db.pool.query(
    `SELECT
       status,
       COUNT(*)::int AS lead_count,
       COALESCE(SUM(COALESCE(value, 0)), 0)::float AS value_sum
     FROM leads
     WHERE ${overallWhere}
     GROUP BY 1`,
    overallValues
  );

  const overallStages = makeEmptyStages();
  const overallCrm = { leads: 0, won_count: 0, pipeline_value: 0, won_revenue: 0, stages: overallStages };
  for (const row of overallRes.rows || []) {
    const leadCount = Number(row.lead_count || 0);
    const valueSum = Number(row.value_sum || 0);
    overallCrm.leads += leadCount;
    overallCrm.pipeline_value += valueSum;
    if (String(row.status || '') === wonStageId) {
      overallCrm.won_count += leadCount;
      overallCrm.won_revenue += valueSum;
    }
    const stage = overallStages.find((item) => String(item.id) === String(row.status || ''));
    if (stage) {
      stage.count += leadCount;
      stage.revenue += valueSum;
    }
  }

  const groups = mappings.map((mapping) => {
    const campaigns = selectedCampaigns.filter((campaign) => mapping.campaignIds.includes(campaign.id));
    const facebookRows = campaigns.map((campaign) => insightsByCampaignId.get(campaign.id)).filter(Boolean);
    const facebook = aggregateFacebookInsightRows(facebookRows);
    const crm = crmByValue.get(mapping.value) || {
      leads: 0,
      won_count: 0,
      pipeline_value: 0,
      won_revenue: 0,
      stages: makeEmptyStages(),
    };
    const leadCount = Number(crm.leads || 0);
    const wonCount = Number(crm.won_count || 0);
    const spend = Number(facebook.spend || 0);
    const wonRevenue = Number(crm.won_revenue || 0);
    return {
      value: mapping.value,
      campaigns,
      campaignIds: mapping.campaignIds,
      facebook,
      crm,
      merged: {
        cost_per_crm_lead: leadCount > 0 ? spend / leadCount : 0,
        cost_per_sale: wonCount > 0 ? spend / wonCount : 0,
        roas: spend > 0 ? wonRevenue / spend : 0,
        conversion_rate: leadCount > 0 ? (wonCount / leadCount) * 100 : 0,
      }
    };
  });

  const totals = {
    facebook: aggregateFacebookInsightRows(importedInsightRows),
    crm: overallCrm,
  };

  const totalSpend = Number(totals.facebook.spend || 0);
  const totalLeadCount = Number(totals.crm.leads || 0);
  const stageById = new Map((overallStages || []).map((stage) => [String(stage.id), stage]));
  const summaryCards = [
    {
      key: 'total_leads',
      label: 'Total Muraciat',
      count: totalLeadCount,
      pct_of_total: totalLeadCount > 0 ? 100 : 0,
      cost_per: totalLeadCount > 0 ? totalSpend / totalLeadCount : 0,
      color: '#3b82f6',
    },
    stageIds.potential ? {
      key: 'potential',
      label: stageById.get(String(stageIds.potential))?.label || 'Potensial Musteriler',
      count: Number(stageById.get(String(stageIds.potential))?.count || 0),
      pct_of_total: totalLeadCount > 0 ? (Number(stageById.get(String(stageIds.potential))?.count || 0) / totalLeadCount) * 100 : 0,
      cost_per: Number(stageById.get(String(stageIds.potential))?.count || 0) > 0 ? totalSpend / Number(stageById.get(String(stageIds.potential))?.count || 0) : 0,
      color: '#a855f7',
    } : null,
    stageIds.won ? {
      key: 'won',
      label: stageById.get(String(stageIds.won))?.label || 'Satis',
      count: Number(stageById.get(String(stageIds.won))?.count || 0),
      pct_of_total: totalLeadCount > 0 ? (Number(stageById.get(String(stageIds.won))?.count || 0) / totalLeadCount) * 100 : 0,
      cost_per: Number(stageById.get(String(stageIds.won))?.count || 0) > 0 ? totalSpend / Number(stageById.get(String(stageIds.won))?.count || 0) : 0,
      color: '#22c55e',
    } : null,
    stageIds.unanswered ? {
      key: 'unanswered',
      label: stageById.get(String(stageIds.unanswered))?.label || 'Cevabsizlar',
      count: Number(stageById.get(String(stageIds.unanswered))?.count || 0),
      pct_of_total: totalLeadCount > 0 ? (Number(stageById.get(String(stageIds.unanswered))?.count || 0) / totalLeadCount) * 100 : 0,
      cost_per: Number(stageById.get(String(stageIds.unanswered))?.count || 0) > 0 ? totalSpend / Number(stageById.get(String(stageIds.unanswered))?.count || 0) : 0,
      color: '#f97316',
    } : null,
    stageIds.lost ? {
      key: 'lost',
      label: stageById.get(String(stageIds.lost))?.label || 'Ugursuzlar',
      count: Number(stageById.get(String(stageIds.lost))?.count || 0),
      pct_of_total: totalLeadCount > 0 ? (Number(stageById.get(String(stageIds.lost))?.count || 0) / totalLeadCount) * 100 : 0,
      cost_per: Number(stageById.get(String(stageIds.lost))?.count || 0) > 0 ? totalSpend / Number(stageById.get(String(stageIds.lost))?.count || 0) : 0,
      color: '#94a3b8',
    } : null,
  ].filter(Boolean);

  res.json({
    metric,
    range: dateRange,
    field: field ? { id: field.id, label: field.label, options: field.options || [] } : null,
    stageLegend,
    importedCampaigns: importedCampaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, account_name: campaign.account_name || null })),
    summaryCards,
    groups,
    totals: {
      ...totals,
      merged: {
        cost_per_crm_lead: totals.crm.leads > 0 ? totals.facebook.spend / totals.crm.leads : 0,
        cost_per_sale: totals.crm.won_count > 0 ? totals.facebook.spend / totals.crm.won_count : 0,
        roas: totals.facebook.spend > 0 ? totals.crm.won_revenue / totals.facebook.spend : 0,
        conversion_rate: totals.crm.leads > 0 ? (totals.crm.won_count / totals.crm.leads) * 100 : 0,
      }
    },
    warnings,
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

  // Track outbound activity (for response SLA dots)
  try {
    await db.pool.query(
      'UPDATE leads SET last_outbound_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2',
      [lead.id, req.tenantId]
    );
  } catch { }

  // Instant UI feedback: show the outgoing message as "sending"
  await emitNewMessageScoped(req.tenantId, lead, {
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

app.get('/api/analytics/layout', requireTenantAuth, requirePermission('view_stats', 'Statistikanı görmək icazəniz yoxdur'), asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const layout = await db.getAnalyticsLayout(req.tenantId, req.userId);
  res.json({ layout });
}));

app.post('/api/analytics/layout', requireTenantAuth, requirePermission('view_stats', 'Statistikanı görmək icazəniz yoxdur'), asyncHandler(async (req, res) => {
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

if (EMBEDDED_WORKER_ENABLED) {
  try {
    require('./worker.cjs');
    console.log('🤖 WhatsApp Worker embedded in same process (single-service mode).');
  } catch (err) {
    console.error('⚠️ Failed to start embedded Worker:', err.message);
  }
} else {
  console.log('ℹ️ Embedded WhatsApp worker disabled for this API process.');
}
