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
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_WEBHOOK_DEBUG = process.env.META_WEBHOOK_DEBUG === 'true';

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
        throw new Error(`HTTP ${response.status}`);
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
      if (req.originalUrl && String(req.originalUrl).startsWith('/api/webhooks/meta')) {
        req.rawBody = buf;
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

app.get('/api/webhooks/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && META_VERIFY_TOKEN && token === META_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ''));
  }
  return res.sendStatus(403);
});

app.post('/api/webhooks/meta', (req, res) => {
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

    // Respond fast; process async
    res.status(200).send('EVENT_RECEIVED');

    metaWebhookStats.total++;
    metaWebhookStats.accepted++;
    metaWebhookStats.last_at = new Date().toISOString();
    metaWebhookStats.last_error = null;

    setImmediate(async () => {
      try {
        const payload = json || {};
        const objectType = String(payload.object || '').toLowerCase();
        const entries = Array.isArray(payload.entry) ? payload.entry : [];
        if (!objectType || entries.length === 0) {
          metaDebugLog('Webhook payload missing object/entry');
          return;
        }

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
          metaDebugLog('Webhook accepted', { objectType, entryId, tenantId, pageId, igBusinessId });

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
            const mid = ev?.message?.mid ? String(ev.message.mid) : '';
            const msgId = (source === 'instagram' ? 'igmid:' : 'fbmid:') + (mid || (String(ev?.timestamp || '') || String(Date.now())));
            const createdAtIso = toIsoFromMetaTimestamp(ev?.timestamp || Date.now());
            const direction = isFromPage ? 'out' : 'in';

            await upsertMetaInbound({
              tenantId,
              source,
              contactKey,
              displayName: null,
              text,
              msgId,
              direction,
              createdAtIso,
              meta: {
                platform: source,
                kind: 'dm',
                page_id: pageId,
                ig_business_id: igBusinessId,
                sender_id: senderId || null,
                recipient_id: recipientId || null
              }
            });

            metaWebhookStats.by_kind.dm = (metaWebhookStats.by_kind.dm || 0) + 1;
          }

          // Comments / feed changes
          const changes = Array.isArray(entry.changes) ? entry.changes : [];
          for (const ch of changes) {
            const value = ch && ch.value ? ch.value : {};
            const verb = String(value.verb || '').toLowerCase();
            if (verb && verb !== 'add') continue;

            const commentId = value.comment_id || value.id || null;
            const postId = value.post_id || value.post_id || value.post || null;
            const messageText = value.message || value.text || '';

            if (!commentId && !messageText) continue;

            let fromId = value?.from?.id ? String(value.from.id) : null;
            let fromName = value?.from?.name ? String(value.from.name) : null;
            if (!fromName && value?.from?.username) fromName = String(value.from.username);

            // Try to enrich comment via Graph API when possible
            let finalText = String(messageText || '').trim();
            let permalink = null;
            if (!finalText && commentId) {
              try {
                const fields = source === 'instagram'
                  ? 'text,username,timestamp,media{id,permalink}'
                  : 'message,from,created_time,permalink_url';
                const url = `https://graph.facebook.com/v19.0/${commentId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken)}`;
                const data = await fetchJsonWithRetry(url, {}, { retries: 0, timeoutMs: 4000 }).catch(() => null);
                if (data) {
                  if (source === 'instagram') {
                    finalText = String(data.text || '').trim();
                    fromName = fromName || data.username || null;
                    permalink = data?.media?.permalink || null;
                  } else {
                    finalText = String(data.message || '').trim();
                    fromId = fromId || data?.from?.id || null;
                    fromName = fromName || data?.from?.name || null;
                    permalink = data?.permalink_url || null;
                  }
                }
              } catch {
                // ignore
              }
            }

            if (!finalText) finalText = '[Comment]';
            const contactKey = (source === 'instagram'
              ? `ig:${fromId || fromName || (commentId ? String(commentId) : 'comment')}`
              : `fb:${fromId || (commentId ? String(commentId) : 'comment')}`
            );

            const msgId = (source === 'instagram' ? 'igcmt:' : 'fbcmt:') + (commentId ? String(commentId) : String(Date.now()));
            const createdAtIso = new Date().toISOString();

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
          }
        }
      } catch (err) {
        metaWebhookStats.last_error = err?.message || 'processing_error';
        metaDebugLog('Webhook processing error', metaWebhookStats.last_error);
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
});

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

const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

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
  const insertResult = await db.pool.query(`
    INSERT INTO messages (lead_id, phone, body, direction, status, tenant_id)
    VALUES ($1, $2, $3, 'out', 'pending', $4)
    RETURNING id, created_at
  `, [leadId, lead.phone, body, req.tenantId]);

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
// META (FACEBOOK/INSTAGRAM) CONNECTION API
// ═══════════════════════════════════════════════════════════════

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
  const pages = await fetchMetaPagesForToken(token);
  res.json({ pages });
}));

app.post('/api/meta/connect', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.upsertMetaPage !== 'function') return res.status(501).json({ error: 'Meta integration is unavailable' });

  const token = String(req.body?.token || '').trim();
  const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!token) return res.status(400).json({ error: 'token is required' });
  if (pageIds.length === 0) return res.status(400).json({ error: 'pageIds is required' });

  const discovered = await fetchMetaPagesForToken(token);
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

  res.status(201).json({ success: true, savedCount: saved.length, pages: saved, subscribe });
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

app.get('/api/meta/pages', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  if (!db || typeof db.getMetaPages !== 'function') return res.status(501).json({ error: 'Meta integration is unavailable' });
  const pages = await db.getMetaPages(req.tenantId);
  res.json({ pages });
}));

app.get('/api/meta/webhook/status', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ stats: metaWebhookStats });
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

  let graphResult = null;
  let outId = null;

  if (mode === 'comment') {
    const commentId = commentMeta?.comment_id;
    if (!commentId) return res.status(400).json({ error: 'No comment_id found to reply' });

    if (src === 'instagram') {
      graphResult = await postGraphForm(`${commentId}/replies`, { message: bodyText, access_token: pageToken });
      outId = graphResult?.id || null;
    } else {
      graphResult = await postGraphForm(`${commentId}/comments`, { message: bodyText, access_token: pageToken });
      outId = graphResult?.id || null;
    }
  } else if (mode === 'private') {
    const commentId = commentMeta?.comment_id;
    if (!commentId) return res.status(400).json({ error: 'No comment_id found for private reply' });

    // Private reply to a comment (DM) - availability depends on permissions/platform.
    graphResult = await postGraphForm(`${commentId}/private_replies`, { message: bodyText, access_token: pageToken });
    outId = graphResult?.id || graphResult?.message_id || null;
  } else if (mode === 'dm') {
    if (!dmMeta) return res.status(400).json({ error: 'No DM thread found for this lead yet' });

    const senderId = dmMeta?.sender_id ? String(dmMeta.sender_id) : '';
    const recipientId = dmMeta?.recipient_id ? String(dmMeta.recipient_id) : '';
    const userId = (dmDirection === 'in') ? senderId : recipientId;
    if (!userId) return res.status(400).json({ error: 'No recipient id found for DM' });

    if (src === 'instagram') {
      const igId = igBusinessId ? String(igBusinessId) : (igFromMeta ? String(igFromMeta) : '');
      if (!igId) return res.status(400).json({ error: 'IG business id is missing for DM send' });
      graphResult = await postGraphJson(`${igId}/messages`, { recipient: { id: userId }, message: { text: bodyText } }, pageToken);
      outId = graphResult?.message_id || graphResult?.id || null;
    } else {
      // Messenger Send API uses Page access token
      graphResult = await postGraphJson(`me/messages`, { recipient: { id: userId }, message: { text: bodyText } }, pageToken);
      outId = graphResult?.message_id || graphResult?.id || null;
    }
  } else {
    return res.status(400).json({ error: "mode must be one of: 'dm', 'comment', 'private'" });
  }

  // Persist outgoing message
  const outKey = outId ? `metaout:${outId}` : `metaout:${Date.now()}`;
  await db.appendMessage({
    leadId: lead.id,
    phone: lead.phone,
    body: bodyText,
    direction: 'out',
    whatsappId: outKey,
    metadata: {
      platform: src,
      kind: mode === 'comment' ? 'comment_reply' : mode === 'private' ? 'private_reply' : 'dm_out',
      page_id: pageId,
      ig_business_id: igBusinessId,
      graph: graphResult || null,
    },
    createdAt: Math.floor(Date.now() / 1000),
    tenantId: req.tenantId
  });

  await db.updateLeadMessage(lead.phone, bodyText, outKey, lead.name || null, req.tenantId, 'out').catch(() => null);

  // Fast UI update
  io.to(req.tenantId).emit('new_message', {
    phone: lead.phone,
    name: lead.name,
    message: bodyText,
    whatsapp_id: outKey,
    fromMe: true,
    timestamp: new Date().toISOString(),
    source: src
  });

  res.status(201).json({ success: true, id: outId || outKey, graph: graphResult });
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
