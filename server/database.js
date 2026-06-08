const { Pool } = require('pg');
const { encrypt: encryptToken, decrypt: decryptToken } = require('./utils/cryptoUtils');

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

function parseTzOffsetMinutes(value) {
    const n = parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : null;
}

function toUtcBoundaryFromLocalDate(dateStr, tzOffsetMinutes, endExclusive = false) {
    const match = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const extraDays = endExclusive ? 1 : 0;
    return new Date(Date.UTC(year, month, day + extraDays, 0, 0, 0, 0) + (tzOffsetMinutes || 0) * 60000);
}

// Database Configuration
// Local Postgres (localhost) has no SSL; managed/remote (Supabase etc.) needs it.
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(String(normalizedDatabaseUrl || ''));
const pool = new Pool({
    connectionString: normalizedDatabaseUrl,
    ssl: isLocalDb ? false : { rejectUnauthorized: false }, // SSL off for localhost, on for remote (Supabase)
    max: isLocalDb ? 24 : 8, // dedicated local Postgres (Vultr VDS) → higher concurrency; remote (Supabase) → conservative
    min: 2, // keep warm connections ready for low-latency first query
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
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

        CREATE TABLE IF NOT EXISTS whatsapp_media_assets (
          tenant_id VARCHAR(50) NOT NULL,
          file_key VARCHAR(255) NOT NULL,
          kind VARCHAR(30),
          mime_type VARCHAR(120),
          original_file_name VARCHAR(255),
          bytes INTEGER DEFAULT 0,
          data BYTEA NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (tenant_id, file_key)
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

        CREATE TABLE IF NOT EXISTS meta_app_config (
          tenant_id VARCHAR(50) PRIMARY KEY,
          app_id VARCHAR(64),
          app_secret TEXT,
          verify_token VARCHAR(255),
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
          auto_sync_enabled BOOLEAN DEFAULT false,
          auto_sync_start_date DATE,
          auto_sync_end_date DATE,
          auto_sync_every_hours INTEGER DEFAULT 1,
          auto_sync_minute INTEGER DEFAULT 0,
          auto_sync_tz_offset_minutes INTEGER DEFAULT 0,
          auto_sync_next_at TIMESTAMP,
          last_insight_sync_at TIMESTAMP,
          last_insight_sync_error TEXT,
          sync_locked_at TIMESTAMP,
          sync_lock_owner TEXT,
          last_sync_at TIMESTAMP,
          last_error TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS facebook_ad_insight_cache (
          tenant_id VARCHAR(50) NOT NULL,
          campaign_id VARCHAR(64) NOT NULL,
          metric VARCHAR(20) NOT NULL,
          date_start DATE NOT NULL,
          date_stop DATE,
          campaign_name TEXT,
          account_id VARCHAR(64),
          account_name TEXT,
          spend NUMERIC DEFAULT 0,
          impressions NUMERIC DEFAULT 0,
          clicks NUMERIC DEFAULT 0,
          ctr NUMERIC DEFAULT 0,
          cpm NUMERIC DEFAULT 0,
          results NUMERIC DEFAULT 0,
          result_type TEXT,
          cost_per_result NUMERIC DEFAULT 0,
          updated_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (tenant_id, campaign_id, metric, date_start)
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

                CREATE TABLE IF NOT EXISTS meta_app_config (
                  tenant_id VARCHAR(50) PRIMARY KEY,
                  app_id VARCHAR(64),
                  app_secret TEXT,
                  verify_token VARCHAR(255),
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
                  auto_sync_enabled BOOLEAN DEFAULT false,
                  auto_sync_start_date DATE,
                  auto_sync_end_date DATE,
                  auto_sync_every_hours INTEGER DEFAULT 1,
                  auto_sync_minute INTEGER DEFAULT 0,
                  auto_sync_tz_offset_minutes INTEGER DEFAULT 0,
                  auto_sync_next_at TIMESTAMP,
                  last_insight_sync_at TIMESTAMP,
                  last_insight_sync_error TEXT,
                  sync_locked_at TIMESTAMP,
                  sync_lock_owner TEXT,
                  last_sync_at TIMESTAMP,
                  last_error TEXT,
                  created_at TIMESTAMP DEFAULT NOW(),
                  updated_at TIMESTAMP DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS facebook_ad_insight_cache (
                  tenant_id VARCHAR(50) NOT NULL,
                  campaign_id VARCHAR(64) NOT NULL,
                  metric VARCHAR(20) NOT NULL,
                  date_start DATE NOT NULL,
                  date_stop DATE,
                  campaign_name TEXT,
                  account_id VARCHAR(64),
                  account_name TEXT,
                  spend NUMERIC DEFAULT 0,
                  impressions NUMERIC DEFAULT 0,
                  clicks NUMERIC DEFAULT 0,
                  ctr NUMERIC DEFAULT 0,
                  cpm NUMERIC DEFAULT 0,
                  results NUMERIC DEFAULT 0,
                  result_type TEXT,
                  cost_per_result NUMERIC DEFAULT 0,
                  updated_at TIMESTAMP DEFAULT NOW(),
                  PRIMARY KEY (tenant_id, campaign_id, metric, date_start)
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
            await client.query("ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN DEFAULT false;");
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_start_date DATE;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_end_date DATE;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_every_hours INTEGER DEFAULT 1;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_minute INTEGER DEFAULT 0;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_tz_offset_minutes INTEGER DEFAULT 0;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS auto_sync_next_at TIMESTAMP;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS last_insight_sync_at TIMESTAMP;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS last_insight_sync_error TEXT;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS sync_locked_at TIMESTAMP;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS sync_lock_owner TEXT;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS last_error TEXT;');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();');
            await client.query('ALTER TABLE facebook_ad_imports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();');
            await client.query(`
              CREATE TABLE IF NOT EXISTS facebook_ad_insight_cache (
                tenant_id VARCHAR(50) NOT NULL,
                campaign_id VARCHAR(64) NOT NULL,
                metric VARCHAR(20) NOT NULL,
                date_start DATE NOT NULL,
                date_stop DATE,
                campaign_name TEXT,
                account_id VARCHAR(64),
                account_name TEXT,
                spend NUMERIC DEFAULT 0,
                impressions NUMERIC DEFAULT 0,
                clicks NUMERIC DEFAULT 0,
                ctr NUMERIC DEFAULT 0,
                cpm NUMERIC DEFAULT 0,
                results NUMERIC DEFAULT 0,
                result_type TEXT,
                cost_per_result NUMERIC DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (tenant_id, campaign_id, metric, date_start)
              );
            `);
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

        try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS whatsapp_media_assets (
                tenant_id VARCHAR(50) NOT NULL,
                file_key VARCHAR(255) NOT NULL,
                kind VARCHAR(30),
                mime_type VARCHAR(120),
                original_file_name VARCHAR(255),
                bytes INTEGER DEFAULT 0,
                data BYTEA NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (tenant_id, file_key)
              );
            `);
        } catch (e) {
            console.warn('⚠️ Migration warning (whatsapp_media_assets):', e.message);
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
            await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_created_at ON leads (tenant_id, created_at DESC);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_status_created_at ON leads (tenant_id, status, created_at DESC);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_leads_tenant_assignee_created_at ON leads (tenant_id, assignee_id, created_at DESC);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_messages_tenant_lead_direction_created ON messages (tenant_id, lead_id, direction, created_at DESC);');
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
            CREATE INDEX IF NOT EXISTS idx_leads_tenant_created_at ON leads(tenant_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_leads_tenant_status_created_at ON leads(tenant_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_leads_tenant_assignee_created_at ON leads(tenant_id, assignee_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_whatsapp_id ON leads(whatsapp_id);
            CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
            CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at ASC);
            CREATE INDEX IF NOT EXISTS idx_messages_polling ON messages(direction, status);
            CREATE INDEX IF NOT EXISTS idx_messages_next_attempt_at ON messages(next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_messages_claimed_at ON messages(claimed_at);
            CREATE INDEX IF NOT EXISTS idx_messages_tenant_lead_direction_created ON messages(tenant_id, lead_id, direction, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_whatsapp_media_assets_created_at ON whatsapp_media_assets(tenant_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_fb_ad_imports_auto_sync_due ON facebook_ad_imports (auto_sync_enabled, auto_sync_next_at);
            CREATE INDEX IF NOT EXISTS idx_fb_ad_insight_cache_lookup ON facebook_ad_insight_cache (tenant_id, metric, date_start, campaign_id);
            CREATE TABLE IF NOT EXISTS facebook_ad_insight_cache_ad (
              tenant_id VARCHAR(50) NOT NULL,
              ad_id VARCHAR(64) NOT NULL,
              metric VARCHAR(20) NOT NULL,
              date_start DATE NOT NULL,
              date_stop DATE,
              campaign_id VARCHAR(64),
              campaign_name TEXT,
              adset_id VARCHAR(64),
              adset_name TEXT,
              ad_name TEXT,
              account_id VARCHAR(64),
              account_name TEXT,
              spend NUMERIC DEFAULT 0,
              impressions NUMERIC DEFAULT 0,
              clicks NUMERIC DEFAULT 0,
              ctr NUMERIC DEFAULT 0,
              cpm NUMERIC DEFAULT 0,
              results NUMERIC DEFAULT 0,
              result_type TEXT,
              cost_per_result NUMERIC DEFAULT 0,
              updated_at TIMESTAMP DEFAULT NOW(),
              PRIMARY KEY (tenant_id, ad_id, metric, date_start)
            );
            CREATE INDEX IF NOT EXISTS idx_fb_ad_insight_cache_ad_lookup ON facebook_ad_insight_cache_ad (tenant_id, metric, date_start, campaign_id);
            CREATE INDEX IF NOT EXISTS idx_leads_ad_source ON leads (tenant_id, (extra_data->>'ad_source_id')) WHERE (extra_data->>'ad_source_id') IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_meta_pages_tenant ON meta_pages(tenant_id);
            CREATE INDEX IF NOT EXISTS idx_meta_webhook_received_at ON meta_webhook_events(received_at DESC);
            CREATE INDEX IF NOT EXISTS idx_meta_webhook_processed_at ON meta_webhook_events(processed_at);
            CREATE INDEX IF NOT EXISTS idx_meta_webhook_next_attempt_at ON meta_webhook_events(next_attempt_at);
            -- Max-speed tenant-scoped indexes (also applied live via perf_indexes.sql)
            CREATE INDEX IF NOT EXISTS idx_followups_open_lead ON follow_ups (tenant_id, lead_id, due_at) WHERE status = 'open';
            CREATE INDEX IF NOT EXISTS idx_followups_due_scan ON follow_ups (due_at) WHERE status = 'open' AND notified_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_followups_overdue_scan ON follow_ups (due_at) WHERE status = 'open' AND overdue_notified_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_leads_sla_unanswered ON leads (last_inbound_at) WHERE conversation_closed = false AND last_inbound_at IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_messages_tenant_phone_created ON messages (tenant_id, phone, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_tenant_created ON messages (tenant_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_entity ON audit_logs (tenant_id, entity_type, entity_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action_created ON audit_logs (tenant_id, action, created_at DESC);
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

        // NOTE: The multi-WhatsApp migration runs OUTSIDE this main transaction
        // (via migrateMultiWhatsAppAccounts() called from initDb after COMMIT).
        // Putting it here would be unsafe: if any prior statement in this transaction
        // aborts (e.g. duplicate-row index creation), Postgres marks the entire
        // transaction as failed and silently skips every subsequent migration step.

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

    // Multi-WhatsApp migration runs OUTSIDE the main transaction so a single
    // failed step (or an unrelated earlier failure that aborted the main
    // transaction) cannot poison the rest of the migration. Each step runs
    // in its own implicit transaction via pool.query() — failures are logged
    // but never abort the next step.
    try {
        await migrateMultiWhatsAppAccounts();
    } catch (e) {
        console.error('❌ Multi-WhatsApp migration failed:', e && e.message ? e.message : e);
        // Don't rethrow — server should still start even if this migration fails
    }
}

// ═══════════════════════════════════════════════════════════════
// MULTI-WHATSAPP STANDALONE MIGRATION
// ═══════════════════════════════════════════════════════════════
// Each step is independent: if one fails, the next still runs. This is
// critical because Postgres aborts the entire transaction on the first
// error, and a single migration block sharing a transaction with the rest
// of initDb means an unrelated failure could silently skip these steps.
async function migrateMultiWhatsAppAccounts() {
    const steps = [
        {
            name: 'tenants.max_whatsapp_accounts column',
            sql: "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_whatsapp_accounts INTEGER NOT NULL DEFAULT 1;"
        },
        {
            name: 'whatsapp_accounts table',
            sql: `
                CREATE TABLE IF NOT EXISTS whatsapp_accounts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    tenant_id VARCHAR(50) NOT NULL,
                    label VARCHAR(120) NOT NULL,
                    phone_number VARCHAR(40),
                    phone_number_normalized VARCHAR(32),
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    is_default BOOLEAN NOT NULL DEFAULT false,
                    last_qr_at TIMESTAMP,
                    last_connected_at TIMESTAMP,
                    last_disconnected_at TIMESTAMP,
                    last_error TEXT,
                    deleted_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `
        },
        {
            name: 'idx_wa_accounts_tenant',
            sql: "CREATE INDEX IF NOT EXISTS idx_wa_accounts_tenant ON whatsapp_accounts(tenant_id) WHERE deleted_at IS NULL;"
        },
        {
            name: 'idx_wa_accounts_default',
            sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_accounts_default ON whatsapp_accounts(tenant_id) WHERE is_default = true AND deleted_at IS NULL;"
        },
        {
            name: 'idx_wa_accounts_phone_active',
            sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_accounts_phone_active ON whatsapp_accounts(tenant_id, phone_number_normalized) WHERE deleted_at IS NULL AND phone_number_normalized IS NOT NULL;"
        },
        {
            name: 'baileys_auth_multi table baseline',
            sql: "CREATE TABLE IF NOT EXISTS baileys_auth_multi (tenant_id VARCHAR(255) NOT NULL, id VARCHAR(255) NOT NULL, data JSONB NOT NULL);"
        },
        {
            name: 'baileys_auth_multi.account_id column',
            sql: "ALTER TABLE baileys_auth_multi ADD COLUMN IF NOT EXISTS account_id UUID;"
        },
        {
            name: 'idx_baileys_auth_multi_tenant_account',
            sql: "CREATE INDEX IF NOT EXISTS idx_baileys_auth_multi_tenant_account ON baileys_auth_multi(tenant_id, account_id);"
        },
        {
            name: 'leads.whatsapp_account_id column',
            sql: "ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_account_id UUID;"
        },
        {
            name: 'idx_leads_tenant_account',
            sql: "CREATE INDEX IF NOT EXISTS idx_leads_tenant_account ON leads(tenant_id, whatsapp_account_id);"
        },
        {
            name: 'messages.whatsapp_account_id column',
            sql: "ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_account_id UUID;"
        },
        {
            name: 'idx_messages_tenant_account_created',
            sql: "CREATE INDEX IF NOT EXISTS idx_messages_tenant_account_created ON messages(tenant_id, whatsapp_account_id, created_at DESC);"
        },
        {
            name: 'auto-create default whatsapp_accounts row for legacy tenants',
            sql: `
                INSERT INTO whatsapp_accounts (id, tenant_id, label, status, is_default, last_connected_at)
                SELECT gen_random_uuid(), src.tenant_id, 'Əsas WhatsApp', 'connected', true, NOW()
                FROM (
                    SELECT DISTINCT tenant_id FROM baileys_auth_multi
                    UNION
                    SELECT DISTINCT tenant_id FROM leads WHERE source = 'whatsapp'
                    UNION
                    SELECT DISTINCT tenant_id FROM tenants WHERE COALESCE(status, 'active') = 'active' AND tenant_id <> 'admin'
                ) src
                WHERE src.tenant_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM whatsapp_accounts wa
                    WHERE wa.tenant_id = src.tenant_id AND wa.deleted_at IS NULL
                  );
            `
        },
        {
            name: 'backfill baileys_auth_multi.account_id',
            sql: `
                UPDATE baileys_auth_multi b
                SET account_id = wa.id
                FROM whatsapp_accounts wa
                WHERE wa.tenant_id = b.tenant_id
                  AND wa.is_default = true
                  AND wa.deleted_at IS NULL
                  AND b.account_id IS NULL;
            `
        },
        {
            name: 'drop legacy baileys_auth_multi PK',
            sql: `
                DO $$
                DECLARE pk_name text;
                BEGIN
                    SELECT conname INTO pk_name
                    FROM pg_constraint
                    WHERE conrelid = 'baileys_auth_multi'::regclass AND contype = 'p'
                    LIMIT 1;
                    IF pk_name IS NOT NULL THEN
                        EXECUTE 'ALTER TABLE baileys_auth_multi DROP CONSTRAINT ' || quote_ident(pk_name);
                    END IF;
                END $$;
            `
        },
        {
            name: 'idx_baileys_auth_multi_account_unique',
            sql: `
                CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_auth_multi_account_unique
                    ON baileys_auth_multi(tenant_id, account_id, id)
                    WHERE account_id IS NOT NULL;
            `
        },
        {
            name: 'idx_baileys_auth_multi_legacy_unique',
            sql: `
                CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_auth_multi_legacy_unique
                    ON baileys_auth_multi(tenant_id, id)
                    WHERE account_id IS NULL;
            `
        },
        {
            name: 'backfill leads.whatsapp_account_id',
            sql: `
                UPDATE leads l
                SET whatsapp_account_id = wa.id
                FROM whatsapp_accounts wa
                WHERE wa.tenant_id = l.tenant_id
                  AND wa.is_default = true
                  AND wa.deleted_at IS NULL
                  AND l.whatsapp_account_id IS NULL
                  AND l.source = 'whatsapp';
            `
        },
        {
            name: 'backfill messages.whatsapp_account_id',
            sql: `
                UPDATE messages m
                SET whatsapp_account_id = l.whatsapp_account_id
                FROM leads l
                WHERE l.id = m.lead_id
                  AND l.tenant_id = m.tenant_id
                  AND m.whatsapp_account_id IS NULL
                  AND l.whatsapp_account_id IS NOT NULL;
            `
        },
        {
            name: 'drop legacy idx_leads_phone_tenant_unique',
            sql: "DROP INDEX IF EXISTS idx_leads_phone_tenant_unique;"
        },
        {
            name: 'drop legacy leads_phone_tenant_unique constraint',
            sql: "ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_phone_tenant_unique;"
        },
        {
            name: 'idx_leads_phone_tenant_account_unique',
            sql: `
                CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone_tenant_account_unique
                    ON leads(phone, tenant_id, whatsapp_account_id)
                    WHERE whatsapp_account_id IS NOT NULL;
            `
        },
        {
            name: 'idx_leads_phone_tenant_noaccount_unique',
            sql: `
                CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone_tenant_noaccount_unique
                    ON leads(phone, tenant_id)
                    WHERE whatsapp_account_id IS NULL;
            `
        },
        // ═══════════════════════════════════════════════════════════
        // DANGER ZONE: soft-delete + 30-day archive + approval requests
        // ═══════════════════════════════════════════════════════════
        {
            name: 'leads.deleted_at column (soft-delete archive)',
            sql: "ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;"
        },
        {
            name: 'idx_leads_active (partial — exclude soft-deleted)',
            sql: "CREATE INDEX IF NOT EXISTS idx_leads_active_tenant_created ON leads(tenant_id, created_at DESC) WHERE deleted_at IS NULL;"
        },
        {
            name: 'idx_leads_archive (find archived rows for purge job)',
            sql: "CREATE INDEX IF NOT EXISTS idx_leads_archive_deleted_at ON leads(deleted_at) WHERE deleted_at IS NOT NULL;"
        },
        {
            name: 'messages.deleted_at column (soft-delete archive)',
            sql: "ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;"
        },
        {
            name: 'idx_messages_archive',
            sql: "CREATE INDEX IF NOT EXISTS idx_messages_archive_deleted_at ON messages(deleted_at) WHERE deleted_at IS NOT NULL;"
        },
        {
            name: 'danger_action_requests table',
            sql: `
                CREATE TABLE IF NOT EXISTS danger_action_requests (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    tenant_id VARCHAR(50) NOT NULL,
                    requester_user_id UUID,
                    requester_username VARCHAR(255),
                    action_type VARCHAR(40) NOT NULL,
                    payload JSONB DEFAULT '{}'::jsonb,
                    reason TEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled')),
                    decided_by_user_id UUID,
                    decided_by_username VARCHAR(255),
                    decided_at TIMESTAMP,
                    decision_reason TEXT,
                    executed_at TIMESTAMP,
                    archive_expires_at TIMESTAMP,
                    affected_count INTEGER,
                    last_error TEXT,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            `
        },
        {
            name: 'idx_danger_requests_tenant_status',
            sql: "CREATE INDEX IF NOT EXISTS idx_danger_requests_tenant_status ON danger_action_requests(tenant_id, status, created_at DESC);"
        },
        {
            name: 'idx_danger_requests_pending',
            sql: "CREATE INDEX IF NOT EXISTS idx_danger_requests_pending ON danger_action_requests(created_at DESC) WHERE status = 'pending';"
        },
        {
            name: 'idx_danger_requests_archive_expires',
            sql: "CREATE INDEX IF NOT EXISTS idx_danger_requests_archive_expires ON danger_action_requests(archive_expires_at) WHERE archive_expires_at IS NOT NULL;"
        }
    ];

    let succeeded = 0;
    let failed = 0;
    for (const step of steps) {
        try {
            await pool.query(step.sql);
            succeeded++;
        } catch (e) {
            failed++;
            const msg = e && e.message ? e.message : String(e);
            console.warn(`⚠️ [migration] ${step.name} — ${msg}`);
        }
    }
    if (failed === 0) {
        console.log(`✅ Multi-WhatsApp + danger-zone schema ready (${succeeded} steps)`);
    } else {
        console.warn(`⚠️ Migration finished with ${failed} warnings (${succeeded} steps OK)`);
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
            assignee_id,
            whatsapp_account_id
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

        // 1. Check for fuzzy match first before inserting.
        // For WhatsApp leads with an explicit account_id, we scope the match to that account,
        // so the same phone writing to a DIFFERENT WhatsApp account becomes a new lead.
        const accountIdForLookup = whatsapp_account_id || null;
        const existingLead = await findLeadByPhone(cleanedPhone, tenantId, accountIdForLookup);

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
                    whatsapp_account_id = COALESCE(whatsapp_account_id, $13),
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
                tenantId,
                accountIdForLookup
            ];

            const result = await client.query(query, values);
            await client.query('COMMIT');
            console.log(`✅ Lead updated (fuzzy merged): ${existingLead.phone} (${result.rows[0].status})`);
            return result.rows[0];
        }

        // 2. Insert new lead since no fuzzy match was found.
        // ON CONFLICT target depends on whether this is a WA lead with account_id or not,
        // because we have two partial unique indexes: one on (phone, tenant_id, account_id)
        // and one on (phone, tenant_id) where account_id is NULL.
        const conflictTarget = accountIdForLookup
            ? '(phone, tenant_id, whatsapp_account_id) WHERE whatsapp_account_id IS NOT NULL'
            : '(phone, tenant_id) WHERE whatsapp_account_id IS NULL';

        const query = `
        INSERT INTO leads (
          phone, name, last_message, source_message, source_contact_name,
          whatsapp_id, status, source, value, product_name, extra_data, tenant_id, assignee_id, whatsapp_account_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT ${conflictTarget}
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
          whatsapp_account_id = COALESCE(leads.whatsapp_account_id, EXCLUDED.whatsapp_account_id),
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
            finalAssigneeId,
            accountIdForLookup
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
 * Find lead by phone number with fuzzy suffix matching.
 * Multi-WhatsApp aware: when whatsappAccountId is provided, only matches leads
 * belonging to that account (so messages from different accounts to the same
 * phone create separate leads).
 */
async function findLeadByPhone(phone, tenantId = 'admin', whatsappAccountId = null) {
    try {
        const cleanedPhone = normalizePhone(phone);
        const accountFilterSql = whatsappAccountId ? ' AND whatsapp_account_id = $3' : '';
        const accountParams = whatsappAccountId ? [whatsappAccountId] : [];

        // 1. Exact match first (exclude soft-deleted archive entries)
        const exact = await pool.query(
            `SELECT * FROM leads WHERE phone = $1 AND tenant_id = $2 AND deleted_at IS NULL${accountFilterSql}`,
            [cleanedPhone, tenantId, ...accountParams]
        );
        if (exact.rows[0]) return exact.rows[0];

        // Non-numeric keys (fb:/ig:) should not use fuzzy matching
        if (!isNumericPhoneKey(cleanedPhone)) {
            return null;
        }

        // 2. Fuzzy: last 9 digits covers local number without country code variants
        if (cleanedPhone.length >= 9) {
            const suffix = cleanedPhone.slice(-9);
            const fuzzy = await pool.query(
                `SELECT * FROM leads WHERE phone LIKE $1 AND tenant_id = $2 AND deleted_at IS NULL${accountFilterSql} ORDER BY created_at DESC LIMIT 1`,
                [`%${suffix}`, tenantId, ...accountParams]
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
        const query = 'SELECT * FROM leads WHERE whatsapp_id = $1 AND tenant_id = $2 AND deleted_at IS NULL';
        const result = await pool.query(query, [whatsappId, tenantId]);
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Error finding lead by WhatsApp ID:', error.message);
        throw error;
    }
}

/**
 * Update lead message and metadata (with transaction).
 * Multi-WhatsApp aware: when whatsappAccountId is provided, only updates the lead
 * tied to that account.
 */
async function updateLeadMessage(phone, message, whatsappId, name = null, tenantId = 'admin', direction = 'in', whatsappAccountId = null) {
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

        const accountFilterSql = whatsappAccountId ? ' AND whatsapp_account_id = $8' : '';
        const accountParams = whatsappAccountId ? [whatsappAccountId] : [];

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
        WHERE phone = $4 AND tenant_id = $5${accountFilterSql}
        RETURNING *;
      `;

        const result = await client.query(query, [
            message || null,
            whatsappId || null,
            name || null,
            cleanedPhone,
            tenantId,
            defaultAssigneeId,
            direction === 'out' ? 'out' : 'in',
            ...accountParams
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
                 wa.label AS whatsapp_account_label,
                 wa.phone_number AS whatsapp_account_phone,
                 wa.status AS whatsapp_account_status,
                 COALESCE(dup.cnt, 0) AS duplicate_lead_count,
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
          LEFT JOIN whatsapp_accounts wa
            ON wa.id = l.whatsapp_account_id AND wa.tenant_id = l.tenant_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS cnt
            FROM leads l2
            WHERE l2.tenant_id = l.tenant_id
              AND l2.phone = l.phone
              AND l2.id <> l.id
              AND l2.deleted_at IS NULL
          ) dup ON true
          WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
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
            const tzOffsetMinutes = parseTzOffsetMinutes(filters.tzOffsetMinutes);
            if (tzOffsetMinutes !== null) {
                query += ` AND l.created_at >= $${paramCount}::timestamptz`;
                values.push(toUtcBoundaryFromLocalDate(filters.startDate, tzOffsetMinutes, false));
            } else {
                query += ` AND l.created_at >= $${paramCount}::timestamptz`;
                values.push(filters.startDate);
            }
            paramCount++;
        }

        if (filters.endDate) {
            const tzOffsetMinutes = parseTzOffsetMinutes(filters.tzOffsetMinutes);
            if (tzOffsetMinutes !== null) {
                query += ` AND l.created_at < $${paramCount}::timestamptz`;
                values.push(toUtcBoundaryFromLocalDate(filters.endDate, tzOffsetMinutes, true));
            } else {
                // Inclusive end-of-day for YYYY-MM-DD filters from UI
                query += ` AND l.created_at < ($${paramCount}::date + INTERVAL '1 day')`;
                values.push(filters.endDate);
            }
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
            // Stage-aware visibility: if the caller passes a list of "shared"
            // stage IDs, the operator should also see leads in those stages
            // even when they're not the assignee. This is how the team inbox
            // works — every operator sees the "Yeni" column but only their
            // own leads in subsequent stages.
            const sharedStages = Array.isArray(filters.sharedStageIds)
                ? filters.sharedStageIds.filter((s) => s != null && String(s).trim() !== '')
                : [];
            if (sharedStages.length > 0) {
                query += ` AND (l.assignee_id = $${paramCount} OR l.status = ANY($${paramCount + 1}::text[]))`;
                values.push(filters.assigneeId);
                values.push(sharedStages);
                paramCount += 2;
            } else {
                query += ` AND l.assignee_id = $${paramCount}`;
                values.push(filters.assigneeId);
                paramCount++;
            }
        }

        if (filters.whatsappAccountId) {
            query += ` AND l.whatsapp_account_id = $${paramCount}`;
            values.push(filters.whatsappAccountId);
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
        FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL;
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
        const query = 'SELECT * FROM leads WHERE status = $1 AND tenant_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50';
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
async function appendMessage({ leadId, phone, body, direction, whatsappId, metadata, createdAt, tenantId = 'admin', senderUserId = null, whatsappAccountId = null }) {
    const ts = createdAt ? new Date(createdAt * 1000) : new Date();

    let meta = metadata;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
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
                INSERT INTO messages (lead_id, phone, body, direction, whatsapp_id, metadata, created_at, tenant_id, sender_user_id, whatsapp_account_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [leadId, phone, body || '', direction, whatsappId || null, meta, ts, tenantId, senderUserId || null, whatsappAccountId || null]);
            return; // success
        } catch (error) {
            const isUnique = error.code === '23505'; // unique_violation — message already exists
            if (isUnique) return; // idempotent: already saved by another path
            const isTransient = error.code === '57P01' || error.code === '08006' || error.code === '08003' || String(error.message).includes('connection');
            console.warn(`⚠️ appendMessage attempt ${attempt}/${MAX_ATTEMPTS} failed [${error.code || 'ERR'}]: ${error.message}`);
            if (attempt < MAX_ATTEMPTS && isTransient) {
                await new Promise(r => setTimeout(r, 200 * attempt));
                continue;
            }
            // Final failure — log full detail so it's visible in Render logs
            console.error(`❌ appendMessage FINAL FAILURE (lead=${leadId}, waid=${whatsappId}, tenant=${tenantId}): ${error.message}`);
            return;
        }
    }
}

async function upsertWhatsAppMediaAsset({ tenantId, fileKey, kind, mimeType, originalFileName, bytes, data }) {
    if (!tenantId || !fileKey || !data) return null;
    const res = await pool.query(
        `INSERT INTO whatsapp_media_assets (tenant_id, file_key, kind, mime_type, original_file_name, bytes, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (tenant_id, file_key)
         DO UPDATE SET
           kind = EXCLUDED.kind,
           mime_type = EXCLUDED.mime_type,
           original_file_name = EXCLUDED.original_file_name,
           bytes = EXCLUDED.bytes,
           data = EXCLUDED.data
         RETURNING tenant_id, file_key, kind, mime_type, original_file_name, bytes, created_at`,
        [
            String(tenantId),
            String(fileKey),
            kind ? String(kind) : null,
            mimeType ? String(mimeType) : null,
            originalFileName ? String(originalFileName) : null,
            Number(bytes || 0),
            data
        ]
    );
    return res.rows[0] || null;
}

async function getWhatsAppMediaAsset(tenantId, fileKey) {
    if (!tenantId || !fileKey) return null;
    const res = await pool.query(
        `SELECT tenant_id, file_key, kind, mime_type, original_file_name, bytes, data, created_at
         FROM whatsapp_media_assets
         WHERE tenant_id = $1 AND file_key = $2
         LIMIT 1`,
        [String(tenantId), String(fileKey)]
    );
    return res.rows[0] || null;
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
            encryptToken(String(user_access_token)),
            expires_at ? new Date(expires_at) : null,
            dbg,
            status ? String(status) : 'active',
            last_error ? String(last_error) : null
        ]
    );
    return res.rows[0] || null;
}

async function getMetaUserToken(tenantId) {
    if (!tenantId) return null;
    const res = await pool.query(
        'SELECT tenant_id, user_access_token, expires_at, debug_info, status, last_error, updated_at FROM meta_user_tokens WHERE tenant_id = $1 LIMIT 1',
        [String(tenantId)]
    );
    if (res.rows[0]) res.rows[0].user_access_token = decryptToken(res.rows[0].user_access_token);
    return res.rows[0] || null;
}

async function deleteMetaUserToken(tenantId) {
    if (!tenantId) throw new Error('tenantId is required');
    const res = await pool.query(
        'DELETE FROM meta_user_tokens WHERE tenant_id = $1 RETURNING tenant_id',
        [String(tenantId)]
    );
    return res.rowCount > 0;
}

// Per-tenant Meta (Facebook/Instagram) app credentials. app_secret is encrypted at rest.
// Self-healing: guarantee the table exists even if a prior schema migration didn't create it
// (e.g. the init transaction rolled back on an already-populated DB).
let _metaAppConfigEnsured = false;
async function ensureMetaAppConfigTable() {
    if (_metaAppConfigEnsured) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS meta_app_config (
        tenant_id VARCHAR(50) PRIMARY KEY,
        app_id VARCHAR(64),
        app_secret TEXT,
        verify_token VARCHAR(255),
        updated_at TIMESTAMP DEFAULT NOW()
    )`);
    _metaAppConfigEnsured = true;
}

async function getMetaAppConfig(tenantId) {
    if (!tenantId) return null;
    await ensureMetaAppConfigTable();
    const res = await pool.query(
        'SELECT tenant_id, app_id, app_secret, verify_token, updated_at FROM meta_app_config WHERE tenant_id = $1 LIMIT 1',
        [String(tenantId)]
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.app_secret) {
        try { row.app_secret = decryptToken(row.app_secret); } catch { /* keep as-is if not encrypted */ }
    }
    return row;
}

// Partial upsert: only non-empty fields overwrite (so verify_token can change without re-entering the secret).
async function upsertMetaAppConfig(tenantId, { app_id, app_secret, verify_token }) {
    if (!tenantId) throw new Error('tenantId is required');
    await ensureMetaAppConfigTable();
    const appIdVal = (app_id != null && String(app_id).trim() !== '') ? String(app_id).trim() : null;
    const verifyVal = (verify_token != null && String(verify_token).trim() !== '') ? String(verify_token).trim() : null;
    const secretVal = (app_secret != null && String(app_secret).trim() !== '') ? encryptToken(String(app_secret).trim()) : null;
    const res = await pool.query(
        `INSERT INTO meta_app_config (tenant_id, app_id, app_secret, verify_token, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           app_id = COALESCE(EXCLUDED.app_id, meta_app_config.app_id),
           app_secret = COALESCE(EXCLUDED.app_secret, meta_app_config.app_secret),
           verify_token = COALESCE(EXCLUDED.verify_token, meta_app_config.verify_token),
           updated_at = NOW()
         RETURNING tenant_id, app_id, verify_token, updated_at`,
        [String(tenantId), appIdVal, secretVal, verifyVal]
    );
    return res.rows[0] || null;
}

async function deleteMetaAppConfig(tenantId) {
    if (!tenantId) throw new Error('tenantId is required');
    await ensureMetaAppConfigTable();
    const res = await pool.query(
        'DELETE FROM meta_app_config WHERE tenant_id = $1 RETURNING tenant_id',
        [String(tenantId)]
    );
    return res.rowCount > 0;
}

// Used by the (unauthenticated) webhook GET verify to accept any tenant's verify token.
async function metaVerifyTokenExists(token) {
    const t = String(token || '').trim();
    if (!t) return false;
    await ensureMetaAppConfigTable();
    const res = await pool.query(
        'SELECT 1 FROM meta_app_config WHERE verify_token = $1 LIMIT 1',
        [t]
    );
    return res.rowCount > 0;
}

async function upsertFacebookAdImport(tenantId, { access_token, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache, last_error, auto_sync_enabled, auto_sync_start_date, auto_sync_end_date, auto_sync_every_hours, auto_sync_minute, auto_sync_tz_offset_minutes, auto_sync_next_at, last_insight_sync_at, last_insight_sync_error }) {
    if (!tenantId) throw new Error('tenantId is required');
    const safeSelected = Array.isArray(selected_account_ids) ? selected_account_ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const safeCampaigns = Array.isArray(selected_campaign_ids) ? selected_campaign_ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const safeCache = Array.isArray(account_cache) ? account_cache : [];
    const safeCampaignCache = Array.isArray(campaign_cache) ? campaign_cache : [];
    const token = access_token ? String(access_token).trim() : null;
    // SEC-06: encrypt token before storing
    const encryptedToken = token ? encryptToken(token) : null;
    const tokenHint = token ? `${token.slice(0, 6)}...${token.slice(-4)}` : null;
    const everyHours = Math.max(1, parseInt(String(auto_sync_every_hours || '1'), 10) || 1);
    const minute = Math.min(59, Math.max(0, parseInt(String(auto_sync_minute || '0'), 10) || 0));
    const tzOffsetMinutes = parseTzOffsetMinutes(auto_sync_tz_offset_minutes) ?? 0;

    const res = await pool.query(
        `INSERT INTO facebook_ad_imports (
           tenant_id, access_token, token_hint, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache,
           auto_sync_enabled, auto_sync_start_date, auto_sync_end_date, auto_sync_every_hours, auto_sync_minute, auto_sync_tz_offset_minutes, auto_sync_next_at,
           last_insight_sync_at, last_insight_sync_error, last_sync_at, last_error, updated_at
         )
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), $17, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
            access_token = COALESCE(EXCLUDED.access_token, facebook_ad_imports.access_token),
            token_hint = COALESCE(EXCLUDED.token_hint, facebook_ad_imports.token_hint),
            selected_account_ids = EXCLUDED.selected_account_ids,
            selected_campaign_ids = EXCLUDED.selected_campaign_ids,
            account_cache = EXCLUDED.account_cache,
            campaign_cache = EXCLUDED.campaign_cache,
            auto_sync_enabled = EXCLUDED.auto_sync_enabled,
            auto_sync_start_date = EXCLUDED.auto_sync_start_date,
            auto_sync_end_date = EXCLUDED.auto_sync_end_date,
            auto_sync_every_hours = EXCLUDED.auto_sync_every_hours,
            auto_sync_minute = EXCLUDED.auto_sync_minute,
            auto_sync_tz_offset_minutes = EXCLUDED.auto_sync_tz_offset_minutes,
            auto_sync_next_at = EXCLUDED.auto_sync_next_at,
            last_insight_sync_at = COALESCE(EXCLUDED.last_insight_sync_at, facebook_ad_imports.last_insight_sync_at),
            last_insight_sync_error = EXCLUDED.last_insight_sync_error,
            last_sync_at = NOW(),
            last_error = EXCLUDED.last_error,
            updated_at = NOW()
         RETURNING tenant_id, token_hint, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache,
                   auto_sync_enabled, auto_sync_start_date, auto_sync_end_date, auto_sync_every_hours, auto_sync_minute, auto_sync_tz_offset_minutes, auto_sync_next_at,
                   last_insight_sync_at, last_insight_sync_error, last_sync_at, last_error, updated_at`,
        [
            String(tenantId),
            encryptedToken,
            tokenHint,
            JSON.stringify(safeSelected),
            JSON.stringify(safeCampaigns),
            JSON.stringify(safeCache),
            JSON.stringify(safeCampaignCache),
            auto_sync_enabled === true,
            auto_sync_start_date || null,
            auto_sync_end_date || null,
            everyHours,
            minute,
            tzOffsetMinutes,
            auto_sync_next_at ? new Date(auto_sync_next_at) : null,
            last_insight_sync_at ? new Date(last_insight_sync_at) : null,
            last_insight_sync_error ? String(last_insight_sync_error) : null,
            last_error ? String(last_error) : null,
        ]
    );
    const row = res.rows[0] || null;
    // SEC-06: decrypt token for caller
    if (row && row.access_token) {
      row.access_token = decryptToken(row.access_token);
    }
    return row;
}

async function getFacebookAdImport(tenantId) {
    if (!tenantId) throw new Error('tenantId is required');
    const res = await pool.query(
        `SELECT tenant_id, access_token, token_hint, selected_account_ids, selected_campaign_ids, account_cache, campaign_cache,
                auto_sync_enabled, auto_sync_start_date, auto_sync_end_date, auto_sync_every_hours, auto_sync_minute, auto_sync_tz_offset_minutes, auto_sync_next_at,
                last_insight_sync_at, last_insight_sync_error, last_sync_at, last_error, updated_at
         FROM facebook_ad_imports
         WHERE tenant_id = $1
         LIMIT 1`,
        [String(tenantId)]
    );
    const row = res.rows[0] || null;
    // SEC-06: decrypt token for caller
    if (row && row.access_token) {
      row.access_token = decryptToken(row.access_token);
    }
    return row;
}

async function upsertFacebookInsightRows(tenantId, metric, rows = [], opts = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    const safeMetric = String(metric || '').trim().toLowerCase();
    if (!safeMetric) throw new Error('metric is required');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const validRows = Array.isArray(rows) ? rows.filter((row) => row && row.campaign_id && row.date_start) : [];
        const dr = opts && opts.deleteRange;
        const optCampIds = Array.isArray(opts && opts.campaignIds) ? opts.campaignIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
        // Incremental: delete ONLY the re-fetched date window (preserve already-cached past days).
        const delCampIds = optCampIds.length ? Array.from(new Set(optCampIds)) : Array.from(new Set(validRows.map((row) => String(row.campaign_id))));
        if (delCampIds.length > 0) {
            if (dr && dr.start && dr.end) {
                await client.query(
                    `DELETE FROM facebook_ad_insight_cache WHERE tenant_id = $1 AND metric = $2 AND campaign_id = ANY($3::text[]) AND date_start >= $4::date AND date_start <= $5::date`,
                    [String(tenantId), safeMetric, delCampIds, String(dr.start), String(dr.end)]
                );
            } else {
                await client.query(
                    `DELETE FROM facebook_ad_insight_cache WHERE tenant_id = $1 AND metric = $2 AND campaign_id = ANY($3::text[])`,
                    [String(tenantId), safeMetric, delCampIds]
                );
            }
        }
        for (const row of validRows) {
            await client.query(
                `INSERT INTO facebook_ad_insight_cache (
                    tenant_id, campaign_id, metric, date_start, date_stop, campaign_name, account_id, account_name,
                    spend, impressions, clicks, ctr, cpm, results, result_type, cost_per_result, updated_at
                 ) VALUES (
                    $1, $2, $3, $4::date, $5::date, $6, $7, $8,
                    $9, $10, $11, $12, $13, $14, $15, $16, NOW()
                 )
                 ON CONFLICT (tenant_id, campaign_id, metric, date_start)
                 DO UPDATE SET
                    date_stop = EXCLUDED.date_stop,
                    campaign_name = EXCLUDED.campaign_name,
                    account_id = EXCLUDED.account_id,
                    account_name = EXCLUDED.account_name,
                    spend = EXCLUDED.spend,
                    impressions = EXCLUDED.impressions,
                    clicks = EXCLUDED.clicks,
                    ctr = EXCLUDED.ctr,
                    cpm = EXCLUDED.cpm,
                    results = EXCLUDED.results,
                    result_type = EXCLUDED.result_type,
                    cost_per_result = EXCLUDED.cost_per_result,
                    updated_at = NOW()`,
                [
                    String(tenantId),
                    String(row.campaign_id),
                    safeMetric,
                    String(row.date_start),
                    row.date_stop ? String(row.date_stop) : null,
                    row.campaign_name ? String(row.campaign_name) : 'Campaign',
                    row.account_id ? String(row.account_id) : null,
                    row.account_name ? String(row.account_name) : null,
                    Number(row.spend || 0),
                    Number(row.impressions || 0),
                    Number(row.clicks || 0),
                    Number(row.ctr || 0),
                    Number(row.cpm || 0),
                    Number(row.results || 0),
                    row.result_type ? String(row.result_type) : null,
                    Number(row.cost_per_result || 0),
                ]
            );
        }
        await client.query('COMMIT');
        return validRows.length;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getFacebookInsightRows(tenantId, metric, campaignIds = [], dateRange = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    const values = [String(tenantId), String(metric || '').trim().toLowerCase() || 'message'];
    let query = `SELECT * FROM facebook_ad_insight_cache WHERE tenant_id = $1 AND metric = $2`;
    let paramCount = 3;
    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
        query += ` AND campaign_id = ANY($${paramCount}::text[])`;
        values.push(campaignIds.map((id) => String(id || '').trim()).filter(Boolean));
        paramCount++;
    }
    if (dateRange && dateRange.start) {
        query += ` AND date_start >= $${paramCount}::date`;
        values.push(String(dateRange.start));
        paramCount++;
    }
    if (dateRange && dateRange.end) {
        query += ` AND date_start <= $${paramCount}::date`;
        values.push(String(dateRange.end));
        paramCount++;
    }
    query += ' ORDER BY date_start ASC, campaign_name ASC';
    const res = await pool.query(query, values);
    return res.rows;
}

// ── Ad-level (adset/ad) insight cache for the Ad Panel ──────────────────────
async function upsertFacebookAdInsightRows(tenantId, metric, rows = [], opts = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    const safeMetric = String(metric || '').trim().toLowerCase();
    if (!safeMetric) throw new Error('metric is required');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqCampaignIds = Array.from(new Set((Array.isArray(opts && opts.campaignIds) ? opts.campaignIds : []).map((x) => String(x || '').trim()).filter(Boolean)));
        const dr = opts && opts.deleteRange;
        const validRows = Array.isArray(rows) ? rows.filter((row) => row && row.ad_id && row.date_start) : [];
        if (reqCampaignIds.length > 0) {
            // Incremental: refresh ONLY the re-fetched window for the synced campaigns (keep old days).
            if (dr && dr.start && dr.end) {
                await client.query(
                    `DELETE FROM facebook_ad_insight_cache_ad WHERE tenant_id = $1 AND metric = $2 AND campaign_id = ANY($3::text[]) AND date_start >= $4::date AND date_start <= $5::date`,
                    [String(tenantId), safeMetric, reqCampaignIds, String(dr.start), String(dr.end)]
                );
            } else {
                await client.query(
                    `DELETE FROM facebook_ad_insight_cache_ad WHERE tenant_id = $1 AND metric = $2 AND campaign_id = ANY($3::text[])`,
                    [String(tenantId), safeMetric, reqCampaignIds]
                );
            }
        } else if (validRows.length > 0) {
            const keepAdIds = Array.from(new Set(validRows.map((row) => String(row.ad_id))));
            await client.query(
                `DELETE FROM facebook_ad_insight_cache_ad WHERE tenant_id = $1 AND metric = $2 AND ad_id = ANY($3::text[])`,
                [String(tenantId), safeMetric, keepAdIds]
            );
        }
        for (const row of validRows) {
            await client.query(
                `INSERT INTO facebook_ad_insight_cache_ad (
                    tenant_id, ad_id, metric, date_start, date_stop, campaign_id, campaign_name, adset_id, adset_name, ad_name, account_id, account_name,
                    spend, impressions, clicks, ctr, cpm, results, result_type, cost_per_result, updated_at
                 ) VALUES (
                    $1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,
                    $13,$14,$15,$16,$17,$18,$19,$20, NOW()
                 )
                 ON CONFLICT (tenant_id, ad_id, metric, date_start) DO UPDATE SET
                    date_stop = EXCLUDED.date_stop, campaign_id = EXCLUDED.campaign_id, campaign_name = EXCLUDED.campaign_name,
                    adset_id = EXCLUDED.adset_id, adset_name = EXCLUDED.adset_name, ad_name = EXCLUDED.ad_name,
                    account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name,
                    spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
                    ctr = EXCLUDED.ctr, cpm = EXCLUDED.cpm, results = EXCLUDED.results,
                    result_type = EXCLUDED.result_type, cost_per_result = EXCLUDED.cost_per_result, updated_at = NOW()`,
                [
                    String(tenantId), String(row.ad_id), safeMetric, String(row.date_start),
                    row.date_stop ? String(row.date_stop) : null,
                    row.campaign_id ? String(row.campaign_id) : null,
                    row.campaign_name ? String(row.campaign_name) : 'Campaign',
                    row.adset_id ? String(row.adset_id) : null,
                    row.adset_name ? String(row.adset_name) : null,
                    row.ad_name ? String(row.ad_name) : 'Ad',
                    row.account_id ? String(row.account_id) : null,
                    row.account_name ? String(row.account_name) : null,
                    Number(row.spend || 0), Number(row.impressions || 0), Number(row.clicks || 0),
                    Number(row.ctr || 0), Number(row.cpm || 0), Number(row.results || 0),
                    row.result_type ? String(row.result_type) : null, Number(row.cost_per_result || 0),
                ]
            );
        }
        await client.query('COMMIT');
        return validRows.length;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getFacebookAdInsightRows(tenantId, metric, campaignIds = [], dateRange = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    const values = [String(tenantId), String(metric || '').trim().toLowerCase() || 'message'];
    let query = `SELECT * FROM facebook_ad_insight_cache_ad WHERE tenant_id = $1 AND metric = $2`;
    let paramCount = 3;
    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
        query += ` AND campaign_id = ANY($${paramCount}::text[])`;
        values.push(campaignIds.map((id) => String(id || '').trim()).filter(Boolean));
        paramCount++;
    }
    if (dateRange && dateRange.start) { query += ` AND date_start >= $${paramCount}::date`; values.push(String(dateRange.start)); paramCount++; }
    if (dateRange && dateRange.end) { query += ` AND date_start <= $${paramCount}::date`; values.push(String(dateRange.end)); paramCount++; }
    query += ' ORDER BY date_start ASC';
    const res = await pool.query(query, values);
    return res.rows;
}

// Min/max cached insight day for a tenant+metric (drives incremental fetch window).
async function getFacebookInsightDateBounds(tenantId, metric, level = 'campaign') {
    if (!tenantId) return { min: null, max: null };
    const table = level === 'ad' ? 'facebook_ad_insight_cache_ad' : 'facebook_ad_insight_cache';
    const res = await pool.query(
        `SELECT to_char(MIN(date_start), 'YYYY-MM-DD') AS mn, to_char(MAX(date_start), 'YYYY-MM-DD') AS mx
         FROM ${table} WHERE tenant_id = $1 AND metric = $2`,
        [String(tenantId), String(metric || '').trim().toLowerCase() || 'message']
    );
    const r = (res.rows && res.rows[0]) || {};
    return { min: r.mn || null, max: r.mx || null };
}

// Aggregate leads grouped by their originating ad (extra_data.ad_source_id) and status.
async function getLeadsGroupedByAdSource(tenantId, opts = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    const values = [String(tenantId)];
    let query = `SELECT (extra_data->>'ad_source_id') AS ad_source_id, status,
        COUNT(*)::int AS lead_count, COALESCE(SUM(COALESCE(value,0)),0)::float AS value_sum
        FROM leads
        WHERE tenant_id = $1 AND deleted_at IS NULL
          AND (extra_data->>'ad_source_id') IS NOT NULL AND (extra_data->>'ad_source_id') <> ''`;
    let p = 2;
    if (opts.startTs) { query += ` AND created_at >= $${p}::timestamptz`; values.push(opts.startTs); p++; }
    if (opts.endTs) { query += ` AND created_at < $${p}::timestamptz`; values.push(opts.endTs); p++; }
    if (opts.assigneeId) { query += ` AND assignee_id = $${p}`; values.push(opts.assigneeId); p++; }
    query += ` GROUP BY 1, 2`;
    const res = await pool.query(query, values);
    return res.rows;
}

async function claimDueFacebookAutoSyncConfigs(owner, limit = 5) {
    const safeOwner = String(owner || '').trim();
    if (!safeOwner) throw new Error('owner is required');
    const res = await pool.query(
        `WITH due AS (
            SELECT tenant_id
            FROM facebook_ad_imports
            WHERE auto_sync_enabled = true
              AND access_token IS NOT NULL
              AND jsonb_array_length(COALESCE(selected_campaign_ids, '[]'::jsonb)) > 0
              AND (
                auto_sync_next_at IS NULL
                OR auto_sync_next_at <= NOW()
              )
              AND (
                sync_locked_at IS NULL
                OR sync_locked_at < NOW() - INTERVAL '15 minutes'
              )
            ORDER BY COALESCE(auto_sync_next_at, to_timestamp(0)) ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        )
        UPDATE facebook_ad_imports cfg
        SET sync_locked_at = NOW(),
            sync_lock_owner = $1
        FROM due
        WHERE cfg.tenant_id = due.tenant_id
        RETURNING cfg.*`,
        [safeOwner, Math.max(1, parseInt(String(limit || '5'), 10) || 5)]
    );
    // SEC-06: decrypt tokens for the sync worker
    for (const row of res.rows) {
      if (row.access_token) row.access_token = decryptToken(row.access_token);
    }
    return res.rows;
}

async function finishFacebookAutoSync(tenantId, { nextSyncAt = null, lastInsightSyncAt = null, lastInsightSyncError = null, clearLock = true } = {}) {
    if (!tenantId) throw new Error('tenantId is required');
    const res = await pool.query(
        `UPDATE facebook_ad_imports
         SET auto_sync_next_at = COALESCE($2, auto_sync_next_at),
             last_insight_sync_at = COALESCE($3, last_insight_sync_at),
             last_insight_sync_error = $4,
             sync_locked_at = CASE WHEN $5 THEN NULL ELSE sync_locked_at END,
             sync_lock_owner = CASE WHEN $5 THEN NULL ELSE sync_lock_owner END,
             updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING *`,
        [String(tenantId), nextSyncAt ? new Date(nextSyncAt) : null, lastInsightSyncAt ? new Date(lastInsightSyncAt) : null, lastInsightSyncError ? String(lastInsightSyncError) : null, clearLock === true]
    );
    return res.rows[0] || null;
}

/**
 * Get all messages for a lead, oldest first
 */
async function getMessages(leadId, tenantId = 'admin') {
    try {
        const result = await pool.query(
            'SELECT * FROM messages WHERE lead_id = $1 AND tenant_id = $2 AND deleted_at IS NULL ORDER BY created_at ASC',
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
                WHERE lead_id = l.id AND tenant_id = l.tenant_id AND deleted_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
            ) m ON true
            WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
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
 * Soft-delete ALL active leads + messages for a tenant (factory reset).
 *
 * Critical change: this no longer hard-deletes. Rows get a deleted_at
 * timestamp and stay in the table for the 30-day archive window so a
 * superadmin can restore everything if the action turns out to be a
 * mistake. The background purge job hard-deletes after 30 days.
 *
 * Returns { affectedLeads, affectedMessages }.
 */
async function deleteAllLeads(tenantId = 'admin') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const msgRes = await client.query(
            'UPDATE messages SET deleted_at = NOW() WHERE tenant_id = $1 AND deleted_at IS NULL',
            [tenantId]
        );
        const leadRes = await client.query(
            'UPDATE leads SET deleted_at = NOW() WHERE tenant_id = $1 AND deleted_at IS NULL',
            [tenantId]
        );
        await client.query('COMMIT');
        const affectedLeads = leadRes.rowCount || 0;
        const affectedMessages = msgRes.rowCount || 0;
        console.log(`🗑️ Soft-deleted ${affectedLeads} leads + ${affectedMessages} messages (factory reset, 30-day archive)`);
        return { deleted: true, affectedLeads, affectedMessages };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ deleteAllLeads error:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Soft-delete only the messages (clear chat history) for a tenant.
 * Leads stay intact. Used by the 'clear_chat_history' danger action.
 */
async function clearAllChatHistory(tenantId = 'admin') {
    const res = await pool.query(
        'UPDATE messages SET deleted_at = NOW() WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenantId]
    );
    const affectedMessages = res.rowCount || 0;
    console.log(`🗑️ Soft-deleted ${affectedMessages} messages (chat history cleared)`);
    return { affectedMessages };
}

/**
 * Restore ALL soft-deleted rows for a tenant whose deletion came from a
 * specific danger_action_request. Used by the superadmin "restore" button
 * within the 30-day window.
 */
async function restoreSoftDeletedSince(tenantId, sinceTimestamp) {
    if (!tenantId || !sinceTimestamp) return { restoredLeads: 0, restoredMessages: 0 };
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Restore ALL rows that were soft-deleted at or after the request's
        // executed_at timestamp. Allow a 5-second window for clock drift between
        // statements that ran in the same UPDATE batch.
        const cutoff = new Date(new Date(sinceTimestamp).getTime() - 5000);
        const leadRes = await client.query(
            'UPDATE leads SET deleted_at = NULL WHERE tenant_id = $1 AND deleted_at IS NOT NULL AND deleted_at >= $2',
            [tenantId, cutoff]
        );
        const msgRes = await client.query(
            'UPDATE messages SET deleted_at = NULL WHERE tenant_id = $1 AND deleted_at IS NOT NULL AND deleted_at >= $2',
            [tenantId, cutoff]
        );
        await client.query('COMMIT');
        return { restoredLeads: leadRes.rowCount || 0, restoredMessages: msgRes.rowCount || 0 };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { }
        console.error('❌ restoreSoftDeletedSince error:', e.message);
        return { restoredLeads: 0, restoredMessages: 0, error: e.message };
    } finally {
        client.release();
    }
}

/**
 * Hard-delete soft-deleted rows older than the retention window (30 days).
 * Run periodically by a background job.
 */
async function purgeExpiredSoftDeletes(retentionDays = 30) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const msgRes = await client.query(
            `DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [retentionDays]
        );
        const leadRes = await client.query(
            `DELETE FROM leads WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [retentionDays]
        );
        await client.query('COMMIT');
        const purgedLeads = leadRes.rowCount || 0;
        const purgedMessages = msgRes.rowCount || 0;
        if (purgedLeads + purgedMessages > 0) {
            console.log(`🧹 Purged ${purgedLeads} archived leads + ${purgedMessages} messages (>${retentionDays}d)`);
        }
        return { purgedLeads, purgedMessages };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { }
        console.error('❌ purgeExpiredSoftDeletes error:', e.message);
        return { purgedLeads: 0, purgedMessages: 0, error: e.message };
    } finally {
        client.release();
    }
}

// ─── Danger action requests (approval queue) ─────────────────────────────
async function createDangerActionRequest({ tenantId, requesterUserId, requesterUsername, actionType, payload, reason }) {
    if (!tenantId || !actionType) throw new Error('tenantId and actionType are required');
    const allowed = ['factory_reset', 'delete_all_data', 'clear_chat_history'];
    if (!allowed.includes(actionType)) throw new Error(`Unsupported actionType: ${actionType}`);
    const res = await pool.query(
        `INSERT INTO danger_action_requests
         (tenant_id, requester_user_id, requester_username, action_type, payload, reason, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending')
         RETURNING *`,
        [tenantId, requesterUserId || null, requesterUsername || null, actionType, payload || {}, reason || null]
    );
    return res.rows[0] || null;
}

async function listDangerActionRequests({ tenantId = null, status = null, limit = 100 } = {}) {
    const where = [];
    const values = [];
    let i = 1;
    if (tenantId) { where.push(`tenant_id = $${i++}`); values.push(tenantId); }
    if (status) { where.push(`status = $${i++}`); values.push(status); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    values.push(Math.max(1, Math.min(500, parseInt(String(limit), 10) || 100)));
    const res = await pool.query(
        `SELECT * FROM danger_action_requests ${whereSql} ORDER BY created_at DESC LIMIT $${i}`,
        values
    );
    return res.rows;
}

async function getDangerActionRequest(id) {
    if (!id) return null;
    const res = await pool.query('SELECT * FROM danger_action_requests WHERE id = $1 LIMIT 1', [id]);
    return res.rows[0] || null;
}

async function updateDangerActionRequest(id, fields) {
    if (!id || !fields || typeof fields !== 'object') return null;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(fields)) {
        if (!['status', 'decided_by_user_id', 'decided_by_username', 'decided_at',
              'decision_reason', 'executed_at', 'archive_expires_at',
              'affected_count', 'last_error'].includes(key)) continue;
        sets.push(`${key} = $${i++}`);
        values.push(value);
    }
    if (sets.length === 0) return null;
    sets.push('updated_at = NOW()');
    values.push(id);
    const res = await pool.query(
        `UPDATE danger_action_requests SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        values
    );
    return res.rows[0] || null;
}

async function getActiveArchiveSummary(tenantId) {
    if (!tenantId) return { archivedLeads: 0, archivedMessages: 0 };
    const leads = await pool.query(
        'SELECT COUNT(*)::int AS c FROM leads WHERE tenant_id = $1 AND deleted_at IS NOT NULL',
        [tenantId]
    );
    const messages = await pool.query(
        'SELECT COUNT(*)::int AS c FROM messages WHERE tenant_id = $1 AND deleted_at IS NOT NULL',
        [tenantId]
    );
    return {
        archivedLeads: leads.rows[0]?.c || 0,
        archivedMessages: messages.rows[0]?.c || 0,
    };
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

        // Defensive: max_whatsapp_accounts and whatsapp_accounts table may not exist yet
        // on installs where the multi-WA migration hasn't run. Detect and use fallbacks.
        let hasMaxCol = false;
        let hasWaTable = false;
        try {
            const colCheck = await pool.query(
                "SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'max_whatsapp_accounts'"
            );
            hasMaxCol = colCheck.rowCount > 0;
        } catch { }
        try {
            const tableCheck = await pool.query(
                "SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_accounts'"
            );
            hasWaTable = tableCheck.rowCount > 0;
        } catch { }

        const maxColExpr = hasMaxCol ? 'COALESCE(t.max_whatsapp_accounts, 1)' : '1';
        const waCountExpr = hasWaTable
            ? "COALESCE((SELECT COUNT(*) FROM whatsapp_accounts WHERE tenant_id = t.tenant_id AND deleted_at IS NULL), 0)"
            : '0';

        const query = `
            SELECT
                t.tenant_id,
                COALESCE(t.display_name, admins.admin_display_name, t.tenant_id) AS display_name,
                t.status,
                t.archived_at,
                COALESCE(t.created_at, admins.first_created_at) as created_at,
                COALESCE((SELECT COUNT(*) FROM users WHERE tenant_id = t.tenant_id), 0) as user_count,
                COALESCE((SELECT COUNT(*) FROM leads WHERE tenant_id = t.tenant_id), 0) as lead_count,
                ${maxColExpr} AS max_whatsapp_accounts,
                ${waCountExpr} AS whatsapp_account_count,
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
    if (res.rows[0]) res.rows[0].bot_token = decryptToken(res.rows[0].bot_token);
    return res.rows[0] || null;
}

async function upsertTelegramIntegration(tenantId, { enabled, chat_id, bot_token }) {
    if (!tenantId) throw new Error('tenantId is required');
    const en = enabled === false ? false : true;
    const chat = chat_id !== undefined && chat_id !== null ? String(chat_id).trim() : null;
    const rawTok = bot_token !== undefined && bot_token !== null ? String(bot_token).trim() : null;
    const tok = rawTok ? encryptToken(rawTok) : null; // şifrele

    const res = await pool.query(
        `INSERT INTO telegram_integrations (tenant_id, enabled, chat_id, bot_token, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           enabled = EXCLUDED.enabled,
           chat_id = EXCLUDED.chat_id,
           bot_token = COALESCE(EXCLUDED.bot_token, telegram_integrations.bot_token),
           updated_at = NOW()
         RETURNING tenant_id, enabled, chat_id, bot_token, last_error, last_sent_at, last_test_at, updated_at`,
        [String(tenantId), en, chat, tok]
    );
    if (res.rows[0]) res.rows[0].bot_token = decryptToken(res.rows[0].bot_token); // çağıran maskeleyəcək
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
        [tenantId, String(page_id), page_name || null, encryptToken(String(page_access_token)), ig_business_id ? String(ig_business_id) : null]
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
    if (res.rows[0]) res.rows[0].page_access_token = decryptToken(res.rows[0].page_access_token);
    return res.rows[0] || null;
}

async function getMetaPageByIgBusinessId(igBusinessId) {
    if (!igBusinessId) return null;
    const res = await pool.query(
        'SELECT tenant_id, page_id, page_name, page_access_token, ig_business_id FROM meta_pages WHERE ig_business_id = $1 LIMIT 1',
        [String(igBusinessId)]
    );
    if (res.rows[0]) res.rows[0].page_access_token = decryptToken(res.rows[0].page_access_token);
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

// ═══════════════════════════════════════════════════════════════
// WHATSAPP ACCOUNTS (multi-account per tenant)
// ═══════════════════════════════════════════════════════════════

/**
 * Normalize a phone number for restore-by-phone matching.
 * Strips all non-digit characters; returns null if too short.
 */
function normalizeWhatsAppPhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (!digits || digits.length < 7 || digits.length > 15) return null;
    return digits;
}

/**
 * Self-healing: if a tenant has live Baileys credentials in baileys_auth_multi
 * but no whatsapp_accounts row (e.g. because the migration auto-create step
 * failed silently), create the default row and re-link the existing creds to
 * it. Idempotent — safe to call on every request.
 *
 * This is the rescue path that prevents existing WhatsApp connections from
 * "disappearing" after the multi-WA migration runs.
 */
async function healWhatsAppAccountsForTenant(tenantId) {
    if (!tenantId || tenantId === 'admin') return null;

    // 1. Already has a healthy whatsapp_accounts row? Make sure baileys_auth_multi
    //    rows are linked to it (in case backfill missed them).
    const existingRow = await pool.query(
        `SELECT id FROM whatsapp_accounts
         WHERE tenant_id = $1 AND deleted_at IS NULL
         ORDER BY is_default DESC, created_at ASC
         LIMIT 1`,
        [tenantId]
    );
    if (existingRow.rowCount > 0) {
        const accountId = existingRow.rows[0].id;
        // Backfill any orphan creds rows
        try {
            await pool.query(
                'UPDATE baileys_auth_multi SET account_id = $1 WHERE tenant_id = $2 AND account_id IS NULL',
                [accountId, tenantId]
            );
        } catch { }
        return { id: accountId, healed: false };
    }

    // 2. No row in whatsapp_accounts. Check if there are existing creds in baileys_auth_multi.
    let credsRow = null;
    try {
        const credsRes = await pool.query(
            "SELECT account_id FROM baileys_auth_multi WHERE tenant_id = $1 AND id = 'creds' LIMIT 1",
            [tenantId]
        );
        credsRow = credsRes.rows[0] || null;
    } catch { }

    if (!credsRow) {
        // No creds either — nothing to heal. The user will see an empty UI and
        // can manually create a new account if they want.
        return null;
    }

    // 3. Creds exist but no whatsapp_accounts row → recover.
    //    If the creds row already has an account_id (from a partial backfill),
    //    create the whatsapp_accounts row WITH that exact id so the link is
    //    preserved. Otherwise generate a new id and backfill.
    const existingAccountId = credsRow.account_id;
    let healedAccountId = null;

    if (existingAccountId) {
        // Try to insert with the existing UUID. ON CONFLICT (id) DO NOTHING in case
        // another concurrent request raced us.
        try {
            const r = await pool.query(
                `INSERT INTO whatsapp_accounts (id, tenant_id, label, status, is_default, last_connected_at)
                 VALUES ($1, $2, 'Əsas WhatsApp', 'connected', true, NOW())
                 ON CONFLICT (id) DO NOTHING
                 RETURNING id`,
                [existingAccountId, tenantId]
            );
            healedAccountId = r.rows[0]?.id || existingAccountId;
        } catch (e) {
            console.warn(`⚠️ heal: failed to insert with existing account_id (${e.message})`);
        }
    }

    if (!healedAccountId) {
        // Either no existing account_id, or insert above failed — generate a new one.
        try {
            const r = await pool.query(
                `INSERT INTO whatsapp_accounts (tenant_id, label, status, is_default, last_connected_at)
                 VALUES ($1, 'Əsas WhatsApp', 'connected', true, NOW())
                 RETURNING id`,
                [tenantId]
            );
            healedAccountId = r.rows[0].id;
            // Backfill all creds rows for this tenant to point to the new account.
            await pool.query(
                'UPDATE baileys_auth_multi SET account_id = $1 WHERE tenant_id = $2 AND account_id IS NULL',
                [healedAccountId, tenantId]
            );
        } catch (e) {
            console.error(`❌ heal: failed to create whatsapp_accounts row for ${tenantId}: ${e.message}`);
            return null;
        }
    }

    console.log(`♻️ Self-healed WhatsApp account for tenant ${tenantId} → ${String(healedAccountId).slice(0, 8)}`);
    return { id: healedAccountId, healed: true };
}

/**
 * List all active (non-deleted) WhatsApp accounts for a tenant.
 */
async function listWhatsAppAccounts(tenantId, { includeDeleted = false } = {}) {
    if (!tenantId) return [];
    const where = ['tenant_id = $1'];
    if (!includeDeleted) where.push('deleted_at IS NULL');
    const res = await pool.query(
        `SELECT id, tenant_id, label, phone_number, phone_number_normalized, status,
                is_default, last_qr_at, last_connected_at, last_disconnected_at,
                last_error, deleted_at, created_at, updated_at
         FROM whatsapp_accounts
         WHERE ${where.join(' AND ')}
         ORDER BY is_default DESC, created_at ASC`,
        [tenantId]
    );
    return res.rows;
}

async function getWhatsAppAccountById(accountId, tenantId) {
    if (!accountId || !tenantId) return null;
    const res = await pool.query(
        `SELECT id, tenant_id, label, phone_number, phone_number_normalized, status,
                is_default, last_qr_at, last_connected_at, last_disconnected_at,
                last_error, deleted_at, created_at, updated_at
         FROM whatsapp_accounts
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1`,
        [accountId, tenantId]
    );
    return res.rows[0] || null;
}

/**
 * Create a new WhatsApp account row for a tenant.
 * Enforces the tenant's max_whatsapp_accounts limit.
 * Returns { account, error }: error is non-null on limit / validation failures.
 */
async function createWhatsAppAccount(tenantId, label) {
    if (!tenantId) return { account: null, error: 'tenant_required' };
    const cleanLabel = String(label || '').trim().slice(0, 120);
    if (!cleanLabel) return { account: null, error: 'label_required' };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Read tenant max-accounts. Defensive: if the column hasn't been migrated yet
        // (or the tenants row doesn't exist), fall back to 1 — better to allow at least
        // one account than to block the whole feature.
        let maxAllowed = 1;
        try {
            const tenantRes = await client.query(
                'SELECT COALESCE(max_whatsapp_accounts, 1) AS max FROM tenants WHERE tenant_id = $1',
                [tenantId]
            );
            maxAllowed = tenantRes.rows[0]?.max ?? 1;
        } catch (colErr) {
            console.warn(`⚠️ tenants.max_whatsapp_accounts unreadable, falling back to 1: ${colErr.message}`);
            // The query may have aborted the transaction — recover before continuing.
            try { await client.query('ROLLBACK'); } catch { }
            await client.query('BEGIN');
            // Best-effort: try to add the column right now so future calls succeed.
            try {
                await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_whatsapp_accounts INTEGER NOT NULL DEFAULT 1;');
            } catch { }
        }

        const countRes = await client.query(
            'SELECT COUNT(*)::int AS cnt FROM whatsapp_accounts WHERE tenant_id = $1 AND deleted_at IS NULL',
            [tenantId]
        );
        const activeCount = countRes.rows[0]?.cnt ?? 0;
        if (activeCount >= maxAllowed) {
            await client.query('ROLLBACK');
            return { account: null, error: 'limit_exceeded', limit: maxAllowed, current: activeCount };
        }

        // First account becomes default
        const isDefault = activeCount === 0;
        const insRes = await client.query(
            `INSERT INTO whatsapp_accounts (tenant_id, label, status, is_default)
             VALUES ($1, $2, 'pending', $3)
             RETURNING id, tenant_id, label, phone_number, phone_number_normalized, status,
                       is_default, last_qr_at, last_connected_at, last_disconnected_at,
                       last_error, deleted_at, created_at, updated_at`,
            [tenantId, cleanLabel, isDefault]
        );
        await client.query('COMMIT');
        return { account: insRes.rows[0], error: null };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { }
        console.error('❌ createWhatsAppAccount error:', e.message);
        return { account: null, error: e.message || 'create_failed' };
    } finally {
        client.release();
    }
}

/**
 * Soft-delete a WhatsApp account. Leads/messages remain bound to the same UUID
 * so that re-binding the same phone number can later restore them.
 */
async function softDeleteWhatsAppAccount(accountId, tenantId) {
    if (!accountId || !tenantId) return false;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Mark as deleted
        const upd = await client.query(
            `UPDATE whatsapp_accounts
             SET deleted_at = NOW(),
                 is_default = false,
                 status = 'logged_out',
                 updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
             RETURNING id, phone_number_normalized`,
            [accountId, tenantId]
        );
        if (upd.rowCount === 0) {
            await client.query('ROLLBACK');
            return false;
        }

        // Clear baileys auth state for this account so a fresh QR is required next time.
        await client.query(
            'DELETE FROM baileys_auth_multi WHERE tenant_id = $1 AND account_id = $2',
            [tenantId, accountId]
        );

        // If we removed the default, promote the most recently active account to default.
        const promote = await client.query(
            `UPDATE whatsapp_accounts
             SET is_default = true, updated_at = NOW()
             WHERE id = (
                SELECT id FROM whatsapp_accounts
                WHERE tenant_id = $1 AND deleted_at IS NULL AND is_default = false
                ORDER BY last_connected_at DESC NULLS LAST, created_at ASC
                LIMIT 1
             )
             RETURNING id`,
            [tenantId]
        );
        // promote may have 0 rows if there are no other accounts — that's fine

        await client.query('COMMIT');
        return true;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { }
        console.error('❌ softDeleteWhatsAppAccount error:', e.message);
        return false;
    } finally {
        client.release();
    }
}

/**
 * Restore a previously soft-deleted WhatsApp account.
 * Used when a brand-new QR scan binds a phone that matches an archived account.
 */
async function restoreWhatsAppAccount(accountId, tenantId) {
    if (!accountId || !tenantId) return null;
    const res = await pool.query(
        `UPDATE whatsapp_accounts
         SET deleted_at = NULL,
             status = 'connected',
             updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, label, phone_number, phone_number_normalized, status,
                   is_default, deleted_at, created_at, updated_at`,
        [accountId, tenantId]
    );
    return res.rows[0] || null;
}

/**
 * Find a soft-deleted account whose normalized phone matches.
 * Used for the auto-restore flow on QR rebind.
 */
async function findArchivedAccountByPhone(tenantId, phoneNumber) {
    if (!tenantId) return null;
    const normalized = normalizeWhatsAppPhone(phoneNumber);
    if (!normalized) return null;
    const res = await pool.query(
        `SELECT id, tenant_id, label, phone_number, phone_number_normalized, status,
                is_default, deleted_at, created_at
         FROM whatsapp_accounts
         WHERE tenant_id = $1 AND phone_number_normalized = $2 AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC
         LIMIT 1`,
        [tenantId, normalized]
    );
    return res.rows[0] || null;
}

/**
 * Rename a WhatsApp account. Returns the updated row or null if not found.
 */
async function renameWhatsAppAccount(accountId, tenantId, label) {
    if (!accountId || !tenantId) return null;
    const cleanLabel = String(label || '').trim().slice(0, 120);
    if (!cleanLabel) return null;
    const res = await pool.query(
        `UPDATE whatsapp_accounts
         SET label = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
         RETURNING id, tenant_id, label, phone_number, phone_number_normalized, status,
                   is_default, last_qr_at, last_connected_at, last_disconnected_at,
                   last_error, deleted_at, created_at, updated_at`,
        [cleanLabel, accountId, tenantId]
    );
    return res.rows[0] || null;
}

async function setDefaultWhatsAppAccount(accountId, tenantId) {
    if (!accountId || !tenantId) return false;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'UPDATE whatsapp_accounts SET is_default = false, updated_at = NOW() WHERE tenant_id = $1 AND deleted_at IS NULL',
            [tenantId]
        );
        const upd = await client.query(
            `UPDATE whatsapp_accounts
             SET is_default = true, updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
             RETURNING id`,
            [accountId, tenantId]
        );
        await client.query('COMMIT');
        return upd.rowCount > 0;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { }
        console.error('❌ setDefaultWhatsAppAccount error:', e.message);
        return false;
    } finally {
        client.release();
    }
}

/**
 * Update connection status / metadata for a WhatsApp account.
 * Called by the worker when QR/connection events fire.
 */
async function updateWhatsAppAccountStatus(accountId, tenantId, fields) {
    if (!accountId || !tenantId || !fields || typeof fields !== 'object') return null;
    const sets = [];
    const values = [];
    let i = 1;

    if (fields.status !== undefined) {
        sets.push(`status = $${i++}`);
        values.push(String(fields.status));
    }
    if (fields.phone_number !== undefined) {
        const raw = fields.phone_number ? String(fields.phone_number) : null;
        const norm = raw ? normalizeWhatsAppPhone(raw) : null;
        sets.push(`phone_number = $${i++}`);
        values.push(raw);
        sets.push(`phone_number_normalized = $${i++}`);
        values.push(norm);
    }
    if (fields.last_qr_at !== undefined) {
        sets.push(`last_qr_at = $${i++}`);
        values.push(fields.last_qr_at ? new Date(fields.last_qr_at) : null);
    }
    if (fields.last_connected_at !== undefined) {
        sets.push(`last_connected_at = $${i++}`);
        values.push(fields.last_connected_at ? new Date(fields.last_connected_at) : null);
    }
    if (fields.last_disconnected_at !== undefined) {
        sets.push(`last_disconnected_at = $${i++}`);
        values.push(fields.last_disconnected_at ? new Date(fields.last_disconnected_at) : null);
    }
    if (fields.last_error !== undefined) {
        sets.push(`last_error = $${i++}`);
        values.push(fields.last_error ? String(fields.last_error).slice(0, 1200) : null);
    }
    if (sets.length === 0) return null;

    sets.push('updated_at = NOW()');
    values.push(accountId);
    values.push(tenantId);

    const res = await pool.query(
        `UPDATE whatsapp_accounts
         SET ${sets.join(', ')}
         WHERE id = $${i++} AND tenant_id = $${i++}
         RETURNING id, tenant_id, label, phone_number, phone_number_normalized, status,
                   is_default, last_qr_at, last_connected_at, last_disconnected_at,
                   last_error, deleted_at, updated_at`,
        values
    );
    return res.rows[0] || null;
}

/**
 * Returns the default account id for a tenant, or null if none exists.
 */
async function getDefaultWhatsAppAccountId(tenantId) {
    if (!tenantId) return null;
    const res = await pool.query(
        `SELECT id FROM whatsapp_accounts
         WHERE tenant_id = $1 AND is_default = true AND deleted_at IS NULL
         LIMIT 1`,
        [tenantId]
    );
    return res.rows[0]?.id || null;
}

/**
 * Returns the (tenantId, accountId) pairs for all accounts that have credentials saved
 * in baileys_auth_multi. Used by the worker on boot to start every active session.
 */
async function getAllAuthenticatedWhatsAppAccounts() {
    const res = await pool.query(`
        SELECT DISTINCT b.tenant_id, b.account_id
        FROM baileys_auth_multi b
        JOIN whatsapp_accounts wa ON wa.id = b.account_id AND wa.tenant_id = b.tenant_id
        WHERE b.id = 'creds' AND b.account_id IS NOT NULL AND wa.deleted_at IS NULL
    `);
    return res.rows.map(r => ({ tenantId: r.tenant_id, accountId: r.account_id }));
}

/**
 * For a given lead, return the list of "duplicate" leads — same phone in same tenant
 * but a different lead row (i.e. tied to another WhatsApp account).
 * Returns minimal fields the UI needs to render the cross-link banner.
 */
async function getDuplicateLeadsForLead(leadId, tenantId) {
    if (!leadId || !tenantId) return [];
    const res = await pool.query(
        `SELECT l2.id, l2.phone, l2.name, l2.status, l2.whatsapp_account_id,
                wa.label AS whatsapp_account_label,
                wa.phone_number AS whatsapp_account_phone,
                l2.last_inbound_at, l2.created_at,
                (SELECT COUNT(*)::int FROM messages m WHERE m.lead_id = l2.id AND m.tenant_id = l2.tenant_id AND m.deleted_at IS NULL) AS message_count
         FROM leads l1
         JOIN leads l2 ON l2.tenant_id = l1.tenant_id AND l2.phone = l1.phone AND l2.id <> l1.id AND l2.deleted_at IS NULL
         LEFT JOIN whatsapp_accounts wa ON wa.id = l2.whatsapp_account_id AND wa.tenant_id = l2.tenant_id
         WHERE l1.id = $1 AND l1.tenant_id = $2 AND l1.deleted_at IS NULL
         ORDER BY l2.created_at DESC
         LIMIT 10`,
        [leadId, tenantId]
    );
    return res.rows;
}

/**
 * Get the per-tenant max WhatsApp accounts limit.
 */
async function getTenantWhatsAppLimit(tenantId) {
    if (!tenantId) return 1;
    try {
        const res = await pool.query(
            'SELECT COALESCE(max_whatsapp_accounts, 1) AS max FROM tenants WHERE tenant_id = $1',
            [tenantId]
        );
        return res.rows[0]?.max ?? 1;
    } catch (e) {
        // Column might not exist yet on installs where the migration hasn't run.
        // Try to add it on the fly so the next call succeeds, then return the default.
        if (String(e.message || '').includes('max_whatsapp_accounts')) {
            try {
                await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_whatsapp_accounts INTEGER NOT NULL DEFAULT 1;');
            } catch { }
        }
        return 1;
    }
}

async function setTenantWhatsAppLimit(tenantId, limit) {
    if (!tenantId) return false;
    const n = Math.max(0, Math.min(50, parseInt(String(limit), 10) || 1));
    await ensureTenantRecord(tenantId, {});
    // Defensive: ensure the column exists before trying to update it.
    try {
        await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_whatsapp_accounts INTEGER NOT NULL DEFAULT 1;');
    } catch { }
    const res = await pool.query(
        `UPDATE tenants SET max_whatsapp_accounts = $1, updated_at = NOW() WHERE tenant_id = $2 RETURNING max_whatsapp_accounts`,
        [n, tenantId]
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
    getMetaUserToken,
    deleteMetaUserToken,
    getMetaAppConfig,
    upsertMetaAppConfig,
    deleteMetaAppConfig,
    metaVerifyTokenExists,
    upsertWhatsAppMediaAsset,
    getWhatsAppMediaAsset,
    upsertFacebookAdImport,
    getFacebookAdImport,
    upsertFacebookInsightRows,
    getFacebookInsightRows,
    upsertFacebookAdInsightRows,
    getFacebookAdInsightRows,
    getFacebookInsightDateBounds,
    getLeadsGroupedByAdSource,
    claimDueFacebookAutoSyncConfigs,
    finishFacebookAutoSync,
    closePool,
    // Danger zone (soft-delete + approval queue)
    clearAllChatHistory,
    restoreSoftDeletedSince,
    purgeExpiredSoftDeletes,
    createDangerActionRequest,
    listDangerActionRequests,
    getDangerActionRequest,
    updateDangerActionRequest,
    getActiveArchiveSummary,
    // Multi-WhatsApp accounts
    healWhatsAppAccountsForTenant,
    listWhatsAppAccounts,
    getWhatsAppAccountById,
    createWhatsAppAccount,
    softDeleteWhatsAppAccount,
    restoreWhatsAppAccount,
    findArchivedAccountByPhone,
    renameWhatsAppAccount,
    setDefaultWhatsAppAccount,
    updateWhatsAppAccountStatus,
    getDefaultWhatsAppAccountId,
    getAllAuthenticatedWhatsAppAccounts,
    getDuplicateLeadsForLead,
    getTenantWhatsAppLimit,
    setTenantWhatsAppLimit,
    normalizeWhatsAppPhone,
    // BUG 6 FIX: index.cjs'deki duplikasyonu kaldırmak için export ediliyor
    toUtcBoundaryFromLocalDate,
    parseTzOffsetMinutes
};
