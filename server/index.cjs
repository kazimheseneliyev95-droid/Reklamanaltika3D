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
app.use(express.json({ limit: '10mb' }));

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
app.post('/api/internal/webhook', (req, res) => {
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
    details: { newStatus: req.body.status }
  });

  res.json(lead);
}));

app.put('/api/leads/:id', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });

  // Field-Level Security: Prevent budget edits if permission is missing (default true for backwards compatibility if not explicitly false)
  if (req.body.value !== undefined && req.userPermissions.view_budget === false) {
    return res.status(403).json({ error: 'Büdcəni dəyişmək üçün icazəniz yoxdur' });
  }

  const lead = await db.updateLeadFields(req.params.id, req.body, req.tenantId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  io.to(req.tenantId).emit('lead_updated', lead);

  // Audit Log
  await db.logAuditAction({
    tenantId: req.tenantId,
    userId: req.userId,
    action: 'UPDATE_FIELDS',
    entityType: 'lead',
    entityId: req.params.id,
    details: { fields: Object.keys(req.body) }
  });

  res.json(lead);
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
  const messages = await db.getMessages(req.params.id, req.tenantId);
  res.json(messages);
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
  const fullLead = await db.pool.query('SELECT phone, name FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, req.tenantId]);
  if (fullLead.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
  const lead = fullLead.rows[0];

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

  res.status(201).json(newMsg);
}));

app.get('/api/stats', requireTenantAuth, asyncHandler(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database not configured' });
  const stats = await db.getLeadStats(req.tenantId);
  res.json(stats);
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
