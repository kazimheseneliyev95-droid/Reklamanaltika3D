require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.endsWith('.pooler.supabase.com') && (!parsed.port || parsed.port === '5432')) {
      parsed.port = '6543';
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

async function run() {
  const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL || '');
  if (!connectionString) {
    throw new Error('DATABASE_URL is missing');
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  const tables = ['leads', 'messages', 'follow_ups', 'audit_logs', 'users', 'lead_reads'];

  await client.connect();
  try {
    const backup = {
      createdAt: new Date().toISOString(),
      connectionHost: new URL(connectionString).hostname,
      tables: {},
    };

    for (const table of tables) {
      const result = await client.query(`SELECT * FROM ${table}`);
      backup.tables[table] = result.rows;
    }

    const backupsDir = path.join(process.cwd(), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupsDir, `crm-backup-${stamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));
    console.log(filePath);
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
