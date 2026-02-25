require('dotenv').config();

// Auto-inject Supabase Database URL to prevent Render Free data loss
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://postgres.ntrmqtbyfvfyixomwphp:Kazimks123%21@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
}

const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const db = require('./database');
const { usePostgresAuthState, getAllAuthenticatedTenants } = require('./postgresAuthState.cjs');

const app = express();
app.use(express.json());

const WORKER_PORT = process.env.WORKER_PORT || 4001;
const API_URL = process.env.API_URL || 'http://localhost:4000'; // Location of main index.cjs

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

// 🆕 Message Deduplication Cache
const PROCESSED_MESSAGES_TTL = 30000;
const processedMessages = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, timestamp] of processedMessages.entries()) {
        if (now - timestamp > PROCESSED_MESSAGES_TTL) {
            processedMessages.delete(id);
        }
    }
}, 60000);

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🤖 WHATSAPP BACKGROUND WORKER INITIALIZING...');
console.log(`📋 Port: ${WORKER_PORT}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Notify Main API Server via Webhook
async function notifyApiServer(tenantId, event, payload) {
    try {
        await fetch(`${API_URL}/api/internal/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, event, payload })
        });
    } catch (err) {
        console.error(`⚠️ Failed to notify API Server for event ${event}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// 📨 INCOMING MESSAGE PROCESSOR
// ═══════════════════════════════════════════════════════════════

async function processMessage(tenantId, msg, isFromMe) {
    try {
        if (!msg.message) return;

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
        if (msg.key.remoteJid === 'status@broadcast') return;
        if (!messageContent || messageContent.trim() === '') return;

        const whatsappId = msg.key.id;
        if (!whatsappId) return;

        if (processedMessages.has(whatsappId)) return;
        processedMessages.set(whatsappId, Date.now());

        const prefix = isFromMe ? '📤 [OUTGOING]' : '📥 [INCOMING]';
        const rawJid = msg.key.remoteJid.split('@')[0];
        const rawNumber = rawJid.split(':')[0]; // Strip `:12` device suffix if present

        if (!rawNumber || rawNumber.length < 5 || rawNumber.includes('g.us')) return;

        const contactName = msg.pushName || `+${rawNumber}`;
        console.log(`[${tenantId}] ${prefix} ${rawNumber} | ${messageContent.substring(0, 50)}...`);

        // Only process incoming messages here (outgoing are processed by the poller when DB writes them)
        if (!isFromMe) {
            if (process.env.DATABASE_URL && db) {
                try {
                    let existingLead = await db.findLeadByWhatsAppId(whatsappId, tenantId);
                    if (!existingLead) {
                        existingLead = await db.findLeadByPhone(rawNumber, tenantId);
                    }

                    let savedLead;
                    if (existingLead) {
                        await db.updateLeadMessage(rawNumber, messageContent, whatsappId, contactName, tenantId);
                        savedLead = existingLead;
                        console.log(`📝 Updated lead [${tenantId}]: ${rawNumber}`);
                    } else {
                        savedLead = await db.createLead({
                            phone: rawNumber,
                            name: contactName,
                            last_message: messageContent,
                            whatsapp_id: whatsappId,
                            source: 'whatsapp',
                            status: 'new'
                        }, tenantId);
                        console.log(`✨ New lead created [${tenantId}]: ${rawNumber}`);
                    }

                    if (savedLead?.id) {
                        await db.appendMessage({
                            leadId: savedLead.id,
                            phone: rawNumber,
                            body: messageContent,
                            direction: 'in',
                            whatsappId,
                            createdAt: msg.messageTimestamp || null,
                            tenantId
                        });
                    }
                } catch (dbError) {
                    console.error('⚠️ Database error (non-fatal):', dbError.message);
                }
            }
        }

        // Always tell the UI to refresh
        notifyApiServer(tenantId, 'new_message', {
            phone: rawNumber,
            name: contactName,
            message: messageContent,
            whatsapp_id: whatsappId,
            fromMe: isFromMe,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error processing message:', error.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// 🟢 WHATSAPP CLIENT INITIALIZER (Baileys)
// ═══════════════════════════════════════════════════════════════

async function startWhatsAppClient(tenantId) {
    console.log(`\n🚀 STARTING WHATSAPP CLIENT FOR TENANT [${tenantId}]...`);
    const session = getSession(tenantId);

    if (session.isInitializing || session.isReady) return;
    session.isInitializing = true;

    try {
        let state, saveCreds, clearState;
        console.log(`📦 Using PostgreSQL for Baileys Auth State [${tenantId}]...`);
        const auth = await usePostgresAuthState(db.pool, tenantId);
        state = auth.state;
        saveCreds = auth.saveCreds;
        clearState = auth.clearState;

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[${tenantId}] using WA v${version.join('.')}, isLatest: ${isLatest}`);

        session.sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }), // Suppress pino
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.macOS('Desktop'),
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        });

        session.sock.ev.on('creds.update', saveCreds);

        session.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`📱 QR RECEIVED [${tenantId}]`);
                session.qrCodeData = qr;
                session.isReady = false;
                session.isAuthenticated = false;
                notifyApiServer(tenantId, 'qr_code', qr);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚠️ Connection closed [${tenantId}] (Status: ${statusCode}), reconnecting: ${shouldReconnect}`);
                session.isReady = false;
                session.isInitializing = false;

                if (shouldReconnect) {
                    setTimeout(() => startWhatsAppClient(tenantId), 5000);
                } else {
                    console.log(`❌ Logged out [${tenantId}], clearing auth state...`);
                    session.isAuthenticated = false;
                    session.qrCodeData = null;
                    notifyApiServer(tenantId, 'auth_failure', 'Logged out. Getting new QR code...');

                    if (clearState) {
                        await clearState();
                    }
                    setTimeout(() => startWhatsAppClient(tenantId), 3000);
                }
            } else if (connection === 'connecting') {
                session.isInitializing = true;
            } else if (connection === 'open') {
                console.log(`✅ CLIENT READY [${tenantId}] (Connection Open)`);
                session.isReady = true;
                session.isAuthenticated = true;
                session.isInitializing = false;
                session.qrCodeData = null;

                if (session.sock?.user?.id) {
                    session.connectedNumber = '+' + session.sock.user.id.split(':')[0].split('@')[0];
                }

                notifyApiServer(tenantId, 'ready', { status: 'connected' });
            }
        });

        session.sock.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages) {
                if (msg.message?.protocolMessage) continue;
                processMessage(tenantId, msg, msg.key.fromMe);
            }
        });

    } catch (err) {
        console.error(`❌ WhatsApp client initialization FAILED [${tenantId}]!`);
        session.isInitializing = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// 📬 OUTGOING MESSAGE POLLER
// ═══════════════════════════════════════════════════════════════

async function pollOutgoingMessages() {
    if (!db.pool) return;
    try {
        // Find all pending outgoing messages
        const result = await db.pool.query(\`
      SELECT id, tenant_id, phone, body 
      FROM messages 
      WHERE direction = 'out' AND status = 'pending'
      ORDER BY created_at ASC
    \`);
    
    for (const msg of result.rows) {
      const session = sessions.get(msg.tenant_id);
      if (session && session.isReady && session.sock) {
        console.log(\`[${msg.tenant_id}] 🤖 Auto-Sending pending message to ${msg.phone}...\`);
        try {
          const jid = \`\${msg.phone}@s.whatsapp.net\`;
          const sentMsg = await session.sock.sendMessage(jid, { text: msg.body });
          
          if (sentMsg?.key?.id) {
            await db.pool.query(\`UPDATE messages SET status = 'sent', whatsapp_id = $1 WHERE id = $2\`, [sentMsg.key.id, msg.id]);
            notifyApiServer(msg.tenant_id, 'message_sent', { id: msg.id, status: 'sent', whatsapp_id: sentMsg.key.id });
          }
        } catch (sendErr) {
          console.error(\`⚠️ Failed to send message \${msg.id}:\`, sendErr.message);
          // Optional: Mark as failed so we don't infinitely retry broken ones, but for now leave pending or add a retry counter
          await db.pool.query(\`UPDATE messages SET status = 'failed' WHERE id = $1\`, [msg.id]);
        }
      }
    }
  } catch (err) {
    console.error("Poller error:", err.message);
  }
}

// Poll every 3 seconds
setInterval(pollOutgoingMessages, 3000);


// ═══════════════════════════════════════════════════════════════
// 🌐 INTERNAL WORKER API (Port 4001)
// ═══════════════════════════════════════════════════════════════

// API Server requests worker to boot/re-boot a tenant's WhatsApp instance
app.post('/api/internal/start/:tenantId', (req, res) => {
  const tenantId = req.params.tenantId;
  const session = getSession(tenantId);
  
  if (session.isReady) {
    return res.json({ success: true, status: 'already_connected' });
  } else if (session.qrCodeData) {
    return res.json({ success: true, status: 'qr_ready', qr: session.qrCodeData });
  } else {
    // Kick off the boot
    startWhatsAppClient(tenantId);
    res.json({ success: true, status: 'starting' });
  }
});

app.get('/api/internal/status/:tenantId', (req, res) => {
  const tenantId = req.params.tenantId;
  const session = getSession(tenantId);
  res.json({
    isReady: session.isReady,
    qr: session.qrCodeData ? true : false,
    number: session.connectedNumber
  });
});

// Boot all saved tenants on startup
db.initDb().then(async () => {
  try {
    const activeTenants = await getAllAuthenticatedTenants(db.pool);
    console.log(\`🤖 Found \${activeTenants.length} active tenants. Booting background syncing...\`);
    for (const tId of activeTenants) {
      startWhatsAppClient(tId);
      // Small delay between boots to prevent rate limiting / high CPU spike
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('Failed to boot background tenants', err);
  }

  app.listen(WORKER_PORT, '0.0.0.0', () => {
    console.log(\`✅ WhatsApp Worker internal API listening on port \${WORKER_PORT}\`);
  });
}).catch(console.error);
