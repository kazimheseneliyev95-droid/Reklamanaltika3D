require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const qrcode = require('qrcode');
// const db = require('./database'); // Moved to line 65 for cleanup

const app = express();
const server = http.createServer(app);

// Environment & Config
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV || 'development';

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

// 🆕 Message Deduplication Cache
const PROCESSED_MESSAGES_TTL = 30000; // 30 seconds
const processedMessages = new Map(); // messageId -> timestamp

// Clean up old processed messages periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > PROCESSED_MESSAGES_TTL) {
      processedMessages.delete(id);
    }
  }
}, 60000); // Clean every 60 seconds

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 CRM BACKEND INITIALIZING...');
console.log(`📋 Environment: ${NODE_ENV}`);
console.log(`📋 Port: ${PORT}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Initialize Database
// Initialize Database
let db = require('./database'); // Default PG
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
// 🔍 PRE-FLIGHT: Check if Chromium binary exists
// ═══════════════════════════════════════════════════════════════
const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH;
if (chromiumPath) {
  const { execSync } = require('child_process');
  try {
    const version = execSync(`${chromiumPath} --version 2>&1`, { timeout: 5000 }).toString().trim();
    console.log(`✅ Chromium found: ${version}`);
    console.log(`📋 Path: ${chromiumPath}`);
  } catch (err) {
    console.error(`❌ Chromium NOT FOUND at ${chromiumPath}`);
    console.error(`❌ Error: ${err.message}`);
    // Try to find chromium elsewhere
    try {
      const which = execSync('which chromium chromium-browser google-chrome 2>/dev/null || echo "NOT FOUND"', { timeout: 3000 }).toString().trim();
      console.log(`🔍 Search results: ${which}`);
    } catch (e) { /* ignore */ }
  }
} else {
  console.log('📋 Using Puppeteer bundled Chromium (no PUPPETEER_EXECUTABLE_PATH set)');
}

// Initialize WhatsApp Client (Improved Config with full diagnostics)
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './wwebjs_auth',
    clientId: 'crm-' + (process.env.INSTANCE_ID || 'default')
  }),
  // Use remote web version cache (fixes cloud hosting issues)
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/nicholasrq/nicholasrq.github.io/refs/heads/main/nicholasrq/nicholasrq.github.io/assets/',
  },
  puppeteer: {
    headless: true,
    dumpio: true, // CRITICAL: pipes Chrome's stdout/stderr so we can see errors
    executablePath: chromiumPath || undefined,
    defaultViewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--mute-audio',
      '--disable-translate',
      '--disable-features=TranslateUI',
      '--js-flags=--max-old-space-size=256'
    ]
  }
});

// ═══════════════════════════════════════════════════════════════
// 🛡️ IMPROVED ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════

process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err.message);
  console.error('Stack:', err.stack);
  // Keep running but log critical errors
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    server.close(() => {
      console.log('✅ HTTP server closed');
    });

    // Disconnect WhatsApp client
    if (client) {
      await client.destroy();
      console.log('✅ WhatsApp client disconnected');
    }

    // Close database connections
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
// 📡 STANDARD EVENT LISTENERS (Improved)
// ═══════════════════════════════════════════════════════════════

client.on('loading_screen', (percent, message) => {
  console.log(`⌛ LOADING SCREEN: ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
  console.log(`🔄 STATE CHANGED: ${state}`);
  if (state === 'CONFLICT') {
    console.warn('⚠️ WhatsApp session conflict detected!');
  }
});

client.on('qr', async (qr) => {
  console.log('📱 QR RECEIVED');
  qrCodeData = qr;
  isReady = false;
  isAuthenticated = false;
  io.emit('qr_code', qr);
});

client.on('ready', () => {
  console.log('✅ CLIENT READY');
  isReady = true;
  isAuthenticated = true;
  qrCodeData = null;
  isInitializing = false;

  io.emit('ready', { status: 'connected' });
  io.emit('crm:health_check', getHealthStatus());

  console.log(`📊 Connected clients: ${io.engine.clientsCount}`);
});

client.on('authenticated', () => {
  console.log('🔑 CLIENT AUTHENTICATED');
  isAuthenticated = true;
  isInitializing = false;

  io.emit('authenticated', { status: 'authenticated' });

  // 🆕 REMOVED: Watchdog timer - it was masking real connection issues
  // If 'ready' event doesn't fire, we should let users know there's a problem
});

client.on('auth_failure', (msg) => {
  console.error('🚫 AUTH FAILURE:', msg);
  isAuthenticated = false;
  isInitializing = false;
  io.emit('auth_failure', msg);
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ CLIENT DISCONNECTED:', reason);
  isReady = false;
  isAuthenticated = false;
  qrCodeData = null;
  io.emit('disconnected', reason);

  // 🔄 Auto-Reconnect Strategy
  console.log('🔄 Attempting to reconnect in 5 seconds...');
  setTimeout(() => {
    if (!isInitializing) {
      isInitializing = true;
      client.initialize().catch(err => {
        console.error('❌ Reconnection failed:', err.message);
        isInitializing = false;
      });
    }
  }, 5000);
});

client.on('session_invalid', () => {
  console.error('🚫 SESSION INVALID - Need to re-authenticate');
  isReady = false;
  isAuthenticated = false;
  io.emit('auth_failure', 'Session invalid, please re-scan QR code');

  // 🔄 Destroy and Re-initialize to allow fresh scan
  client.destroy().then(() => {
    console.log('🔄 Client destroyed, re-initializing for new scan...');
    client.initialize();
  }).catch(err => console.error('❌ Error destroying client:', err));
});

// ═══════════════════════════════════════════════════════════════
// 📨 IMPROVED MESSAGE PROCESSOR (With De-duplication)
// ═══════════════════════════════════════════════════════════════

async function processMessage(msg, type) {
  try {
    // Basic Filter: Ignore Status Updates
    if (msg.from === 'status@broadcast') return;
    if (!msg.body || msg.body.trim() === '') return;

    // 🆕 Duplicate Detection by WhatsApp Message ID
    const whatsappId = msg.id?._serialized || msg.id;
    if (!whatsappId) {
      console.warn('⚠️ Message missing ID, skipping');
      return;
    }

    // Check if already processed
    if (processedMessages.has(whatsappId)) {
      console.log(`⏭️ Skipping duplicate message: ${whatsappId}`);
      return;
    }

    // Mark as processed
    processedMessages.set(whatsappId, Date.now());

    // Logging
    const prefix = msg.fromMe ? '📤 [OUTGOING]' : '📥 [INCOMING]';
    const rawNumber = msg.fromMe ? msg.to.split('@')[0] : msg.from.split('@')[0];

    // Safety check
    if (!rawNumber || rawNumber.length < 5) {
      console.warn('⚠️ Invalid phone number, skipping:', rawNumber);
      return;
    }

    console.log(`${prefix} ${rawNumber} | ${msg.body.substring(0, 50)}...`);

    // 1. FAST EMIT (Instant with minimal data)
    const fastPayload = {
      phone: rawNumber,
      name: `~${rawNumber}`,
      message: msg.body,
      whatsapp_id: whatsappId,
      fromMe: msg.fromMe,
      timestamp: new Date().toISOString(),
      is_fast_emit: true
    };

    io.emit('new_message', fastPayload);

    // 2. ENRICHED EMIT (Background Name Resolution with better error handling)
    try {
      let contactName = `+${rawNumber}`;

      try {
        if (typeof msg.getContact === 'function') {
          const contact = await msg.getContact();
          contactName = contact.pushname || contact.name || contactName;
        }
      } catch (contactError) {
        console.warn('⚠️ Could not fetch contact name:', contactError.message);
      }

      const enrichedPayload = {
        ...fastPayload,
        name: contactName,
        is_fast_emit: false
      };

      // Only emit enriched if name changed
      if (enrichedPayload.name !== fastPayload.name) {
        io.emit('new_message', enrichedPayload);
      }

      // 3. DATABASE PERSISTENCE (Only if DATABASE_URL exists)
      if (process.env.DATABASE_URL && db) {
        try {
          // First try to find by WhatsApp ID (more accurate)
          let existingLead = await db.findLeadByWhatsAppId(whatsappId);

          // If not found by WhatsApp ID, try by phone
          if (!existingLead) {
            existingLead = await db.findLeadByPhone(rawNumber);
          }

          if (existingLead) {
            // SMART UPDATE: Update message, name, and timestamp, preserve status
            await db.updateLeadMessage(rawNumber, msg.body, whatsappId, contactName);
            console.log(`📝 Updated lead: ${rawNumber} (${existingLead.status})`);
          } else {
            // CREATE NEW LEAD with better data
            await db.createLead({
              phone: rawNumber,
              name: contactName,
              last_message: msg.body,
              whatsapp_id: whatsappId,
              source: 'whatsapp',
              status: 'new'
            });
            console.log(`✨ New lead created: ${rawNumber}`);
          }
        } catch (dbError) {
          console.error('⚠️ Database error (non-fatal):', dbError.message);
          // Don't throw - allow system to continue
        }
      }
    } catch (err) {
      console.error('❌ Error in enriched emit:', err.message);
    }

  } catch (error) {
    console.error('❌ Error processing message:', error.message);
  }
}

// Handler for INCOMING messages
client.on('message', async (msg) => {
  processMessage(msg, 'INCOMING');
});

// Handler for OUTGOING messages (Sent by me)
client.on('message_create', async (msg) => {
  if (msg.fromMe) {
    processMessage(msg, 'OUTGOING');
  }
});

// ═══════════════════════════════════════════════════════════════
// 🔌 SOCKET.IO CONNECTION (Improved Cleanup)
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`👤 NEW UI CLIENT CONNECTED: ${socket.id} (Total: ${io.engine.clientsCount})`);

  // Send immediate state
  socket.emit('crm:health_check', getHealthStatus());

  // If we have a pending QR, send it (for refreshing page)
  if (qrCodeData && !isAuthenticated) {
    socket.emit('qr_code', qrCodeData);
  }

  // If already authenticated, tell the new client immediately
  if (isAuthenticated) {
    socket.emit('authenticated', { status: 'authenticated' });
  }
  if (isReady) {
    socket.emit('ready', { status: 'connected' });
  }

  // Handle disconnect
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
// 🛠️ API ENDPOINTS (Improved Error Handling)
// ═══════════════════════════════════════════════════════════════

// Async handler wrapper for better error handling
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 🗄️ LEADS API ENDPOINTS

app.get('/api/leads', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { status, startDate, endDate, limit, offset } = req.query;
    const leads = await db.getLeads({
      status,
      startDate,
      endDate,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined
    });
    res.json(leads);
  } catch (error) {
    console.error('❌ Error fetching leads:', error.message);
    res.status(500).json({ error: 'Failed to fetch leads', details: error.message });
  }
}));

app.post('/api/leads', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const lead = await db.createLead(req.body);
    res.status(201).json(lead);
  } catch (error) {
    console.error('❌ Error creating lead:', error.message);
    res.status(500).json({ error: 'Failed to create lead', details: error.message });
  }
}));

app.put('/api/leads/:id/status', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { status } = req.body;
    const lead = await db.updateLeadStatus(req.params.id, status);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Emit socket event for real-time update
    io.emit('lead_updated', lead);

    res.json(lead);
  } catch (error) {
    console.error('❌ Error updating lead status:', error.message);
    res.status(500).json({ error: 'Failed to update lead status', details: error.message });
  }
}));

app.delete('/api/leads/:id', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const lead = await db.deleteLead(req.params.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json(lead);
  } catch (error) {
    console.error('❌ Error deleting lead:', error.message);
    res.status(500).json({ error: 'Failed to delete lead', details: error.message });
  }
}));

app.get('/api/stats', asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const stats = await db.getLeadStats();
    res.json(stats);
  } catch (error) {
    console.error('❌ Error fetching stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats', details: error.message });
  }
}));

// 🧪 TEST ROUTES

app.get('/__test_emit', (req, res) => {
  console.log('🧪 TEST: Manually emitting socket event...');

  const testPayload = {
    phone: '994500000000',
    name: 'TEST USER (Backend)',
    message: 'This is a test message from /__test_emit',
    whatsapp_id: 'TEST_ID_' + Date.now(),
    fromMe: false,
    timestamp: new Date().toISOString(),
    is_fast_emit: true
  };

  io.emit('new_message', testPayload);
  res.send(`<h1>Socket Test Emitted</h1><pre>${JSON.stringify(testPayload, null, 2)}</pre>`);
});

app.get('/health', (req, res) => {
  const health = getHealthStatus();

  // Add database health
  if (process.env.DATABASE_URL && db.healthCheck) {
    db.healthCheck()
      .then(dbHealth => {
        res.json({ ...health, database: dbHealth });
      })
      .catch(() => {
        res.json({ ...health, database: { status: 'error' } });
      });
  } else {
    res.json(health);
  }
});

app.get('/chats/recent', asyncHandler(async (req, res) => {
  console.log('📂 RECENT CHATS REQUESTED');

  if (!isReady) {
    console.warn('⚠️ Request rejected: Client not ready');
    return res.status(503).json({ error: 'WhatsApp client not ready yet' });
  }

  try {
    console.log('⏳ Fetching chats from WhatsApp Client...');
    const chatsPromise = client.getChats();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout getting chats')), 10000)
    );

    const chats = await Promise.race([chatsPromise, timeoutPromise]);
    console.log(`✅ RAW CHATS FOUND: ${chats.length}`);

    const recent = chats.slice(0, 20).map(c => ({
      name: c.name,
      unread: c.unreadCount,
      lastMessage: c.lastMessage ? c.lastMessage.body : '',
      timestamp: c.timestamp || Date.now() / 1000,
      phone: c.id.user
    }));

    console.log(`📤 RETURNING ${recent.length} CHATS to Frontend`);
    res.json(recent);
  } catch (e) {
    console.error('⚠️ Error fetching chats:', e.message);
    res.json([]);
  }
}));

// 🧪 WHATSAPP SEND TEST

app.get('/__test_send_whatsapp', asyncHandler(async (req, res) => {
  let phone = req.query.phone;
  if (!phone) {
    return res.status(400).send('Please provide ?phone=994XXXXXXXX');
  }

  // Auto-fix common prefix issues for Azerbaijan
  if (phone.length === 9) phone = '994' + phone;
  if (phone.startsWith('0')) phone = '994' + phone.substring(1);
  if (phone.startsWith('55') && phone.length === 9) phone = '994' + phone;

  const chatId = `${phone}@c.us`;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🧪 TEST SEND REQUEST`);
  console.log(`📍 Phone: ${phone}`);
  console.log(`📍 Chat ID: ${chatId}`);
  console.log(`📍 Client Auth State: ${isAuthenticated}`);
  console.log(`📍 Client Ready State: ${isReady}`);

  if (!isAuthenticated && !isReady) {
    return res.status(503).send(
      `<h1>Client Not Ready</h1>
       <p>Auth: ${isAuthenticated}, Ready: ${isReady}</p>
       <p>Please scan QR code first.</p>`
    );
  }

  try {
    const sentMsg = await client.sendMessage(
      chatId,
      '🤖 Hello! This is a backend self-test message. If you see this, sending works!'
    );
    console.log('✅ SENT SUCCESSFULLY via API');

    // Manually inject into CRM
    await processMessage({
      ...sentMsg,
      body: sentMsg.body,
      fromMe: true,
      from: sentMsg.from,
      to: sentMsg.to,
      id: sentMsg.id,
      getContact: async () => ({ name: 'Self-Test (Backend)' })
    }, 'OUTGOING');

    res.send(
      `<h1>Message Sent & Logged!</h1>
       <p>Target: ${chatId}</p>
       <p>Check CRM Dashboard now.</p>`
    );
  } catch (e) {
    console.error('❌ SEND FAILED ERROR:', e.message);
    res.status(500).send(`<h1>Send Failed</h1><pre>${e.stack || e.message}</pre>`);
  }
}));

// ═══════════════════════════════════════════════════════════════
// 🔍 DIAGNOSTIC ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.get('/api/debug', (req, res) => {
  const mem = process.memoryUsage();
  const info = {
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      external_mb: Math.round(mem.external / 1024 / 1024),
    },
    whatsapp: {
      isReady,
      isAuthenticated,
      isInitializing,
      hasQrCode: !!qrCodeData,
    },
    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      puppeteer_path: process.env.PUPPETEER_EXECUTABLE_PATH || 'bundled',
      has_database_url: !!process.env.DATABASE_URL,
    },
    connected_clients: io.engine?.clientsCount || 0,
  };
  console.log('🔍 DEBUG:', JSON.stringify(info, null, 2));
  res.json(info);
});

// START
console.log('\n🚀 STARTING WHATSAPP CLIENT...');
console.log(`📋 Chromium path: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'bundled'}`);
console.log(`📋 Memory before init: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`);

isInitializing = true;
client.initialize()
  .then(() => {
    console.log('✅ WhatsApp client initialization started');
    console.log(`📋 Memory after init: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`);
  })
  .catch(err => {
    console.error('❌ WhatsApp client initialization FAILED!');
    console.error('❌ Error:', err.message);
    console.error('❌ Stack:', err.stack);
    console.error(`📋 Memory at failure: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`);
    isInitializing = false;
  });

// QR Timeout Detector — if no QR within 90 seconds, log a warning
setTimeout(() => {
  if (!isReady && !isAuthenticated && !qrCodeData) {
    const mem = process.memoryUsage();
    console.error('⏰ ════════════════════════════════════════════');
    console.error('⏰ QR TIMEOUT: No QR code received after 90 seconds!');
    console.error(`⏰ Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS`);
    console.error(`⏰ isInitializing: ${isInitializing}`);
    console.error(`⏰ Chromium path: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'bundled'}`);
    console.error('⏰ LIKELY CAUSE: Chromium failed to launch or WhatsApp Web failed to load.');
    console.error('⏰ Check dumpio output above for Chrome error messages.');
    console.error('⏰ ════════════════════════════════════════════');
  }
}, 90000);

// Log memory every 30 seconds for debugging
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`📊 Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS | WA: ${isReady ? 'READY' : isInitializing ? 'INITIALIZING' : 'OFFLINE'} | QR: ${qrCodeData ? 'YES' : 'NO'}`);
}, 30000);

// SERVE FRONTEND (Monolith Mode)
const path = require('path');
const DIST_PATH = path.join(__dirname, '../dist');

// Check if dist exists
const fs = require('fs');
if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));

  app.use((req, res, next) => {
    const file = req.path.split('/').pop();
    if (file && file.includes('.')) {
      return res.status(404).send('Not found');
    }
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
} else {
  console.warn(`⚠️ DIST_PATH not found: ${DIST_PATH}`);
  console.warn('⚠️ Frontend not served. Make sure to run "npm run build" first.');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
