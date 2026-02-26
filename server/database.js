const { Pool } = require('pg');

function normalizeDatabaseUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.hostname.endsWith('.pooler.supabase.com') && (!parsed.port || parsed.port === '5432')) {
            parsed.port = '6543';
            console.warn('⚠️ Supabase pooler detected on port 5432. Auto-correcting to 6543.');
        }
        return parsed.toString();
    } catch (err) {
        console.warn('⚠️ DATABASE_URL parse warning:', err.message);
        return rawUrl;
    }
}

const normalizedDatabaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);

// Database Configuration
const pool = new Pool({
    connectionString: normalizedDatabaseUrl,
    ssl: { rejectUnauthorized: false }, // Required for Supabase
    max: 25, // Increased pool size for better concurrency
    idleTimeoutMillis: 60000, // Increased from 30s to 60s
    connectionTimeoutMillis: 10000, // Increased from 2s to 10s for production
});

let didLogAuthHint = false;

// Connection pool health monitoring
let poolConnectCount = 0;
let poolDisconnectCount = 0;

// Test connection
pool.on('connect', () => {
    poolConnectCount++;
    console.log(`✅ Database connected (Total connections: ${poolConnectCount})`);
});

pool.on('remove', () => {
    poolDisconnectCount++;
    console.log(`🔌 Database connection removed (Total removed: ${poolDisconnectCount})`);
});

pool.on('error', (err) => {
    console.error('❌ Unexpected database pool error:', err.message);
    if (!didLogAuthHint) {
        const msg = String(err && err.message ? err.message : '').toLowerCase();
        if ((err && err.code === '28P01') || msg.includes('authentication') || msg.includes('sasl')) {
            didLogAuthHint = true;
            console.error('❌ Database authentication failed. Verify DATABASE_URL username/password.');
        }
    }
});

// Initialize database tables with better error handling
async function initDb() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const createTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'admin',
          permissions JSONB DEFAULT '{}',
          tenant_id VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(50) NOT NULL,
          user_id UUID,
          action VARCHAR(50) NOT NULL,
          entity_type VARCHAR(50) NOT NULL,
          entity_id UUID,
          details JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS leads (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) NOT NULL,
          name VARCHAR(255),
          last_message TEXT,
          source_message TEXT,
          source_contact_name VARCHAR(255),
          whatsapp_id VARCHAR(255),
          status VARCHAR(50) DEFAULT 'new',
          source VARCHAR(50) DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'manual')),
          value DECIMAL(10, 2) DEFAULT 0 CHECK (value >= 0),
          product_name VARCHAR(255),
          extra_data JSONB DEFAULT '{}'::jsonb,
          tenant_id VARCHAR(50) DEFAULT 'admin',
          assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT leads_phone_tenant_unique UNIQUE (phone, tenant_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          phone VARCHAR(30) NOT NULL,
          body TEXT NOT NULL,
          direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out')),
          whatsapp_id VARCHAR(255),
          tenant_id VARCHAR(50) DEFAULT 'admin',
          status VARCHAR(50) DEFAULT 'delivered',
          created_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT messages_wa_tenant_unique UNIQUE (whatsapp_id, tenant_id)
        );
      `;

        await client.query(createTableQuery);

        // Migration: Restructure constraints for multi-tenancy
        try {
            await client.query(`
                ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
                ALTER TABLE leads ALTER COLUMN status TYPE VARCHAR(50);
                
                -- Drop old single-tenant unique constraints if they exist
                ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_phone_key CASCADE;
                ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_whatsapp_id_key CASCADE;
                
                -- Add tenant_id columns if they don't exist
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'delivered';
                
                -- Add missing columns to users table
                ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}';
                ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);

                -- Add crm_settings table
                CREATE TABLE IF NOT EXISTS crm_settings (
                    tenant_id VARCHAR(50) PRIMARY KEY,
                    settings JSONB NOT NULL DEFAULT '{}',
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `);
        } catch (e) {
            console.error("Migration warning (can be ignored on fresh install):", e.message);
        }

        // Ensure extra_data exists even if the big migration query partially failed
        try {
            await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb;");
        } catch (e) {
            console.error('Migration warning (extra_data):', e.message);
        }

        // Analytics layouts (per-tenant, per-user)
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS analytics_layouts (
                    tenant_id VARCHAR(50) NOT NULL,
                    user_id UUID NOT NULL,
                    layout JSONB NOT NULL DEFAULT '{}'::jsonb,
                    updated_at TIMESTAMP DEFAULT NOW(),
                    PRIMARY KEY (tenant_id, user_id)
                );
            `);
        } catch (e) {
            console.error('Migration warning (analytics_layouts):', e.message);
        }

        // Migration: id type
        try {
            await client.query(`
                ALTER TABLE leads ALTER COLUMN id SET DATA TYPE UUID USING id::uuid;
            `);
        } catch (e) {
            // Already UUID type, ignore
        }

        // Create indexes after assuring columns exist
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_phone ON leads(phone);
            CREATE INDEX IF NOT EXISTS idx_status ON leads(status);
            CREATE INDEX IF NOT EXISTS idx_tenant ON leads(tenant_id);
            CREATE INDEX IF NOT EXISTS idx_created_at ON leads(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_whatsapp_id ON leads(whatsapp_id);
            CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
            CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at ASC);
            CREATE INDEX IF NOT EXISTS idx_messages_polling ON messages(direction, status);
        `);

        // Ensure multi-tenant UNIQUE constraints exist for ON CONFLICT clauses.
        // CREATE TABLE IF NOT EXISTS is skipped for existing tables, so the constraints
        // defined there never get created on pre-existing tables. Using UNIQUE INDEXes
        // instead of ALTER TABLE ADD CONSTRAINT to leverage IF NOT EXISTS.
        try {
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone_tenant_unique
                    ON leads(phone, tenant_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_tenant_unique
                    ON messages(whatsapp_id, tenant_id);
            `);
        } catch (e) {
            console.warn('⚠️ Constraint migration warning:', e.message);
        }

        await client.query('COMMIT');
        console.log('✅ Database tables initialized successfully');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error initializing database:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════

function normalizePhone(phone) {
    if (!phone) throw new Error('Phone number is required');
    // Step 1: Strip Baileys device-ID suffix BEFORE removing non-digits
    // e.g. "994776069606:12" -> "994776069606:12" split(':')[0] -> "994776069606"
    const withoutSuffix = String(phone).split(':')[0];
    // Step 2: Remove all remaining non-digit characters (+/-/spaces)
    const cleaned = withoutSuffix.replace(/\D/g, '');
    if (!cleaned || cleaned.length < 7 || cleaned.length > 15) {
        throw new Error(`Invalid phone: ${phone} (normalized: ${cleaned})`);
    }
    return cleaned;
}

// Backward compat alias
const validatePhone = normalizePhone;

function validateStatus(status) {
    // Accept any non-empty string to support user-defined pipeline stages
    if (!status || typeof status !== 'string' || status.trim() === '') {
        return 'new';
    }
    return status.trim();
}

function validateValue(value) {
    if (value !== undefined && value !== null && value !== '') {
        const numValue = parseFloat(value);
        if (isNaN(numValue) || numValue < 0) {
            throw new Error('Value must be a non-negative number');
        }
        return numValue;
    }
    return 0;
}

// ═══════════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Create or update a lead (Fuzzy match + Upsert operation)
 */
async function createLead(data, tenantId = 'admin') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Validate inputs
        const cleanedPhone = validatePhone(data.phone);
        const status = validateStatus(data.status || 'new');
        const value = validateValue(data.value);

        const {
            name,
            last_message,
            source_message,
            source_contact_name,
            whatsapp_id,
            source = 'whatsapp',
            product_name,
            extra_data
        } = data;

        // Normalize extra_data (JSONB)
        let extraDataObj = {};
        if (extra_data !== undefined) {
            if (typeof extra_data === 'string') {
                try {
                    extraDataObj = JSON.parse(extra_data) || {};
                } catch {
                    extraDataObj = {};
                }
            } else if (extra_data && typeof extra_data === 'object' && !Array.isArray(extra_data)) {
                extraDataObj = extra_data;
            } else {
                extraDataObj = {};
            }
        }

        if (!extraDataObj || typeof extraDataObj !== 'object' || Array.isArray(extraDataObj)) {
            extraDataObj = {};
        }

        // 1. Check for fuzzy match first before inserting
        // This prevents duplicate leads when the phone format differs slightly (e.g. +994 vs 055...)
        const existingLead = await findLeadByPhone(cleanedPhone, tenantId);

        if (existingLead) {
            // Update the canonical lead
            const query = `
                UPDATE leads
                SET
                    name = COALESCE($1, name),
                    last_message = COALESCE($2, last_message),
                    source_message = COALESCE($3, source_message),
                    source_contact_name = COALESCE($4, source_contact_name),
                    whatsapp_id = COALESCE($5, whatsapp_id),
                    value = COALESCE(NULLIF($6, 0), value),
                    product_name = COALESCE($7, product_name),
                    status = COALESCE($8, status),
                    extra_data = COALESCE(extra_data, '{}'::jsonb) || COALESCE($9::jsonb, '{}'::jsonb),
                    updated_at = NOW()
                WHERE id = $10 AND tenant_id = $11
                RETURNING *;
            `;
            const values = [
                name || null,
                last_message || null,
                source_message || null,
                source_contact_name || null,
                whatsapp_id || null,
                value,
                product_name || null,
                status,
                extraDataObj,
                existingLead.id,
                tenantId
            ];

            const result = await client.query(query, values);
            await client.query('COMMIT');
            console.log(`✅ Lead updated (fuzzy merged): ${existingLead.phone} (${result.rows[0].status})`);
            return result.rows[0];
        }

        // 2. Insert new lead since no fuzzy match was found
        const query = `
        INSERT INTO leads (
          phone, name, last_message, source_message, source_contact_name,
          whatsapp_id, status, source, value, product_name, extra_data, tenant_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (phone, tenant_id) 
        DO UPDATE SET
          name = COALESCE(EXCLUDED.name, leads.name),
          last_message = COALESCE(EXCLUDED.last_message, leads.last_message),
          source_message = COALESCE(EXCLUDED.source_message, leads.source_message),
          source_contact_name = COALESCE(EXCLUDED.source_contact_name, leads.source_contact_name),
          whatsapp_id = COALESCE(EXCLUDED.whatsapp_id, leads.whatsapp_id),
          value = COALESCE(NULLIF(EXCLUDED.value, 0), leads.value),
          product_name = COALESCE(EXCLUDED.product_name, leads.product_name),
          status = COALESCE(EXCLUDED.status, leads.status),
          extra_data = COALESCE(leads.extra_data, '{}'::jsonb) || COALESCE(EXCLUDED.extra_data, '{}'::jsonb),
          updated_at = NOW()
        RETURNING *;
      `;

        const values = [
            cleanedPhone,
            name || null,
            last_message || null,
            source_message || null,
            source_contact_name || null,
            whatsapp_id || null,
            status,
            source,
            value,
            product_name || null,
            extraDataObj,
            tenantId
        ];

        const result = await client.query(query, values);
        await client.query('COMMIT');

        console.log(`✅ Lead upserted: ${cleanedPhone} (${result.rows[0].status})`);
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error creating lead:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Find lead by phone number with fuzzy suffix matching
 */
async function findLeadByPhone(phone, tenantId = 'admin') {
    try {
        const cleanedPhone = normalizePhone(phone);

        // 1. Exact match first
        const exact = await pool.query('SELECT * FROM leads WHERE phone = $1 AND tenant_id = $2', [cleanedPhone, tenantId]);
        if (exact.rows[0]) return exact.rows[0];

        // 2. Fuzzy: last 9 digits covers local number without country code variants
        if (cleanedPhone.length >= 9) {
            const suffix = cleanedPhone.slice(-9);
            const fuzzy = await pool.query(
                "SELECT * FROM leads WHERE phone LIKE $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1",
                [`%${suffix}`, tenantId]
            );
            if (fuzzy.rows[0]) {
                console.log(`Fuzzy phone match: ${cleanedPhone} found as ${fuzzy.rows[0].phone}`);
                return fuzzy.rows[0];
            }
        }

        return null;
    } catch (error) {
        console.error('Error finding lead:', error.message);
        return null; // recoverable
    }
}

/**
 * Find lead by WhatsApp ID
 */
async function findLeadByWhatsAppId(whatsappId, tenantId = 'admin') {
    try {
        if (!whatsappId) return null;
        const query = 'SELECT * FROM leads WHERE whatsapp_id = $1 AND tenant_id = $2';
        const result = await pool.query(query, [whatsappId, tenantId]);
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Error finding lead by WhatsApp ID:', error.message);
        throw error;
    }
}

/**
 * Update lead message and metadata (with transaction)
 */
async function updateLeadMessage(phone, message, whatsappId, name = null, tenantId = 'admin') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const cleanedPhone = validatePhone(phone);

        const query = `
        UPDATE leads
        SET last_message = $1, 
            whatsapp_id = COALESCE($2, whatsapp_id),
            name = COALESCE($3, name),
            updated_at = NOW()
        WHERE phone = $4 AND tenant_id = $5
        RETURNING *;
      `;

        const result = await client.query(query, [message || null, whatsappId || null, name || null, cleanedPhone, tenantId]);
        await client.query('COMMIT');

        if (result.rows.length === 0) {
            console.warn(`⚠️ No lead found to update: ${cleanedPhone}`);
            return null;
        }

        console.log(`✅ Lead message updated: ${cleanedPhone}`);
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error updating lead message:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update lead status (with validation and transaction)
 */
async function updateLeadStatus(id, status, tenantId = 'admin') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const validStatus = validateStatus(status);

        const query = `
        UPDATE leads
        SET status = $1, updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *;
      `;

        const result = await client.query(query, [validStatus, id, tenantId]);
        await client.query('COMMIT');

        if (result.rows.length === 0) {
            console.warn(`⚠️ No lead found to update status: ${id}`);
            return null;
        }

        console.log(`✅ Lead status updated: ${id} -> ${validStatus}`);
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error updating lead status:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update multiple fields of a lead (from UI Edit modal)
 */
async function updateLeadFields(id, updates, tenantId = 'admin') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const fields = [];
        const values = [];
        let paramCount = 1;

        if (updates.name !== undefined) {
            fields.push(`name = $${paramCount++}`);
            values.push(updates.name);
        }
        if (updates.last_message !== undefined) {
            fields.push(`last_message = $${paramCount++}`);
            values.push(updates.last_message);
        }
        if (updates.product_name !== undefined) {
            fields.push(`product_name = $${paramCount++}`);
            values.push(updates.product_name);
        }
        if (updates.value !== undefined) {
            const validValue = validateValue(updates.value);
            fields.push(`value = $${paramCount++}`);
            values.push(validValue);
        }
        if (updates.assignee_id !== undefined) {
            fields.push(`assignee_id = $${paramCount++}`);
            values.push(updates.assignee_id || null); // null means unassigned
        }

        if (updates.status !== undefined) {
            const validStatus = validateStatus(updates.status);
            fields.push(`status = $${paramCount++}`);
            values.push(validStatus);
        }

        if (updates.extra_data !== undefined) {
            let extra = updates.extra_data;
            if (typeof extra === 'string') {
                try {
                    extra = JSON.parse(extra);
                } catch {
                    // ignore parse errors; store empty object instead of breaking update
                    extra = {};
                }
            }
            // Only allow objects; anything else becomes empty object
            if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
                extra = {};
            }
            fields.push(`extra_data = $${paramCount++}`);
            values.push(extra);
        }

        if (fields.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }

        fields.push(`updated_at = NOW()`);

        values.push(id);
        const idParam = paramCount++;

        values.push(tenantId);
        const tenantParam = paramCount++;

        const query = `
        UPDATE leads
        SET ${fields.join(', ')}
        WHERE id = $${idParam} AND tenant_id = $${tenantParam}
        RETURNING *;
      `;

        const result = await client.query(query, values);
        await client.query('COMMIT');

        if (result.rows.length === 0) {
            console.warn(`⚠️ No lead found to update fields: ${id}`);
            return null;
        }

        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error updating lead fields:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Update lead value
 */
async function updateLeadValue(id, value, tenantId = 'admin') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const validValue = validateValue(value);

        const query = `
        UPDATE leads
        SET value = $1, updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3
        RETURNING *;
      `;

        const result = await client.query(query, [validValue, id, tenantId]);
        await client.query('COMMIT');

        if (result.rows.length === 0) {
            console.warn(`⚠️ No lead found to update value: ${id}`);
            return null;
        }

        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error updating lead value:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get all leads with optional filters (improved with pagination)
 */
async function getLeads(filters = {}, tenantId = 'admin') {
    try {
        let query = 'SELECT * FROM leads WHERE tenant_id = $1';
        const values = [tenantId];
        let paramCount = 2;

        if (filters.status) {
            const validStatus = validateStatus(filters.status);
            query += ` AND status = $${paramCount}`;
            values.push(validStatus);
            paramCount++;
        }

        if (filters.startDate) {
            query += ` AND created_at >= $${paramCount}::timestamptz`;
            values.push(filters.startDate);
            paramCount++;
        }

        if (filters.endDate) {
            // Inclusive end-of-day for YYYY-MM-DD filters from UI
            query += ` AND created_at < ($${paramCount}::date + INTERVAL '1 day')`;
            values.push(filters.endDate);
            paramCount++;
        }

        if (filters.search) {
            query += ` AND (name ILIKE $${paramCount} OR phone ILIKE $${paramCount} OR last_message ILIKE $${paramCount})`;
            values.push(`%${filters.search}%`);
            paramCount++;
        }

        query += ' ORDER BY created_at DESC';

        if (filters.limit) {
            query += ` LIMIT $${paramCount}`;
            values.push(filters.limit);
            paramCount++; // Add this depending on offset usage
        }

        if (filters.offset) {
            query += ` OFFSET $${paramCount}`;
            values.push(filters.offset);
        }

        const result = await pool.query(query, values);
        return result.rows;
    } catch (error) {
        console.error('❌ Error getting leads:', error.message);
        throw error;
    }
}

/**
 * Delete lead (with transaction)
 */
async function deleteLead(id, tenantId = 'admin') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const query = 'DELETE FROM leads WHERE id = $1 AND tenant_id = $2 RETURNING *';
        const result = await client.query(query, [id, tenantId]);
        await client.query('COMMIT');

        if (result.rows.length === 0) {
            console.warn(`⚠️ No lead found to delete: ${id}`);
            return null;
        }

        console.log(`✅ Lead deleted: ${id}`);
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error deleting lead:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get lead statistics with improved query
 */
async function getLeadStats(tenantId = 'admin') {
    try {
        const query = `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'new') as new,
          COUNT(*) FILTER (WHERE status = 'potential') as potential,
          COUNT(*) FILTER (WHERE status = 'contacted') as contacted,
          COUNT(*) FILTER (WHERE status = 'won') as won,
          COUNT(*) FILTER (WHERE status = 'lost') as lost,
          COALESCE(SUM(value) FILTER (WHERE status = 'won'), 0) as total_won_value,
          COALESCE(AVG(value) FILTER (WHERE status = 'won'), 0) as avg_won_value
        FROM leads WHERE tenant_id = $1;
      `;

        const result = await pool.query(query, [tenantId]);
        const stats = result.rows[0];

        console.log(`📊 Lead stats: ${stats.total} total, ${stats.won} won, ${stats.potential} potential`);
        return stats;
    } catch (error) {
        console.error('❌ Error getting lead stats:', error.message);
        throw error;
    }
}

/**
 * Get leads by status for dashboard
 */
async function getLeadsByStatus(status, tenantId = 'admin') {
    try {
        const validStatus = validateStatus(status);
        const query = 'SELECT * FROM leads WHERE status = $1 AND tenant_id = $2 ORDER BY updated_at DESC LIMIT 50';
        const result = await pool.query(query, [validStatus, tenantId]);
        return result.rows;
    } catch (error) {
        console.error('❌ Error getting leads by status:', error.message);
        throw error;
    }
}

/**
 * Health check for database
 */
async function healthCheck() {
    try {
        const result = await pool.query('SELECT 1 as health');
        return {
            status: 'healthy',
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            error: error.message
        };
    }
}

/**
 * Append a single message to the messages table (idempotent via whatsapp_id without relying on constraints)
 */
async function appendMessage({ leadId, phone, body, direction, whatsappId, createdAt, tenantId = 'admin' }) {
    try {
        const ts = createdAt ? new Date(createdAt * 1000) : new Date();

        // 1. Check if message already exists (safer than ON CONFLICT due to partial index migrations)
        if (whatsappId) {
            const existing = await pool.query(
                'SELECT id FROM messages WHERE whatsapp_id = $1 AND tenant_id = $2',
                [whatsappId, tenantId]
            );
            if (existing.rows.length > 0) return; // already exists
        }

        // 2. Insert message
        await pool.query(`
            INSERT INTO messages (lead_id, phone, body, direction, whatsapp_id, created_at, tenant_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [leadId, phone, body || '', direction, whatsappId || null, ts, tenantId]);
    } catch (error) {
        // Non-fatal - log and continue
        console.warn('⚠️ appendMessage error:', error.message);
    }
}

/**
 * Get all messages for a lead, oldest first
 */
async function getMessages(leadId, tenantId = 'admin') {
    try {
        const result = await pool.query(
            'SELECT * FROM messages WHERE lead_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
            [leadId, tenantId]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ getMessages error:', error.message);
        return [];
    }
}

/**
 * Get recent conversations from DB: one row per unique phone (latest message per lead).
 * Used as the DB-backed replacement for the in-memory recentChatsMap.
 * Returns up to `limit` conversations sorted by most recent message.
 */
async function getRecentLeadsWithLatestMessage(tenantId = 'admin', limit = 50) {
    try {
        // Join leads with their most recent message for rich conversation data
        const result = await pool.query(`
            SELECT
                l.id as lead_id,
                l.phone,
                l.name,
                l.status,
                l.updated_at,
                COALESCE(m.body, l.last_message) as lastMessage,
                COALESCE(m.created_at, l.updated_at) as timestamp,
                COALESCE(m.direction, 'in') as last_direction,
                (
                    SELECT COUNT(*) FROM messages
                    WHERE lead_id = l.id AND tenant_id = l.tenant_id AND direction = 'in'
                ) as total_messages
            FROM leads l
            LEFT JOIN LATERAL (
                SELECT body, created_at, direction
                FROM messages
                WHERE lead_id = l.id AND tenant_id = l.tenant_id
                ORDER BY created_at DESC
                LIMIT 1
            ) m ON true
            WHERE l.tenant_id = $1
            ORDER BY COALESCE(m.created_at, l.updated_at) DESC
            LIMIT $2
        `, [tenantId, limit]);
        return result.rows;
    } catch (error) {
        console.error('❌ getRecentLeadsWithLatestMessage error:', error.message);
        return [];
    }
}

/**
 * Delete ALL leads and messages (Format / Factory Reset)
 */
async function deleteAllLeads(tenantId = 'admin') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM leads WHERE tenant_id = $1', [tenantId]);
        await client.query('COMMIT');
        console.log('🗑️ All leads and messages deleted (factory reset)');
        return { deleted: true };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ deleteAllLeads error:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// ═══════════════════════════════════════════════════════════════
// USER OPERATIONS (Phase 2)
// ═══════════════════════════════════════════════════════════════

/**
 * Creates a new user
 */
async function createUser(username, passwordHash, role, permissions, tenantId, displayName = null) {
    try {
        const result = await pool.query(
            'INSERT INTO users (username, password_hash, role, permissions, tenant_id, display_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, role, permissions, tenant_id, display_name, created_at',
            [username, passwordHash, role, permissions || {}, tenantId, displayName]
        );
        return result.rows[0];
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            throw new Error('Username already exists');
        }
        console.error('❌ createUser error:', error.message);
        throw error;
    }
}

/**
 * Gets all users for a given tenant (or all if superadmin)
 */
async function getUsers(tenantId = null) {
    try {
        let query = 'SELECT id, username, role, permissions, tenant_id, display_name, created_at FROM users';
        let values = [];

        if (tenantId) {
            query += ' WHERE tenant_id = $1 ORDER BY created_at DESC';
            values.push(tenantId);
        } else {
            query += ' ORDER BY tenant_id ASC, created_at DESC';
        }

        const result = await pool.query(query, values);
        return result.rows;
    } catch (error) {
        console.error('❌ getUsers error:', error.message);
        throw error;
    }
}

/**
 * Updates a user\'s role
 */
async function updateUserRole(userId, newRole, tenantId) {
    try {
        const result = await pool.query(
            'UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, username, role, permissions',
            [newRole, userId, tenantId]
        );
        if (result.rowCount === 0) throw new Error('User not found or unauthorized');
        return result.rows[0];
    } catch (error) {
        console.error('❌ updateUserRole error:', error.message);
        throw error;
    }
}

/**
 * Updates a user's permissions
 */
async function updateUserPermissions(userId, newPermissions, tenantId) {
    try {
        const result = await pool.query(
            'UPDATE users SET permissions = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, username, role, permissions',
            [newPermissions, userId, tenantId]
        );
        if (result.rowCount === 0) throw new Error('User not found or unauthorized');
        return result.rows[0];
    } catch (error) {
        console.error('❌ updateUserPermissions error:', error.message);
        throw error;
    }
}

/**
 * Deletes a user
 */
async function deleteUser(userId, tenantId) {
    try {
        const result = await pool.query(
            'DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id',
            [userId, tenantId]
        );
        if (result.rowCount === 0) throw new Error('User not found or unauthorized');
        return true;
    } catch (error) {
        console.error('❌ deleteUser error:', error.message);
        throw error;
    }
}

/**
 * Super Admin: Get all tenants and their statistics
 */
async function getSuperAdminTenants() {
    try {
        const query = `
            SELECT 
                u.tenant_id,
                MIN(u.created_at) as created_at,
                (SELECT COUNT(*) FROM users WHERE tenant_id = u.tenant_id) as user_count,
                (SELECT COUNT(*) FROM leads WHERE tenant_id = u.tenant_id) as lead_count,
                (SELECT username FROM users WHERE tenant_id = u.tenant_id AND role = 'admin' ORDER BY created_at ASC LIMIT 1) as admin_username
            FROM users u
            WHERE u.tenant_id != 'admin'
            GROUP BY u.tenant_id
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query);
        return result.rows;
    } catch (error) {
        console.error('❌ getSuperAdminTenants error:', error.message);
        throw error;
    }
}

/**
 * Authenticate User by username
 * Note: Password validation will happen in the API layer.
 */
async function findUserByUsername(username) {
    try {
        const result = await pool.query(
            'SELECT id, username, password_hash, role, permissions, tenant_id, display_name FROM users WHERE username = $1',
            [username]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ findUserByUsername error:', error.message);
        throw error;
    }
}

async function updateUserPasswordHash(userId, passwordHash) {
    try {
        const result = await pool.query(
            'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id',
            [passwordHash, userId]
        );
        return result.rowCount > 0;
    } catch (error) {
        console.error('❌ updateUserPasswordHash error:', error.message);
        throw error;
    }
}

/**
 * Get tenant admin
 */
async function getTenantAdmin(tenantId) {
    try {
        const result = await pool.query(
            "SELECT id, username, role, permissions, tenant_id, display_name FROM users WHERE tenant_id = $1 AND role = 'admin' ORDER BY created_at ASC LIMIT 1",
            [tenantId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ getTenantAdmin error:', error.message);
        throw error;
    }
}

async function deleteTenant(tenantId) {
    if (!tenantId || tenantId === 'admin') throw new Error('Cannot delete superadmin tenant');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM leads WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
        // Also clear any persistent whatsapp sessions mapping to this tenant if we had a multi-tenant DB table
        // Wrap the baileys_auth_multi drop in a try-catch because if a tenant was never initialized online, the table might hypothetically not exist or be empty
        try {
            await client.query('DELETE FROM baileys_auth_multi WHERE tenant_id = $1', [tenantId]);
        } catch (we) {
            console.log('No WhatsApp session data found to delete for this tenant.');
        }
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ deleteTenant error:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Graceful shutdown
 */
async function closePool() {
    try {
        await pool.end();
        console.log('✅ Database connection pool closed');
    } catch (error) {
        console.error('❌ Error closing database pool:', error.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// AUDIT LOGS (Phase 3)
// ═══════════════════════════════════════════════════════════════

/**
 * Log an action to the audit_logs table
 */
async function logAuditAction({ tenantId, userId, action, entityType, entityId, details }) {
    try {
        await pool.query(
            `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tenantId, userId, action, entityType, entityId, details || {}]
        );
    } catch (error) {
        console.error('⚠️ logAuditAction error:', error.message);
    }
}

/**
 * Get recent audit logs for a tenant
 */
async function getAuditLogs(tenantId, limit = 100) {
    try {
        const result = await pool.query(`
            SELECT 
                a.*,
                u.username 
            FROM audit_logs a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE a.tenant_id = $1
            ORDER BY a.created_at DESC
            LIMIT $2
        `, [tenantId, limit]);
        return result.rows;
    } catch (error) {
        console.error('❌ getAuditLogs error:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════
// CRM SETTINGS (Phase 4)
// ═══════════════════════════════════════════════════════════════

/**
 * Get CRM Settings for a tenant
 */
async function getCRMSettings(tenantId) {
    try {
        const result = await pool.query(
            'SELECT settings FROM crm_settings WHERE tenant_id = $1',
            [tenantId]
        );
        if (result.rows.length > 0) {
            return result.rows[0].settings;
        }
        return null; // Signals the frontend to use its default structure
    } catch (error) {
        console.error('❌ getCRMSettings error:', error.message);
        throw error;
    }
}

/**
 * Update CRM Settings for a tenant
 */
async function updateCRMSettings(tenantId, settings) {
    try {
        const query = `
            INSERT INTO crm_settings (tenant_id, settings, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (tenant_id)
            DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
            RETURNING settings;
        `;
        const result = await pool.query(query, [tenantId, settings]);
        return result.rows[0].settings;
    } catch (error) {
        console.error('❌ updateCRMSettings error:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════
// ANALYTICS LAYOUTS (per-user)
// ═══════════════════════════════════════════════════════════════

async function getAnalyticsLayout(tenantId, userId) {
    try {
        const result = await pool.query(
            'SELECT layout FROM analytics_layouts WHERE tenant_id = $1 AND user_id = $2',
            [tenantId, userId]
        );
        if (result.rows.length > 0) return result.rows[0].layout;
        return null;
    } catch (error) {
        console.error('❌ getAnalyticsLayout error:', error.message);
        throw error;
    }
}

async function upsertAnalyticsLayout(tenantId, userId, layout) {
    try {
        const result = await pool.query(
            `INSERT INTO analytics_layouts (tenant_id, user_id, layout, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (tenant_id, user_id)
             DO UPDATE SET layout = EXCLUDED.layout, updated_at = NOW()
             RETURNING layout`,
            [tenantId, userId, layout]
        );
        return result.rows[0].layout;
    } catch (error) {
        console.error('❌ upsertAnalyticsLayout error:', error.message);
        throw error;
    }
}

// NOTE: SIGINT/SIGTERM handlers are NOT registered here.
// The main entry point (index.cjs) owns the graceful shutdown sequence
// and calls db.closePool() itself. Having duplicate handlers caused
// "Called end on pool more than once" errors on Render.

module.exports = {
    pool,
    initDb,
    createLead,
    findLeadByPhone,
    findLeadByWhatsAppId,
    updateLeadMessage,
    updateLeadStatus,
    updateLeadFields,
    updateLeadValue,
    getLeads,
    getMessages,
    appendMessage,
    getRecentLeadsWithLatestMessage,
    deleteLead,
    deleteAllLeads,
    getLeadStats,
    getLeadsByStatus,
    healthCheck,
    createUser,
    getUsers,
    updateUserRole,
    updateUserPermissions,
    deleteUser,
    getSuperAdminTenants,
    findUserByUsername,
    updateUserPasswordHash,
    getTenantAdmin,
    deleteTenant,
    logAuditAction,
    getAuditLogs,
    getCRMSettings,
    updateCRMSettings,
    getAnalyticsLayout,
    upsertAnalyticsLayout,
    closePool
};
