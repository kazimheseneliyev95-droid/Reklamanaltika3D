require('dotenv').config();

if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is missing in worker process. Database operations may fail.');
}

const express = require('express');
const path = require('path');
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
    isJidStatusBroadcast
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

workerApp.use('/api/internal', (req, res, next) => {
    if (!INTERNAL_WEBHOOK_SECRET) {
        return next();
    }
    const incoming = req.headers['x-internal-secret'];
    if (incoming === INTERNAL_WEBHOOK_SECRET) return next();
    return res.status(401).json({ error: 'Unauthorized internal request' });
});

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
            connectedNumber: null
        });
    }
    return sessions.get(tenantId);
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
                'x-internal-secret': INTERNAL_WEBHOOK_SECRET
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

        function extractText(m) {
            if (!m) return '';
            if (m.conversation) return m.conversation;
            if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;
            if (m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption;
            if (m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption;
            if (m.documentMessage && m.documentMessage.caption) return m.documentMessage.caption;

            if (m.buttonsResponseMessage) {
                return m.buttonsResponseMessage.selectedDisplayText || m.buttonsResponseMessage.selectedButtonId || '';
            }
            if (m.listResponseMessage && m.listResponseMessage.singleSelectReply) {
                return m.listResponseMessage.title || m.listResponseMessage.singleSelectReply.selectedRowId || '';
            }
            if (m.templateMessage && m.templateMessage.hydratedTemplate) {
                return m.templateMessage.hydratedTemplate.hydratedContentText || '';
            }

            return '';
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

        var messageContent = extractText(unwrapped);
        if (!messageContent || messageContent.trim() === '') return;

        var whatsappId = msg.key.id;
        if (!whatsappId) return;

        if (processedMessages.has(whatsappId)) return;
        processedMessages.set(whatsappId, Date.now());

        var prefix = isFromMe ? '📤 [OUT]' : '📥 [IN]';

        var peerJid = getPeerJid();
        var rawNumber = phoneFromJid(peerJid);
        if (!rawNumber) return;

        // Avoid overwriting the lead name with our own display name on outgoing messages
        var contactName = (!isFromMe && msg.pushName) ? msg.pushName : null;
        var displayName = contactName || ('+' + rawNumber);
        console.log('[' + tenantId + '] ' + prefix + ' ' + rawNumber + ' | ' + messageContent.substring(0, 50));

        // Write ALL messages (incoming AND outgoing caught by Baileys) to DB
        if (HAS_DATABASE && db) {
            try {
                var existingLead = await db.findLeadByPhone(rawNumber, tenantId);

                var savedLead;
                if (existingLead) {
                    // Use the canonical phone from the DB to avoid mismatch
                    var canonicalPhone = existingLead.phone;
                    await db.updateLeadMessage(canonicalPhone, messageContent, whatsappId, contactName, tenantId);
                    savedLead = existingLead;
                } else {
                    savedLead = await db.createLead({
                        phone: rawNumber,
                        name: displayName,
                        last_message: messageContent,
                        whatsapp_id: whatsappId,
                        source: 'whatsapp',
                        status: 'new'
                    }, tenantId);
                    console.log('✨ New lead [' + tenantId + ']: ' + rawNumber);
                }

                if (savedLead && savedLead.id) {
                    await db.appendMessage({
                        leadId: savedLead.id,
                        phone: existingLead ? existingLead.phone : rawNumber,
                        body: messageContent,
                        direction: isFromMe ? 'out' : 'in',
                        whatsappId: whatsappId,
                        createdAt: msg.messageTimestamp || null,
                        tenantId: tenantId
                    });
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
            timestamp: new Date().toISOString()
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
    session.isInitializing = true;

    try {
        session.lastInitError = null;
        if (HAS_DATABASE) {
            console.log('📦 PostgreSQL Auth State [' + tenantId + ']...');
        } else {
            console.log('📦 File Auth State [' + tenantId + ']...');
        }
        var auth = await getAuthState(tenantId);

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

                if (shouldReconnect) {
                    setTimeout(function () { startWhatsAppClient(tenantId); }, 5000);
                } else {
                    session.isAuthenticated = false;
                    session.qrCodeData = null;
                    notifyApiServer(tenantId, 'auth_failure', 'Logged out.');
                    if (auth.clearState) await auth.clearState();
                    setTimeout(function () { startWhatsAppClient(tenantId); }, 3000);
                }
            } else if (update.connection === 'connecting') {
                session.isInitializing = true;
            } else if (update.connection === 'open') {
                console.log('✅ CLIENT READY [' + tenantId + ']');
                session.isReady = true;
                session.isAuthenticated = true;
                session.isInitializing = false;
                session.qrCodeData = null;

                if (session.sock && session.sock.user && session.sock.user.id) {
                    session.connectedNumber = '+' + session.sock.user.id.split(':')[0].split('@')[0];
                }

                notifyApiServer(tenantId, 'ready', { status: 'connected' });
                notifyApiServer(tenantId, 'authenticated', { status: 'authenticated' });
            }
        });

        session.sock.ev.on('messages.upsert', async function (m) {
            for (var i = 0; i < m.messages.length; i++) {
                var msg = m.messages[i];
                if (msg.message && msg.message.protocolMessage) continue;
                processMessage(tenantId, msg, msg.key.fromMe);
            }
        });

    } catch (err) {
        console.error('❌ Init FAILED [' + tenantId + ']: ' + err.message);
        session.lastInitError = err && (err.stack || err.message) ? String(err.stack || err.message) : 'init_failed';
        session.isInitializing = false;
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
            "SELECT id, tenant_id, phone, body FROM messages WHERE direction = 'out' AND status = 'pending' ORDER BY created_at ASC"
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
                        await db.pool.query("UPDATE messages SET status = 'sent', whatsapp_id = $1 WHERE id = $2", [sentMsg.key.id, msg.id]);
                        notifyApiServer(msg.tenant_id, 'message_sent', { id: msg.id, status: 'sent', whatsapp_id: sentMsg.key.id });
                    }
                } catch (sendErr) {
                    console.error('⚠️ Send failed ' + msg.id + ': ' + sendErr.message);
                    await db.pool.query("UPDATE messages SET status = 'failed' WHERE id = $1", [msg.id]);
                }
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
