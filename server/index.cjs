require('dotenv').config();

// Auto-inject Supabase Database URL to prevent Render Free data loss
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres.ntrmqtbyfvfyixomwphp:Kazimks123%21@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
  console.log('✅ Injected Permanent Supabase DATABASE_URL successfully.');
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Environment & Config
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_DIR = './baileys_auth';

// Middleware
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000', '*'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Socket.IO Setup
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// State Variables
let isReady = false;
let isAuthenticated = false;
let qrCodeData = null;
let isInitializing = false;
let lastInitError = null;
let sock = null;

// Lightweight Custom Chat Store for /chats/recent
const recentChats = new Map();

// 🆕 Message Deduplication Cache
const PROCESSED_MESSAGES_TTL = 30000; // 30 seconds
const processedMessages = new Map(); // messageId -> timestamp

setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > PROCESSED_MESSAGES_TTL) {
      processedMessages.delete(id);
    }
  }
}, 60000);

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

db.initDb()
  .then(() => console.log('✅ Storage initialized successfully'))
  .catch(err => {
    console.error('⚠️ Storage initialization failed:', err.message);
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

    if (sock && sock.ws) {
      sock.ws.close();
      console.log('✅ WhatsApp client network socket closed (session perserved)');
    }

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
// 📨 MESSAGE PROCESSOR (With De-duplication)
// ═══════════════════════════════════════════════════════════════

async function processMessage(msg, isFromMe) {
  try {
    if (!msg.message) return; // ignore updates with no message

    const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (!messageContent || messageContent.trim() === '') return;

    const whatsappId = msg.key.id;
    if (!whatsappId) {
      console.warn('⚠️ Message missing ID, skipping');
      return;
    }

    if (processedMessages.has(whatsappId)) {
      console.log(`⏭️ Skipping duplicate message: ${whatsappId}`);
      return;
    }

    processedMessages.set(whatsappId, Date.now());

    const prefix = isFromMe ? '📤 [OUTGOING]' : '📥 [INCOMING]';
    // Baileys appends `:deviceId` to remoteJid for outgoing messages
    // e.g. "994776069606:12@s.whatsapp.net" → we want "994776069606"
    const rawJid = msg.key.remoteJid.split('@')[0];
    const rawNumber = rawJid.split(':')[0]; // Strip `:12` device suffix if present

    if (rawJid !== rawNumber) {
      console.log(`🔧 Normalized outgoing number: ${rawJid} → ${rawNumber}`);
    }

    if (!rawNumber || rawNumber.length < 5 || rawNumber.includes('g.us')) { // ignore groups for CRM
      console.warn('⚠️ Invalid or Group number, skipping:', rawNumber);
      return;
    }

    const contactName = msg.pushName || `+${rawNumber}`;

    recentChats.set(rawNumber, {
      name: contactName,
      unread: isFromMe ? 0 : ((recentChats.get(rawNumber)?.unread || 0) + 1),
      lastMessage: messageContent,
      timestamp: Date.now() / 1000,
      phone: rawNumber
    });

    if (recentChats.size > 50) {
      const firstKey = recentChats.keys().next().value;
      recentChats.delete(firstKey);
    }

    console.log(`${prefix} ${rawNumber} | ${messageContent.substring(0, 50)}...`);

    const payload = {
      phone: rawNumber,
      name: contactName,
      message: messageContent,
      whatsapp_id: whatsappId,
      fromMe: isFromMe,
      timestamp: new Date().toISOString(),
      is_fast_emit: false
    };

    io.emit('new_message', payload);

    if (process.env.DATABASE_URL && db) {
      try {
        let existingLead = await db.findLeadByWhatsAppId(whatsappId);
        if (!existingLead) {
          existingLead = await db.findLeadByPhone(rawNumber);
        }

        if (existingLead) {
          await db.updateLeadMessage(rawNumber, messageContent, whatsappId, contactName);
          console.log(`📝 Updated lead: ${rawNumber} (${existingLead.status})`);
        } else {
          await db.createLead({
            phone: rawNumber,
            name: contactName,
            last_message: messageContent,
            whatsapp_id: whatsappId,
            source: 'whatsapp',
            status: 'new'
          });
          console.log(`✨ New lead created: ${rawNumber}`);
        }
      } catch (dbError) {
        console.error('⚠️ Database error (non-fatal):', dbError.message);
      }
    }

  } catch (error) {
    console.error('❌ Error processing message:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// 🟢 WHATSAPP CLIENT INITIALIZER (Baileys)
// ═══════════════════════════════════════════════════════════════

async function startWhatsAppClient() {
  console.log('\n🚀 STARTING WHATSAPP CLIENT (Baileys)...');

  try {
    let state, saveCreds, clearState;
    if (process.env.DATABASE_URL && db && db.pool) {
      console.log('📦 Using PostgreSQL for Baileys Auth State...');
      const usePostgresAuthState = require('./postgresAuthState.cjs');
      const auth = await usePostgresAuthState(db.pool);
      state = auth.state;
      saveCreds = auth.saveCreds;
      clearState = auth.clearState;
    } else {
      console.log('📁 Using Local File System for Baileys Auth State...');
      const auth = await useMultiFileAuthState(AUTH_DIR);
      state = auth.state;
      saveCreds = auth.saveCreds;
      clearState = async () => {
        const fs = require('fs');
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
      };
    }

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    isInitializing = true;

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }), // Suppress pino debug logs
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.macOS('Desktop'), // Standard generic browser to avoid bans
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 QR RECEIVED');
        qrCodeData = qr;
        isReady = false;
        isAuthenticated = false;
        io.emit('qr_code', qr);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`⚠️ Connection closed (Status: ${statusCode}), reconnecting: ${shouldReconnect}`);
        isReady = false;

        if (shouldReconnect) {
          setTimeout(startWhatsAppClient, 5000);
        } else {
          console.log('❌ Logged out, clearing auth state and restarting for a new QR...');
          isAuthenticated = false;
          qrCodeData = null;
          isInitializing = false;
          io.emit('auth_failure', 'Logged out. Getting new QR code...');

          // Clear PostgreSQL auth data to allow new QR generation
          if (clearState) {
            await clearState();
            console.log('🗑️ Auth state permanently cleared.');
          }

          // Reboot the client setup again
          setTimeout(startWhatsAppClient, 3000);
        }
      } else if (connection === 'connecting') {
        console.log('🔄 CONNECTING...');
        isInitializing = true;
      } else if (connection === 'open') {
        console.log('✅ CLIENT READY (Connection Open)');
        isReady = true;
        isAuthenticated = true;
        isInitializing = false;
        qrCodeData = null;

        io.emit('ready', { status: 'connected' });
        io.emit('authenticated', { status: 'authenticated' });
        io.emit('crm:health_check', getHealthStatus());
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      // Handle array of messages
      for (const msg of m.messages) {
        // filter out protocol messages
        if (msg.message?.protocolMessage) continue;

        const isFromMe = msg.key.fromMe;
        processMessage(msg, isFromMe);
      }
    });

  } catch (err) {
    console.error('❌ WhatsApp client initialization FAILED!');
    console.error('❌ Error:', err.message);
    isInitializing = false;
    lastInitError = {
      message: err.message,
      time: new Date().toISOString()
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 🔌 SOCKET.IO CONNECTION
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`👤 NEW UI CLIENT CONNECTED: ${socket.id} (Total: ${io.engine.clientsCount})`);

  socket.emit('crm:health_check', getHealthStatus());

  if (qrCodeData && !isAuthenticated) {
    socket.emit('qr_code', qrCodeData);
  }

  if (isAuthenticated) {
    socket.emit('authenticated', { status: 'authenticated' });
  }
  if (isReady) {
    socket.emit('ready', { status: 'connected' });
  }

  socket.on('disconnect', (reason) => {
    console.log(`👤 UI CLIENT DISCONNECTED: ${socket.id} (${reason})`);
  });
});

function getHealthStatus() {
  let status = 'OFFLINE';
  if (isReady) status = 'CONNECTED';
  else if (isAuthenticated) status = 'SYNCING';
  else if (isInitializing) status = 'INITIALIZING';

  return {
    whatsapp: status,
    socket_clients: io.engine.clientsCount,
    timestamp: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════════
// 🛠️ API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 🗄️ LEADS API
app.get('/api/leads', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const { status, startDate, endDate, limit, offset } = req.query;
  const leads = await db.getLeads({ status, startDate, endDate, limit: limit ? parseInt(limit) : undefined, offset: offset ? parseInt(offset) : undefined });
  res.json(leads);
}));

app.post('/api/leads', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.createLead(req.body);
  res.status(201).json(lead);
}));

app.put('/api/leads/:id/status', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.updateLeadStatus(req.params.id, req.body.status);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.emit('lead_updated', lead);
  res.json(lead);
}));

app.put('/api/leads/:id', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.updateLeadFields(req.params.id, req.body);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.emit('lead_updated', lead);
  res.json(lead);
}));

app.delete('/api/leads/:id', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.deleteLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // Broadcast deletion to all clients
  io.emit('lead_deleted', lead.id);

  res.json(lead);
}));

// 🧹 CLEANUP: Merge duplicate leads with same last 9 phone digits
app.post('/api/leads/cleanup-duplicates', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  const result = await db.pool.query('SELECT * FROM leads ORDER BY created_at ASC');
  const leads = result.rows;
  const merged = [];
  const seenSuffixes = new Map(); // suffix -> lead_id

  for (const lead of leads) {
    const phone = String(lead.phone).replace(/\D/g, '');
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
        WHERE id = $3
      `, [lead.last_message, lead.name, canonicalId]);

      await db.pool.query('DELETE FROM leads WHERE id = $1', [lead.id]);
      merged.push({ deleted: lead.id, mergedInto: canonicalId, phone: lead.phone });
      console.log(`🧹 Merged duplicate: ${lead.phone} → ${canonicalId}`);
    } else {
      seenSuffixes.set(suffix, lead.id);
    }
  }

  // Broadcast updated lead list
  const updatedLeads = await db.getLeads({});
  io.emit('leads_updated', updatedLeads);

  res.json({ merged, count: merged.length, message: `Merged ${merged.length} duplicate leads` });
}));

app.get('/api/stats', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const stats = await db.getLeadStats();
  res.json(stats);
}));

app.get('/health', (req, res) => {
  const health = getHealthStatus();
  if (process.env.DATABASE_URL && db.healthCheck) {
    db.healthCheck().then(dbHealth => res.json({ ...health, database: dbHealth })).catch(() => res.json({ ...health, database: { status: 'error' } }));
  } else {
    res.json(health);
  }
});

app.get('/chats/recent', asyncHandler(async (req, res) => {
  console.log('📂 RECENT CHATS REQUESTED');
  if (!isReady) return res.status(503).json({ error: 'WhatsApp client not ready yet' });

  // Custom recentChats map 
  const chatsArray = Array.from(recentChats.values());
  // Sort by latest message
  chatsArray.sort((a, b) => b.timestamp - a.timestamp);

  res.json(chatsArray.slice(0, 20));
}));

app.get('/__test_send_whatsapp', asyncHandler(async (req, res) => {
  let phone = req.query.phone;
  if (!phone) return res.status(400).send('Please provide ?phone=994XXXXXXXX');

  if (phone.length === 9) phone = '994' + phone;
  if (phone.startsWith('0')) phone = '994' + phone.substring(1);
  if (phone.startsWith('55') && phone.length === 9) phone = '994' + phone;

  const jid = `${phone}@s.whatsapp.net`; // Baileys uses s.whatsapp.net

  if (!isAuthenticated && !isReady) {
    return res.status(503).send(`<h1>Client Not Ready</h1>`);
  }

  try {
    const sentMsg = await sock.sendMessage(jid, { text: '🤖 Hello! This is a backend self-test message. If you see this, sending works!' });

    await processMessage(sentMsg, true);

    res.send(`<h1>Message Sent & Logged!</h1><p>Target: ${jid}</p>`);
  } catch (e) {
    res.status(500).send(`<h1>Send Failed</h1><pre>${e.stack || e.message}</pre>`);
  }
}));

app.get('/api/debug', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    whatsapp: {
      isReady,
      isAuthenticated,
      isInitializing,
      hasQrCode: !!qrCodeData,
      lastInitError,
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
  console.log(`📊 Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS | WA: ${isReady ? 'READY' : isInitializing ? 'INITIALIZING' : 'OFFLINE'} | QR: ${qrCodeData ? 'YES' : 'NO'}`);
}, 30000);

// SERVE FRONTEND (Monolith Mode)
const DIST_PATH = path.join(__dirname, '../dist');
if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  app.use((req, res, next) => {
    const file = req.path.split('/').pop();
    if (file && file.includes('.')) return res.status(404).send('Not found');
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Server running on port ${PORT}`);

  setTimeout(() => {
    startWhatsAppClient();
  }, 2000);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
