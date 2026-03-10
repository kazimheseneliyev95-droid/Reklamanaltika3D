require('dotenv').config();

if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is missing in worker process. Database operations may fail.');
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    jidDecode,
    jidNormalizedUser,
    isJidGroup,
    isJidBroadcast,
    isJidStatusBroadcast,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const HAS_DATABASE = Boolean(process.env.DATABASE_URL);
const db = HAS_DATABASE ? require('./database') : null;
const { usePostgresAuthState, getAllAuthenticatedTenants } = require('./postgresAuthState.cjs');

const workerApp = express();
workerApp.use(express.json());


const WORKER_PORT = process.env.WORKER_PORT || 4001;
var apiPort = process.env.PORT || 4000;
var API_URL = process.env.API_URL || ('http://localhost:' + apiPort);
const INTERNAL_WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || '';
const OUTGOING_CLAIM_OWNER = `worker:${process.pid}`;
const OUTGOING_BATCH = Math.max(1, parseInt(String(process.env.OUTGOING_BATCH || '10'), 10) || 10);
const OUTGOING_CLAIM_TTL_MINUTES = Math.max(1, parseInt(String(process.env.OUTGOING_CLAIM_TTL_MINUTES || '2'), 10) || 2);

const WA_MEDIA_ENABLED = process.env.WA_MEDIA_ENABLED !== 'false';
const WA_MEDIA_MAX_BYTES = (() => {
    const n = parseInt(String(process.env.WA_MEDIA_MAX_BYTES || ''), 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 50 * 1024 * 1024);
    return 15 * 1024 * 1024; // 15MB default
})();

workerApp.use('/api/internal', (req, res, next) => {
    if (!INTERNAL_WEBHOOK_SECRET) {
        return res.status(503).json({ error: 'Internal secret is not configured' });
    }
    const incoming = req.headers['x-internal-secret'];
    if (incoming === INTERNAL_WEBHOOK_SECRET) return next();
    return res.status(401).json({ error: 'Unauthorized internal request' });
});

if (!INTERNAL_WEBHOOK_SECRET) {
    console.warn('⚠️ INTERNAL_WEBHOOK_SECRET is missing in worker process. Internal endpoints will only accept loopback requests.');
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
    const retries = retryOptions.retries ?? 2;
    const timeoutMs = retryOptions.timeoutMs ?? 5000;
    const baseDelayMs = retryOptions.baseDelayMs ?? 300;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response;
        } catch (err) {
            clearTimeout(timeout);
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

function getTenantAuthDir(tenantId) {
    var safeTenantId = String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(__dirname, '.baileys_auth', safeTenantId);
}

function toSafeTenantId(tenantId) {
    return String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toSafeFileBase(value, maxLen) {
    var s = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!s) s = 'file';
    if (typeof maxLen === 'number' && maxLen > 0) s = s.slice(0, maxLen);
    return s;
}

function ensureDirSync(dirPath) {
    try {
        fs.mkdirSync(dirPath, { recursive: true });
    } catch { }
}

function normalizeMime(mime) {
    if (!mime) return '';
    return String(mime).split(';')[0].trim().toLowerCase();
}

function guessExtFromMime(mime) {
    var m = normalizeMime(mime);
    if (m === 'image/jpeg') return 'jpg';
    if (m === 'image/png') return 'png';
    if (m === 'image/webp') return 'webp';
    if (m === 'image/gif') return 'gif';
    if (m === 'audio/ogg') return 'ogg';
    if (m === 'audio/mpeg') return 'mp3';
    if (m === 'audio/mp4') return 'm4a';
    if (m === 'audio/aac') return 'aac';
    if (m === 'audio/wav') return 'wav';
    if (m === 'video/mp4') return 'mp4';
    if (m === 'application/pdf') return 'pdf';
    return 'bin';
}

function safeNumberFromLong(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        var n = parseInt(v, 10);
        return Number.isFinite(n) ? n : null;
    }
    if (typeof v === 'object') {
        // protobufjs Long-like
        if (typeof v.low === 'number' && typeof v.high === 'number') {
            try {
                // best-effort; may overflow for huge values but fine for typical media sizes
                return (v.high * 4294967296) + (v.low >>> 0);
            } catch {
                return null;
            }
        }
    }
    return null;
}

async function maybePersistWhatsAppMedia(tenantId, msg, unwrapped, msgType, whatsappId) {
    if (!WA_MEDIA_ENABLED) return null;
    if (!tenantId || !msg || !unwrapped || !whatsappId) return null;
    if (msgType !== 'image' && msgType !== 'audio' && msgType !== 'video' && msgType !== 'document') return null;

    var content = null;
    if (msgType === 'image') content = unwrapped.imageMessage;
    else if (msgType === 'audio') content = unwrapped.audioMessage;
    else if (msgType === 'video') content = unwrapped.videoMessage;
    else if (msgType === 'document') content = unwrapped.documentMessage;
    if (!content) return null;

    var mimeType = normalizeMime(content.mimetype || content.mimeType || '');
    var declaredLen = safeNumberFromLong(content.fileLength);
    if (declaredLen && declaredLen > WA_MEDIA_MAX_BYTES) {
        return {
            kind: msgType,
            mimeType: mimeType || null,
            tooLarge: true,
            maxBytes: WA_MEDIA_MAX_BYTES,
            declaredBytes: declaredLen
        };
    }

    var session = sessions.get(tenantId);
    if (!session || !session.sock) return null;

    var safeTenant = toSafeTenantId(tenantId);
    var mediaDir = path.join(__dirname, 'media', safeTenant);
    ensureDirSync(mediaDir);

    var base = toSafeFileBase('wa_' + whatsappId, 120);
    var rand = crypto.randomBytes(6).toString('hex');

    var fileNameHint = null;
    try {
        if (msgType === 'document' && content.fileName) fileNameHint = String(content.fileName);
    } catch { }

    var ext = null;
    if (fileNameHint && fileNameHint.includes('.')) {
        var last = fileNameHint.split('.').pop();
        if (last && /^[a-zA-Z0-9]{1,8}$/.test(last)) ext = last.toLowerCase();
    }
    if (!ext) ext = guessExtFromMime(mimeType);

    var storedFileName = base + '_' + rand + '.' + ext;
    var fullPath = path.join(mediaDir, storedFileName);

    try {
        var dlMsg = Object.assign({}, msg, { message: unwrapped });
        var buffer = await downloadMediaMessage(
            dlMsg,
            'buffer',
            {},
            {
                logger: pino({ level: 'silent' }),
                reuploadRequest: session.sock.updateMediaMessage
            }
        );

        if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) {
            return null;
        }

        if (buffer.length > WA_MEDIA_MAX_BYTES) {
            return {
                kind: msgType,
                mimeType: mimeType || null,
                tooLarge: true,
                maxBytes: WA_MEDIA_MAX_BYTES,
                declaredBytes: declaredLen || null,
                actualBytes: buffer.length
            };
        }

        fs.writeFileSync(fullPath, buffer);

        if (HAS_DATABASE && db && typeof db.upsertWhatsAppMediaAsset === 'function') {
            try {
                await db.upsertWhatsAppMediaAsset({
                    tenantId: tenantId,
                    fileKey: storedFileName,
                    kind: msgType,
                    mimeType: mimeType || null,
                    originalFileName: fileNameHint || null,
                    bytes: buffer.length,
                    data: buffer,
                });
            } catch (assetErr) {
                console.warn('⚠️ [' + tenantId + '] Media DB backup failed:', assetErr && assetErr.message ? assetErr.message : assetErr);
            }
        }

        return {
            kind: msgType,
            mimeType: mimeType || null,
            fileName: fileNameHint || null,
            bytes: buffer.length,
            url: '/api/media/' + safeTenant + '/' + encodeURIComponent(storedFileName)
        };
    } catch (e) {
        console.warn('⚠️ [' + tenantId + '] Media download failed:', e && e.message ? e.message : e);
        return null;
    }
}

async function getAuthState(tenantId) {
    if (HAS_DATABASE && db) {
        if (!db.pool && db.initDb) {
            await db.initDb();
        }
        if (!db.pool) {
            throw new Error('Database pool is not initialized');
        }
        return usePostgresAuthState(db.pool, tenantId);
    }
    var authDir = getTenantAuthDir(tenantId);
    return useMultiFileAuthState(authDir);
}

// State Variables (Multi-Tenant)
const sessions = new Map();

function getSession(tenantId) {
    if (!sessions.has(tenantId)) {
        sessions.set(tenantId, {
            isReady: false,
            isAuthenticated: false,
            qrCodeData: null,
            isInitializing: false,
            lastInitError: null,
            sock: null,
            connectedNumber: null,
            keys: null,
            reconnectAttempts: 0,
            reconnectTimer: null,
            lastStartAt: 0,
        });
    }
    return sessions.get(tenantId);
}

function clearReconnectTimer(session) {
    try {
        if (session && session.reconnectTimer) {
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = null;
        }
    } catch {
        // ignore
    }
}

function scheduleSessionRestart(tenantId, session, delayMs) {
    if (!session) return;
    if (session.reconnectTimer) return;
    session.reconnectTimer = setTimeout(function () {
        session.reconnectTimer = null;
        startWhatsAppClient(tenantId);
    }, delayMs);
}

const REPAIR_SCAN_COOLDOWN_MS = 30000;
const lastRepairScanAt = new Map(); // tenantId -> ms
const repairedOldPhones = new Map(); // tenantId:oldPhone -> ms

async function getPNForLidUser(tenantId, lidUser) {
    try {
        if (!lidUser) return null;
        var session = sessions.get(tenantId);
        var keys = session && session.keys;
        if (!keys || !keys.get) return null;
        var reverseKey = String(lidUser) + '_reverse';
        var stored = await keys.get('lid-mapping', [reverseKey]);
        var pnUser = stored && stored[reverseKey];
        if (!pnUser) return null;
        var digits = String(pnUser).replace(/\D/g, '');
        if (!digits || digits.length < 7 || digits.length > 15) return null;
        return digits;
    } catch {
        return null;
    }
}

async function repairLeadPhoneMapping(tenantId, oldPhone, newPhone) {
    if (!HAS_DATABASE || !db || !db.pool) return;
    if (!oldPhone || !newPhone || oldPhone === newPhone) return;

    const now = Date.now();
    const k = String(tenantId) + ':' + String(oldPhone);
    const last = repairedOldPhones.get(k) || 0;
    if (now - last < 10 * 60 * 1000) return; // 10 min
    repairedOldPhones.set(k, now);

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const oldRes = await client.query(
            'SELECT id, phone, name, last_message FROM leads WHERE phone = $1 AND tenant_id = $2 LIMIT 1',
            [oldPhone, tenantId]
        );
        if (oldRes.rowCount === 0) {
            await client.query('COMMIT');
            return;
        }
        const oldLead = oldRes.rows[0];

        const newRes = await client.query(
            'SELECT id, phone, name, last_message FROM leads WHERE phone = $1 AND tenant_id = $2 LIMIT 1',
            [newPhone, tenantId]
        );

        if (newRes.rowCount > 0) {
            const newLead = newRes.rows[0];

            await client.query(
                'UPDATE messages SET lead_id = $1, phone = $2 WHERE lead_id = $3 AND tenant_id = $4',
                [newLead.id, newPhone, oldLead.id, tenantId]
            );

            await client.query(
                `UPDATE leads
                 SET
                   name = COALESCE(leads.name, $1),
                   last_message = COALESCE(leads.last_message, $2),
                   updated_at = NOW()
                 WHERE id = $3 AND tenant_id = $4`,
                [oldLead.name, oldLead.last_message, newLead.id, tenantId]
            );

            await client.query('DELETE FROM leads WHERE id = $1 AND tenant_id = $2', [oldLead.id, tenantId]);
        } else {
            await client.query(
                'UPDATE leads SET phone = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
                [newPhone, oldLead.id, tenantId]
            );
            await client.query(
                'UPDATE messages SET phone = $1 WHERE lead_id = $2 AND tenant_id = $3',
                [newPhone, oldLead.id, tenantId]
            );
        }

        await client.query('COMMIT');
        console.log('🧩 [' + tenantId + '] Repaired phone mapping: ' + oldPhone + ' -> ' + newPhone);
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { }
        console.error('⚠️ Phone mapping repair failed:', e.message);
    } finally {
        client.release();
    }
}

async function maybeRepairMappedLeads(tenantId) {
    if (!HAS_DATABASE || !db || !db.pool) return;
    const session = sessions.get(tenantId);
    if (!session || !session.keys) return;

    const now = Date.now();
    const last = lastRepairScanAt.get(tenantId) || 0;
    if (now - last < REPAIR_SCAN_COOLDOWN_MS) return;
    lastRepairScanAt.set(tenantId, now);

    // Light-touch scan: check recent leads and fix if a reverse mapping exists
    try {
        const res = await db.pool.query(
            'SELECT phone FROM leads WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 120',
            [tenantId]
        );
        for (let i = 0; i < res.rows.length; i++) {
            const phone = String(res.rows[i].phone || '');
            if (!phone) continue;
            const mapped = await getPNForLidUser(tenantId, phone);
            if (mapped && mapped !== phone) {
                await repairLeadPhoneMapping(tenantId, phone, mapped);
            }
        }
    } catch (e) {
        console.error('⚠️ maybeRepairMappedLeads error:', e.message);
    }
}

// Message Deduplication Cache
const PROCESSED_MESSAGES_TTL = 30000;
const processedMessages = new Map();
let outgoingPollPauseUntil = 0;
let outgoingPollAuthHintShown = false;

function isDatabaseAuthError(err) {
    if (!err) return false;
    if (err.code === '28P01') return true;
    const message = String(err.message || '').toLowerCase();
    return message.includes('authentication') || message.includes('sasl') || message.includes('password');
}

setInterval(function () {
    var now = Date.now();
    for (var entry of processedMessages.entries()) {
        if (now - entry[1] > PROCESSED_MESSAGES_TTL) {
            processedMessages.delete(entry[0]);
        }
    }
}, 60000);

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🤖 WHATSAPP BACKGROUND WORKER INITIALIZING...');
console.log('📋 Worker Port: ' + WORKER_PORT);
console.log('📋 API URL: ' + API_URL);
console.log('📋 Storage Mode: ' + (HAS_DATABASE ? 'postgres' : 'file-auth/no-db'));
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Notify Main API Server via Webhook
async function notifyApiServer(tenantId, event, payload) {
    try {
        await fetchWithRetry(API_URL + '/api/internal/webhook', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(INTERNAL_WEBHOOK_SECRET ? { 'x-internal-secret': INTERNAL_WEBHOOK_SECRET } : {})
            },
            body: JSON.stringify({ tenantId: tenantId, event: event, payload: payload })
        }, { retries: 1, timeoutMs: 4000 });
    } catch (err) {
        console.error('⚠️ Webhook to API failed for ' + event + ': ' + err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// 📨 INCOMING MESSAGE PROCESSOR
// ═══════════════════════════════════════════════════════════════

async function processMessage(tenantId, msg, isFromMe) {
    try {
        if (!msg || !msg.key) return;

        function unwrapMessage(m) {
            if (!m) return m;
            if (m.ephemeralMessage && m.ephemeralMessage.message) return unwrapMessage(m.ephemeralMessage.message);
            if (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) return unwrapMessage(m.viewOnceMessageV2.message);
            if (m.viewOnceMessageV2Extension && m.viewOnceMessageV2Extension.message) return unwrapMessage(m.viewOnceMessageV2Extension.message);
            if (m.editedMessage && m.editedMessage.message) return unwrapMessage(m.editedMessage.message);
            return m;
        }

        function detectType(m) {
            if (!m) return 'unknown';
            if (m.conversation || m.extendedTextMessage) return 'text';
            if (m.imageMessage) return 'image';
            if (m.videoMessage) return 'video';
            if (m.documentMessage) return 'document';
            if (m.audioMessage) return 'audio';
            if (m.stickerMessage) return 'sticker';
            if (m.locationMessage || m.liveLocationMessage) return 'location';
            if (m.contactMessage || m.contactsArrayMessage) return 'contact';
            if (m.reactionMessage) return 'reaction';
            if (m.buttonsResponseMessage) return 'buttons_response';
            if (m.listResponseMessage) return 'list_response';
            if (m.templateMessage) return 'template';
            return 'unknown';
        }

        function extractText(m) {
            if (!m) return '';
            if (m.conversation) return m.conversation;
            if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;

            if (m.imageMessage) return m.imageMessage.caption || '[Image]';
            if (m.videoMessage) return m.videoMessage.caption || '[Video]';
            if (m.documentMessage) return m.documentMessage.caption || '[Document]';
            if (m.audioMessage) return '[Audio]';
            if (m.stickerMessage) return '[Sticker]';
            if (m.locationMessage || m.liveLocationMessage) return '[Location]';
            if (m.contactMessage || m.contactsArrayMessage) return '[Contact]';
            if (m.reactionMessage) return m.reactionMessage.text || '[Reaction]';

            if (m.buttonsResponseMessage) {
                return m.buttonsResponseMessage.selectedDisplayText || m.buttonsResponseMessage.selectedButtonId || '[Button]';
            }
            if (m.listResponseMessage && m.listResponseMessage.singleSelectReply) {
                return m.listResponseMessage.title || m.listResponseMessage.singleSelectReply.selectedRowId || '[List]';
            }
            if (m.templateMessage && m.templateMessage.hydratedTemplate) {
                return m.templateMessage.hydratedTemplate.hydratedContentText || '[Template]';
            }

            return '';
        }

        function extractContextInfo(m) {
            if (!m) return null;
            try {
                if (m.extendedTextMessage && m.extendedTextMessage.contextInfo) return m.extendedTextMessage.contextInfo;
                if (m.imageMessage && m.imageMessage.contextInfo) return m.imageMessage.contextInfo;
                if (m.videoMessage && m.videoMessage.contextInfo) return m.videoMessage.contextInfo;
                if (m.documentMessage && m.documentMessage.contextInfo) return m.documentMessage.contextInfo;
                if (m.buttonsResponseMessage && m.buttonsResponseMessage.contextInfo) return m.buttonsResponseMessage.contextInfo;
                if (m.listResponseMessage && m.listResponseMessage.contextInfo) return m.listResponseMessage.contextInfo;
                if (m.templateMessage && m.templateMessage.contextInfo) return m.templateMessage.contextInfo;
                if (m.messageContextInfo) return m.messageContextInfo;
            } catch { }
            return null;
        }

        function pickExternalAd(ad) {
            if (!ad || typeof ad !== 'object') return null;
            return {
                title: ad.title || null,
                body: ad.body || null,
                sourceUrl: ad.sourceUrl || null,
                mediaUrl: ad.mediaUrl || null,
                thumbnailUrl: ad.thumbnailUrl || null,
                originalImageUrl: ad.originalImageUrl || null,
                adPreviewUrl: ad.adPreviewUrl || null,
                wtwaWebsiteUrl: ad.wtwaWebsiteUrl || null,
                sourceType: ad.sourceType || null,
                sourceId: ad.sourceId || null,
                sourceApp: ad.sourceApp || null,
                ref: ad.ref || null,
                ctwaClid: ad.ctwaClid || null,
                showAdAttribution: ad.showAdAttribution || null,
                containsAutoReply: ad.containsAutoReply || null,
                automatedGreetingMessageShown: ad.automatedGreetingMessageShown || null,
                greetingMessageBody: ad.greetingMessageBody || null,
                ctaPayload: ad.ctaPayload || null
            };
        }

        function pickQuotedAd(qa) {
            if (!qa || typeof qa !== 'object') return null;
            return {
                advertiserName: qa.advertiserName || null,
                caption: qa.caption || null,
                mediaType: qa.mediaType || null
            };
        }

        function extractLinks(text) {
            if (!text) return [];
            var out = [];
            var re = /(https?:\/\/[^\s)\]]+)|(www\.[^\s)\]]+)/gi;
            var m2;
            while ((m2 = re.exec(String(text))) !== null) {
                var u = m2[0];
                if (u && u.startsWith('www.')) u = 'https://' + u;
                out.push(u);
            }
            // de-dupe
            return Array.from(new Set(out)).slice(0, 10);
        }

        function phoneFromJid(jid) {
            if (!jid) return null;
            var decoded = jidDecode(jid);
            var user = decoded && decoded.user ? decoded.user : String(jid).split('@')[0];
            user = String(user).split(':')[0];
            var digits = String(user).replace(/\D/g, '');
            if (!digits || digits.length < 7 || digits.length > 15) return null;
            return digits;
        }

        function getPeerJid() {
            var remoteJid = msg.key.remoteJid;
            if (!remoteJid) return null;
            if (remoteJid === 'status@broadcast' || isJidStatusBroadcast(remoteJid)) return null;
            if (isJidGroup(remoteJid)) return null;
            if (isJidBroadcast(remoteJid)) return null;

            var remote = jidDecode(remoteJid);
            var participantJid = msg.key.participant;
            var participant = participantJid ? jidDecode(participantJid) : null;

            // LID threads: participant often contains the real phone WAID
            if (remote && remote.server === 'lid' && participant && participant.server === 's.whatsapp.net') {
                return participantJid;
            }

            // If remoteJid resolves to ourselves, participant is the other party (edge cases)
            var session = sessions.get(tenantId);
            var me = session && session.sock && session.sock.user && session.sock.user.id;
            if (me && participantJid) {
                if (jidNormalizedUser(remoteJid) === jidNormalizedUser(me)) {
                    return participantJid;
                }
            }

            return remoteJid;
        }

        var unwrapped = unwrapMessage(msg.message);
        if (!unwrapped) return;

        var msgType = detectType(unwrapped);
        var contextInfo = extractContextInfo(unwrapped);
        var externalAd = contextInfo && contextInfo.externalAdReply ? pickExternalAd(contextInfo.externalAdReply) : null;
        var quotedAd = contextInfo && contextInfo.quotedAd ? pickQuotedAd(contextInfo.quotedAd) : null;
        var ctwaPayloadB64 = null;
        try {
            if (contextInfo && contextInfo.ctwaPayload) {
                ctwaPayloadB64 = Buffer.from(contextInfo.ctwaPayload).toString('base64');
            }
        } catch { }

        var messageContent = extractText(unwrapped);

        // If message has no visible text, but contains ad greeting/body, surface it
        if ((!messageContent || String(messageContent).trim() === '') && externalAd && externalAd.greetingMessageBody) {
            messageContent = String(externalAd.greetingMessageBody);
        }

        // If still empty, but has quoted ad caption, surface it
        if ((!messageContent || String(messageContent).trim() === '') && quotedAd && quotedAd.caption) {
            messageContent = String(quotedAd.caption);
        }

        if (!messageContent || String(messageContent).trim() === '') {
            messageContent = '[Unsupported message]';
        }

        var whatsappId = msg.key.id;
        if (!whatsappId) return;

        if (processedMessages.has(whatsappId)) return;
        processedMessages.set(whatsappId, Date.now());

        var prefix = isFromMe ? '📤 [OUT]' : '📥 [IN]';

        var peerJid = getPeerJid();
        if (!peerJid) return;

        // If this is a LID conversation, try to resolve the real phone number via reverse mapping.
        // This fixes the "random long code" issue in UI for click-to-WhatsApp/modern identity threads.
        var peerDecoded = jidDecode(peerJid);
        var lidUser = null;
        if (peerDecoded && (peerDecoded.server === 'lid' || peerDecoded.server === 'hosted.lid') && peerDecoded.user) {
            lidUser = peerDecoded.user;
        }

        var mappedPn = lidUser ? await getPNForLidUser(tenantId, lidUser) : null;
        if (mappedPn && lidUser && mappedPn !== String(lidUser)) {
            await repairLeadPhoneMapping(tenantId, String(lidUser).replace(/\D/g, ''), mappedPn);
        }

        var rawNumber = mappedPn || phoneFromJid(peerJid);
        if (!rawNumber) return;

        // Avoid overwriting the lead name with our own display name on outgoing messages
        var contactName = (!isFromMe && msg.pushName) ? msg.pushName : null;
        var displayName = contactName || ('+' + rawNumber);
        console.log('[' + tenantId + '] ' + prefix + ' ' + rawNumber + ' | ' + messageContent.substring(0, 50));

        var metadata = {
            type: msgType,
            links: extractLinks(messageContent),
            ad: externalAd,
            quotedAd: quotedAd,
            ctwa: contextInfo ? {
                ctwaSignals: contextInfo.ctwaSignals || null,
                ctwaPayloadB64: ctwaPayloadB64,
                smbClientCampaignId: contextInfo.smbClientCampaignId || null,
                smbServerCampaignId: contextInfo.smbServerCampaignId || null
            } : null,
            entry: contextInfo ? {
                conversionSource: contextInfo.conversionSource || null,
                entryPointConversionSource: contextInfo.entryPointConversionSource || null,
                entryPointConversionApp: contextInfo.entryPointConversionApp || null,
                entryPointConversionExternalSource: contextInfo.entryPointConversionExternalSource || null,
                entryPointConversionExternalMedium: contextInfo.entryPointConversionExternalMedium || null
            } : null
        };
        if (externalAd) {
            var adLinks = [];
            if (externalAd.sourceUrl) adLinks.push(externalAd.sourceUrl);
            if (externalAd.wtwaWebsiteUrl) adLinks.push(externalAd.wtwaWebsiteUrl);
            if (externalAd.adPreviewUrl) adLinks.push(externalAd.adPreviewUrl);
            if (externalAd.mediaUrl) adLinks.push(externalAd.mediaUrl);
            metadata.links = Array.from(new Set([].concat(metadata.links || [], adLinks))).slice(0, 10);
        }

        // Media: download and persist, then store URL in metadata (so UI can render image/audio)
        try {
            if (msgType === 'image' || msgType === 'audio' || msgType === 'video' || msgType === 'document') {
                var media = await maybePersistWhatsAppMedia(tenantId, msg, unwrapped, msgType, whatsappId);
                if (media) {
                    metadata.media = media;
                }
            }
        } catch { }

        // Write ALL messages (incoming AND outgoing caught by Baileys) to DB
        if (HAS_DATABASE && db) {
            try {
                var existingLead = await db.findLeadByPhone(rawNumber, tenantId);
                // Preserve pre-message state for automation rules in API server.
                var wasClosedBefore = Boolean(existingLead && existingLead.conversation_closed);
                var statusBefore = (existingLead && existingLead.status) ? String(existingLead.status) : '';

                var savedLead;
                if (existingLead) {
                    // Use the canonical phone from the DB to avoid mismatch
                    var canonicalPhone = existingLead.phone;
                    savedLead = await db.updateLeadMessage(canonicalPhone, messageContent, whatsappId, contactName, tenantId, isFromMe ? 'out' : 'in');
                    if (!savedLead) savedLead = existingLead;
                } else {
                    savedLead = await db.createLead({
                        phone: rawNumber,
                        name: displayName,
                        last_message: messageContent,
                        whatsapp_id: whatsappId,
                        source: 'whatsapp',
                        status: 'new'
                    }, tenantId);
                    // Ensure unread counter & last_inbound_at are updated for the first inbound message too
                    if (savedLead && savedLead.phone) {
                        try {
                            const updatedFirst = await db.updateLeadMessage(savedLead.phone, messageContent, whatsappId, contactName, tenantId, isFromMe ? 'out' : 'in');
                            if (updatedFirst) savedLead = updatedFirst;
                        } catch { }
                    }
                    console.log('✨ New lead [' + tenantId + ']: ' + rawNumber);
                }

                if (savedLead && savedLead.id) {
                    // If this CTWA thread includes an automated greeting, persist it as a synthetic outgoing message
                    // so it shows up in CRM chat history even when WhatsApp renders it as a banner.
                    if (externalAd && externalAd.greetingMessageBody) {
                        await db.appendMessage({
                            leadId: savedLead.id,
                            phone: existingLead ? existingLead.phone : rawNumber,
                            body: String(externalAd.greetingMessageBody),
                            direction: 'out',
                            whatsappId: 'greeting-' + whatsappId,
                            metadata: { type: 'ad_greeting', ad: externalAd },
                            createdAt: msg.messageTimestamp || null,
                            tenantId: tenantId
                        });
                    }

                    await db.appendMessage({
                        leadId: savedLead.id,
                        phone: existingLead ? existingLead.phone : rawNumber,
                        body: messageContent,
                        direction: isFromMe ? 'out' : 'in',
                        whatsappId: whatsappId,
                        metadata: metadata,
                        createdAt: msg.messageTimestamp || null,
                        tenantId: tenantId
                    });

                    // If this message contains ad attribution, persist it on the lead as well (extra_data.ad)
                    if ((externalAd || quotedAd) && savedLead && savedLead.id) {
                        try {
                            await db.updateLeadFields(savedLead.id, { extra_data: JSON.stringify({ ad: externalAd, quotedAd: quotedAd, ctwa: metadata.ctwa }) }, tenantId);
                        } catch { }
                    }
                }
            } catch (dbError) {
                console.error('⚠️ DB error (non-fatal):', dbError.message);
            }
        }

        // Tell the UI to refresh via webhook
        var canonicalPhoneEmit = (typeof savedLead !== 'undefined' && savedLead && savedLead.phone) ? savedLead.phone : rawNumber;

        notifyApiServer(tenantId, 'new_message', {
            phone: canonicalPhoneEmit,
            name: displayName,
            message: messageContent,
            whatsapp_id: whatsappId,
            fromMe: isFromMe,
            was_closed: wasClosedBefore,
            status_before: statusBefore,
            timestamp: new Date().toISOString(),
            source: 'whatsapp'
        });

    } catch (error) {
        console.error('❌ processMessage error:', error.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// 🟢 WHATSAPP CLIENT INITIALIZER (Baileys)
// ═══════════════════════════════════════════════════════════════

async function startWhatsAppClient(tenantId) {
    console.log('\n🚀 STARTING WHATSAPP CLIENT [' + tenantId + ']...');
    var session = getSession(tenantId);

    if (session.isInitializing || session.isReady) return;
    var now = Date.now();
    if (session.lastStartAt && (now - session.lastStartAt) < 4000) return;
    session.lastStartAt = now;
    clearReconnectTimer(session);
    session.isInitializing = true;

    try {
        session.lastInitError = null;
        if (HAS_DATABASE) {
            console.log('📦 PostgreSQL Auth State [' + tenantId + ']...');
        } else {
            console.log('📦 File Auth State [' + tenantId + ']...');
        }
        var auth = await getAuthState(tenantId);
        // Keep a reference to keys for LID ↔ PN mapping repairs
        try {
            session.keys = auth && auth.state ? auth.state.keys : null;
        } catch {
            session.keys = null;
        }

        var versionInfo = await fetchLatestBaileysVersion();
        console.log('[' + tenantId + '] WA v' + versionInfo.version.join('.'));

        session.sock = makeWASocket({
            version: versionInfo.version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: auth.state,
            browser: Browsers.macOS('Desktop'),
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        });

        session.sock.ev.on('creds.update', auth.saveCreds);

        session.sock.ev.on('connection.update', async function (update) {
            if (update.qr) {
                console.log('📱 QR RECEIVED [' + tenantId + ']');
                session.qrCodeData = update.qr;
                session.isReady = false;
                session.isAuthenticated = false;
                notifyApiServer(tenantId, 'qr_code', update.qr);
            }

            if (update.connection === 'close') {
                var statusCode = null;
                if (update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output) {
                    statusCode = update.lastDisconnect.error.output.statusCode;
                }
                var shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('⚠️ Closed [' + tenantId + '] Status:' + statusCode + ' reconnect:' + shouldReconnect);
                session.isReady = false;
                session.isInitializing = false;
                session.sock = null;

                if (shouldReconnect) {
                    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
                    var baseDelay = (session.qrCodeData || !session.isAuthenticated) ? 15000 : 5000;
                    var delay = Math.min(60000, baseDelay * Math.max(1, session.reconnectAttempts));
                    scheduleSessionRestart(tenantId, session, delay);
                } else {
                    session.isAuthenticated = false;
                    session.qrCodeData = null;
                    notifyApiServer(tenantId, 'auth_failure', 'Logged out.');
                    if (auth.clearState) await auth.clearState();
                    session.reconnectAttempts = 0;
                    scheduleSessionRestart(tenantId, session, 3000);
                }
            } else if (update.connection === 'connecting') {
                session.isInitializing = true;
            } else if (update.connection === 'open') {
                console.log('✅ CLIENT READY [' + tenantId + ']');
                session.isReady = true;
                session.isAuthenticated = true;
                session.isInitializing = false;
                session.qrCodeData = null;
                session.reconnectAttempts = 0;
                clearReconnectTimer(session);

                if (session.sock && session.sock.user && session.sock.user.id) {
                    session.connectedNumber = '+' + session.sock.user.id.split(':')[0].split('@')[0];
                }

                notifyApiServer(tenantId, 'ready', { status: 'connected' });
                notifyApiServer(tenantId, 'authenticated', { status: 'authenticated' });

                // Opportunistic repair: if we previously stored LID codes as phones, convert them now.
                maybeRepairMappedLeads(tenantId);
            }
        });

        session.sock.ev.on('messages.upsert', async function (m) {
            for (var i = 0; i < m.messages.length; i++) {
                var msg = m.messages[i];
                if (msg.message && msg.message.protocolMessage) continue;
                processMessage(tenantId, msg, msg.key.fromMe);
            }
        });

        // On reconnect, Baileys can deliver recent history in a batch.
        // Persist it so early "ad click" greetings & first replies are not missed.
        session.sock.ev.on('messaging-history.set', async function (h) {
            try {
                if (!h || !h.messages || !Array.isArray(h.messages)) return;
                for (var i = 0; i < h.messages.length; i++) {
                    var msg = h.messages[i];
                    if (!msg || !msg.key) continue;
                    if (msg.message && msg.message.protocolMessage) continue;
                    processMessage(tenantId, msg, msg.key.fromMe);
                }

                // Run repair after history import (mappings often arrive around this time)
                maybeRepairMappedLeads(tenantId);
            } catch (e) {
                console.error('⚠️ messaging-history.set handler error:', e.message);
            }
        });

    } catch (err) {
        console.error('❌ Init FAILED [' + tenantId + ']: ' + err.message);
        session.lastInitError = err && (err.stack || err.message) ? String(err.stack || err.message) : 'init_failed';
        session.isInitializing = false;
        session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
        scheduleSessionRestart(tenantId, session, Math.min(60000, 5000 * session.reconnectAttempts));
    }
}

// ═══════════════════════════════════════════════════════════════
// 📬 OUTGOING MESSAGE POLLER
// ═══════════════════════════════════════════════════════════════

async function pollOutgoingMessages() {
    if (!HAS_DATABASE || !db || !db.pool) return;
    if (Date.now() < outgoingPollPauseUntil) return;
    try {
        var result = await db.pool.query(
            `WITH candidates AS (
                SELECT m.id
                FROM messages m
                JOIN leads l ON l.id = m.lead_id AND l.tenant_id = m.tenant_id
                WHERE m.direction = 'out'
                  AND m.status IN ('pending', 'processing')
                  AND COALESCE(l.source, '') = 'whatsapp'
                  AND m.phone ~ '^[0-9]{7,15}$'
                  AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= NOW())
                  AND (m.status = 'pending' OR m.claimed_at IS NULL OR m.claimed_at < NOW() - ($2::text || ' minutes')::interval)
                ORDER BY m.created_at ASC
                LIMIT $3
                FOR UPDATE SKIP LOCKED
            )
            UPDATE messages m
            SET status = 'processing',
                claimed_at = NOW(),
                claim_owner = $1,
                attempts = COALESCE(m.attempts, 0) + 1,
                last_error = NULL
            FROM candidates c
            WHERE m.id = c.id
            RETURNING m.id, m.tenant_id, m.phone, m.body, COALESCE(m.attempts, 0) AS attempts`,
            [OUTGOING_CLAIM_OWNER, String(OUTGOING_CLAIM_TTL_MINUTES), OUTGOING_BATCH]
        );

        for (var i = 0; i < result.rows.length; i++) {
            var msg = result.rows[i];
            var session = sessions.get(msg.tenant_id);
            if (session && session.isReady && session.sock) {
                console.log('[' + msg.tenant_id + '] 🤖 Sending → ' + msg.phone);
                try {
                    var jid = msg.phone + '@s.whatsapp.net';
                    var sentMsg = await session.sock.sendMessage(jid, { text: msg.body });

                    if (sentMsg && sentMsg.key && sentMsg.key.id) {
                        await db.pool.query(
                            "UPDATE messages SET status = 'sent', whatsapp_id = $1, claimed_at = NULL, claim_owner = NULL, next_attempt_at = NULL, last_error = NULL WHERE id = $2",
                            [sentMsg.key.id, msg.id]
                        );
                        notifyApiServer(msg.tenant_id, 'message_sent', { id: msg.id, status: 'sent', whatsapp_id: sentMsg.key.id });
                    }
                } catch (sendErr) {
                    console.error('⚠️ Send failed ' + msg.id + ': ' + sendErr.message);
                    var attempts = Number(msg.attempts || 1);
                    var terminal = attempts >= 5;
                    await db.pool.query(
                        `UPDATE messages
                         SET status = $2,
                             claimed_at = NULL,
                             claim_owner = NULL,
                             last_error = $3,
                             next_attempt_at = CASE WHEN $2 = 'pending' THEN NOW() + (LEAST($4, 5) * INTERVAL '30 seconds') ELSE NULL END
                         WHERE id = $1`,
                        [msg.id, terminal ? 'failed' : 'pending', String(sendErr.message || 'send_failed').slice(0, 500), attempts]
                    );
                }
            } else {
                await db.pool.query(
                    "UPDATE messages SET status = 'pending', claimed_at = NULL, claim_owner = NULL, next_attempt_at = NOW() + INTERVAL '20 seconds' WHERE id = $1",
                    [msg.id]
                );
            }
        }
    } catch (err) {
        if (isDatabaseAuthError(err)) {
            outgoingPollPauseUntil = Date.now() + 120000;
            if (!outgoingPollAuthHintShown) {
                outgoingPollAuthHintShown = true;
                console.error('❌ Worker DB authentication error. Pausing outgoing poller for 120s. Check DATABASE_URL credentials.');
            }
        }
        if (err && err.errors && Array.isArray(err.errors)) {
            for (const nestedErr of err.errors) {
                if (isDatabaseAuthError(nestedErr)) {
                    outgoingPollPauseUntil = Date.now() + 120000;
                    if (!outgoingPollAuthHintShown) {
                        outgoingPollAuthHintShown = true;
                        console.error('❌ Worker DB authentication error. Pausing outgoing poller for 120s. Check DATABASE_URL credentials.');
                    }
                    break;
                }
            }
            console.error('⚠️ pollOutgoingMessages error: AggregateError');
            for (const e of err.errors) {
                console.error('   -', (e && (e.code || e.name)) || 'ERR', (e && e.message) || e);
            }
        } else {
            console.error('⚠️ pollOutgoingMessages error:', (err && (err.stack || err.message)) || err);
        }
    }
}

if (HAS_DATABASE) {
    setInterval(pollOutgoingMessages, 3000);
} else {
    console.log('ℹ️ Outgoing DB poller disabled (DATABASE_URL missing).');
}

// ═══════════════════════════════════════════════════════════════
// 🌐 INTERNAL WORKER API (Port 4001)
// ═══════════════════════════════════════════════════════════════

workerApp.post('/api/internal/start/:tenantId', function (req, res) {
    var tenantId = req.params.tenantId;
    var session = getSession(tenantId);

    if (session.isReady) {
        return res.json({ success: true, status: 'already_connected' });
    } else if (session.qrCodeData) {
        return res.json({ success: true, status: 'qr_ready', qr: session.qrCodeData });
    } else {
        startWhatsAppClient(tenantId);
        res.json({ success: true, status: 'starting' });
    }
});

workerApp.get('/api/internal/status/:tenantId', function (req, res) {
    var tenantId = req.params.tenantId;
    var session = getSession(tenantId);
    res.json({
        isReady: session.isReady,
        qr: session.qrCodeData ? true : false,
        number: session.connectedNumber,
        error: session.lastInitError
    });
});

// ═══════════════════════════════════════════════════════════════
// 🚀 WORKER BOOT SEQUENCE
// ═══════════════════════════════════════════════════════════════

async function bootWorker() {
    // CRITICAL: Wait for the API server to finish binding its port.
    // Without this, webhook calls (qr_code, ready, etc.) fail with 'fetch failed'.
    console.log('🤖 Worker: waiting 5s for API server to bind...');
    await new Promise(function (resolve) { setTimeout(resolve, 5000); });

    if (HAS_DATABASE && db) {
        // Wait for db.pool to become available (index.cjs initializes it)
        var retries = 0;
        while (!db.pool && retries < 10) {
            console.log('🤖 Waiting for DB pool... (' + retries + '/10)');
            await new Promise(function (resolve) { setTimeout(resolve, 1000); });
            retries++;
        }

        if (!db.pool) {
            try { await db.initDb(); } catch (e) {
                console.error('Worker DB init failed:', e.message);
                return;
            }
        }

        try {
            var activeTenants = await getAllAuthenticatedTenants(db.pool);
            console.log('🤖 Found ' + activeTenants.length + ' active tenants. Booting...');
            for (var i = 0; i < activeTenants.length; i++) {
                startWhatsAppClient(activeTenants[i]);
                await new Promise(function (resolve) { setTimeout(resolve, 2000); });
            }
        } catch (err) {
            console.error('Boot tenants failed:', err.message);
        }
    } else {
        console.log('ℹ️ Worker started without database. Sessions start on-demand per tenant.');
    }

    workerApp.listen(WORKER_PORT, '0.0.0.0', function () {
        console.log('✅ Worker API on port ' + WORKER_PORT);
    });
}

bootWorker().catch(function (err) {
    console.error('Worker boot failed:', err.message);
});
