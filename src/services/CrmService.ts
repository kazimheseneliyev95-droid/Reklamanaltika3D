import { Lead, LeadStatus, DateRange } from '../types/crm';
import { io, Socket } from 'socket.io-client';
import { toNumberSafe } from '../lib/utils';

const DEV_LOG = import.meta.env.DEV;

function debugLog(...args: any[]) {
  if (DEV_LOG) console.log(...args);
}

const getStorageKey = () => `dualite_crm_leads_v3_${localStorage.getItem('crm_tenant_id') || 'admin'}`;
const SERVER_URL_KEY = 'dualite_server_url';
const DEMO_NAMES = ['Aysel', 'Murad', 'Nigar', 'Kamran', 'Laman', 'Elvin'];
const DEMO_MESSAGES = ['Salam, qiymet?', 'How much is this?', 'Catdirilma var?', 'Sifaris vermek isteyirem', 'Rengleri var?'];

function randomDigits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

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
  private settingsListeners: Map<string, (settings: any) => void> = new Map();
  private followupDueListeners: Map<string, (data: any) => void> = new Map();
  private notificationListeners: Map<string, (data: any) => void> = new Map();
  private leadsUpdatedListeners: Map<string, (leads: Lead[]) => void> = new Map();

  // Demo Mode State
  private isDemoMode: boolean = false;
  private demoInterval: any = null;

  // 🆕 In-memory cache for better performance and deduplication
  private leadsCache: Lead[] = [];

  // 🆕 De-duplication cache
  private readonly PROCESSED_MESSAGES_TTL = 30000; // 30 seconds
  private processedMessageIds = new Map<string, number>();

  private listenerIdCounter = 0;

  private normalizeLead(raw: any): Lead {
    const lead: any = (raw && typeof raw === 'object') ? { ...raw } : {};
    // PG numeric -> string; normalize for consistent client-side math
    lead.value = toNumberSafe(lead.value, 0);
    if (lead.unread_count !== undefined) lead.unread_count = toNumberSafe(lead.unread_count, 0);
    return lead as Lead;
  }

  // --- SERVER CONNECTION ---
  getServerUrl() {
    const saved = localStorage.getItem(SERVER_URL_KEY);
    if (saved) return saved;
    // In production, the frontend and backend are the same server (monolith),
    // so window.location.origin is ALWAYS the correct server URL.
    // This fixes the blank screen on new devices that have no localStorage.
    const isProd = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    if (isProd) {
      const origin = window.location.origin;
      localStorage.setItem(SERVER_URL_KEY, origin); // Save it so next time is instant
      return origin;
    }
    return this.serverUrl || (import.meta as any).env.VITE_SERVER_URL || 'http://localhost:4000';
  }

  // Auto-reconnect on application boot
  public autoConnect() {
    const token = localStorage.getItem('crm_auth_token');
    if (!token) return; // Not logged in, skip

    // In production, always connect to the current origin (no saved URL needed)
    // In development, use the saved URL from localStorage
    const isProd = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    const urlToUse = isProd
      ? window.location.origin
      : localStorage.getItem(SERVER_URL_KEY);

    if (urlToUse && !this.socket) {
      debugLog('🔄 Auto-connecting to CRM backend:', urlToUse);
      this.connectToServer(urlToUse).catch(err => {
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
    debugLog('💾 Server URL saved to localStorage:', url);

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
        reconnectionAttempts: Infinity,
        reconnectionDelay: 800,
        reconnectionDelayMax: 8000,
        timeout: 20000,
        forceNew: true
      });

      let hasConnectedOnce = false;

      // Always re-attach app listeners on (re)connect.
      this.socket.on('connect', () => {
        debugLog('✅ Connected to backend:', this.socket?.id);
        // Ensure we don't accumulate duplicate listeners after reconnect
        this.cleanupSocketListeners();
        this.setupSocketListeners();

        if (hasConnectedOnce) {
          debugLog('🔁 Socket reconnected — triggering data refresh...');
          this.notifyReconnectListeners();
        }
        hasConnectedOnce = true;
      });

      // Manager-level reconnect events (socket.io-client)
      try {
        (this.socket as any).io?.on('reconnect', () => {
          debugLog('🔁 Manager reconnect event');
          this.notifyReconnectListeners();
        });
      } catch {
        // ignore
      }

      return new Promise((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let resolved = false;

        this.socket?.on('connect', () => {
          if (timeoutId) clearTimeout(timeoutId);
          if (!resolved) {
            resolved = true;
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
          // Do NOT clean up app listeners here; they are re-attached on next connect.
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

  // 🚀 Manual WhatsApp Boot Command
  async startWhatsApp(): Promise<boolean> {
    try {
      if (this.isDemoMode) return true;
      const url = this.getServerUrl();
      if (!url) return false;

      debugLog('🚀 Triggering manual WhatsApp start...');
      const response = await this.authFetch(`${url}/api/whatsapp/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': localStorage.getItem('crm_tenant_id') || 'admin'
        }
      });

      const data = await response.json();
      debugLog('🚀 Manual start response:', data);
      return data.success;
    } catch (e) {
      console.error('❌ Failed to trigger manual WhatsApp start:', e);
      return false;
    }
  }

  // Lightweight connection info for settings UI
  getConnectionInfo() {
    return {
      serverUrl: this.getServerUrl(),
      socketConnected: Boolean(this.socket && this.socket.connected),
      isDemoMode: this.isDemoMode
    };
  }

  async fetchHealth(): Promise<any | null> {
    try {
      if (this.isDemoMode) {
        return {
          whatsapp: 'CONNECTED',
          connectedNumber: '+demo',
          socket_clients: 1,
          timestamp: new Date().toISOString(),
          database: { status: 'healthy' }
        };
      }

      const url = this.getServerUrl();
      if (!url) return null;
      const res = await this.authFetch(`${url}/health`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async reconnect(): Promise<boolean> {
    const url = this.getServerUrl();
    this.disconnect();
    if (!url) return false;
    return await this.connectToServer(url);
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
    this.socket.off('leads_updated');
    this.socket.off('settings_updated');
    this.socket.off('leads_reset');
    this.socket.off('lead_read');
    this.socket.off('followup_due');
    this.socket.off('notification:new');

    debugLog('🧹 Socket listeners cleaned up');
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
            phone: `994${randomDigits(9)}`,
            name: randomItem(DEMO_NAMES),
            last_message: randomItem(DEMO_MESSAGES),
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
      debugLog('📱 QR RECEIVED');
      if (this.qrCallback) this.qrCallback(qr);
    });

    this.socket.on('authenticated', () => {
      debugLog('🔑 AUTHENTICATED');
      if (this.authCallback) this.authCallback();
    });

    this.socket.on('crm:test_incoming_message', (data: any) => {
      debugLog('🧪 TEST MESSAGE:', data);
      this.notifyTestMessageListeners(data);
    });

    this.socket.on('crm:health_check', (health: any) => {
      this.notifyHealthListeners(health);
    });

    this.socket.on('settings_updated', (settings: any) => {
      debugLog('⚙️ SOCKET: settings_updated received');
      this.settingsListeners.forEach(cb => cb(settings));
    });

    this.socket.on('new_message', async (data: any) => {
      debugLog('⚡ SOCKET: new_message received', data);

      const now = Date.now();

      // De-dup by whatsapp_id
      if (data.whatsapp_id) {
        const lastProcessed = this.processedMessageIds.get(data.whatsapp_id);
        if (lastProcessed && (now - lastProcessed) < this.PROCESSED_MESSAGES_TTL) {
          debugLog('⏭️ Skipping recently processed message:', data.whatsapp_id);
          return;
        }
      }

      const incomingRawPhone = String(data.phone || '').trim();
      const incomingLower = incomingRawPhone.toLowerCase();
      const incomingIsExternal = incomingLower.startsWith('fb:') || incomingLower.startsWith('ig:') || incomingLower.startsWith('meta:');

      // Fuzzy phone-based dedup (last 9 digits) — WhatsApp only
      const incomingDigits = incomingRawPhone.replace(/\D/g, '');
      const incomingSuffix9 = incomingIsExternal ? '' : incomingDigits.slice(-9);

      const cachedLead = this.leadsCache.find(l => {
        const cachedRaw = String(l.phone || '').trim();
        const cachedLower = cachedRaw.toLowerCase();
        const cachedIsExternal = cachedLower.startsWith('fb:') || cachedLower.startsWith('ig:') || cachedLower.startsWith('meta:');

        // Match by whatsapp_id first
        if ((l as any).whatsapp_id && data.whatsapp_id && (l as any).whatsapp_id === data.whatsapp_id) return true;

        // External IDs: exact match only
        if (incomingIsExternal || cachedIsExternal) {
          return cachedLower !== '' && cachedLower === incomingLower;
        }

        // WhatsApp: fuzzy last-9 match
        const cachedDigits = cachedRaw.replace(/\D/g, '');
        const cachedSuffix9 = cachedDigits.slice(-9);
        return (incomingSuffix9.length >= 7 && cachedSuffix9 === incomingSuffix9);
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

      const source = (data.source === 'facebook' || data.source === 'instagram' || data.source === 'manual' || data.source === 'whatsapp')
        ? data.source
        : 'whatsapp';

      const defaultName = source === 'facebook'
        ? 'Facebook User'
        : source === 'instagram'
          ? 'Instagram User'
          : source === 'manual'
            ? 'Manual'
            : 'WhatsApp User';

      const newLead: Omit<Lead, 'id' | 'created_at' | 'updated_at'> = {
        phone: data.phone,
        name: data.name || defaultName,
        last_message: data.message,
        // Preserve existing status — let auto-rules in Store.tsx override if needed
        status: existingStatus as any,
        source: source,
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

      const messageLead = this.normalizeLead({
        ...(cachedLead || {}),
        ...newLead,
        id: data.lead_id || cachedLead?.id || '',
        created_at: cachedLead?.created_at || data.timestamp || new Date().toISOString(),
        updated_at: data.timestamp || new Date().toISOString(),
      } as any);
      const enrichedLead = { ...(messageLead as any), __fromMe: Boolean(data.fromMe), __message_whatsapp_id: data.whatsapp_id || null } as any;
      this.notifyMessageListeners(enrichedLead as any);
    });


    this.socket.on('lead_updated', async (updatedLead: Lead) => {
      debugLog('🔄 SOCKET: lead_updated received', updatedLead);

      const normalized = this.normalizeLead(updatedLead as any);

      // Update cache
      const cacheIndex = this.leadsCache.findIndex(l =>
        l.id === normalized.id || l.phone === normalized.phone
      );

      if (cacheIndex !== -1) {
        this.leadsCache[cacheIndex] = normalized;
      } else {
        this.leadsCache.unshift(normalized);
      }

      // Update localStorage to match database (robust to event ordering)
      // NOTE: lead_updated may arrive before new_message for brand-new leads.
      const raw = localStorage.getItem(getStorageKey());
      const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
      const index = allLeads.findIndex(l => (l.id && normalized.id && l.id === normalized.id) || l.phone === normalized.phone);

      if (index !== -1) {
        allLeads[index] = this.normalizeLead({ ...allLeads[index], ...normalized } as any) as any;
      } else {
        allLeads.unshift(normalized);
      }

      localStorage.setItem(getStorageKey(), JSON.stringify(allLeads));
      debugLog('✅ Lead synced with database');
      this.notifyLeadUpdateListeners(normalized);
    });

    this.socket.on('lead_deleted', (id: string) => {
      debugLog('🗑️ SOCKET: lead_deleted received', id);

      const raw = localStorage.getItem(getStorageKey());
      const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
      const updated = allLeads.filter(l => l.id !== id);
      localStorage.setItem(getStorageKey(), JSON.stringify(updated));

      this.leadsCache = this.leadsCache.filter(l => l.id !== id);
      this.notifyLeadDeletedListeners(id);
    });

    this.socket.on('leads_updated', (rows: Lead[]) => {
      try {
        const normalized = (Array.isArray(rows) ? rows : []).map((lead) => this.normalizeLead(lead as any));
        this.leadsCache = normalized;
        localStorage.setItem(getStorageKey(), JSON.stringify(normalized));
        this.leadsUpdatedListeners.forEach((cb) => cb(normalized));
      } catch {
        // ignore
      }
    });

    this.socket.on('lead_read', (data: any) => {
      try {
        const leadId = data?.leadId;
        if (!leadId) return;
        const ts = data?.timestamp || new Date().toISOString();
        const nextUnread = Number.isFinite(Number(data?.unread_count)) ? Number(data.unread_count) : 0;
        const idx = this.leadsCache.findIndex(l => l.id === leadId);
        if (idx !== -1) {
          const updated = { ...this.leadsCache[idx], unread_count: nextUnread, last_read_at: ts } as any;
          this.leadsCache[idx] = updated;

          const raw = localStorage.getItem(getStorageKey());
          const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
          const index = allLeads.findIndex(l => l.id === leadId);
          if (index !== -1) {
            allLeads[index] = updated as any;
            localStorage.setItem(getStorageKey(), JSON.stringify(allLeads));
          }

          this.notifyLeadUpdateListeners(updated as any);
        }
      } catch {
        // ignore
      }
    });

    this.socket.on('leads_reset', () => {
      debugLog('🌀 SOCKET: leads_reset received');
      this.leadsCache = [];
      localStorage.removeItem(getStorageKey());
      this.resetListeners.forEach((cb) => cb());
    });

    this.socket.on('followup_due', (data: any) => {
      try {
        this.followupDueListeners.forEach((cb) => cb(data));
      } catch {
        // ignore
      }
    });

    this.socket.on('notification:new', (data: any) => {
      try {
        this.notificationListeners.forEach((cb) => cb(data));
      } catch {
        // ignore
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
  private resetListeners: Map<string, () => void> = new Map();
  private reconnectListeners: Map<string, () => void> = new Map();

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
  onQrCode(cb: (qr: string) => void): () => void {
    this.qrCallback = cb;
    return () => {
      if (this.qrCallback === cb) this.qrCallback = null;
    };
  }

  onAuthenticated(cb: () => void): () => void {
    this.authCallback = cb;
    return () => {
      if (this.authCallback === cb) this.authCallback = null;
    };
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
    this.resetListeners.set(id, cb);
    return () => this.resetListeners.delete(id);
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

  onSettingsUpdated(cb: (settings: any) => void): () => void {
    const id = `settings-${this.listenerIdCounter++}`;
    this.settingsListeners.set(id, cb);
    return () => this.settingsListeners.delete(id);
  }

  // 🆕 Called when socket reconnects — Store.tsx uses this to refresh leads from DB
  onReconnect(cb: () => void): () => void {
    const id = `reconnect-${this.listenerIdCounter++}`;
    this.reconnectListeners.set(id, cb);
    return () => this.reconnectListeners.delete(id);
  }

  onFollowupDue(cb: (data: any) => void): () => void {
    const id = `followup-${this.listenerIdCounter++}`;
    this.followupDueListeners.set(id, cb);
    return () => this.followupDueListeners.delete(id);
  }

  onNotificationNew(cb: (data: any) => void): () => void {
    const id = `notif-${this.listenerIdCounter++}`;
    this.notificationListeners.set(id, cb);
    return () => this.notificationListeners.delete(id);
  }

  onLeadsUpdated(cb: (leads: Lead[]) => void): () => void {
    const id = `leads-${this.listenerIdCounter++}`;
    this.leadsUpdatedListeners.set(id, cb);
    return () => this.leadsUpdatedListeners.delete(id);
  }

  async fetchNotifications(opts?: { unreadOnly?: boolean; limit?: number }): Promise<{ notifications: any[]; unread_count: number }> {
    const url = this.getServerUrl();
    if (!url) return { notifications: [], unread_count: 0 };
    const unreadOnly = Boolean(opts?.unreadOnly);
    const limit = Number.isFinite(Number(opts?.limit)) ? Math.max(1, Math.min(200, Math.round(Number(opts?.limit)))) : 60;
    try {
      const q = new URLSearchParams();
      q.set('limit', String(limit));
      if (unreadOnly) q.set('unread', '1');
      const res = await fetch(`${url}/api/notifications?${q.toString()}`, {
        headers: this.getAuthHeaders()
      });
      if (!res.ok) return { notifications: [], unread_count: 0 };
      const data = await res.json().catch(() => ({}));
      return {
        notifications: Array.isArray(data?.notifications) ? data.notifications : [],
        unread_count: Number.isFinite(Number(data?.unread_count)) ? Number(data.unread_count) : 0,
      };
    } catch {
      return { notifications: [], unread_count: 0 };
    }
  }

  async markNotificationRead(id: string): Promise<boolean> {
    const url = this.getServerUrl();
    if (!url) return false;
    const nid = String(id || '').trim();
    if (!nid) return false;
    try {
      const res = await fetch(`${url}/api/notifications/${encodeURIComponent(nid)}/read`, {
        method: 'POST',
        headers: this.getAuthHeaders()
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async markAllNotificationsRead(): Promise<boolean> {
    const url = this.getServerUrl();
    if (!url) return false;
    try {
      const res = await fetch(`${url}/api/notifications/read-all`, {
        method: 'POST',
        headers: this.getAuthHeaders()
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private notifyReconnectListeners() {
    this.reconnectListeners.forEach(cb => cb());
  }

  private getAuthHeaders(): { [key: string]: string } {
    const token = localStorage.getItem('crm_auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  /**
   * SEC-02: Wrapper around fetch that always sends credentials: 'include'
   * so that the httpOnly auth cookie is automatically sent with every request.
   * The Bearer header is kept as a fallback for environments where cookies aren't available.
   */
  private authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const merged: RequestInit = {
      ...init,
      credentials: 'include',
      headers: {
        ...this.getAuthHeaders(),
        ...(init?.headers || {})
      }
    };
    return fetch(input, merged);
  }

  async fetchRecentMessages(limit: number = 30): Promise<any[]> {
    const url = this.getServerUrl();
    if (!url) return [];
    try {
      const response = await this.authFetch(`${url}/chats/recent?limit=${limit}`, {
      });
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error('❌ Error fetching recent messages:', e);
      return [];
    }
  }

  async getAnalyticsLayout(): Promise<any | null> {
    const url = this.getServerUrl();
    if (!url) return null;
    try {
      const res = await this.authFetch(`${url}/api/analytics/layout`, {
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.layout || null;
    } catch (e) {
      console.error('❌ Error fetching analytics layout:', e);
      return null;
    }
  }

  async saveAnalyticsLayout(layout: any): Promise<boolean> {
    const url = this.getServerUrl();
    if (!url) return false;
    try {
      const res = await this.authFetch(`${url}/api/analytics/layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Failed to save analytics layout');
      }
      return true;
    } catch (e) {
      console.error('❌ Error saving analytics layout:', e);
      throw e;
    }
  }

  async markLeadRead(leadId: string): Promise<boolean> {
    const url = this.getServerUrl();
    if (!url) return false;
    try {
      const res = await this.authFetch(`${url}/api/leads/${leadId}/read`, {
        method: 'POST'
      });

      if (res.ok) {
        try {
          const data = await res.json().catch(() => ({}));
          const lead = data?.lead || null;
          const nextUnread = Number.isFinite(Number(lead?.unread_count)) ? Number(lead.unread_count) : 0;
          const nextReadAt = lead?.last_read_at || new Date().toISOString();
          const idx = this.leadsCache.findIndex(l => l.id === leadId);
          if (idx !== -1) {
            const updated = { ...this.leadsCache[idx], unread_count: nextUnread, last_read_at: nextReadAt } as any;
            this.leadsCache[idx] = updated;

            const raw = localStorage.getItem(getStorageKey());
            const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
            const index = allLeads.findIndex(l => l.id === leadId);
            if (index !== -1) {
              allLeads[index] = updated as any;
              localStorage.setItem(getStorageKey(), JSON.stringify(allLeads));
            }

            this.notifyLeadUpdateListeners(updated as any);
          }
        } catch {
          // ignore
        }
      }

      return res.ok;
    } catch {
      return false;
    }
  }

  // --- DATA METHODS (DATABASE API) ---

  /**
   * Get leads with caching for better performance
   */
  async getLeads(dateRange?: DateRange): Promise<Lead[]> {
    const url = this.getServerUrl();

    // Skip cache and always hit DB — this ensures fresh data on every page open
    // Try database API first (always available in production via window.location.origin)
    if (url) {
      try {
        const params = new URLSearchParams();
        if (dateRange?.start) params.append('startDate', dateRange.start);
        if (dateRange?.end) params.append('endDate', dateRange.end);
        params.append('tzOffsetMinutes', String(new Date().getTimezoneOffset()));

        const response = await this.authFetch(`${url}/api/leads?${params}`, {
        });
        if (response.ok) {
          const leadsRaw = await response.json();
          const leads = (Array.isArray(leadsRaw) ? leadsRaw : []).map((l) => this.normalizeLead(l));
          this.leadsCache = leads;
          localStorage.setItem(getStorageKey(), JSON.stringify(leads));
          return this.filterLeadsByDate(leads, dateRange);
        }
      } catch (error) {
        console.warn('⚠️ Failed to fetch from database, using localStorage fallback:', error);
      }
    }

    // Fallback to localStorage
    const raw = localStorage.getItem(getStorageKey());
    let leads: Lead[] = (raw ? JSON.parse(raw) : []).map((l: any) => this.normalizeLead(l));

    this.leadsCache = leads;

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
    const url = this.getServerUrl();
    // Try database API first
    if (url) {
      try {
        const response = await this.authFetch(`${url}/api/leads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lead)
        });

        if (response.ok) {
          const savedLead = this.normalizeLead(await response.json());
          debugLog('✅ Lead saved to database:', savedLead.phone);
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
      debugLog(`♻️ Upserting existing lead (localStorage): ${lead.phone}`);
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
    return newLead;
  }

  private updateCacheAndStorage(lead: Lead) {
    const normalized = this.normalizeLead(lead);
    // Update cache
    const existingIndex = this.leadsCache.findIndex(l => l.phone === normalized.phone);
    if (existingIndex !== -1) {
      this.leadsCache[existingIndex] = normalized;
    } else {
      this.leadsCache.unshift(normalized);
    }

    // Update localStorage
    const raw = localStorage.getItem(getStorageKey());
    const allLeads: Lead[] = raw ? JSON.parse(raw) : [];
    const storageIndex = allLeads.findIndex(l => l.phone === normalized.phone);
    if (storageIndex !== -1) {
      allLeads[storageIndex] = normalized;
    } else {
      allLeads.unshift(normalized);
    }
    localStorage.setItem(getStorageKey(), JSON.stringify(allLeads));
  }

  async updateLead(id: string, updates: Partial<Lead>): Promise<void> {
    const url = this.getServerUrl();
    // Update database if available
    if (url) {
      const isStatusOnly = updates.status && Object.keys(updates).length === 1;

      try {
        const endpoint = isStatusOnly
          ? `${url}/api/leads/${id}/status`
          : `${url}/api/leads/${id}`;

        const response = await this.authFetch(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isStatusOnly ? { status: updates.status } : updates)
        });

        if (response.ok) {
          debugLog(`✅ Lead ${isStatusOnly ? 'status' : 'fields'} updated in database and broadcasted`);
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
  }

  async updateStatus(id: string, status: LeadStatus): Promise<void> {
    await this.updateLead(id, { status });
  }

  async deleteLead(id: string): Promise<void> {
    const url = this.getServerUrl();
    if (url) {
      try {
        const response = await this.authFetch(`${url}/api/leads/${id}`, {
          method: 'DELETE'
        });
        if (response.ok) {
          debugLog(`✅ Lead ${id} deleted from database`);
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
  }

  /**
   * Clear all leads (for testing/reset)
   */
  async clearAllLeads(): Promise<void> {
    // Try database first
    const url = this.getServerUrl();
    if (url) {
      try {
        const leads = await this.getLeads();
        for (const lead of leads) {
          await this.authFetch(`${url}/api/leads/${lead.id}`, {
            method: 'DELETE'
          });
        }
        debugLog('✅ All leads cleared from database');
      } catch (error) {
        console.warn('⚠️ Failed to clear database leads:', error);
      }
    }

    // Clear localStorage and cache
    localStorage.removeItem(getStorageKey());
    this.leadsCache = [];
    this.processedMessageIds.clear();
    debugLog('✅ All leads cleared');
  }
}

export const CrmService = new CrmServiceImpl();
