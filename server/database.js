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

        CREATE TABLE IF NOT EXISTS tenants (
          tenant_id VARCHAR(50) PRIMARY KEY,
          display_name VARCHAR(255),
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          import_source VARCHAR(50),
          import_meta JSONB DEFAULT '{}'::jsonb,
          archived_at TIMESTAMP,
          archived_by UUID,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
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
          phone VARCHAR(80) NOT NULL,
          name VARCHAR(255),
          last_message TEXT,
          source_message TEXT,
          source_contact_name VARCHAR(255),
          whatsapp_id VARCHAR(255),
          status VARCHAR(50) DEFAULT 'new',
          source VARCHAR(50) DEFAULT 'whatsapp',
          value DECIMAL(10, 2) DEFAULT 0 CHECK (value >= 0),
          product_name VARCHAR(255),
          extra_data JSONB DEFAULT '{}'::jsonb,
          unread_count INTEGER DEFAULT 0,
          last_read_at TIMESTAMP,
          last_inbound_at TIMESTAMP,
          last_outbound_at TIMESTAMP,
          conversation_closed BOOLEAN DEFAULT false,
          conversation_closed_at TIMESTAMP,
          tenant_id VARCHAR(50) DEFAULT 'admin',
          assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT leads_phone_tenant_unique UNIQUE (phone, tenant_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          phone VARCHAR(80) NOT NULL,
          body TEXT NOT NULL,
          direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out')),
          whatsapp_id VARCHAR(255),
          sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          metadata JSONB DEFAULT '{}'::jsonb,
          tenant_id VARCHAR(50) DEFAULT 'admin',
          status VARCHAR(50) DEFAULT 'delivered',
          created_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT messages_wa_tenant_unique UNIQUE (whatsapp_id, tenant_id)
        );

        CREATE TABLE IF NOT EXISTS meta_pages (
          tenant_id VARCHAR(50) NOT NULL,
          page_id VARCHAR(64) NOT NULL,
          page_name TEXT,
          page_access_token TEXT NOT NULL,
          ig_business_id VARCHAR(64),
          status VARCHAR(20) DEFAULT 'connected',
          token_expires_at TIMESTAMP,
          last_checked_at TIMESTAMP,
          last_error TEXT,
          connected_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (tenant_id, page_id)
        );

        CREATE TABLE IF NOT EXISTS meta_webhook_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          received_at TIMESTAMP DEFAULT NOW(),
          object_type VARCHAR(32),
          payload JSONB NOT NULL,
          signature VARCHAR(255),
          signature_ok BOOLEAN DEFAULT true,
          attempts INTEGER DEFAULT 0,
          next_attempt_at TIMESTAMP,
          processed_at TIMESTAMP,
          locked_at TIMESTAMP,
          lock_owner TEXT,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS meta_user_tokens (
          tenant_id VARCHAR(50) PRIMARY KEY,
          user_access_token TEXT NOT NULL,
          expires_at TIMESTAMP,
          debug_info JSONB DEFAULT '{}'::jsonb,
          status VARCHAR(20) DEFAULT 'active',
          last_error TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS facebook_ad_imports (
          tenant_id VARCHAR(50) PRIMARY KEY,
          access_token TEXT,
          token_hint VARCHAR(64),
          selected_account_ids JSONB DEFAULT '[]'::jsonb,
          selected_campaign_ids JSONB DEFAULT '[]'::jsonb,
          account_cache JSONB DEFAULT '[]'::jsonb,
          campaign_cache JSONB DEFAULT '[]'::jsonb,
          last_sync_at TIMESTAMP,
          last_error TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS telegram_integrations (
          tenant_id VARCHAR(50) PRIMARY KEY,
          bot_token TEXT,
          chat_id TEXT,
          enabled BOOLEAN DEFAULT true,
          last_error TEXT,
          last_sent_at TIMESTAMP,
          last_test_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS follow_ups (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(50) NOT NULL,
          lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
          due_at TIMESTAMP NOT NULL,
          note TEXT,
          notified_at TIMESTAMP,
          overdue_notified_at TIMESTAMP,
          done_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(50) NOT NULL,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          type VARCHAR(40) NOT NULL,
          title TEXT,
          body TEXT,
          payload JSONB DEFAULT '{}'::jsonb,
          dedupe_key TEXT NOT NULL,
          lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
          followup_id UUID REFERENCES follow_ups(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          read_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS lead_reads (
          tenant_id VARCHAR(50) NOT NULL,
          lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (tenant_id, lead_id, user_id)
        );

        -- Idempotency/dedupe: do not spam the same user for the same event
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_tenant_user_dedupe
          ON notifications (tenant_id, user_id, dedupe_key);
        CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_created
          ON notifications (tenant_id, user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_unread
          ON notifications (tenant_id, user_id, read_at, created_at DESC);
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

                -- Allow additional lead sources (facebook/instagram/etc.)
                ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;
                
                -- Add tenant_id columns if they don't exist
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb;
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP;
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMP;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'delivered';
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;
                
                -- Add missing columns to users table
                ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}';
                ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'admin';
                ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);

                CREATE TABLE IF NOT EXISTS tenants (
                    tenant_id VARCHAR(50) PRIMARY KEY,
                    display_name VARCHAR(255),
                    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
                    import_source VARCHAR(50),
                    import_meta JSONB DEFAULT '{}'::jsonb,
                    archived_at TIMESTAMP,
                    archived_by UUID,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );

                -- Add crm_settings table
                CREATE TABLE IF NOT EXISTS crm_settings (
                    tenant_id VARCHAR(50) PRIMARY KEY,
                    settings JSONB NOT NULL DEFAULT '{}',
                    updated_at TIMESTAMP DEFAULT NOW()
                );

                -- Telegram integration (per-tenant)
                CREATE TABLE IF NOT EXISTS telegram_integrations (
                  tenant_id VARCHAR(50) PRIMARY KEY,
                  bot_token TEXT,
                  chat_id TEXT,
                  enabled BOOLEAN DEFAULT true,
                  last_error TEXT,
                  last_sent_at TIMESTAMP,
                  last_test_at TIMESTAMP,
                  created_at TIMESTAMP DEFAULT NOW(),
                  updated_at TIMESTAMP DEFAULT NOW()
                );

                -- Meta (Facebook/Instagram) integrations
                CREATE TABLE IF NOT EXISTS meta_pages (
                    tenant_id VARCHAR(50) NOT NULL,
                    page_id VARCHAR(64) NOT NULL,
                    page_name TEXT,
                    page_access_token TEXT NOT NULL,
                    ig_business_id VARCHAR(64),
                    status VARCHAR(20) DEFAULT 'connected',
                    token_expires_at TIMESTAMP,
                    last_checked_at TIMESTAMP,
                    last_error TEXT,
                    connected_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    PRIMARY KEY (tenant_id, page_id)
                );

                CREATE TABLE IF NOT EXISTS meta_webhook_events (
                  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  received_at TIMESTAMP DEFAULT NOW(),
                  object_type VARCHAR(32),
                  payload JSONB NOT NULL,
                  signature VARCHAR(255),
                  signature_ok BOOLEAN DEFAULT true,
                  attempts INTEGER DEFAULT 0,
                  next_attempt_at TIMESTAMP,
                  processed_at TIMESTAMP,
                  locked_at TIMESTAMP,
                  lock_owner TEXT,
                  last_error TEXT
                );

                CREATE TABLE IF NOT EXISTS meta_user_tokens (
                  tenant_id VARCHAR(50) PRIMARY KEY,
                  user_access_token TEXT NOT NULL,
                  expires_at TIMESTAMP,
                  debug_info JSONB DEFAULT '{}'::jsonb,
                  status VARCHAR(20) DEFAULT 'active',
                  last_error TEXT,
                  updated_at TIMESTAMP DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS facebook_ad_imports (
                  tenant_id VARCHAR(50) PRIMARY KEY,
                  access_token TEXT,
                  token_hint VARCHAR(64),
                  selected_account_ids JSONB DEFAULT '[]'::jsonb,
                  selected_campaign_ids JSONB DEFAULT '[]'::jsonb,
                  account_cache JSONB DEFAULT '[]'::jsonb,
                  campaign_cache JSONB DEFAULT '[]'::jsonb,
                  last_sync_at TIMESTAMP,
                  last_error TEXT,
                  created_at TIMESTAMP DEFAULT NOW(),
                  updated_at TIMESTAMP DEFAULT NOW()
                );
                 -- Follow-ups / tasks (per-tenant)
                 CREATE TABLE IF NOT EXISTS follow_ups (
                   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                   tenant_id VARCHAR(50) NOT NULL,
                   lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                   assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
                   created_by UUID REFERENCES users(id) ON DELETE SET NULL,
                   status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
                   due_at TIMESTAMP NOT NULL,
                   note TEXT,
                   notified_at TIMESTAMP,
                   overdue_notified_at TIMESTAMP,
                   done_at TIMESTAMP,
                   created_at TIMESTAMP DEFAULT NOW(),
                   updated_at TIMESTAMP DEFAULT NOW()
                 );
            `);
        } catch (e) {
            console.error("Migration warning (can be ignored on fresh install):", e.message);
        }

        // Meta pages: ensure new columns exist on older installs
        try {
            await client.query("ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'connected';");
            await client.query('ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;');
            await client.query('ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;');
            await client.query('ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS last_error TEXT;');
        } catch (e) {
            console.warn('⚠️ Migration warning (meta_pages columns):', e.message);
        }

        // Ensure facebook ad imports table exists for ad account import architecture
        try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS facebook_ad_imports (
                tenant_id VARCHAR(50) PRIMARY KEY,
                access_token TEXT,
                token_hint VARCHAR(64),
                selected_account_ids JSONB DEFAULT '[]'::jsonb,
                selected_campaign_ids JSONB DEFAULT '[]'::jsonb,
                account_cache JSONB DEFAULT '[]'::jsonb,
                campaign_cache JSONB DEFAULT '[]'::jsonb,
                last_sync_at TIMESTAMP,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
              );
            `);
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS access_token TEXT;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS token_hint VARCHAR(64);');
            await client.query("ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS selected_account_ids JSONB DEFAULT '[]'::jsonb;");
            await client.query("ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS selected_campaign_ids JSONB DEFAULT '[]'::jsonb;");
            await client.query("ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS account_cache JSONB DEFAULT '[]'::jsonb;");
            await client.query("ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS campaign_cache JSONB DEFAULT '[]'::jsonb;");
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS last_error TEXT;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();');
        } catch (e) {
            console.warn('⚠️ Migration warning (facebook_ad_imports):', e.message);
        }

        // Ensure phone column can store non-phone external IDs (fb:/ig:)
        try {
            await client.query('ALTER TABLE leads ALTER COLUMN phone TYPE VARCHAR(80);');
            await client.query('ALTER TABLE messages ALTER COLUMN phone TYPE VARCHAR(80);');
        } catch (e) {
            console.error('Migration warning (phone type):', e.message);
        }

        // Ensure tenants table columns exist and backfill old tenant rows
        try {
            await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);');
            await client.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';");
            await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS import_source VARCHAR(50);');
            await client.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS import_meta JSONB DEFAULT '{}'::jsonb;");
            await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;');
            await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS archived_by UUID;');
            await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();');
            await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();');
            await client.query(`
                INSERT INTO tenants (tenant_id, display_name, status, created_at, updated_at)
                SELECT u.tenant_id,
                       MAX(NULLIF(u.display_name, '')) FILTER (WHERE u.role = 'admin') AS display_name,
                       'active' AS status,
                       MIN(u.created_at) AS created_at,
                       NOW() AS updated_at
                FROM users u
                WHERE u.tenant_id IS NOT NULL AND u.tenant_id <> 'admin'
                GROUP BY u.tenant_id
                ON CONFLICT (tenant_id) DO UPDATE
                  SET display_name = COALESCE(tenants.display_name, EXCLUDED.display_name),
                      updated_at = NOW();
            `);
        } catch (e) {
            console.warn('⚠️ Migration warning (tenants):', e.message);
        }

        // Ensure extra_data exists even if the big migration query partially failed
        try {
            await client.query("ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb;");
        } catch (e) {
            console.error('Migration warning (extra_data):', e.message);
        }

        // Ensure unread tracking columns exist
        try {
            await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;');
            await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP;');
            await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;');
            await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMP;');
            await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_closed BOOLEAN DEFAULT false;');
            await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_closed_at TIMESTAMP;');
        } catch (e) {
            console.error('Migration warning (unread columns):', e.message);
        }

        // Ensure follow_ups table exists
        try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS follow_ups (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id VARCHAR(50) NOT NULL,
                lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
                created_by UUID REFERENCES users(id) ON DELETE SET NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
                due_at TIMESTAMP NOT NULL,
                note TEXT,
                notified_at TIMESTAMP,
                overdue_notified_at TIMESTAMP,
                done_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
              );
            `);
            await client.query('ALTER TABLE follow_ups ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMP;');
            await client.query('CREATE INDEX IF NOT EXISTS idx_followups_tenant_due ON follow_ups (tenant_id, status, due_at);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_followups_tenant_lead ON follow_ups (tenant_id, lead_id, due_at);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_followups_tenant_assignee_due ON follow_ups (tenant_id, assignee_id, due_at);');
        } catch (e) {
            console.warn('⚠️ Migration warning (follow_ups):', e.message);
        }

        // Ensure notifications table exists (persistent in-app alerts)
        try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id VARCHAR(50) NOT NULL,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(40) NOT NULL,
                title TEXT,
                body TEXT,
                payload JSONB DEFAULT '{}'::jsonb,
                dedupe_key TEXT NOT NULL,
                lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
                followup_id UUID REFERENCES follow_ups(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                read_at TIMESTAMP
              );
            `);
            await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_tenant_user_dedupe ON notifications (tenant_id, user_id, dedupe_key);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_created ON notifications (tenant_id, user_id, created_at DESC);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_notifications_tenant_user_unread ON notifications (tenant_id, user_id, read_at, created_at DESC);');
        } catch (e) {
            console.warn('⚠️ Migration warning (notifications):', e.message);
        }

        // Ensure messages.metadata exists
        try {
            await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;");
        } catch (e) {
            console.error('Migration warning (messages.metadata):', e.message);
        }

        // Ensure outbox retry columns exist
        try {
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;');
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP;');
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;');
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;');
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS claim_owner TEXT;');
        } catch (e) {
            console.warn('⚠️ Migration warning (messages outbox columns):', e.message);
        }

        try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS lead_reads (
                tenant_id VARCHAR(50) NOT NULL,
                lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (tenant_id, lead_id, user_id)
              );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_lead_reads_tenant_user ON lead_reads (tenant_id, user_id, updated_at DESC);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_lead_reads_tenant_lead_user ON lead_reads (tenant_id, lead_id, user_id);');
        } catch (e) {
            console.warn('⚠️ Migration warning (lead_reads):', e.message);
        }

        // Ensure message sender tracking exists (response-time analytics)
        try {
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL;');
            await client.query('CREATE INDEX IF NOT EXISTS idx_messages_tenant_lead_created_at ON messages (tenant_id, lead_id, created_at);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_messages_tenant_sender_created_at ON messages (tenant_id, sender_user_id, created_at);');
        } catch (e) {
            console.warn('⚠️ Migration warning (messages sender_user_id):', e.message);
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
            CREATE INDEX IF NOT EXISTS idx_messages_next_attempt_at ON messages(next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_messages_claimed_at ON messages(claimed_at);
            CREATE INDEX IF NOT EXISTS idx_meta_pages_tenant ON meta_pages(tenant_id);
            CREATE INDEX IF NOT EXISTS idx_meta_webhook_received_at ON meta_webhook_events(received_at DESC);
            CREATE INDEX IF NOT EXISTS idx_meta_webhook_processed_at ON meta_webhook_events(processed_at);
            CREATE INDEX IF NOT EXISTS idx_meta_webhook_next_attempt_at ON meta_webhook_events(next_attempt_at);
        `);

        try {
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_meta_webhook_unprocessed
                    ON meta_webhook_events(received_at ASC)
                    WHERE processed_at IS NULL;
                CREATE INDEX IF NOT EXISTS idx_meta_webhook_retry
                    ON meta_webhook_events(next_attempt_at ASC)
                    WHERE processed_at IS NULL AND next_attempt_at IS NOT NULL;
            `);
        } catch (e) {
            console.warn('⚠️ Migration warning (meta_webhook_events indexes):', e.message);
        }

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

        try {
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_pages_page_unique
                    ON meta_pages(page_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_pages_ig_unique
                    ON meta_pages(ig_business_id)
                    WHERE ig_business_id IS NOT NULL;
            `);
        } catch (e) {
            console.warn('⚠️ Constraint migration warning (meta_pages):', e.message);
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
    // Backward-compat note:
    // This project historically used `phone` as the unique lead key.
    // For WhatsApp it's a numeric phone. For Meta (FB/IG) we store external IDs
    // as a prefixed key like: "fb:PSID", "ig:USER_ID", or "meta:fb:...".
    if (!phone) throw new Error('Phone/contact key is required');

    const raw = String(phone).trim();
    if (!raw) throw new Error('Phone/contact key is required');

    const lower = raw.toLowerCase();
    if (lower.startsWith('fb:') || lower.startsWith('ig:') || lower.startsWith('meta:')) {
        if (raw.length < 4 || raw.length > 80) {
            throw new Error(`Invalid contact key length: ${raw.length}`);
        }
        return raw;
    }

    // WhatsApp numeric phone flow
    // Step 1: Strip Baileys device-ID suffix BEFORE removing non-digits
    const withoutSuffix = raw.split(':')[0];
    // Step 2: Remove all remaining non-digit characters (+/-/spaces)
    const cleaned = withoutSuffix.replace(/\D/g, '');
    if (!cleaned || cleaned.length < 7 || cleaned.length > 15) {
        throw new Error(`Invalid phone: ${phone} (normalized: ${cleaned})`);
    }
    return cleaned;
}

function isNumericPhoneKey(normalizedPhoneOrKey) {
    return typeof normalizedPhoneOrKey === 'string' && /^\d{7,15}$/.test(normalizedPhoneOrKey);
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
        // Status handling:
        // - If status is NOT provided: don't override existing lead status; new leads default to 'new'
        // - If status is explicitly null/empty: same as not provided
        // - If status is a non-empty string: validate + apply
        const hasStatusKey = Object.prototype.hasOwnProperty.call(data || {}, 'status');
        let statusForUpdate = null;
        let statusForInsert = 'new';
        if (hasStatusKey) {
            const rawStatus = data.status;
            if (rawStatus === null || rawStatus === undefined) {
                statusForUpdate = null;
                statusForInsert = 'new';
            } else if (typeof rawStatus === 'string' && rawStatus.trim() === '') {
                statusForUpdate = null;
                statusForInsert = 'new';
            } else {
                const v = validateStatus(rawStatus);
                statusForUpdate = v;
                statusForInsert = v;
            }
        }
        const value = validateValue(data.value);

        const {
            name,
            last_message,
            source_message,
            source_contact_name,
            whatsapp_id,
            source = 'whatsapp',
            product_name,
            extra_data,
            assignee_id
        } = data;

        // Default assignee: tenant's first admin (only if not provided)
        let finalAssigneeId = assignee_id || null;
        if (!finalAssigneeId) {
            try {
                const a = await client.query(
                    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' ORDER BY created_at ASC LIMIT 1",
                    [tenantId]
                );
                finalAssigneeId = a.rows[0]?.id || null;
            } catch {
                finalAssigneeId = null;
            }
        }

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
                    assignee_id = COALESCE(assignee_id, $10),
                    updated_at = NOW()
                WHERE id = $11 AND tenant_id = $12
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
                statusForUpdate,
                extraDataObj,
                finalAssigneeId,
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
          whatsapp_id, status, source, value, product_name, extra_data, tenant_id, assignee_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
          assignee_id = COALESCE(leads.assignee_id, EXCLUDED.assignee_id),
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
            statusForInsert,
            source,
            value,
            product_name || null,
            extraDataObj,
            tenantId,
            finalAssigneeId
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

        // Non-numeric keys (fb:/ig:) should not use fuzzy matching
        if (!isNumericPhoneKey(cleanedPhone)) {
            return null;
        }

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
async function updateLeadMessage(phone, message, whatsappId, name = null, tenantId = 'admin', direction = 'in') {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const cleanedPhone = validatePhone(phone);

        // Default assignee: tenant's first admin (only if currently unassigned)
        let defaultAssigneeId = null;
        try {
            const a = await client.query(
                "SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' ORDER BY created_at ASC LIMIT 1",
                [tenantId]
            );
            defaultAssigneeId = a.rows[0]?.id || null;
        } catch {
            defaultAssigneeId = null;
        }

        const query = `
        UPDATE leads
        SET last_message = $1,
            whatsapp_id = COALESCE($2, whatsapp_id),
            name = COALESCE($3, name),
            assignee_id = COALESCE(assignee_id, $6),
            unread_count = CASE WHEN $7 = 'in' THEN COALESCE(unread_count, 0) + 1 ELSE unread_count END,
            last_inbound_at = CASE WHEN $7 = 'in' THEN NOW() ELSE last_inbound_at END,
            last_outbound_at = CASE WHEN $7 = 'out' THEN NOW() ELSE last_outbound_at END,
            conversation_closed = CASE WHEN $7 = 'in' THEN false ELSE conversation_closed END,
            conversation_closed_at = CASE WHEN $7 = 'in' THEN NULL ELSE conversation_closed_at END,
            updated_at = NOW()
        WHERE phone = $4 AND tenant_id = $5
        RETURNING *;
      `;

        const result = await client.query(query, [
            message || null,
            whatsappId || null,
            name || null,
            cleanedPhone,
            tenantId,
            defaultAssigneeId,
            direction === 'out' ? 'out' : 'in'
        ]);
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

        if (updates.unread_count !== undefined) {
            const n = parseInt(String(updates.unread_count), 10);
            fields.push(`unread_count = $${paramCount++}`);
            values.push(Number.isFinite(n) && n >= 0 ? n : 0);
        }

        if (updates.last_read_at !== undefined) {
            fields.push(`last_read_at = $${paramCount++}`);
            values.push(updates.last_read_at || null);
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
            // Merge into existing JSON (preserve other keys)
            fields.push(`extra_data = COALESCE(extra_data, '{}'::jsonb) || $${paramCount++}::jsonb`);
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
async function getLeads(filters = {}, tenantId = 'admin', existingClient = null) {
    try {
        const runner = existingClient || pool;
        const viewerUserId = filters.userId ? String(filters.userId) : null;
        let query = `
          SELECT l.*,
                 ${viewerUserId ? 'COALESCE(msg_unread.unread_count, 0) AS unread_count,' : 'l.unread_count,'}
                 ${viewerUserId ? 'lr.last_read_at AS last_read_at,' : 'l.last_read_at,'}
                 fu.next_due_at AS next_followup_due_at,
                 CASE WHEN l.last_inbound_at IS NOT NULL THEN (EXTRACT(EPOCH FROM l.last_inbound_at) * 1000)::bigint ELSE NULL END AS last_inbound_ms,
                 CASE WHEN l.last_outbound_at IS NOT NULL THEN (EXTRACT(EPOCH FROM l.last_outbound_at) * 1000)::bigint ELSE NULL END AS last_outbound_ms,
                 CASE WHEN fu.next_due_at IS NOT NULL THEN (EXTRACT(EPOCH FROM fu.next_due_at) * 1000)::bigint ELSE NULL END AS next_followup_due_ms
          FROM leads l
          ${viewerUserId ? `LEFT JOIN lead_reads lr
            ON lr.tenant_id = l.tenant_id AND lr.lead_id = l.id AND lr.user_id = $2` : ''}
          ${viewerUserId ? `LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS unread_count
            FROM messages m
            WHERE m.tenant_id = l.tenant_id
              AND m.lead_id = l.id
              AND m.direction = 'in'
              AND (lr.last_read_at IS NULL OR m.created_at > lr.last_read_at)
          ) msg_unread ON true` : ''}
          LEFT JOIN LATERAL (
            SELECT MIN(due_at) AS next_due_at
            FROM follow_ups f
            WHERE f.tenant_id = l.tenant_id
              AND f.lead_id = l.id
              AND f.status = 'open'
          ) fu ON true
          WHERE l.tenant_id = $1
        `;
        const values = [tenantId];
        let paramCount = 2;

        if (viewerUserId) {
            values.push(viewerUserId);
            paramCount++;
        }

        if (filters.status) {
            const validStatus = validateStatus(filters.status);
            query += ` AND l.status = $${paramCount}`;
            values.push(validStatus);
            paramCount++;
        }

        if (filters.startDate) {
            query += ` AND l.created_at >= $${paramCount}::timestamptz`;
            values.push(filters.startDate);
            paramCount++;
        }

        if (filters.endDate) {
            // Inclusive end-of-day for YYYY-MM-DD filters from UI
            query += ` AND l.created_at < ($${paramCount}::date + INTERVAL '1 day')`;
            values.push(filters.endDate);
            paramCount++;
        }

        if (filters.search) {
            query += ` AND (l.name ILIKE $${paramCount} OR l.phone ILIKE $${paramCount} OR l.last_message ILIKE $${paramCount})`;
            values.push(`%${filters.search}%`);
            paramCount++;
        }

        if (filters.leadId) {
            query += ` AND l.id = $${paramCount}`;
            values.push(filters.leadId);
            paramCount++;
        }

        if (filters.assigneeId) {
            query += ` AND l.assignee_id = $${paramCount}`;
            values.push(filters.assigneeId);
            paramCount++;
        }

        query += ' ORDER BY l.created_at DESC';

        if (filters.limit) {
            query += ` LIMIT $${paramCount}`;
            values.push(filters.limit);
            paramCount++; // Add this depending on offset usage
        }

        if (filters.offset) {
            query += ` OFFSET $${paramCount}`;
            values.push(filters.offset);
        }

        const result = await runner.query(query, values);
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
async function appendMessage({ leadId, phone, body, direction, whatsappId, metadata, createdAt, tenantId = 'admin', senderUserId = null }) {
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
        let meta = metadata;
        if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch { meta = {}; }
        }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};

        await pool.query(`
            INSERT INTO messages (lead_id, phone, body, direction, whatsapp_id, metadata, created_at, tenant_id, sender_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [leadId, phone, body || '', direction, whatsappId || null, meta, ts, tenantId, senderUserId || null]);
    } catch (error) {
        // Non-fatal - log and continue
        console.warn('⚠️ appendMessage error:', error.message);
    }
}

async function messageExists(whatsappId, tenantId = 'admin') {
    try {
        if (!whatsappId) return false;
        const res = await pool.query(
            'SELECT 1 FROM messages WHERE whatsapp_id = $1 AND tenant_id = $2 LIMIT 1',
            [String(whatsappId), tenantId]
        );
        return res.rowCount > 0;
    } catch {
        return false;
    }
}

async function insertMetaWebhookEvent({ objectType, payload, signature, signatureOk }) {
    const res = await pool.query(
        `INSERT INTO meta_webhook_events (object_type, payload, signature, signature_ok, received_at)
         VALUES ($1, $2::jsonb, $3, $4, NOW())
         RETURNING id, received_at`,
        [objectType ? String(objectType) : null, payload || {}, signature ? String(signature) : null, signatureOk !== false]
    );
    return res.rows[0] || null;
}

async function claimMetaWebhookEvents(limit = 10, lockOwner = 'worker') {
    const n = Number(limit);
    const safeLimit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10;
    const owner = String(lockOwner || 'worker').slice(0, 120);

    const res = await pool.query(
        `UPDATE meta_webhook_events
         SET locked_at = NOW(), lock_owner = $2
         WHERE id IN (
            SELECT id
            FROM meta_webhook_events
            WHERE processed_at IS NULL
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            ORDER BY received_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         RETURNING id, object_type, payload, received_at, attempts`,
        [safeLimit, owner]
    );
    return res.rows || [];
}

async function completeMetaWebhookEvent(id) {
    if (!id) return false;
    const res = await pool.query(
        `UPDATE meta_webhook_events
         SET processed_at = NOW(), last_error = NULL, locked_at = NULL, lock_owner = NULL
         WHERE id = $1`,
        [String(id)]
    );
    return res.rowCount > 0;
}

async function failMetaWebhookEvent(id, errorMessage, backoffSeconds = 10) {
    if (!id) return false;
    const secs = Number(backoffSeconds);
    const safeSecs = Number.isFinite(secs) && secs > 0 ? Math.min(secs, 3600) : 10;
    const msg = String(errorMessage || 'processing_error').slice(0, 1200);
    const res = await pool.query(
        `UPDATE meta_webhook_events
         SET attempts = attempts + 1,
             last_error = $2,
             next_attempt_at = NOW() + ($3::int * INTERVAL '1 second'),
             locked_at = NULL,
             lock_owner = NULL
         WHERE id = $1`,
        [String(id), msg, safeSecs]
    );
    return res.rowCount > 0;
}

async function upsertMetaUserToken(tenantId, { user_access_token, expires_at, debug_info, status, last_error }) {
    if (!tenantId) throw new Error('tenantId is required');
    if (!user_access_token) throw new Error('user_access_token is required');
    const dbg = (debug_info && typeof debug_info === 'object') ? debug_info : {};
    const res = await pool.query(
        `INSERT INTO meta_user_tokens (tenant_id, user_access_token, expires_at, debug_info, status, last_error, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           user_access_token = EXCLUDED.user_access_token,
           expires_at = EXCLUDED.expires_at,
           debug_info = EXCLUDED.debug_info,
           status = EXCLUDED.status,
           last_error = EXCLUDED.last_error,
           updated_at = NOW()
         RETURNING tenant_id, expires_at, status, updated_at`,
        [
            String(tenantId),
            String(user_access_token),
            expires_at ? new Date(expires_at) : null,
            dbg,
            status ? String(status) : 'active',
            last_error ? String(last_error) : null
        ]
    );
    return res.rows[0] || null;
}

async function upsertFacebookAdImport(tenantId, { access_token, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache, last_error }) {
    if (!tenantId) throw new Error('tenantId is required');
    const safeSelected = Array.isArray(selected_account_ids) ? selected_account_ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const safeCampaigns = Array.isArray(selected_campaign_ids) ? selected_campaign_ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const safeCache = Array.isArray(account_cache) ? account_cache : [];
    const safeCampaignCache = Array.isArray(campaign_cache) ? campaign_cache : [];
    const token = access_token ? String(access_token).trim() : null;
    const tokenHint = token ? `${token.slice(0, 6)}...${token.slice(-4)}` : null;

    const res = await pool.query(
        `INSERT INTO facebook_ad_imports (
           tenant_id, access_token, token_hint, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache, last_sync_at, last_error, updated_at
         )
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, NOW(), $8, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           access_token = COALESCE(EXCLUDED.access_token, facebook_ad_imports.access_token),
           token_hint = COALESCE(EXCLUDED.token_hint, facebook_ad_imports.token_hint),
           selected_account_ids = EXCLUDED.selected_account_ids,
           selected_campaign_ids = EXCLUDED.selected_campaign_ids,
           account_cache = EXCLUDED.account_cache,
           campaign_cache = EXCLUDED.campaign_cache,
           last_sync_at = NOW(),
           last_error = EXCLUDED.last_error,
           updated_at = NOW()
         RETURNING tenant_id, token_hint, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache, last_sync_at, last_error, updated_at`,
        [
            String(tenantId),
            token,
            tokenHint,
            JSON.stringify(safeSelected),
            JSON.stringify(safeCampaigns),
            JSON.stringify(safeCache),
            JSON.stringify(safeCampaignCache),
            last_error ? String(last_error) : null,
        ]
    );
    return res.rows[0] || null;
}

async function getFacebookAdImport(tenantId) {
    if (!tenantId) throw new Error('tenantId is required');
    const res = await pool.query(
        `SELECT tenant_id, access_token, token_hint, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache, last_sync_at, last_error, updated_at
         FROM facebook_ad_imports
         WHERE tenant_id = $1
         LIMIT 1`,
        [String(tenantId)]
    );
    return res.rows[0] || null;
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

async function ensureTenantRecord(tenantId, opts = {}) {
    const cleanTenantId = String(tenantId || '').trim();
    if (!cleanTenantId || cleanTenantId === 'admin') return null;

    const displayName = opts.displayName ? String(opts.displayName).trim() : null;
    const status = opts.status === 'archived' ? 'archived' : 'active';
    const importSource = opts.importSource ? String(opts.importSource).trim() : null;
    const importMeta = (opts.importMeta && typeof opts.importMeta === 'object') ? opts.importMeta : {};

    const result = await pool.query(
        `INSERT INTO tenants (tenant_id, display_name, status, import_source, import_meta, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (tenant_id) DO UPDATE
           SET display_name = COALESCE(tenants.display_name, EXCLUDED.display_name),
               status = CASE WHEN tenants.status = 'archived' AND EXCLUDED.status = 'active' THEN 'active' ELSE tenants.status END,
               import_source = COALESCE(tenants.import_source, EXCLUDED.import_source),
               import_meta = COALESCE(tenants.import_meta, '{}'::jsonb) || EXCLUDED.import_meta,
               updated_at = NOW()
         RETURNING tenant_id, display_name, status, import_source, import_meta, archived_at, created_at, updated_at`,
        [cleanTenantId, displayName, status, importSource, importMeta]
    );
    return result.rows[0] || null;
}

async function getTenantRecord(tenantId) {
    const cleanTenantId = String(tenantId || '').trim();
    if (!cleanTenantId || cleanTenantId === 'admin') return null;
    const result = await pool.query(
        `SELECT tenant_id, display_name, status, import_source, import_meta, archived_at, archived_by, created_at, updated_at
         FROM tenants
         WHERE tenant_id = $1
         LIMIT 1`,
        [cleanTenantId]
    );
    return result.rows[0] || null;
}

// ═══════════════════════════════════════════════════════════════
// USER OPERATIONS (Phase 2)
// ═══════════════════════════════════════════════════════════════

/**
 * Creates a new user
 */
async function createUser(username, passwordHash, role, permissions, tenantId, displayName = null) {
    try {
        await ensureTenantRecord(tenantId, { displayName });
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
async function getSuperAdminTenants(options = {}) {
    try {
        const includeArchived = options.includeArchived === true;
        const search = String(options.search || '').trim();
        const where = ["t.tenant_id <> 'admin'"];
        const values = [];

        if (!includeArchived) {
            where.push("COALESCE(t.status, 'active') = 'active'");
        }
        if (search) {
            values.push(`%${search.toLowerCase()}%`);
            where.push(`(
                LOWER(t.tenant_id) LIKE $${values.length}
                OR LOWER(COALESCE(t.display_name, '')) LIKE $${values.length}
                OR LOWER(COALESCE(admins.admin_username, '')) LIKE $${values.length}
            )`);
        }

        const query = `
            SELECT 
                t.tenant_id,
                COALESCE(t.display_name, admins.admin_display_name, t.tenant_id) AS display_name,
                t.status,
                t.archived_at,
                COALESCE(t.created_at, admins.first_created_at) as created_at,
                COALESCE((SELECT COUNT(*) FROM users WHERE tenant_id = t.tenant_id), 0) as user_count,
                COALESCE((SELECT COUNT(*) FROM leads WHERE tenant_id = t.tenant_id), 0) as lead_count,
                admins.admin_username,
                admins.admin_display_name,
                t.import_source
            FROM tenants t
            LEFT JOIN LATERAL (
                SELECT username AS admin_username,
                       display_name AS admin_display_name,
                       created_at AS first_created_at
                FROM users
                WHERE tenant_id = t.tenant_id AND role = 'admin'
                ORDER BY created_at ASC
                LIMIT 1
            ) admins ON true
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(t.status, 'active') ASC, COALESCE(t.created_at, admins.first_created_at) DESC
        `;
        const result = await pool.query(query, values);
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
            `SELECT u.id, u.username, u.password_hash, u.role, u.permissions, u.tenant_id, u.display_name,
                    COALESCE(t.status, 'active') AS tenant_status,
                    t.archived_at AS tenant_archived_at,
                    t.display_name AS tenant_display_name
             FROM users u
             LEFT JOIN tenants t ON t.tenant_id = u.tenant_id
             WHERE u.username = $1`,
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
            `SELECT u.id, u.username, u.role, u.permissions, u.tenant_id, u.display_name,
                    COALESCE(t.status, 'active') AS tenant_status
             FROM users u
             LEFT JOIN tenants t ON t.tenant_id = u.tenant_id
             WHERE u.tenant_id = $1 AND u.role = 'admin'
             ORDER BY u.created_at ASC
             LIMIT 1`,
            [tenantId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ getTenantAdmin error:', error.message);
        throw error;
    }
}

async function archiveTenant(tenantId, archivedBy = null) {
    if (!tenantId || tenantId === 'admin') throw new Error('Cannot archive superadmin tenant');
    await ensureTenantRecord(tenantId, {});
    const result = await pool.query(
        `UPDATE tenants
         SET status = 'archived', archived_at = NOW(), archived_by = $2, updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING tenant_id, status, archived_at`,
        [tenantId, archivedBy || null]
    );
    return result.rows[0] || null;
}

async function restoreTenant(tenantId) {
    if (!tenantId || tenantId === 'admin') throw new Error('Cannot restore superadmin tenant');
    await ensureTenantRecord(tenantId, {});
    const result = await pool.query(
        `UPDATE tenants
         SET status = 'active', archived_at = NULL, archived_by = NULL, updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING tenant_id, status, archived_at`,
        [tenantId]
    );
    return result.rows[0] || null;
}

async function deleteTenant(tenantId, archivedBy = null) {
    return archiveTenant(tenantId, archivedBy);
}

async function bulkImportTenants(rows = []) {
    const out = { created: [], skipped: [], errors: [] };
    for (const row of rows) {
        const tenantId = String(row?.tenantId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const adminUsername = String(row?.adminUsername || '').trim().toLowerCase();
        const adminPasswordHash = row?.adminPasswordHash || null;
        const passwordHash = adminPasswordHash || row?.passwordHash || null;
        const displayName = String(row?.displayName || '').trim() || null;
        const role = String(row?.role || 'admin').trim() || 'admin';

        if (!tenantId || !adminUsername || !passwordHash) {
            out.skipped.push({ tenantId, adminUsername, reason: 'missing_required_fields' });
            continue;
        }

        try {
            await ensureTenantRecord(tenantId, { displayName, importSource: 'superadmin_import', importMeta: { imported: true } });
            const created = await pool.query(
                `INSERT INTO users (username, password_hash, role, permissions, tenant_id, display_name)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, username, tenant_id, display_name`,
                [adminUsername, passwordHash, role, {}, tenantId, displayName]
            );
            out.created.push(created.rows[0]);
        } catch (error) {
            if (error.code === '23505') out.skipped.push({ tenantId, adminUsername, reason: 'username_exists' });
            else out.errors.push({ tenantId, adminUsername, error: error.message });
        }
    }
    return out;
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
// TELEGRAM INTEGRATION (per-tenant)
// ═══════════════════════════════════════════════════════════════

async function getTelegramIntegration(tenantId) {
    if (!tenantId) return null;
    const res = await pool.query(
        'SELECT tenant_id, enabled, chat_id, bot_token, last_error, last_sent_at, last_test_at, updated_at FROM telegram_integrations WHERE tenant_id = $1 LIMIT 1',
        [String(tenantId)]
    );
    return res.rows[0] || null;
}

async function upsertTelegramIntegration(tenantId, { enabled, chat_id, bot_token }) {
    if (!tenantId) throw new Error('tenantId is required');
    const en = enabled === false ? false : true;
    const chat = chat_id !== undefined && chat_id !== null ? String(chat_id).trim() : null;
    const tok = bot_token !== undefined && bot_token !== null ? String(bot_token).trim() : null;

    const res = await pool.query(
        `INSERT INTO telegram_integrations (tenant_id, enabled, chat_id, bot_token, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           enabled = EXCLUDED.enabled,
           chat_id = EXCLUDED.chat_id,
           bot_token = EXCLUDED.bot_token,
           updated_at = NOW()
         RETURNING tenant_id, enabled, chat_id, bot_token, last_error, last_sent_at, last_test_at, updated_at`,
        [String(tenantId), en, chat, tok]
    );
    return res.rows[0] || null;
}

async function setTelegramIntegrationStatus(tenantId, { last_error, last_sent_at, last_test_at }) {
    if (!tenantId) return false;
    const fields = [];
    const values = [];
    let i = 1;

    if (last_error !== undefined) {
        fields.push(`last_error = $${i++}`);
        values.push(last_error ? String(last_error).slice(0, 1200) : null);
    }
    if (last_sent_at !== undefined) {
        fields.push(`last_sent_at = $${i++}`);
        values.push(last_sent_at ? new Date(last_sent_at) : null);
    }
    if (last_test_at !== undefined) {
        fields.push(`last_test_at = $${i++}`);
        values.push(last_test_at ? new Date(last_test_at) : null);
    }
    if (fields.length === 0) return false;

    fields.push('updated_at = NOW()');
    values.push(String(tenantId));

    const res = await pool.query(
        `UPDATE telegram_integrations SET ${fields.join(', ')} WHERE tenant_id = $${i}`,
        values
    );
    return res.rowCount > 0;
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

async function markLeadRead(leadId, tenantId = 'admin', userId = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let result = null;
        if (userId) {
            await client.query(
                `INSERT INTO lead_reads (tenant_id, lead_id, user_id, last_read_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW())
                 ON CONFLICT (tenant_id, lead_id, user_id)
                 DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`,
                [tenantId, leadId, userId]
            );
            result = await getLeadById(leadId, tenantId, userId, client);
        } else {
            const legacyResult = await client.query(
                `UPDATE leads
                 SET unread_count = 0, last_read_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING *`,
                [leadId, tenantId]
            );
            result = legacyResult.rows[0] || null;
        }
        await client.query('COMMIT');
        return result || null;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ markLeadRead error:', e.message);
        throw e;
    } finally {
        client.release();
    }
}

async function getLeadById(leadId, tenantId = 'admin', userId = null, existingClient = null) {
    const client = existingClient || await pool.connect();
    try {
        const rows = await getLeads({ leadId, userId, limit: 1 }, tenantId, client);
        return rows[0] || null;
    } finally {
        if (!existingClient) client.release();
    }
}

// ═══════════════════════════════════════════════════════════════
// META (FACEBOOK/INSTAGRAM) INTEGRATIONS
// ═══════════════════════════════════════════════════════════════

async function upsertMetaPage(tenantId, { page_id, page_name, page_access_token, ig_business_id }) {
    if (!tenantId) throw new Error('tenantId is required');
    if (!page_id) throw new Error('page_id is required');
    if (!page_access_token) throw new Error('page_access_token is required');

    const res = await pool.query(
        `INSERT INTO meta_pages (tenant_id, page_id, page_name, page_access_token, ig_business_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (tenant_id, page_id)
         DO UPDATE SET
           page_name = EXCLUDED.page_name,
           page_access_token = EXCLUDED.page_access_token,
           ig_business_id = EXCLUDED.ig_business_id,
           updated_at = NOW()
         RETURNING tenant_id, page_id, page_name, ig_business_id, connected_at, updated_at`,
        [tenantId, String(page_id), page_name || null, String(page_access_token), ig_business_id ? String(ig_business_id) : null]
    );
    return res.rows[0] || null;
}

async function getMetaPages(tenantId) {
    if (!tenantId) throw new Error('tenantId is required');
    const res = await pool.query(
        'SELECT tenant_id, page_id, page_name, ig_business_id, status, token_expires_at, last_checked_at, last_error, connected_at, updated_at FROM meta_pages WHERE tenant_id = $1 ORDER BY updated_at DESC',
        [tenantId]
    );
    return res.rows || [];
}

async function getMetaPageByPageId(pageId) {
    if (!pageId) return null;
    const res = await pool.query(
        'SELECT tenant_id, page_id, page_name, page_access_token, ig_business_id FROM meta_pages WHERE page_id = $1 LIMIT 1',
        [String(pageId)]
    );
    return res.rows[0] || null;
}

async function getMetaPageByIgBusinessId(igBusinessId) {
    if (!igBusinessId) return null;
    const res = await pool.query(
        'SELECT tenant_id, page_id, page_name, page_access_token, ig_business_id FROM meta_pages WHERE ig_business_id = $1 LIMIT 1',
        [String(igBusinessId)]
    );
    return res.rows[0] || null;
}

async function deleteMetaPage(tenantId, pageId) {
    if (!tenantId) throw new Error('tenantId is required');
    if (!pageId) throw new Error('pageId is required');
    const res = await pool.query(
        'DELETE FROM meta_pages WHERE tenant_id = $1 AND page_id = $2 RETURNING page_id',
        [tenantId, String(pageId)]
    );
    return res.rowCount > 0;
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
    messageExists,
    getRecentLeadsWithLatestMessage,
    deleteLead,
    deleteAllLeads,
    getLeadStats,
    getLeadById,
    getLeadsByStatus,
    healthCheck,
    createUser,
    getUsers,
    updateUserRole,
    updateUserPermissions,
    deleteUser,
    ensureTenantRecord,
    getTenantRecord,
    getSuperAdminTenants,
    findUserByUsername,
    updateUserPasswordHash,
    getTenantAdmin,
    archiveTenant,
    restoreTenant,
    bulkImportTenants,
    deleteTenant,
    logAuditAction,
    getAuditLogs,
    getCRMSettings,
    updateCRMSettings,
    getTelegramIntegration,
    upsertTelegramIntegration,
    setTelegramIntegrationStatus,
    getAnalyticsLayout,
    upsertAnalyticsLayout,
    markLeadRead,
    upsertMetaPage,
    getMetaPages,
    getMetaPageByPageId,
    getMetaPageByIgBusinessId,
    deleteMetaPage,
    insertMetaWebhookEvent,
    claimMetaWebhookEvents,
    completeMetaWebhookEvent,
    failMetaWebhookEvent,
    upsertMetaUserToken,
    upsertFacebookAdImport,
    getFacebookAdImport,
    closePool
};
