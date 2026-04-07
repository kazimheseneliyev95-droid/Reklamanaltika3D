const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

/**
 * Multi-WhatsApp aware Postgres auth state.
 *
 * Backward compatibility: when accountId is omitted, the function falls back to the
 * legacy partition (account_id IS NULL). This lets the old single-account boot path
 * keep working until it has been migrated to multi-account.
 */
const usePostgresAuthState = async (pool, tenantId, accountId = null) => {
    if (!tenantId) throw new Error("tenantId is required for Multi-Tenant Baileys Auth State");

    // 1. Create the tenant-aware auth table if it doesn't exist.
    //    NOTE: For brand-new installs we omit the legacy PRIMARY KEY (tenant_id, id) — that key
    //    blocks multi-account because two accounts in the same tenant would collide on id='creds'.
    //    The database.js migration replaces the legacy PK with partial unique indexes; we skip
    //    creating the PK here so fresh installs match.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth_multi (
            tenant_id VARCHAR(255) NOT NULL,
            id VARCHAR(255) NOT NULL,
            data JSONB NOT NULL,
            account_id UUID
        );
    `);
    // Defensive: ensure account_id column exists on installs that pre-date this change.
    await pool.query("ALTER TABLE baileys_auth_multi ADD COLUMN IF NOT EXISTS account_id UUID;").catch(() => { });
    // Defensive: create the partial unique indexes (idempotent — also created in database.js migration).
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_auth_multi_account_unique
            ON baileys_auth_multi(tenant_id, account_id, id)
            WHERE account_id IS NOT NULL;
    `).catch(() => { });
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_auth_multi_legacy_unique
            ON baileys_auth_multi(tenant_id, id)
            WHERE account_id IS NULL;
    `).catch(() => { });

    const accountFilter = accountId ? 'AND account_id = $3' : 'AND account_id IS NULL';
    const accountParams = accountId ? [accountId] : [];
    const tag = accountId ? `${tenantId}:${String(accountId).slice(0, 8)}` : tenantId;

    const readData = async (id) => {
        try {
            const { rows } = await pool.query(
                `SELECT data FROM baileys_auth_multi WHERE tenant_id = $1 AND id = $2 ${accountFilter}`,
                [tenantId, id, ...accountParams]
            );
            if (rows.length > 0) {
                return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`[${tag}] Error reading auth data from Postgres:`, error.message);
            return null;
        }
    };

    const writeData = async (data, id) => {
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer);
            if (accountId) {
                // Multi-account write: ON CONFLICT against the partial unique index for non-null account_id.
                await pool.query(
                    `INSERT INTO baileys_auth_multi (tenant_id, id, data, account_id)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (tenant_id, account_id, id) WHERE account_id IS NOT NULL
                     DO UPDATE SET data = EXCLUDED.data`,
                    [tenantId, id, serialized, accountId]
                );
            } else {
                // Legacy write (no account_id) — uses the partial index for null account_id.
                // Should only happen during the migration window before backfill completes.
                await pool.query(
                    `INSERT INTO baileys_auth_multi (tenant_id, id, data)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (tenant_id, id) WHERE account_id IS NULL
                     DO UPDATE SET data = EXCLUDED.data`,
                    [tenantId, id, serialized]
                );
            }
        } catch (error) {
            console.error(`[${tag}] Error writing auth data to Postgres:`, error.message);
        }
    };

    const removeData = async (id) => {
        try {
            await pool.query(
                `DELETE FROM baileys_auth_multi WHERE tenant_id = $1 AND id = $2 ${accountFilter}`,
                [tenantId, id, ...accountParams]
            );
        } catch (error) {
            console.error(`[${tag}] Error removing auth data from Postgres:`, error.message);
        }
    };

    // 2. Fetch or initialize creds
    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds'),
        clearState: async () => {
            try {
                await pool.query(
                    `DELETE FROM baileys_auth_multi WHERE tenant_id = $1 ${accountFilter.replace('$3', '$2')}`,
                    accountId ? [tenantId, accountId] : [tenantId]
                );
            } catch (error) {
                console.error(`[${tag}] Error clearing auth state:`, error);
            }
        },
    };
};

/**
 * Legacy: Returns a list of all distinct tenant IDs that currently have a saved WhatsApp session creds.
 * Kept for backward compatibility — new code should use getAllAuthenticatedAccounts(pool).
 */
const getAllAuthenticatedTenants = async (pool) => {
    try {
        const result = await pool.query(
            "SELECT DISTINCT tenant_id FROM baileys_auth_multi WHERE id = 'creds'"
        );
        return result.rows.map(row => row.tenant_id);
    } catch (err) {
        console.error("❌ Error fetching authenticated tenants from Postgres:", err.message);
        return [];
    }
};

/**
 * Returns (tenantId, accountId) pairs for all WhatsApp accounts that currently have
 * persisted Baileys credentials. Used by the worker on boot to start every active session.
 */
const getAllAuthenticatedAccounts = async (pool) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT tenant_id, account_id
            FROM baileys_auth_multi
            WHERE id = 'creds' AND account_id IS NOT NULL
        `);
        return result.rows.map(row => ({ tenantId: row.tenant_id, accountId: row.account_id }));
    } catch (err) {
        console.error("❌ Error fetching authenticated accounts from Postgres:", err.message);
        return [];
    }
};

module.exports = {
    usePostgresAuthState,
    getAllAuthenticatedTenants,
    getAllAuthenticatedAccounts
};
