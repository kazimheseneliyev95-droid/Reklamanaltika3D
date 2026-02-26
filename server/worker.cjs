require('dotenv').config();

if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is missing in worker process. Database operations may fail.');
}

const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const db = require('./database');
const { usePostgresAuthState, getAllAuthenticatedTenants } = require('./postgresAuthState.cjs');

const workerApp = express();
workerApp.use(express.json());

workerApp.use('/api/internal', (req, res, next) => {
    if (!INTERNAL_WEBHOOK_SECRET) {
        return next();
    }
    const incoming = req.headers['x-internal-secret'];
    if (incoming === INTERNAL_WEBHOOK_SECRET) return next();
    return res.status(401).json({ error: 'Unauthorized internal request' });
});

const WORKER_PORT = process.env.WORKER_PORT || 4001;
var apiPort = process.env.PORT || 4000;
var API_URL = process.env.API_URL || ('http://localhost:' + apiPort);
const INTERNAL_WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || '';

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
        if (!msg.message) return;

        var messageContent = '';
        if (msg.message.conversation) messageContent = msg.message.conversation;
        else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) messageContent = msg.message.extendedTextMessage.text;
        else if (msg.message.imageMessage && msg.message.imageMessage.caption) messageContent = msg.message.imageMessage.caption;

        if (msg.key.remoteJid === 'status@broadcast') return;
        if (!messageContent || messageContent.trim() === '') return;

        var whatsappId = msg.key.id;
        if (!whatsappId) return;

        if (processedMessages.has(whatsappId)) return;
        processedMessages.set(whatsappId, Date.now());

        var prefix = isFromMe ? '📤 [OUT]' : '📥 [IN]';
        var rawJid = msg.key.remoteJid.split('@')[0];
        var rawNumber = rawJid.split(':')[0];

        if (!rawNumber || rawNumber.length < 5 || rawNumber.includes('g.us')) return;

        var contactName = msg.pushName || ('+' + rawNumber);
        console.log('[' + tenantId + '] ' + prefix + ' ' + rawNumber + ' | ' + messageContent.substring(0, 50));

        // Write ALL messages (incoming AND outgoing caught by Baileys) to DB
        if (process.env.DATABASE_URL && db) {
            try {
                var existingLead = await db.findLeadByPhone(rawNumber, tenantId);

                var savedLead;
                if (existingLead) {
                    await db.updateLeadMessage(rawNumber, messageContent, whatsappId, contactName, tenantId);
                    savedLead = existingLead;
                } else {
                    savedLead = await db.createLead({
                        phone: rawNumber,
                        name: contactName,
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
                        phone: rawNumber,
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
        notifyApiServer(tenantId, 'new_message', {
            phone: rawNumber,
            name: contactName,
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
        console.log('📦 PostgreSQL Auth State [' + tenantId + ']...');
        var auth = await usePostgresAuthState(db.pool, tenantId);

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
        session.isInitializing = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// 📬 OUTGOING MESSAGE POLLER
// ═══════════════════════════════════════════════════════════════

async function pollOutgoingMessages() {
    if (!db.pool) return;
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
        console.error('⚠️ pollOutgoingMessages error:', err.message);
    }
}

setInterval(pollOutgoingMessages, 3000);

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
        number: session.connectedNumber
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

    workerApp.listen(WORKER_PORT, '0.0.0.0', function () {
        console.log('✅ Worker API on port ' + WORKER_PORT);
    });
}

bootWorker().catch(function (err) {
    console.error('Worker boot failed:', err.message);
});
