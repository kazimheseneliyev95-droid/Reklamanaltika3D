import { Lead, LeadStatus, DateRange } from '../types/crm';
import { io, Socket } from 'socket.io-client';
import { faker } from '@faker-js/faker';

const getStorageKey = () => `dualite_crm_leads_v3_${localStorage.getItem('crm_tenant_id') || 'admin'}`;
const SERVER_URL_KEY = 'dualite_server_url';

class CrmServiceImpl {
  private socket: Socket | null = null;
  private serverUrl: string = '';
  private qrCallback: ((qr: string) => void) | null = null;
  private authCallback: (() => void) | null = null;

  // Improved listener arrays with unique IDs for cleanup
  private messageListeners: Map<string, (lead: Lead) => void> = new Map();
  private leadUpdateListeners: Map<string, (lead: Lead) => void> = new Map();
  private testMessageListeners: Map<string, (data: any) => void> = new Map();
  private healthListeners: Map<string, (health: any) => void> = new Map();

  // Demo Mode State
  private isDemoMode: boolean = false;
  private demoInterval: any = null;

  // 🆕 In-memory cache for better performance and deduplication
  private leadsCache: Lead[] = [];
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 5000; // 5 seconds

  // 🆕 De-duplication cache
  private readonly PROCESSED_MESSAGES_TTL = 30000; // 30 seconds
  private processedMessageIds = new Map<string, number>();

  private listenerIdCounter = 0;

  // --- SERVER CONNECTION ---
  getServerUrl() {
    const saved = localStorage.getItem(SERVER_URL_KEY);
    if (saved) return saved;
    return this.serverUrl || (import.meta as any).env.VITE_SERVER_URL || 'http://localhost:4000';
  }

  // 🆕 Auto-reconnect on application boot
  public autoConnect() {
    const savedUrl = localStorage.getItem(SERVER_URL_KEY);
    const token = localStorage.getItem('crm_auth_token');

    // Only auto-connect if we have a saved URL and an active auth session
    if (savedUrl && token && !this.socket) {
      console.log('🔄 Auto-connecting to saved CRM backend:', savedUrl);
      this.connectToServer(savedUrl).catch(err => {
        console.warn('⚠️ Auto-connect failed:', err);
      });
    }
  }

  async connectToServer(url: string): Promise<boolean> {
    if (url === 'demo') {
      this.isDemoMode = true;
      this.startDemoSimulation();
      return true;
    }

    this.isDemoMode = false;
    this.serverUrl = url;

    localStorage.setItem(SERVER_URL_KEY, url);
    console.log('💾 Server URL saved to localStorage:', url);

    try {
      if (this.socket) {
        this.cleanupSocketListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      this.socket = io(url, {
        withCredentials: true,
        transports: ['websocket', 'polling'],
        auth: { token: localStorage.getItem('crm_auth_token') },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
        timeout: 60000,
        forceNew: true
      });

      return new Promise((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let resolved = false;

        this.socket?.on('connect', () => {
          console.log('✅ Connected to backend successfully!');
          if (timeoutId) clearTimeout(timeoutId);
          if (!resolved) {
            resolved = true;
            this.setupSocketListeners();
            resolve(true);
          }
        });

        this.socket?.on('connect_error', (error) => {
          console.error('❌ Connection failed:', error.message);
          if (timeoutId) clearTimeout(timeoutId);
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
        });

        this.socket?.on('disconnect', (reason) => {
          console.warn('🔌 Socket disconnected:', reason);
          this.cleanupSocketListeners();
        });

        timeoutId = setTimeout(() => {
          console.warn('⏱️ Connection timeout - server is taking too long to respond');
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
        }, 60000);
      });
    } catch (e) {
      console.error('❌ Connection error:', e);
      return false;
    }
  }

  disconnect() {
    if (this.isDemoMode) {
      this.isDemoMode = false;
      if (this.demoInterval) {
        clearInterval(this.demoInterval);
        this.demoInterval = null;
      }
      if (this.authCallback) this.authCallback();
    }

    if (this.socket) {
      this.cleanupSocketListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    // Clear cache
    this.leadsCache = [];
    this.cacheTimestamp = 0;
    this.processedMessageIds.clear();
  }

  // 🆕 Cleanup socket listeners properly
  private cleanupSocketListeners() {
    if (!this.socket) return;

    // Remove all listeners
    this.socket.off('qr_code');
    this.socket.off('authenticated');
    this.socket.off('crm:test_incoming_message');
    this.socket.off('crm:health_check');
    this.socket.off('new_message');
    this.socket.off('lead_updated');
    this.socket.off('lead_deleted');
    this.socket.off('connect');
    this.socket.off('connect_error');
    this.socket.off('disconnect');

    console.log('🧹 Socket listeners cleaned up');
  }

  private startDemoSimulation() {
    console.log("Starting Demo Simulation...");

    setTimeout(() => {
      if (this.qrCallback) this.qrCallback('DEMO_QR_CODE_DATA');

      setTimeout(() => {
        if (this.authCallback) this.authCallback();

        this.demoInterval = setInterval(async () => {
          if (!this.isDemoMode) return;

          const fakeLead: Omit<Lead, 'id' | 'created_at' | 'updated_at'> = {
            phone: faker.phone.number(),
            name: faker.person.fullName(),
            last_message: faker.helpers.arrayElement([
              "Salam, qiymət?",
              "How much is this?",
              "Çatdırılma var?",
              "Sifariş vermək istəyirəm",
              "Rəngləri var?"
            ]),
            status: 'new',
            source: 'whatsapp',
            value: 0
          };

          const savedLead = await this.addLead(fakeLead);
          this.notifyMessageListeners(savedLead);

        }, 15000);

      }, 2000);
    }, 500);
  }

  private setupSocketListeners() {
    if (!this.socket) return;

    this.socket.on('qr_code', (qr) => {
      console.log('📱 QR RECEIVED');
      if (this.qrCallback) this.qrCallback(qr);
    });

    this.socket.on('authenticated', () => {
      console.log('🔑 AUTHENTICATED');
      if (this.authCallback) this.authCallback();
    });

    this.socket.on('crm:test_incoming_message', (data: any) => {
      console.log('🧪 TEST MESSAGE:', data);
      this.notifyTestMessageListeners(data);
    });

    this.socket.on('crm:health_check', (health: any) => {
      this.notifyHealthListeners(health);
    });

    this.socket.on('new_message', async (data: any) => {
      console.log('⚡ SOCKET: new_message received', data);

      const now = Date.now();

      // De-dup by whatsapp_id
      if (data.whatsapp_id) {
        const lastProcessed = this.processedMessageIds.get(data.whatsapp_id);
        if (lastProcessed && (now - lastProcessed) < this.PROCESSED_MESSAGES_TTL) {
          console.log('⏭️ Skipping recently processed message:', data.whatsapp_id);
          return;
        }
      }

      // Fuzzy phone-based dedup (last 9 digits)
      const incomingPhone = String(data.phone || '').replace(/\D/g, '');
      const incomingSuffix9 = incomingPhone.slice(-9);

      const cachedLead = this.leadsCache.find(l => {
        const cachedPhone = String(l.phone || '').replace(/\D/g, '');
        const cachedSuffix9 = cachedPhone.slice(-9);
        // Match by whatsapp_id OR fuzzy phone suffix
        return (l as any).whatsapp_id === data.whatsapp_id ||
          (incomingSuffix9.length >= 7 && cachedSuffix9 === incomingSuffix9);
      });

      if (cachedLead && (cachedLead as any).whatsapp_id === data.whatsapp_id && data.is_fast_emit === false && (cachedLead as any).is_fast_emit) {
        const updatedLead = { ...cachedLead, name: data.name, is_fast_emit: false };
        await this.updateLead(updatedLead.id, updatedLead);
        this.notifyMessageListeners(updatedLead);
        return;
      }

      // Build lead — carry forward existing value and status from cache if present
      const existingValue = cachedLead?.value ?? 0;
      const existingStatus = cachedLead?.status ?? 'new';

      const newLead: Omit<Lead, 'id' | 'created_at' | 'updated_at'> = {
        phone: data.phone,
        name: data.name || 'WhatsApp User',
        last_message: data.message,
        // Preserve existing status — let auto-rules in Store.tsx override if needed
        status: existingStatus as any,
        source: 'whatsapp',
        // NEVER clear a previously-set value: keep the larger of the two
        value: existingValue,
        whatsapp_id: data.whatsapp_id,
        is_fast_emit: data.is_fast_emit
      };

      // Mark as processed
      if (data.whatsapp_id) {
        this.processedMessageIds.set(data.whatsapp_id, now);
      }

      this.cleanupOldProcessedMessages();

      const savedLead = await this.addLead(newLead);
      console.log('✨ New lead saved:', savedLead.phone);
      this.notifyMessageListeners(savedLead);
    });


    this.socket.on('lead_updated', async (updatedLead: Lead) => {
      console.log('🔄 SOCKET: lead_updated received', updatedLead);

      // Update cache
      const cacheIndex = this.leadsCache.findIndex(l =>
        l.id === updatedLead.id || l.phone === updatedLead.phone
      );

      if (cacheIndex !== -1) {
        this.leadsCache[cacheIndex] = updatedLead;
      } else {
        this.leadsCache.unshift(updatedLead);
      }

      // Update localStorage to match database
      const raw = localStorage.getItem(getStorageKey());
      const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
      const index = allLeads.findIndex(l => l.phone === updatedLead.phone);

      if (index !== -1) {
        allLeads[index] = updatedLead;
        localStorage.setItem(getStorageKey(), JSON.stringify(allLeads));
        console.log('✅ Lead synced with database');
        this.notifyLeadUpdateListeners(updatedLead);
      }
    });

    this.socket.on('lead_deleted', (id: string) => {
      console.log('🗑️ SOCKET: lead_deleted received', id);

      const raw = localStorage.getItem(getStorageKey());
      const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
      const updated = allLeads.filter(l => l.id !== id);
      localStorage.setItem(getStorageKey(), JSON.stringify(updated));

      this.leadsCache = this.leadsCache.filter(l => l.id !== id);
      this.notifyLeadDeletedListeners(id);
    });

    this.socket.on('leads_reset', () => {
      console.log('🌀 SOCKET: leads_reset received');
      this.leadsCache = [];
      localStorage.removeItem(getStorageKey());
      if ((this as any).resetListeners) {
        (this as any).resetListeners.forEach((cb: () => void) => cb());
      }
    });
  }

  // 🆕 Clean up old processed message IDs
  private cleanupOldProcessedMessages() {
    const now = Date.now();
    for (const [id, timestamp] of this.processedMessageIds.entries()) {
      if (now - timestamp > this.PROCESSED_MESSAGES_TTL) {
        this.processedMessageIds.delete(id);
      }
    }
  }

  // 🆕 Helper methods to notify listeners
  private leadDeletedListeners: Map<string, (id: string) => void> = new Map();

  private notifyMessageListeners(lead: Lead) {
    this.messageListeners.forEach(cb => cb(lead));
  }

  private notifyLeadUpdateListeners(lead: Lead) {
    this.leadUpdateListeners.forEach(cb => cb(lead));
  }

  private notifyLeadDeletedListeners(id: string) {
    this.leadDeletedListeners.forEach(cb => cb(id));
  }

  private notifyTestMessageListeners(data: any) {
    this.testMessageListeners.forEach(cb => cb(data));
  }

  private notifyHealthListeners(health: any) {
    this.healthListeners.forEach(cb => cb(health));
  }

  // --- EVENT LISTENERS ---
  onQrCode(cb: (qr: string) => void) {
    this.qrCallback = cb;
  }

  onAuthenticated(cb: () => void) {
    this.authCallback = cb;
  }

  onNewMessage(cb: (lead: Lead) => void): () => void {
    const id = `msg-${this.listenerIdCounter++}`;
    this.messageListeners.set(id, cb);

    // Return cleanup function
    return () => {
      this.messageListeners.delete(id);
    };
  }

  onLeadUpdated(cb: (lead: Lead) => void): () => void {
    const id = `update-${this.listenerIdCounter++}`;
    this.leadUpdateListeners.set(id, cb);

    return () => {
      this.leadUpdateListeners.delete(id);
    };
  }

  onLeadDeleted(cb: (id: string) => void): () => void {
    const listenerId = `delete-${this.listenerIdCounter++}`;
    this.leadDeletedListeners.set(listenerId, cb);

    return () => {
      this.leadDeletedListeners.delete(listenerId);
    };
  }

  onLeadsReset(cb: () => void): () => void {
    const id = `reset-${this.listenerIdCounter++}`;
    // Using a new map for reset listeners
    if (!(this as any).resetListeners) (this as any).resetListeners = new Map();
    (this as any).resetListeners.set(id, cb);
    return () => (this as any).resetListeners.delete(id);
  }


  onTestMessage(cb: (data: any) => void): () => void {
    const id = `test-${this.listenerIdCounter++}`;
    this.testMessageListeners.set(id, cb);

    return () => {
      this.testMessageListeners.delete(id);
    };
  }

  onHealthCheck(cb: (health: any) => void): () => void {
    const id = `health-${this.listenerIdCounter++}`;
    this.healthListeners.set(id, cb);

    return () => {
      this.healthListeners.delete(id);
    };
  }

  private getAuthHeaders(): { [key: string]: string } {
    const token = localStorage.getItem('crm_auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  async fetchRecentMessages(limit: number = 30): Promise<any[]> {
    if (!this.serverUrl) return [];
    try {
      const response = await fetch(`${this.serverUrl}/chats/recent?limit=${limit}`, {
        headers: this.getAuthHeaders()
      });
      const data = await response.json();
      // 🆕 Fixed: Direct array, not data.messages
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error('❌ Error fetching recent messages:', e);
      return [];
    }
  }

  // --- DATA METHODS (DATABASE API) ---

  /**
   * Get leads with caching for better performance
   */
  async getLeads(dateRange?: DateRange): Promise<Lead[]> {
    const now = Date.now();

    // Check cache first
    if (this.leadsCache.length > 0 && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      console.log('📦 Returning cached leads');
      return this.filterLeadsByDate(this.leadsCache, dateRange);
    }

    // Try database API first
    if (this.serverUrl) {
      try {
        const params = new URLSearchParams();
        if (dateRange?.start) params.append('startDate', dateRange.start);
        if (dateRange?.end) params.append('endDate', dateRange.end);

        const response = await fetch(`${this.serverUrl}/api/leads?${params}`, {
          headers: this.getAuthHeaders()
        });
        if (response.ok) {
          const leads = await response.json();
          this.leadsCache = leads;
          this.cacheTimestamp = now;
          localStorage.setItem(getStorageKey(), JSON.stringify(leads));
          return leads;
        }
      } catch (error) {
        console.warn('⚠️ Failed to fetch from database, using localStorage fallback:', error);
      }
    }

    // Fallback to localStorage
    const raw = localStorage.getItem(getStorageKey());
    let leads: Lead[] = raw ? JSON.parse(raw) : [];

    this.leadsCache = leads;
    this.cacheTimestamp = now;

    return this.filterLeadsByDate(leads, dateRange);
  }

  private filterLeadsByDate(leads: Lead[], dateRange?: DateRange): Lead[] {
    if (!dateRange || (!dateRange.start && !dateRange.end)) {
      return leads.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    let filtered = leads;

    if (dateRange.start) {
      const startDate = new Date(dateRange.start);
      startDate.setHours(0, 0, 0, 0);
      filtered = filtered.filter(l => new Date(l.created_at) >= startDate);
    }
    if (dateRange.end) {
      const endDate = new Date(dateRange.end);
      endDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(l => new Date(l.created_at) <= endDate);
    }

    return filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  async addLead(lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>): Promise<Lead> {
    // Try database API first
    if (this.serverUrl) {
      try {
        const response = await fetch(`${this.serverUrl}/api/leads`, {
          method: 'POST',
          headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(lead)
        });

        if (response.ok) {
          const savedLead = await response.json();
          console.log('✅ Lead saved to database:', savedLead.phone);
          this.updateCacheAndStorage(savedLead);
          return savedLead;
        }
      } catch (error) {
        console.warn('⚠️ Failed to save to database, using localStorage:', error);
      }
    }

    // Fallback: localStorage only
    const raw = localStorage.getItem(getStorageKey());
    const allLeads: Lead[] = raw ? JSON.parse(raw) : [];

    // Fuzzy phone match for localStorage dedup (last 9 digits)
    const incomingPhone = String(lead.phone || '').replace(/\D/g, '');
    const incomingSuffix = incomingPhone.slice(-9);
    const existingIndex = allLeads.findIndex(l => {
      const p = String(l.phone || '').replace(/\D/g, '');
      return p === incomingPhone || (incomingSuffix.length >= 7 && p.slice(-9) === incomingSuffix);
    });

    if (existingIndex !== -1) {
      console.log(`♻️ Upserting existing lead (localStorage): ${lead.phone}`);
      const existingLead = allLeads[existingIndex];
      existingLead.last_message = lead.last_message;
      existingLead.updated_at = new Date().toISOString();
      if (lead.name && lead.name !== 'WhatsApp User') existingLead.name = lead.name;
      if (lead.source_contact_name) existingLead.source_contact_name = lead.source_contact_name;
      if (lead.source_message) existingLead.source_message = lead.source_message;
      if (lead.whatsapp_id) existingLead.whatsapp_id = lead.whatsapp_id;
      // Preserve value — only overwrite if the incoming has a larger value
      if (lead.value && lead.value > (existingLead.value || 0)) existingLead.value = lead.value;
      allLeads.splice(existingIndex, 1);
      const updatedList = [existingLead, ...allLeads];
      localStorage.setItem(getStorageKey(), JSON.stringify(updatedList));
      this.leadsCache = updatedList;
      this.cacheTimestamp = Date.now();
      return existingLead;
    }

    const newLead: Lead = {
      ...lead,
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `lead-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const updated = [newLead, ...allLeads];
    localStorage.setItem(getStorageKey(), JSON.stringify(updated));
    this.leadsCache = updated;
    this.cacheTimestamp = Date.now();
    return newLead;
  }

  private updateCacheAndStorage(lead: Lead) {
    // Update cache
    const existingIndex = this.leadsCache.findIndex(l => l.phone === lead.phone);
    if (existingIndex !== -1) {
      this.leadsCache[existingIndex] = lead;
    } else {
      this.leadsCache.unshift(lead);
    }

    // Update localStorage
    const raw = localStorage.getItem(getStorageKey());
    const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
    const storageIndex = allLeads.findIndex(l => l.phone === lead.phone);
    if (storageIndex !== -1) {
      allLeads[storageIndex] = lead;
    } else {
      allLeads.unshift(lead);
    }
    localStorage.setItem(getStorageKey(), JSON.stringify(allLeads));
    this.cacheTimestamp = Date.now();
  }

  async updateLead(id: string, updates: Partial<Lead>): Promise<void> {
    // Update database if available
    if (this.serverUrl) {
      const isStatusOnly = updates.status && Object.keys(updates).length === 1;

      try {
        const endpoint = isStatusOnly
          ? `${this.serverUrl}/api/leads/${id}/status`
          : `${this.serverUrl}/api/leads/${id}`;

        const response = await fetch(endpoint, {
          method: 'PUT',
          headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(isStatusOnly ? { status: updates.status } : updates)
        });

        if (response.ok) {
          console.log(`✅ Lead ${isStatusOnly ? 'status' : 'fields'} updated in database and broadcasted`);
        } else {
          console.warn('⚠️ Server returned non-ok status for update');
        }
      } catch (error) {
        console.warn('⚠️ Failed to update database:', error);
      }
    }

    // Always update localStorage cache
    const raw = localStorage.getItem(getStorageKey());
    const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
    const updated = allLeads.map(l =>
      l.id === id ? { ...l, ...updates, updated_at: new Date().toISOString() } : l
    );
    localStorage.setItem(getStorageKey(), JSON.stringify(updated));

    // Update cache
    const cacheIndex = this.leadsCache.findIndex(l => l.id === id);
    if (cacheIndex !== -1) {
      this.leadsCache[cacheIndex] = { ...this.leadsCache[cacheIndex], ...updates, updated_at: new Date().toISOString() };
    }
    this.cacheTimestamp = Date.now();
  }

  async updateStatus(id: string, status: LeadStatus): Promise<void> {
    await this.updateLead(id, { status });
  }

  async deleteLead(id: string): Promise<void> {
    if (this.serverUrl) {
      try {
        const response = await fetch(`${this.serverUrl}/api/leads/${id}`, {
          method: 'DELETE',
          headers: this.getAuthHeaders()
        });
        if (response.ok) {
          console.log(`✅ Lead ${id} deleted from database`);
        } else {
          console.warn(`⚠️ Failed to delete lead from database: ${response.status}`);
        }
      } catch (error) {
        console.warn('⚠️ Network error deleting lead from database:', error);
      }
    }

    const raw = localStorage.getItem(getStorageKey());
    const allLeads: Lead[] = raw ? JSON.parse(raw) : [];

    const updated = allLeads.filter(l => l.id !== id);
    localStorage.setItem(getStorageKey(), JSON.stringify(updated));

    // Update cache
    this.leadsCache = this.leadsCache.filter(l => l.id !== id);
    this.cacheTimestamp = Date.now();
  }

  /**
   * Clear all leads (for testing/reset)
   */
  async clearAllLeads(): Promise<void> {
    // Try database first
    if (this.serverUrl) {
      try {
        const leads = await this.getLeads();
        for (const lead of leads) {
          await fetch(`${this.serverUrl}/api/leads/${lead.id}`, {
            method: 'DELETE',
            headers: this.getAuthHeaders()
          });
        }
        console.log('✅ All leads cleared from database');
      } catch (error) {
        console.warn('⚠️ Failed to clear database leads:', error);
      }
    }

    // Clear localStorage and cache
    localStorage.removeItem(getStorageKey());
    this.leadsCache = [];
    this.cacheTimestamp = 0;
    this.processedMessageIds.clear();
    console.log('✅ All leads cleared');
  }
}

export const CrmService = new CrmServiceImpl();
