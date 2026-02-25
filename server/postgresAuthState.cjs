const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

module.exports = async (pool, tenantId) => {
    if (!tenantId) throw new Error("tenantId is required for Multi-Tenant Baileys Auth State");

    // 1. Create the tenant-aware auth table if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth_multi (
            tenant_id VARCHAR(255) NOT NULL,
            id VARCHAR(255) NOT NULL,
            data JSONB NOT NULL,
            PRIMARY KEY (tenant_id, id)
        );
    `);

    const readData = async (id) => {
        try {
            const { rows } = await pool.query('SELECT data FROM baileys_auth_multi WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
            if (rows.length > 0) {
                return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`[${tenantId}] Error reading auth data from Postgres:`, error.message);
            return null;
        }
    };

    const writeData = async (data, id) => {
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer);
            await pool.query(
                `INSERT INTO baileys_auth_multi (tenant_id, id, data) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (tenant_id, id) DO UPDATE SET data = EXCLUDED.data`,
                [tenantId, id, serialized]
            );
        } catch (error) {
            console.error(`[${tenantId}] Error writing auth data to Postgres:`, error.message);
        }
    };

    const removeData = async (id) => {
        try {
            await pool.query('DELETE FROM baileys_auth_multi WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
        } catch (error) {
            console.error(`[${tenantId}] Error removing auth data from Postgres:`, error.message);
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
                await pool.query('DELETE FROM baileys_auth_multi WHERE tenant_id = $1', [tenantId]);
            } catch (error) {
                console.error(`[${tenantId}] Error clearing auth state:`, error);
            }
        },
    };
};
