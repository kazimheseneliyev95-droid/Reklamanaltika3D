import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Lead, LeadStatus, DateRange, User } from '../types/crm';
import { CrmService } from '../services/CrmService';
import { loadCRMSettings, applyAutoRules, syncCRMSettingsFromServer } from '../lib/crmSettings';

interface AppContextType {
  leads: Lead[];
  isLoading: boolean;
  isWhatsAppConnected: boolean;
  dateRange: DateRange;
  currentUser: User | null;
  teamMembers: User[];

  // Auth State
  isAuthenticated: boolean;
  isLoadingAuth: boolean;
  error: string | null;

  // Actions
  setDateRange: (range: DateRange) => void;
  addLead: (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => void;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  updateLeadStatus: (id: string, status: LeadStatus) => void;
  removeLead: (id: string) => void;
  syncLeadsFromWhatsApp: () => Promise<void>;
  toggleWhatsAppConnection: () => void;
  clearAllLeads: () => Promise<void>;

  login: (username: string, pass: string) => Promise<void>;
  impersonate: (tenantId: string) => Promise<void>;
  logout: () => void;

  // Metrics
  getMetrics: () => { messages: number; potential: number; sales: number; revenue: number };
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [teamMembers, setTeamMembers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isWhatsAppConnected, setIsWhatsAppConnected] = useState(false);

  // 🆕 Ref for tracking leads to prevent stale closures
  const leadsRef = useRef<Lead[]>([]);
  leadsRef.current = leads;

  // Initialize Date Range to Current Month (Local Time - FIXED)
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // 🆕 FIXED: Use local date methods instead of timezone offset
    const toLocalISO = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    return {
      start: toLocalISO(start),
      end: toLocalISO(end)
    };
  });

  // 🆕 Initial Load & Auth Verify Effect
  useEffect(() => {
    const verifyToken = async () => {
      const token = localStorage.getItem('crm_auth_token');
      if (!token) {
        setIsLoadingAuth(false);
        return;
      }
      try {
        const res = await fetch(`${CrmService.getServerUrl()}/api/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
          if (data.valid) {
            localStorage.setItem('crm_tenant_id', data.tenantId);
            setCurrentUser({
              id: data.id,
              username: data.username,
              role: data.role,
              permissions: data.permissions || {},
              tenant_id: data.tenantId,
              display_name: data.displayName || null
            });
            setIsAuthenticated(true);
          // 🆕 Automatically restore WhatsApp Socket if there is a saved server URL
          CrmService.autoConnect();

          // Sync settings from server
          try {
            await syncCRMSettingsFromServer();
          } catch (e) {
            console.error('Failed to sync settings on load', e);
          }

          // If token didn't include display name (older tokens), fetch tenant profile
          try {
            if (!data.displayName) {
              const profileRes = await fetch(`${CrmService.getServerUrl()}/api/tenant/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (profileRes.ok) {
                const profile = await profileRes.json();
                if (profile?.displayName) {
                  setCurrentUser(prev => prev ? { ...prev, display_name: profile.displayName } : prev);
                }
              }
            }
          } catch (e) {
            console.warn('Tenant profile fetch failed', e);
          }
        } else {
          localStorage.removeItem('crm_auth_token');
          localStorage.removeItem('crm_tenant_id');
        }
      } catch (err) {
        console.error('Auth verification failed', err);
      } finally {
        setIsLoadingAuth(false);
      }
    };
    verifyToken();
  }, []);

  const loadLeads = useCallback(async () => {
    setIsLoading(true);
    console.log('🔍 Loading leads for range:', dateRange);
    try {
      const data = await CrmService.getLeads(dateRange);
      console.log(`📊 Found ${data.length} leads in range.`);
      setLeads(data);
      leadsRef.current = data;
    } catch (error) {
      console.error('❌ Error loading leads:', error);
    } finally {
      setIsLoading(false);
    }
  }, [dateRange]);

  const loadTeamMembers = useCallback(async () => {
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/users`, {
        headers: CrmService['getAuthHeaders']()
      });
      if (res.ok) {
        const users = await res.json();
        setTeamMembers(users);
      }
    } catch (e) {
      console.error('Failed to load team members', e);
    }
  }, []);

  // 🆕 Improved WhatsApp Message Listener with proper cleanup
  useEffect(() => {
    console.log('🚀 Registering WhatsApp message listener...');

    const cleanupFunctions: (() => void)[] = [];

    // ALWAYS listen for new incoming messages from backend
    const cleanupNewMessage = CrmService.onNewMessage(async (newLead) => {
      console.log('%c📩 NEW WHATSAPP MESSAGE!', 'background: #25d366; color: white; font-size: 16px; font-weight: bold; padding: 4px 8px; border-radius: 4px;');
      console.log('   Phone:', newLead.phone);
      console.log('   Message:', newLead.last_message);

      // ─── Apply Auto-Rules ────────────────────────────────────────────────
      const crmSettings = loadCRMSettings();
      let finalLead = { ...newLead };

      if (newLead.last_message && crmSettings.autoRules?.length > 0) {
        const ruleMatch = applyAutoRules(newLead.last_message, crmSettings.autoRules);
        if (ruleMatch) {
          const stageExists = crmSettings.pipelineStages.find(s => s.id === ruleMatch.targetStage);
          if (stageExists) {
            console.log(`🤖 Auto-rule triggered → moving ${newLead.phone} to stage: ${ruleMatch.targetStage}`);

            // Apply optimistic update immediately
            finalLead = {
              ...finalLead,
              status: ruleMatch.targetStage,
              ...(ruleMatch.extractedValue !== null ? { value: ruleMatch.extractedValue } : {}),
            };

            // Persist to DB in background
            if (newLead.id && !newLead.id.startsWith('test-')) {
              CrmService.updateStatus(newLead.id, ruleMatch.targetStage).catch((err: unknown) =>
                console.warn('⚠️ Auto-rule status update failed:', err)
              );

              if (ruleMatch.extractedValue !== null) {
                CrmService.updateLead(newLead.id, { value: ruleMatch.extractedValue }).catch((err: unknown) =>
                  console.warn('⚠️ Auto-rule value update failed:', err)
                );
              }
            }
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Ensure new leads have a resilient ID mapping in case backend hasn't supplied one sequentially yet
      if (!finalLead.id) {
        finalLead.id = `wa-${Date.now()}`;
      }

      // Check if this lead already exists in current state
      const existingIndex = leadsRef.current.findIndex(l =>
        l.id === finalLead.id || l.whatsapp_id === finalLead.whatsapp_id || l.phone === finalLead.phone
      );

      if (existingIndex !== -1) {
        console.log('🔄 Updating existing lead in UI:', finalLead.phone);
        setLeads(prev => {
          const newList = [...prev];
          newList[existingIndex] = { ...newList[existingIndex], ...finalLead };
          return newList;
        });
      } else {
        // New Conversation!
        console.log('➕ Adding new lead to UI:', finalLead.phone);
        setLeads(prev => [finalLead, ...prev]);
      }
    });
    cleanupFunctions.push(cleanupNewMessage);

    // Listen for lead updates (status changes, etc.)
    const cleanupLeadUpdated = CrmService.onLeadUpdated(async (updatedLead) => {
      console.log('🔄 LEAD UPDATED:', updatedLead);

      // Update UI state
      setLeads(prev => {
        const existingIndex = prev.findIndex(l =>
          l.id === updatedLead.id || l.phone === updatedLead.phone
        );

        if (existingIndex !== -1) {
          console.log('✅ Updating lead in UI:', updatedLead.phone);
          const newList = [...prev];
          newList[existingIndex] = updatedLead;
          return newList;
        }

        console.log('⚠️ Lead not found in UI, adding:', updatedLead.phone);
        return [updatedLead, ...prev];
      });
    });
    cleanupFunctions.push(cleanupLeadUpdated);

    // Listen for lead deletions
    const cleanupLeadDeleted = CrmService.onLeadDeleted((deletedLeadId) => {
      console.log('🗑️ LEAD DELETED IN UI:', deletedLeadId);
      setLeads(prev => prev.filter(l => l.id !== deletedLeadId));
    });
    cleanupFunctions.push(cleanupLeadDeleted);

    // Listen for full database reset (Formatla)
    const cleanupLeadsReset = CrmService.onLeadsReset(() => {
      console.log('🌀 LEADS RESET IN UI: Clearing all local state');
      setLeads([]);
    });
    cleanupFunctions.push(cleanupLeadsReset);

    // Listen for settings updates from other clients
    const cleanupSettingsUpdated = CrmService.onSettingsUpdated(async () => {
      console.log('⚙️ SETTINGS UPDATED: Syncing from server and reloading...');
      await syncCRMSettingsFromServer();
      window.location.reload();
    });
    cleanupFunctions.push(cleanupSettingsUpdated);

    // 🧪 TEST MODE LISTENER
    const cleanupTestMessage = CrmService.onTestMessage((data: any) => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🧠 CRM TEST MESSAGE RECEIVED (TEST_MODE)');
      console.log('   Phone:', data.phone);
      console.log('   Name:', data.name);
      console.log('   Message:', data.message);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const settings = loadCRMSettings();
      const defaultStatus = settings.pipelineStages.length > 0 ? settings.pipelineStages[0].id : 'new';

      const testLead: Lead = {
        id: 'test-' + Date.now(),
        phone: data.phone,
        name: `[TEST] ${data.name}`,
        last_message: data.message,
        status: defaultStatus,
        source: 'whatsapp',
        value: 0,
        created_at: data.timestamp || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      setLeads((prev) => [testLead, ...prev]);
      console.log('✅ WhatsApp → Backend → Frontend → CRM SUCCESS');
    });
    cleanupFunctions.push(cleanupTestMessage);

    // 🏥 HEALTH CHECK LISTENER
    const cleanupHealthCheck = CrmService.onHealthCheck((health: any) => {
      console.log('🏥 SYSTEM HEALTH:', health);
      // Update connection state based on health without stale closure coupling
      setIsWhatsAppConnected((prev) => {
        if (health.whatsapp === 'CONNECTED') return true;
        if (health.whatsapp === 'OFFLINE') return false;
        return prev;
      });
    });
    cleanupFunctions.push(cleanupHealthCheck);

    // 🆕 RECONNECT — reload leads from DB whenever the socket re-establishes.
    // This is what makes messages visible after tab close, screen sleep, or account switch.
    const cleanupReconnect = CrmService.onReconnect(() => {
      console.log('🔁 Socket reconnected — reloading leads from DB...');
      loadLeads();
    });
    cleanupFunctions.push(cleanupReconnect);

    console.log('✅ Message listener registered successfully!');

    // Cleanup function
    return () => {
      console.log('🔌 Unregistering all message listeners');
      cleanupFunctions.forEach(cleanup => cleanup());
    };
  }, [loadLeads]);

  useEffect(() => {
    if (isAuthenticated) {
      loadLeads();
      loadTeamMembers();
    }
  }, [dateRange, isAuthenticated, loadLeads, loadTeamMembers]);

  // --- ACTIONS ---

  const addLead = async (leadData: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => {
    try {
      const settings = loadCRMSettings();
      const stages = settings.pipelineStages;
      const defaultStatus = stages.length > 0 ? stages[0].id : 'new';

      // Apply user-configured auto-rules
      let status: LeadStatus = defaultStatus;
      let autoValue: number | null = null;
      const message = leadData.last_message || '';

      const ruleMatch = applyAutoRules(message, settings.autoRules);
      if (ruleMatch) {
        // Verify the target stage still exists before applying
        const stageExists = stages.find(s => s.id === ruleMatch.targetStage);
        if (stageExists) {
          status = ruleMatch.targetStage;
          autoValue = ruleMatch.extractedValue;
          console.log(`🤖 Auto-rule matched → stage: ${status}, value: ${autoValue}`);
        }
      }

      // Build lead data, auto-fill value if rule says so
      const leadToCreate: typeof leadData = {
        ...leadData,
        status,
        ...(autoValue !== null ? { value: autoValue } : {}),
      };

      // Create Lead
      const newLead = await CrmService.addLead(leadToCreate);

      // Update State - check if within current date range
      const inRange = !dateRange.start || new Date(newLead.created_at) >= new Date(dateRange.start);
      const inRangeEnd = !dateRange.end || new Date(newLead.created_at) <= new Date(dateRange.end);

      if (inRange && inRangeEnd) {
        setLeads(prev => [newLead, ...prev]);
      }
    } catch (error) {
      console.error('❌ Error adding lead:', error);
      // Could add toast notification here
    }
  };

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    try {
      await CrmService.updateLead(id, updates);
      setLeads(prev => prev.map(l => l.id === id ? { ...l, ...updates } : l));
    } catch (error) {
      console.error('❌ Error updating lead:', error);
      // Could add toast notification here
    }
  };

  const updateLeadStatus = async (id: string, status: LeadStatus) => {
    try {
      await CrmService.updateStatus(id, status);
      setLeads(prev => prev.map(l => l.id === id ? { ...l, status } : l));
    } catch (error) {
      console.error('❌ Error updating lead status:', error);
      // Could add toast notification here
    }
  };

  const removeLead = useCallback((id: string) => {
    CrmService.deleteLead(id).then(() => {
      setLeads((prev) => prev.filter((l) => l.id !== id));
    }).catch(error => {
      console.error('❌ Error removing lead:', error);
    });
  }, []);

  const syncLeadsFromWhatsApp = useCallback(async () => {
    setIsLoading(true);
    try {
      console.log('🔄 Starting manual sync from WhatsApp (DB-backed)...');

      // Always reload leads from DB first
      await loadLeads();

      // Fetch recent conversations (now DB-backed, survives restarts)
      const messages = await CrmService.fetchRecentMessages(50);

      // Get fresh list from DB for de-duplication
      const existingLeads = await CrmService.getLeads();

      let newLeadsAdded = 0;
      for (const msg of messages) {
        const msgText = msg.lastMessage || msg.message || '';
        const msgPhone = String(msg.phone || '').replace(/\D/g, '');

        // Skip if this phone already exists in DB (the /chats/recent now returns DB leads,
        // so most entries will already exist — we only upsert truly new ones)
        const phoneExists = existingLeads.some(l => {
          const lPhone = String(l.phone || '').replace(/\D/g, '');
          const lSuffix = lPhone.slice(-9);
          const mSuffix = msgPhone.slice(-9);
          return lPhone === msgPhone || (lSuffix.length >= 7 && lSuffix === mSuffix);
        });

        if (!phoneExists && msgPhone.length >= 7) {
          const leadData: Omit<Lead, 'id' | 'created_at' | 'updated_at'> = {
            phone: msgPhone,
            name: msg.name,
            last_message: msgText,
            status: 'new',
            source: 'whatsapp',
            value: 0,
          };
          await CrmService.addLead(leadData);
          newLeadsAdded++;
        }
      }

      console.log(`✅ Sync complete. Added ${newLeadsAdded} new leads.`);
      // Reload from DB to ensure UI is always in sync
      await loadLeads();
    } catch (e) {
      console.error('❌ Sync failed:', e);
    } finally {
      setIsLoading(false);
    }
  }, [loadLeads]);

  const clearAllLeads = useCallback(async () => {
    if (window.confirm('Are you sure you want to delete ALL leads? This cannot be undone.')) {
      try {
        await CrmService.clearAllLeads();
        setLeads([]);
        console.log('✅ All leads cleared');
      } catch (error) {
        console.error('❌ Error clearing leads:', error);
      }
    }
  }, []);

  const toggleWhatsAppConnection = () => {
    setIsWhatsAppConnected(!isWhatsAppConnected);
  };

  // --- METRICS ---
  const getMetrics = () => {
    const messages = leads.length;
    const potential = leads.filter(l => l.status === 'potential').length;
    const sales = leads.filter(l => l.status === 'won').length;
    const revenue = leads.filter(l => l.status === 'won').reduce((acc, curr) => acc + (curr.value || 0), 0);

    return { messages, potential, sales, revenue };
  };

  // --- AUTH ---
  const login = async (u: string, p: string) => {
    setIsLoadingAuth(true);
    setError(null);
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem('crm_auth_token', data.token);
        localStorage.setItem('crm_tenant_id', data.tenantId);
        setCurrentUser({
          id: data.id,
          username: data.username,
          role: data.role,
          permissions: data.permissions || {},
          tenant_id: data.tenantId,
          display_name: data.displayName || null
        });
        setIsAuthenticated(true);
      } else {
        setError(data.error || 'İstifadəçi adı və ya şifrə yanlışdır');
      }
    } catch (err) {
      setError('Serverə qoşulmaq mümkün olmadı');
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const impersonate = async (tenantId: string) => {
    setIsLoadingAuth(true);
    setError(null);
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/impersonate/${tenantId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('crm_auth_token')}`
        }
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem('crm_auth_token', data.token);
        localStorage.setItem('crm_tenant_id', data.tenantId);
        setCurrentUser({
          id: data.id,
          username: data.username,
          role: data.role,
          permissions: data.permissions || {},
          tenant_id: data.tenantId,
          display_name: data.displayName || null
        });
        setIsAuthenticated(true);
      } else {
        throw new Error(data.error || 'İmpersonasiya xətası');
      }
    } catch (err: any) {
      alert(err.message || 'Server xətası');
      throw err;
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const logout = useCallback(() => {
    localStorage.removeItem('crm_auth_token');
    localStorage.removeItem('crm_tenant_id');
    setIsAuthenticated(false);
    setLeads([]);
    CrmService.disconnect();
  }, []);

  return (
    <AppContext.Provider value={{
      leads,
      isLoading,
      isWhatsAppConnected,
      dateRange,
      currentUser,
      teamMembers,

      isAuthenticated,
      isLoadingAuth,
      error,

      setDateRange,
      addLead,
      updateLead,
      updateLeadStatus,
      removeLead,
      syncLeadsFromWhatsApp,
      toggleWhatsAppConnection,
      clearAllLeads,
      getMetrics,

      login,
      impersonate,
      logout
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppStore() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppStore must be used within an AppProvider');
  }
  return context;
}
