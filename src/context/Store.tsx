import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Lead, LeadStatus, DateRange } from '../types/crm';
import { CrmService } from '../services/CrmService';
import { loadCRMSettings } from '../lib/crmSettings';

interface AppContextType {
  leads: Lead[];
  isLoading: boolean;
  isWhatsAppConnected: boolean;
  dateRange: DateRange;

  // Actions
  setDateRange: (range: DateRange) => void;
  addLead: (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => void;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  updateLeadStatus: (id: string, status: LeadStatus) => void;
  removeLead: (id: string) => void;
  syncLeadsFromWhatsApp: () => Promise<void>;
  toggleWhatsAppConnection: () => void;
  clearAllLeads: () => Promise<void>;

  // Metrics
  getMetrics: () => { messages: number; potential: number; sales: number; revenue: number };
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [leads, setLeads] = useState<Lead[]>([]);
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

  // 🆕 Ref for cleanup functions
  const cleanupRef = useRef<(() => void)[]>([]);

  // Initial Load & Filter Effect
  useEffect(() => {
    loadLeads();
  }, [dateRange]);

  // 🆕 Improved WhatsApp Message Listener with proper cleanup
  useEffect(() => {
    console.log('🚀 Registering WhatsApp message listener...');

    const cleanupFunctions: (() => void)[] = [];

    // ALWAYS listen for new incoming messages from backend
    const cleanupNewMessage = CrmService.onNewMessage(async (newLead) => {
      console.log('%c📩 NEW WHATSAPP MESSAGE!', 'background: #25d366; color: white; font-size: 16px; font-weight: bold; padding: 4px 8px; border-radius: 4px;');
      console.log('   Phone:', newLead.phone);
      console.log('   Message:', newLead.last_message);

      // Check if this lead already exists in current state
      const existingIndex = leadsRef.current.findIndex(l =>
        l.id === newLead.id || l.phone === newLead.phone
      );

      if (existingIndex !== -1) {
        console.log('🔄 Updating existing lead in UI:', newLead.phone);
        setLeads(prev => {
          const newList = [...prev];
          newList[existingIndex] = newLead;
          return newList;
        });
      } else {
        // New Conversation
        console.log('➕ Adding new lead to UI:', newLead.phone);
        setLeads(prev => [newLead, ...prev]);
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
      // Update connection state based on health
      if (health.whatsapp === 'CONNECTED' && !isWhatsAppConnected) {
        setIsWhatsAppConnected(true);
      } else if (health.whatsapp === 'OFFLINE' && isWhatsAppConnected) {
        setIsWhatsAppConnected(false);
      }
    });
    cleanupFunctions.push(cleanupHealthCheck);

    console.log('✅ Message listener registered successfully!');

    // Cleanup function
    return () => {
      console.log('🔌 Unregistering all message listeners');
      cleanupFunctions.forEach(cleanup => cleanup());
    };
  }, [isWhatsAppConnected]);

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
      // Show error to user (could add toast notification here)
    } finally {
      setIsLoading(false);
    }
  }, [dateRange]);

  // --- ACTIONS ---

  const addLead = async (leadData: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => {
    try {
      const settings = loadCRMSettings();
      const stages = settings.pipelineStages;
      const defaultStatus = stages.length > 0 ? stages[0].id : 'new';

      // 1. Auto-Sort Logic (The "Brain") - with better patterns
      let status: LeadStatus = defaultStatus;
      const msg = leadData.last_message?.toLowerCase() || '';

      // Azerbaijani and English keywords
      const priceKeywords = ['qiymət', 'price', 'neçəyə', 'ne qeder', 'haqqında'];
      const orderKeywords = ['sifariş', 'almaq', 'buy', 'istəyirəm', 'gətirmək', 'var'];

      if (priceKeywords.some(k => msg.includes(k))) {
        // Find if potential or a custom alternative exists, else stay default
        const hasPotential = stages.find(s => s.id === 'potential');
        if (hasPotential) status = 'potential';
      } else if (orderKeywords.some(k => msg.includes(k))) {
        const hasWon = stages.find(s => s.id === 'won');
        if (hasWon) status = 'won';
      }

      // 2. Create Lead
      const newLead = await CrmService.addLead({ ...leadData, status });

      // 3. Update State - check if within current date range
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
      console.log('🔄 Starting manual sync from WhatsApp...');
      const messages = await CrmService.fetchRecentMessages(30);
      const existingLeads = await CrmService.getLeads(); // Get ALL for proper de-duplication

      let newLeadsAdded = 0;
      const newLeads: Lead[] = [];

      for (const msg of messages) {
        // De-duplication check: WhatsApp ID or (Phone + Message)
        const exists = existingLeads.some(l =>
          (l as any).whatsapp_id === msg.whatsapp_id ||
          (l.phone === msg.phone && l.last_message === msg.message)
        );

        if (!exists) {
          const leadData: Omit<Lead, 'id' | 'created_at' | 'updated_at'> = {
            phone: msg.phone,
            name: msg.name,
            last_message: msg.message,
            status: 'new',
            source: 'whatsapp',
            value: 0,
            whatsapp_id: msg.whatsapp_id
          };

          // PERSIST to storage
          const savedLead = await CrmService.addLead(leadData);
          newLeads.push(savedLead);
          newLeadsAdded++;
        }
      }

      console.log(`✅ Sync complete. Added ${newLeadsAdded} new leads to storage.`);

      // Reload from storage to ensure UI is in sync with persistent data and filters
      await loadLeads();

      if (newLeadsAdded > 0) {
        console.log('🔄 UI refreshed with new sync data');
      }
    } catch (e) {
      console.error('❌ Sync failed:', e);
      // Could add toast notification here
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

  return (
    <AppContext.Provider value={{
      leads,
      isLoading,
      isWhatsAppConnected,
      dateRange,
      setDateRange,
      addLead,
      updateLead,
      updateLeadStatus,
      removeLead,
      syncLeadsFromWhatsApp,
      toggleWhatsAppConnection,
      clearAllLeads,
      getMetrics
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
