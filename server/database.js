const { Pool } = require('pg');

// Database Configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for Supabase
    max: 25, // Increased pool size for better concurrency
    idleTimeoutMillis: 60000, // Increased from 30s to 60s
    connectionTimeoutMillis: 10000, // Increased from 2s to 10s for production
});

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
});

// Initialize database tables with better error handling
async function initDb() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const createTableQuery = `
        CREATE TABLE IF NOT EXISTS leads (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) UNIQUE NOT NULL,
          name VARCHAR(255),
          last_message TEXT,
          source_message TEXT,
          source_contact_name VARCHAR(255),
          whatsapp_id VARCHAR(255) UNIQUE,
          status VARCHAR(50) DEFAULT 'new',
          source VARCHAR(50) DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'manual')),
          value DECIMAL(10, 2) DEFAULT 0 CHECK (value >= 0),
          product_name VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_phone ON leads(phone);
        CREATE INDEX IF NOT EXISTS idx_status ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_created_at ON leads(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_whatsapp_id ON leads(whatsapp_id);
      `;

        await client.query(createTableQuery);

        // Migration: Remove old status CHECK constraint if it exists (from previous installs)
        // This allows custom pipeline stages like 'field_1234_abc' to be stored
        try {
            await client.query(`
                ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
            `);
            await client.query(`
                ALTER TABLE leads ALTER COLUMN status TYPE VARCHAR(50);
            `);
        } catch (e) {
            // Ignore migration errors — table may not have the constraint
        }

        // Migration: id type
        try {
            await client.query(`
                ALTER TABLE leads ALTER COLUMN id SET DATA TYPE UUID USING id::uuid;
            `);
        } catch (e) {
            // Already UUID type, ignore
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
 * Create or update a lead (Upsert operation with transaction)
 */
async function createLead(data) {
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
            product_name
        } = data;

        // Upsert with full UPDATE (not DO NOTHING)
        const query = `
        INSERT INTO leads (
          phone, name, last_message, source_message, source_contact_name,
          whatsapp_id, status, source, value, product_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (phone) 
        DO UPDATE SET
          name = COALESCE(EXCLUDED.name, leads.name),
          last_message = COALESCE(EXCLUDED.last_message, leads.last_message),
          source_message = COALESCE(EXCLUDED.source_message, leads.source_message),
          source_contact_name = COALESCE(EXCLUDED.source_contact_name, leads.source_contact_name),
          whatsapp_id = COALESCE(EXCLUDED.whatsapp_id, leads.whatsapp_id),
          value = COALESCE(EXCLUDED.value, leads.value),
          product_name = COALESCE(EXCLUDED.product_name, leads.product_name),
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
            product_name || null
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
async function findLeadByPhone(phone) {
    try {
        const cleanedPhone = normalizePhone(phone);

        // 1. Exact match first
        const exact = await pool.query('SELECT * FROM leads WHERE phone = $1', [cleanedPhone]);
        if (exact.rows[0]) return exact.rows[0];

        // 2. Fuzzy: last 9 digits covers local number without country code variants
        // Handles: "994776069606" vs "0776069606" vs "776069606"
        if (cleanedPhone.length >= 9) {
            const suffix = cleanedPhone.slice(-9);
            const fuzzy = await pool.query(
                "SELECT * FROM leads WHERE phone LIKE $1 ORDER BY created_at DESC LIMIT 1",
                [`%${suffix}`]
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
async function findLeadByWhatsAppId(whatsappId) {
    try {
        if (!whatsappId) return null;
        const query = 'SELECT * FROM leads WHERE whatsapp_id = $1';
        const result = await pool.query(query, [whatsappId]);
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Error finding lead by WhatsApp ID:', error.message);
        throw error;
    }
}

/**
 * Update lead message and metadata (with transaction)
 */
async function updateLeadMessage(phone, message, whatsappId, name = null) {
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
        WHERE phone = $4
        RETURNING *;
      `;

        const result = await client.query(query, [message || null, whatsappId || null, name || null, cleanedPhone]);
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
async function updateLeadStatus(id, status) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const validStatus = validateStatus(status);

        const query = `
        UPDATE leads
        SET status = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *;
      `;

        const result = await client.query(query, [validStatus, id]);
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
async function updateLeadFields(id, updates) {
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

        if (fields.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }

        fields.push(`updated_at = NOW()`);
        values.push(id);

        const query = `
        UPDATE leads
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
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
async function updateLeadValue(id, value) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const validValue = validateValue(value);

        const query = `
        UPDATE leads
        SET value = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *;
      `;

        const result = await client.query(query, [validValue, id]);
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
async function getLeads(filters = {}) {
    try {
        let query = 'SELECT * FROM leads WHERE 1=1';
        const values = [];
        let paramCount = 1;

        if (filters.status) {
            const validStatus = validateStatus(filters.status);
            query += ` AND status = $${paramCount}`;
            values.push(validStatus);
            paramCount++;
        }

        if (filters.startDate) {
            query += ` AND created_at >= $${paramCount}`;
            values.push(filters.startDate);
            paramCount++;
        }

        if (filters.endDate) {
            query += ` AND created_at <= $${paramCount}`;
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
        }

        if (filters.offset) {
            paramCount++;
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
async function deleteLead(id) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const query = 'DELETE FROM leads WHERE id = $1 RETURNING *';
        const result = await client.query(query, [id]);
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
async function getLeadStats() {
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
        FROM leads;
      `;

        const result = await pool.query(query);
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
async function getLeadsByStatus(status) {
    try {
        const validStatus = validateStatus(status);
        const query = 'SELECT * FROM leads WHERE status = $1 ORDER BY updated_at DESC LIMIT 50';
        const result = await pool.query(query, [validStatus]);
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

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, closing database connection...');
    await closePool();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, closing database connection...');
    await closePool();
    process.exit(0);
});

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
    deleteLead,
    getLeadStats,
    getLeadsByStatus,
    healthCheck,
    closePool
};
