const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'leads.json');

function buildFallbackUser() {
    const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const passwordHash = String(process.env.ADMIN_PASSWORD || '').trim();
    if (!passwordHash) {
        return null;
    }
    return {
        id: 'file-admin',
        username,
        password_hash: passwordHash,
        role: 'admin',
        permissions: {},
        tenant_id: 'admin',
        display_name: process.env.ADMIN_DISPLAY_NAME || 'Local Admin',
        tenant_status: 'active',
        tenant_display_name: process.env.ADMIN_DISPLAY_NAME || 'Local Admin'
    };
}

function readDb() {
    if (!fs.existsSync(DB_FILE)) {
        return { leads: [] };
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return { leads: [] };
    }
}

function writeDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Ensure DB file exists
if (!fs.existsSync(DB_FILE)) {
    writeDb({ leads: [] });
}

module.exports = {
    initDb: async () => {
        if (!buildFallbackUser()) {
            console.warn('⚠️ FileDB auth is disabled because ADMIN_PASSWORD is not set.');
        }
        console.log('✅ FileDB: Ready');
    },

    findUserByUsername: async (username) => {
        const user = buildFallbackUser();
        if (!user) return null;
        return user.username === String(username || '').trim().toLowerCase() ? { ...user } : null;
    },

    getUsers: async () => {
        const user = buildFallbackUser();
        if (!user) return [];
        return [{
            id: user.id,
            username: user.username,
            role: user.role,
            permissions: user.permissions,
            tenant_id: user.tenant_id,
            display_name: user.display_name,
            created_at: null
        }];
    },

    getTenantAdmin: async (tenantId) => {
        if (String(tenantId || 'admin') !== 'admin') return null;
        const user = buildFallbackUser();
        if (!user) return null;
        return {
            id: user.id,
            username: user.username,
            role: user.role,
            permissions: user.permissions,
            tenant_id: user.tenant_id,
            display_name: user.display_name,
            tenant_status: user.tenant_status
        };
    },

    createLead: async (data) => {
        const db = readDb();
        const existingIndex = db.leads.findIndex(l => l.phone === data.phone);

        if (existingIndex >= 0) {
            // Updatte existing
            const updated = { ...db.leads[existingIndex], ...data, updated_at: new Date().toISOString() };
            db.leads[existingIndex] = updated;
            writeDb(db);
            return updated;
        }

        const newLead = {
            id: crypto.randomUUID(),
            ...data,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: data.status || 'new',
            source: 'whatsapp'
        };
        db.leads.push(newLead);
        writeDb(db);
        return newLead;
    },

    findLeadByPhone: async (phone) => {
        const db = readDb();
        return db.leads.find(l => l.phone === phone);
    },

    findLeadByWhatsAppId: async (wid) => {
        const db = readDb();
        return db.leads.find(l => l.whatsapp_id === wid);
    },

    updateLeadMessage: async (phone, msg, wid, name) => {
        const db = readDb();
        const lead = db.leads.find(l => l.phone === phone);
        if (lead) {
            lead.last_message = msg;
            if (wid) lead.whatsapp_id = wid;
            if (name) lead.name = name;
            lead.updated_at = new Date().toISOString();
            writeDb(db);
            return lead;
        }
        return null;
    },

    updateLeadStatus: async (id, status) => {
        const db = readDb();
        const lead = db.leads.find(l => l.id === id);
        if (lead) {
            lead.status = status;
            lead.updated_at = new Date().toISOString();
            writeDb(db);
            return lead;
        }
        return null;
    },

    deleteLead: async (id) => {
        const db = readDb();
        const index = db.leads.findIndex(l => l.id === id);
        if (index === -1) return null;
        const [removed] = db.leads.splice(index, 1);
        writeDb(db);
        return removed;
    },

    deleteAllLeads: async () => {
        writeDb({ leads: [] });
        return true;
    },

    getLeads: async (filters = {}) => {
        let leads = readDb().leads;
        if (filters.status) leads = leads.filter(l => l.status === filters.status);
        return leads.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },

    getLeadStats: async () => {
        const leads = readDb().leads;
        return {
            total: leads.length,
            new: leads.filter(l => l.status === 'new').length,
            potential: leads.filter(l => l.status === 'potential').length,
            won: leads.filter(l => l.status === 'won').length
        };
    },

    logAuditAction: async () => true,

    healthCheck: async () => ({ status: 'healthy', type: 'json-file' })
};
