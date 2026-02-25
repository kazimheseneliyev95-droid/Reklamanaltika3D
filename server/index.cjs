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
      sock: null
    });
  }
  return sessions.get(tenantId);
}

// Lightweight Custom Chat Store for /chats/recent
const recentChatsMap = new Map(); // tenantId -> Map(phone -> data)

function getRecentChats(tenantId) {
  if (!recentChatsMap.has(tenantId)) recentChatsMap.set(tenantId, new Map());
  return recentChatsMap.get(tenantId);
}

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
  .then(() => {
    console.log('✅ Storage initialized successfully');

    // Start HTTP Server ONLY after DB is ready to prevent Port Binding timeouts on Render
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
  })
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

    if (db.closePool) {
      await db.closePool();
      console.log('✅ Database connections closed');
    }

    for (const [tenant, session] of sessions.entries()) {
      if (session.sock && session.sock.ws) {
        session.sock.ws.close();
        console.log(`✅ WhatsApp client socket closed for ${tenant}`);
      }
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

async function processMessage(tenantId, msg, isFromMe) {
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

    const recentChats = getRecentChats(tenantId);
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

    console.log(`[${tenantId}] ${prefix} ${rawNumber} | ${messageContent.substring(0, 50)}...`);

    const payload = {
      phone: rawNumber,
      name: contactName,
      message: messageContent,
      whatsapp_id: whatsappId,
      fromMe: isFromMe,
      timestamp: new Date().toISOString(),
      is_fast_emit: false
    };

    io.to(tenantId).emit('new_message', payload);

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
          console.log(`📝 Updated lead [${tenantId}]: ${rawNumber} (${existingLead.status})`);
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

        // 📜 Append to full message history
        if (savedLead?.id && messageContent) {
          await db.appendMessage({
            leadId: savedLead.id,
            phone: rawNumber,
            body: messageContent,
            direction: isFromMe ? 'out' : 'in',
            whatsappId,
            createdAt: msg.messageTimestamp || null,
            tenantId
          });
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

async function startWhatsAppClient(tenantId) {
  console.log(`\n🚀 STARTING WHATSAPP CLIENT FOR TENANT [${tenantId}]...`);
  const session = getSession(tenantId);

  // Prevent multiple initializing attempts
  if (session.isInitializing || session.isReady) return;

  // LOCK EARLY to prevent duplicate async socket instances!
  session.isInitializing = true;

  try {
    let state, saveCreds, clearState;
    if (process.env.DATABASE_URL && db && db.pool) {
      console.log(`📦 Using PostgreSQL for Baileys Auth State [${tenantId}]...`);
      const usePostgresAuthState = require('./postgresAuthState.cjs');
      const auth = await usePostgresAuthState(db.pool, tenantId); // Need to update this helper later
      state = auth.state;
      saveCreds = auth.saveCreds;
      clearState = auth.clearState;
    } else {
      console.log(`📁 Using Local File System for Baileys Auth State [${tenantId}]...`);
      const authDirTemplate = `${AUTH_DIR}_${tenantId}`;
      const auth = await useMultiFileAuthState(authDirTemplate);
      state = auth.state;
      saveCreds = auth.saveCreds;
      clearState = async () => {
        const fs = require('fs');
        if (fs.existsSync(authDirTemplate)) {
          fs.rmSync(authDirTemplate, { recursive: true, force: true });
        }
      };
    }

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[${tenantId}] using WA v${version.join('.')}, isLatest: ${isLatest}`);

    session.sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }), // Suppress pino debug logs
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.macOS('Desktop'), // Standard generic browser to avoid bans
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
        io.to(tenantId).emit('qr_code', qr);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`⚠️ Connection closed [${tenantId}] (Status: ${statusCode}), reconnecting: ${shouldReconnect}`);
        session.isReady = false;
        session.isInitializing = false; // MUST unlock before retrying

        if (shouldReconnect) {
          setTimeout(() => startWhatsAppClient(tenantId), 5000);
        } else {
          console.log(`❌ Logged out [${tenantId}], clearing auth state and restarting for a new QR...`);
          session.isAuthenticated = false;
          session.qrCodeData = null;
          io.to(tenantId).emit('auth_failure', 'Logged out. Getting new QR code...');

          // Clear PostgreSQL auth data to allow new QR generation
          if (clearState) {
            await clearState();
            console.log(`🗑️ Auth state permanently cleared [${tenantId}].`);
          }

          // Reboot the client setup again
          setTimeout(() => startWhatsAppClient(tenantId), 3000);
        }
      } else if (connection === 'connecting') {
        console.log(`🔄 CONNECTING [${tenantId}]...`);
        session.isInitializing = true;
      } else if (connection === 'open') {
        console.log(`✅ CLIENT READY [${tenantId}] (Connection Open)`);
        session.isReady = true;
        session.isAuthenticated = true;
        session.isInitializing = false;
        session.qrCodeData = null;

        io.to(tenantId).emit('ready', { status: 'connected' });
        io.to(tenantId).emit('authenticated', { status: 'authenticated' });
        io.to(tenantId).emit('crm:health_check', getHealthStatus(tenantId));
      }
    });

    session.sock.ev.on('messages.upsert', async (m) => {
      // Handle array of messages
      for (const msg of m.messages) {
        // filter out protocol messages
        if (msg.message?.protocolMessage) continue;

        const isFromMe = msg.key.fromMe;
        processMessage(tenantId, msg, isFromMe);
      }
    });

  } catch (err) {
    console.error(`❌ WhatsApp client initialization FAILED [${tenantId}]!`);
    console.error('❌ Error:', err.message);
    session.isInitializing = false;
    session.lastInitError = {
      message: err.message,
      time: new Date().toISOString()
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 🔌 SOCKET.IO CONNECTION
// ═══════════════════════════════════════════════════════════════

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (!token) {
    return next(new Error('Authentication error: Token required'));
  }
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const data = JSON.parse(raw);
    if (!data.tenantId) throw new Error();
    socket.tenantId = data.tenantId;
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid format'));
  }
});

io.on('connection', (socket) => {
  const tenantId = socket.tenantId;
  socket.join(tenantId);
  console.log(`👤 NEW UI CLIENT CONNECTED [${tenantId}]: ${socket.id} (Total: ${io.engine.clientsCount})`);

  // Ensure WhatsApp client is initialized for this tenant
  const session = getSession(tenantId);
  if (!session.sock && !session.isInitializing) {
    startWhatsAppClient(tenantId);
  }

  socket.emit('crm:health_check', getHealthStatus(tenantId));

  if (session.qrCodeData && !session.isAuthenticated) {
    socket.emit('qr_code', session.qrCodeData);
  }

  if (session.isAuthenticated) {
    socket.emit('authenticated', { status: 'authenticated' });
  }
  if (session.isReady) {
    socket.emit('ready', { status: 'connected' });
  }

  socket.on('disconnect', (reason) => {
    console.log(`👤 UI CLIENT DISCONNECTED [${tenantId}]: ${socket.id} (${reason})`);
  });
});

function getHealthStatus(tenantId) {
  const session = getSession(tenantId);
  let status = 'OFFLINE';
  if (session.isReady) status = 'CONNECTED';
  else if (session.isAuthenticated) status = 'SYNCING';
  else if (session.isInitializing) status = 'INITIALIZING';

  return {
    whatsapp: status,
    socket_clients: io.engine.clientsCount, // Global count, maybe scope to namespace later
    timestamp: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════════
// 🛠️ API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// 🔐 AUTHENTICATION API
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kazimks12';

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || username.trim() === '') {
    return res.status(400).json({ success: false, error: 'İstifadəçi adı daxil edilməlidir' });
  }

  const normalizedUsername = username.toLowerCase().trim();

  // Accept the global master password
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Şifrə yalnışdır' });
  }

  // Find user in database to determine role and tenant mapping
  let user = await db.findUserByUsername(normalizedUsername);

  if (!user) {
    return res.status(401).json({ success: false, error: 'İstifadəçi tapılmadı' });
  }

  // Ensure WhatsApp session is pre-initialized for their tenant
  getSession(user.tenant_id);

  // Generate simple token (In production, use true JWT with signing secret)
  const tokenPayload = {
    id: user.id,
    username: user.username,
    tenantId: user.tenant_id,
    role: user.role
  };
  const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');

  res.json({ success: true, token, tenantId: user.tenant_id, role: user.role, id: user.id, username: user.username });
}));

app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const data = JSON.parse(raw);
    if (data.tenantId) {
      res.json({ success: true, valid: true, tenantId: data.tenantId, id: data.id, role: data.role, username: data.username });
    } else {
      throw new Error();
    }
  } catch (err) {
    res.status(401).json({ success: false, valid: false });
  }
});

// Middleware for API routes
const requireTenantAuth = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-tenant-id'];
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const data = JSON.parse(raw);
    if (!data.tenantId) throw new Error();
    req.tenantId = data.tenantId;
    req.userRole = data.role; // Extract role from token
    req.userId = data.id;     // Extract ID from token
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

// 👥 USER MANAGEMENT API (Phase 2)
app.get('/api/users', requireTenantAuth, asyncHandler(async (req, res) => {
  // Superadmin can see all, regular admin/worker only sees their tenant's users
  const targetTenant = req.userRole === 'superadmin' ? null : req.tenantId;
  const users = await db.getUsers(targetTenant);
  res.json(users);
}));

app.post('/api/users', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required' });
  }

  if (role !== 'admin' && role !== 'worker') {
    return res.status(400).json({ error: 'Invalid role. Must be admin or worker' });
  }

  // Regular admins cannot create users for other tenants
  const tenantId = req.tenantId;

  try {
    const newUser = await db.createUser(username.toLowerCase(), password, role, tenantId);
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
  const { role } = req.body;

  if (role !== 'admin' && role !== 'worker') {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const updatedUser = await db.updateUserRole(req.params.id, role, req.tenantId);
  res.json(updatedUser);
}));

app.delete('/api/users/:id', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  await db.deleteUser(req.params.id, req.tenantId);
  res.json({ success: true });
}));

// � SUPER ADMIN API (Phase 3)
app.get('/api/admin/tenants', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }
  const tenants = await db.getSuperAdminTenants();

  // Augment tenants array with their WhatsApp session connection status
  const tenantsWithStatus = tenants.map(t => {
    const session = sessions.get(t.tenant_id);
    const waStatus = session ? 'connected' : 'disconnected'; // Simple check, real status might vary
    return { ...t, whatsapp_status: waStatus };
  });

  res.json(tenantsWithStatus);
}));

app.post('/api/admin/tenants', requireTenantAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }

  const { tenantId, adminUsername, adminPassword } = req.body;

  if (!tenantId || !tenantId.trim() || !adminUsername || !adminPassword) {
    return res.status(400).json({ error: 'Müştəri ID-si, admin adı və şifrə mütləqdir' });
  }

  const cleanTenantId = tenantId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

  try {
    const newAdmin = await db.createUser(adminUsername.toLowerCase(), adminPassword, 'admin', cleanTenantId);

    // Auto-init WhatsApp session for the new tenant
    getSession(cleanTenantId);

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
    username: adminUser.username
  };
  const token = Buffer.from(JSON.stringify(tokenPayload)).toString('base64');

  res.json({
    success: true,
    token,
    tenantId: adminUser.tenant_id,
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role
  });
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
  const lead = await db.updateLeadStatus(req.params.id, req.body.status, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.to(req.tenantId).emit('lead_updated', lead);
  res.json(lead);
}));

app.put('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.updateLeadFields(req.params.id, req.body, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.to(req.tenantId).emit('lead_updated', lead);
  res.json(lead);
}));

app.delete('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const lead = await db.deleteLead(req.params.id, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // Broadcast deletion to tenant clients
  io.to(req.tenantId).emit('lead_deleted', lead.id);

  res.json(lead);
}));

// 🧹 CLEANUP: Merge duplicate leads with same last 9 phone digits (Global Script - Can be secured in phase 2)
app.post('/api/leads/cleanup-duplicates', requireTenantAuth, asyncHandler(async (req, res) => {
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

  // Broadcast updated lead list to the tenant
  const updatedLeads = await db.getLeads({}, req.tenantId);
  io.to(req.tenantId).emit('leads_updated', updatedLeads);

  res.json({ merged, count: merged.length, message: `Merged ${merged.length} duplicate leads` });
}));

app.get('/api/leads/:id/messages', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const messages = await db.getMessages(req.params.id, req.tenantId);
  res.json(messages);
}));

// 🗑️ FACTORY RESET — delete ALL leads and messages FOR TENANT
app.delete('/api/leads/all', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  await db.deleteAllLeads(req.tenantId);
  io.to(req.tenantId).emit('leads_reset', {});
  res.json({ success: true, message: 'All leads and messages deleted for tenant' });
}));

app.get('/api/stats', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const stats = await db.getLeadStats(req.tenantId);
  res.json(stats);
}));

app.get('/health', requireTenantAuth, (req, res) => {
  const health = getHealthStatus(req.tenantId);
  if (process.env.DATABASE_URL && db.healthCheck) {
    db.healthCheck(req.tenantId)
      .then(dbHealth => res.json({ ...health, database: dbHealth }))
      .catch(() => res.json({ ...health, database: { status: 'error' } }));
  } else {
    res.json(health);
  }
});

app.get('/chats/recent', requireTenantAuth, asyncHandler(async (req, res) => {
  console.log(`📂 RECENT CHATS REQUESTED [${req.tenantId}]`);
  const session = getSession(req.tenantId);

  if (!session.isReady) return res.status(503).json({ error: 'WhatsApp client not ready yet' });

  // Custom recentChats map for this tenant
  const chatsArray = Array.from(getRecentChats(req.tenantId).values());
  // Sort by latest message
  chatsArray.sort((a, b) => b.timestamp - a.timestamp);

  res.json(chatsArray.slice(0, 20));
}));

app.get('/__test_send_whatsapp', requireTenantAuth, asyncHandler(async (req, res) => {
  let phone = req.query.phone;
  if (!phone) return res.status(400).send('Please provide ?phone=994XXXXXXXX');

  if (phone.length === 9) phone = '994' + phone;
  if (phone.startsWith('0')) phone = '994' + phone.substring(1);
  if (phone.startsWith('55') && phone.length === 9) phone = '994' + phone;

  const jid = `${phone}@s.whatsapp.net`; // Baileys uses s.whatsapp.net

  const session = getSession(req.tenantId);
  if (!session.isAuthenticated && !session.isReady) {
    return res.status(503).send(`<h1>Client Not Ready for ${req.tenantId}</h1>`);
  }

  try {
    const sentMsg = await session.sock.sendMessage(jid, { text: `🤖 Hello! This is a backend self-test message from ${req.tenantId}.` });

    await processMessage(req.tenantId, sentMsg, true);

    res.send(`<h1>Message Sent & Logged!</h1><p>Target: ${jid}</p>`);
  } catch (e) {
    res.status(500).send(`<h1>Send Failed</h1><pre>${e.stack || e.message}</pre>`);
  }
}));

app.get(['/api/debug', '/api/debug/:tenantId'], (req, res) => {
  const mem = process.memoryUsage();
  const summary = {};

  // Create safe summary of all tenants
  for (const [tId, sess] of sessions.entries()) {
    summary[tId] = {
      isReady: sess.isReady,
      isAuthenticated: sess.isAuthenticated,
      isInitializing: sess.isInitializing,
      hasQrCode: !!sess.qrCodeData,
      lastInitError: sess.lastInitError,
    };
  }

  res.json({
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    tenants: summary,
    environment: {
      node_version: process.version,
      platform: process.platform,
      has_database_url: !!process.env.DATABASE_URL,
    }
  });
});

setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`📊 Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS | Tenants active: ${sessions.size}`);
}, 60000);

// SERVE FRONTEND (Monolith Mode)
const DIST_PATH = path.join(__dirname, '../dist');
console.log(`🔍 Checking Frontend Build Directory: ${DIST_PATH} -> Exists: ${fs.existsSync(DIST_PATH)}`);

if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  app.use((req, res, next) => {
    const file = req.path.split('/').pop();
    if (file && file.includes('.')) return res.status(404).send('Not found');
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
} else {
  // Graceful fallback warning if user forgot to configure the Build Command in Render
  app.get('*', (req, res) => {
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

// Server start moved to db.initDb().then() above
