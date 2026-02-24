const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

module.exports = async (pool) => {
    // 1. Create the auth table if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth (
            id VARCHAR(255) PRIMARY KEY,
            data JSONB NOT NULL
        );
    `);

    const readData = async (id) => {
        try {
            const { rows } = await pool.query('SELECT data FROM baileys_auth WHERE id = $1', [id]);
            if (rows.length > 0) {
                return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error('Error reading auth data from Postgres:', error.message);
            return null;
        }
    };

    const writeData = async (data, id) => {
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer);
            await pool.query(
                `INSERT INTO baileys_auth (id, data) 
                 VALUES ($1, $2) 
                 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
                [id, serialized]
            );
        } catch (error) {
            console.error('Error writing auth data to Postgres:', error.message);
        }
    };

    const removeData = async (id) => {
        try {
            await pool.query('DELETE FROM baileys_auth WHERE id = $1', [id]);
        } catch (error) {
            console.error('Error removing auth data from Postgres:', error.message);
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
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                await writeData(value, key);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds'),
        clearState: async () => {
            try {
                await pool.query('DELETE FROM baileys_auth');
            } catch (error) {
                console.error('Error clearing auth state:', error);
            }
        },
    };
};
