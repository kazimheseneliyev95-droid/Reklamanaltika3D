import { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '../context/Store';
import { Lead, LeadStatus } from '../types/crm';
import { Badge } from '../components/ui/Badge';
import { Trash2, Calendar, Filter, RefreshCcw, Pencil, ShoppingBag, DollarSign, TrendingUp, Users, MessageSquare, UserPlus, CheckCircle, XCircle, Phone, Bell, GripVertical } from 'lucide-react';
import { cn, formatCurrency, toNumberSafe } from '../lib/utils';
import { businessMinutesBetween, type BusinessHoursCfg } from '../lib/businessHours';
import { LeadDetailsPanel } from '../components/LeadDetailsPanel';
import { loadCRMSettings, CustomField, LeadCardUISettings, DelayDotsSettings } from '../lib/crmSettings';
import { CRMFilterSidebar, countActiveFilters, makeDefaultCRMFilters, type CRMFilters } from '../components/CRMFilterSidebar';

export default function CRMPage() {
  const [activeMobileTab, setActiveMobileTab] = useState<string>('new');
  const {
    leads,
    isLoading,
    isWhatsAppConnected,
    updateLead,
    updateLeadStatus,
    removeLead,
    syncLeadsFromWhatsApp,
    dateRange,
    setDateRange,
    teamMembers,
    currentUser
  } = useAppStore();

  const { pipelineStages, customFields, ui, notifications } = loadCRMSettings();
  const leadCardUi = ui?.leadCard;
  const delayDotsUi = ui?.delayDots;
  const slaIgnoreStages = Array.isArray(notifications?.slaIgnoreStages) ? notifications!.slaIgnoreStages : ['won'];
  const businessHours = notifications?.businessHours;

  const pipelineSig = useMemo(() => (pipelineStages || []).map(s => s.id).join('|'), [pipelineStages]);

  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<CRMFilters>(() => makeDefaultCRMFilters(pipelineStages));
  const [showNotif, setShowNotif] = useState(false);

  // When settings sync updates pipeline stages, keep mobile tab + stage filters valid
  useEffect(() => {
    if (!pipelineStages || pipelineStages.length === 0) return;

    if (!pipelineStages.some(s => s.id === activeMobileTab)) {
      setActiveMobileTab(pipelineStages[0].id);
    }

    setFilters((prev) => {
      const allowed = new Set(pipelineStages.map(s => s.id));
      const kept = (prev.stageIds || []).filter(id => allowed.has(id));

      // If user had nothing selected (or everything became invalid), default to all stages
      const base = kept.length === 0 ? pipelineStages.map(s => s.id) : kept;

      // Include any newly-added stages by default
      const missing = pipelineStages.map(s => s.id).filter(id => !base.includes(id));
      const nextStageIds = [...base, ...missing];

      return nextStageIds.join('|') === (prev.stageIds || []).join('|')
        ? prev
        : { ...prev, stageIds: nextStageIds };
    });
  }, [pipelineSig]);

  const activeFilterCount = useMemo(() => countActiveFilters(filters, pipelineStages), [filters, pipelineStages]);

  const filteredLeads = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    const productQ = filters.product.trim().toLowerCase();

    const stageSet = new Set(filters.stageIds);
    const assigneeSet = new Set(filters.assigneeIds);

    const vMin = Number.isFinite(parseFloat(filters.valueMin)) ? parseFloat(filters.valueMin) : null;
    const vMax = Number.isFinite(parseFloat(filters.valueMax)) ? parseFloat(filters.valueMax) : null;

    const customText = Object.entries(filters.customText).filter(([, v]) => String(v || '').trim() !== '');
    const customSelect = Object.entries(filters.customSelect).filter(([, v]) => String(v || '').trim() !== '');
    const customNumber = Object.entries(filters.customNumber).filter(([, r]) => String(r?.min || '').trim() !== '' || String(r?.max || '').trim() !== '');
    const customDate = Object.entries(filters.customDate).filter(([, r]) => String(r?.start || '').trim() !== '' || String(r?.end || '').trim() !== '');

    const normDt = (raw: any): string | null => {
      const v = String(raw ?? '').trim();
      if (!v) return null;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00`;
      if (v.includes('T') && v.length >= 16) return v.slice(0, 16);
      const d = new Date(v);
      if (!Number.isFinite(d.getTime())) return null;
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    return leads.filter((l) => {
      // stage
      if (stageSet.size > 0 && !stageSet.has(l.status)) return false;
      if (stageSet.size === 0) return false;

      // source
      if (filters.source !== 'all' && l.source !== filters.source) return false;

      // assignee
      if (assigneeSet.size > 0) {
        const k = l.assignee_id ? String(l.assignee_id) : 'unassigned';
        if (!assigneeSet.has(k)) return false;
      }

      // value
      if (vMin !== null || vMax !== null) {
        const v = typeof l.value === 'number' ? l.value : parseFloat(String(l.value ?? ''));
        if (!Number.isFinite(v)) return false;
        if (vMin !== null && v < vMin) return false;
        if (vMax !== null && v > vMax) return false;
      }

      // query
      if (q) {
        const hay = `${l.phone || ''} ${l.name || ''} ${l.last_message || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      // product
      if (productQ) {
        const hay = String(l.product_name || '').toLowerCase();
        if (!hay.includes(productQ)) return false;
      }

      // custom
      if (customText.length + customSelect.length + customNumber.length + customDate.length > 0) {
        const extra = parseExtraData((l as any).extra_data);

        for (const [fieldId, wantRaw] of customSelect) {
          const want = String(wantRaw || '').trim();
          if (!want) continue;
          const got = String(extra?.[fieldId] ?? '').trim();
          if (got !== want) return false;
        }

        for (const [fieldId, wantRaw] of customText) {
          const want = String(wantRaw || '').trim().toLowerCase();
          if (!want) continue;
          const got = String(extra?.[fieldId] ?? '').trim().toLowerCase();
          if (!got.includes(want)) return false;
        }

        for (const [fieldId, range] of customNumber) {
          const min = Number.isFinite(parseFloat(String(range?.min ?? ''))) ? parseFloat(String(range?.min ?? '')) : null;
          const max = Number.isFinite(parseFloat(String(range?.max ?? ''))) ? parseFloat(String(range?.max ?? '')) : null;
          if (min === null && max === null) continue;
          const gotN = parseFloat(String(extra?.[fieldId] ?? ''));
          if (!Number.isFinite(gotN)) return false;
          if (min !== null && gotN < min) return false;
          if (max !== null && gotN > max) return false;
        }

        for (const [fieldId, range] of customDate) {
          const start = normDt(range?.start);
          const end = normDt(range?.end);
          if (!start && !end) continue;

          const got = normDt(extra?.[fieldId]);
          if (!got) return false;
          if (start && got < start) return false;
          if (end && got > end) return false;
        }
      }

      return true;
    });
  }, [leads, filters]);

  // Keep selectedLead in sync with the global leads store
  useEffect(() => {
    if (!selectedLead) return;
    const fresh = leads.find(l => l.id === selectedLead.id);
    if (fresh) setSelectedLead(fresh);
  }, [leads]);

  // --- METRICS CALCULATION ---
  const metrics = useMemo(() => {
    const totalLeads = filteredLeads.length;

    const normalizeLabel = (v: any) => String(v || '')
      .toLowerCase()
      .replace(/ı/g, 'i')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const revenueStageId =
      (pipelineStages || []).find((s) => s.id === 'won')?.id ||
      (pipelineStages || []).find((s) => normalizeLabel(s.label) === 'satis')?.id ||
      'won';

    const totalRevenue = filteredLeads
      .filter(l => String(l.status) === String(revenueStageId))
      .reduce((sum, l) => sum + toNumberSafe((l as any).value, 0), 0);

    return { totalLeads, totalRevenue };
  }, [filteredLeads, pipelineStages]);

  const handleEdit = (lead: Lead) => {
    setSelectedLead(lead);
  };

  const resetFilters = () => setFilters(makeDefaultCRMFilters(pipelineStages));

  const getIconForColor = (color: string) => {
    switch (color) {
      case 'blue': return <MessageSquare className="w-4 h-4" />;
      case 'purple': return <UserPlus className="w-4 h-4" />;
      case 'green': return <CheckCircle className="w-4 h-4" />;
      case 'slate': return <XCircle className="w-4 h-4" />;
      default: return <div className={cn("w-3 h-3 rounded-full", `bg-${color}-500`)} />;
    }
  };

  const columns: { id: LeadStatus; title: string; color: string; icon: React.ReactNode }[] = pipelineStages.map(stage => ({
    id: stage.id,
    title: stage.label,
    color: stage.color,
    icon: getIconForColor(stage.color)
  }));

  const canViewBudget = currentUser?.permissions?.view_budget !== false;

  const unreadTotal = useMemo(() => {
    return (leads || []).reduce((sum, l) => sum + (Number(l.unread_count || 0) > 0 ? Number(l.unread_count || 0) : 0), 0);
  }, [leads]);

  const topUnread = useMemo(() => {
    const rows = (leads || []).filter(l => Number(l.unread_count || 0) > 0).slice();
    rows.sort((a, b) => {
      const au = Number(a.unread_count || 0);
      const bu = Number(b.unread_count || 0);
      if (bu !== au) return bu - au;
      const at = new Date(a.last_inbound_at || a.updated_at || a.created_at).getTime();
      const bt = new Date(b.last_inbound_at || b.updated_at || b.created_at).getTime();
      return bt - at;
    });
    return rows.slice(0, 8);
  }, [leads]);

  useEffect(() => {
    if (!showNotif) return;
    const onDoc = (e: any) => {
      const target = e?.target as HTMLElement;
      if (!target) return;
      const root = document.getElementById('crm-notif-root');
      if (root && root.contains(target)) return;
      setShowNotif(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showNotif]);

  return (
    <div className="p-2 sm:p-6 max-w-[1600px] mx-auto h-full flex flex-col font-sans space-y-2 sm:space-y-6">

      {/* HEADER & METRICS */}
      <div className="flex flex-col gap-3 sm:gap-6 border-b border-slate-800 pb-3 sm:pb-6">

        {/* Top Row: Title & Actions */}
        <div className="flex items-start sm:items-center justify-between gap-2">
          <div className="flex-1">
            <h1 className="text-lg sm:text-3xl font-bold text-white flex items-center gap-1.5 sm:gap-2">
              <MessageSquare className="text-green-500 w-4 h-4 sm:w-7 sm:h-7" />
              WhatsApp CRM
              {currentUser?.display_name && (
                <span className="ml-1.5 sm:ml-2 px-2 py-0.5 rounded-full text-[9px] sm:text-[11px] bg-slate-800/60 border border-slate-700 text-slate-200 font-semibold max-w-[40vw] sm:max-w-none truncate">
                  {currentUser.display_name}
                </span>
              )}
            </h1>
            <p className="text-slate-400 mt-0.5 flex items-center gap-1.5 text-[10px] sm:text-sm">
              <span className={isWhatsAppConnected ? "w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" : "w-1.5 h-1.5 rounded-full bg-red-500"}></span>
              <span className="hidden sm:inline">{isWhatsAppConnected ? "Live Connection Active" : "Offline Mode (Manual)"}</span>
              <span className="sm:hidden">{isWhatsAppConnected ? "Online" : "Offline"}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 sm:gap-2 justify-end">
            <div id="crm-notif-root" className="relative">
              <button
                type="button"
                onClick={() => setShowNotif(v => !v)}
                className={cn(
                  'relative inline-flex items-center gap-1.5 sm:gap-2 p-1.5 sm:px-3 sm:py-2 rounded-lg border text-xs sm:text-sm font-semibold transition-colors',
                  unreadTotal > 0
                    ? 'bg-amber-950/20 border-amber-900/40 text-amber-200 hover:bg-amber-950/30'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                )}
                title="Unread messages"
              >
                <Bell className={cn('w-3.5 h-3.5 sm:w-4 sm:h-4', unreadTotal > 0 ? 'text-amber-300' : 'text-slate-300')} />
                <span className="hidden sm:inline">Unread</span>
                <span className={cn(
                  'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold border tabular-nums',
                  unreadTotal > 0
                    ? 'bg-amber-500/20 text-amber-200 border-amber-500/20'
                    : 'bg-slate-900/40 text-slate-300 border-slate-600/40'
                )}>
                  {unreadTotal > 99 ? '99+' : unreadTotal}
                </span>
              </button>

              {showNotif ? (
                <div className="absolute right-0 mt-2 w-[320px] max-w-[92vw] rounded-xl border border-slate-800 bg-slate-950/95 shadow-2xl backdrop-blur p-2 z-50">
                  <div className="px-2 py-1.5 flex items-center justify-between">
                    <div className="text-[11px] uppercase font-bold text-slate-500">Unread messages</div>
                    <button
                      className="text-[10px] font-bold text-slate-400 hover:text-slate-200"
                      onClick={() => setShowNotif(false)}
                      type="button"
                    >
                      Close
                    </button>
                  </div>

                  {topUnread.length === 0 ? (
                    <div className="px-2 py-3 text-[12px] text-slate-500">No unread messages</div>
                  ) : (
                    <div className="max-h-[320px] overflow-auto pr-1 custom-scrollbar">
                      {topUnread.map((l) => {
                        const u = Number(l.unread_count || 0);
                        const label = l.name || l.phone;
                        const last = l.last_message || '';
                        return (
                          <button
                            key={l.id}
                            onClick={() => {
                              setSelectedLead(l);
                              setActiveMobileTab(l.status);
                              setShowNotif(false);
                            }}
                            className="w-full text-left px-2 py-2 rounded-lg hover:bg-slate-900/50 border border-transparent hover:border-slate-800 transition-colors"
                            type="button"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold text-slate-200 truncate">{label}</div>
                                <div className="text-[11px] text-slate-500 truncate">{last}</div>
                              </div>
                              <div className="shrink-0">
                                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold bg-amber-500/20 text-amber-200 border border-amber-500/20">
                                  {u}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="mt-2 px-2 pb-1 text-[10px] text-slate-600">
                    Lead açanda unread avtomatik 0 olur.
                  </div>
                </div>
              ) : null}
            </div>

            <button
              onClick={syncLeadsFromWhatsApp}
              disabled={isLoading}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 p-1.5 sm:px-3 sm:py-2 rounded-lg flex items-center gap-1.5 text-xs sm:text-sm transition-all border border-slate-700 disabled:opacity-50"
              title="Manual Sync from WhatsApp"
            >
              <RefreshCcw className={cn("w-3.5 h-3.5 sm:w-4 sm:h-4", isLoading && "animate-spin")} />
              <span className="hidden sm:inline">Yenilə</span>
            </button>

            <button
              onClick={() => setShowFilters(true)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 p-1.5 sm:px-3 sm:py-2 rounded-lg flex items-center gap-1.5 text-xs sm:text-sm transition-all border border-slate-700"
              title="Filtrlər"
            >
              <Filter className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">Filtrlər</span>
              {activeFilterCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600/20 text-blue-300 text-[10px] font-extrabold border border-blue-500/20">
                  {activeFilterCount}
                </span>
              )}
            </button>

          </div>
        </div>

        {/* Second Row: Metrics & Filters */}
        <div className="flex flex-col xl:flex-row gap-2 sm:gap-4 items-stretch xl:items-center justify-between">

          {/* Summary Cards (Compact grid on mobile) */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-2 sm:p-3 sm:px-5 flex items-center gap-2 sm:gap-4 flex-1 sm:flex-none sm:min-w-[180px]">
              <div className="p-1.5 sm:p-2 bg-blue-500/10 rounded-full shrink-0">
                <Users className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-blue-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] sm:text-xs text-slate-400 uppercase font-medium truncate">Leads</p>
                <p className="text-sm sm:text-xl font-bold text-white truncate">{metrics.totalLeads}</p>
              </div>
            </div>

            {canViewBudget && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-2 sm:p-3 sm:px-5 flex items-center gap-2 sm:gap-4 flex-1 sm:flex-none sm:min-w-[180px]">
                <div className="p-1.5 sm:p-2 bg-green-500/10 rounded-full shrink-0">
                  <TrendingUp className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-green-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] sm:text-xs text-slate-400 uppercase font-medium truncate">Satış</p>
                  <p className="text-sm sm:text-xl font-bold text-green-400 truncate">{formatCurrency(metrics.totalRevenue, 'AZN')}</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 p-2 rounded-lg border border-slate-800">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <Calendar className="w-4 h-4 text-slate-500" />
              <span className="tabular-nums">
                {(!dateRange.start && !dateRange.end) ? 'Tüm zamanlar' : `${dateRange.start || '...'} - ${dateRange.end || '...'}`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {activeFilterCount > 0 && (
                <button
                  onClick={resetFilters}
                  className="px-2 py-1.5 rounded-lg text-[11px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                  title="Filterləri sıfırla"
                >
                  Sıfırla
                </button>
              )}
            </div>
          </div>

        </div>
      </div>

      <CRMFilterSidebar
        open={showFilters}
        onClose={() => setShowFilters(false)}
        filters={filters}
        setFilters={setFilters}
        pipelineStages={pipelineStages}
        customFields={customFields}
        teamMembers={teamMembers}
        currentUser={currentUser}
        dateRange={dateRange}
        setDateRange={setDateRange}
        resultCount={filteredLeads.length}
        totalCount={leads.length}
      />

      {/* AMOCRM STYLE LEAD DETAILS PANEL */}
      {selectedLead && (
        <LeadDetailsPanel
          lead={selectedLead}
          onSave={async (id: string, updates: Partial<Lead>) => {
            await updateLead(id, updates);
          }}
          onUpdateStatus={(id: string, status: LeadStatus) => {
            updateLeadStatus(id, status);
            // Optimistic update of the modal itself
            setSelectedLead(prev => prev ? { ...prev, status } : null);
          }}
          onClose={() => setSelectedLead(null)}
        />
      )}

      {/* MOBILE TABS (iOS Segmented Control Style) */}
      <div className="flex sm:hidden gap-1 bg-[#1c2436] p-1 rounded-xl w-full sticky top-0 z-10 mx-auto shadow-md overflow-x-auto no-scrollbar mb-2">
        {columns.map((col) => (
          <button
            key={col.id}
            onClick={() => setActiveMobileTab(col.id)}
            className={cn(
              "flex-1 min-w-[70px] py-1.5 px-1 rounded-lg text-[10px] font-semibold flex flex-col items-center gap-0.5 transition-all",
              activeMobileTab === col.id
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            {col.icon}
            <span className="truncate w-full text-center px-0.5">{col.title}</span>
            {(() => {
              const inCol = filteredLeads.filter(l => l.status === col.id);
              const cnt = inCol.length;
              const unread = inCol.reduce((s, l) => {
                const u = Number((l as any).unread_count || 0);
                return s + (Number.isFinite(u) && u > 0 ? u : 0);
              }, 0);

              return (
                <div className="mt-0.5 flex items-center gap-1">
                  <span className={cn(
                    "text-[8px] px-1.5 py-0.5 rounded-full",
                    activeMobileTab === col.id ? "bg-white/20 text-white" : "bg-slate-800 text-slate-400"
                  )}>
                    {cnt}
                  </span>
                  {unread > 0 ? (
                    <span className="text-[7px] px-1 py-0.5 rounded-full bg-amber-500/10 text-amber-200/90 border border-amber-500/15 tabular-nums" title="Unread">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </div>
              );
            })()}
          </button>
        ))}
      </div>

      {/* KANBAN BOARD — desktop: fit-to-screen grid | mobile: single column */}
      <div className="flex-1 overflow-x-hidden pb-4">
        {/* Desktop */}
        <div
          className="hidden sm:grid gap-3 lg:gap-4 h-full w-full min-w-0"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {columns.map((col) => (
            (() => {
              const leadsInCol = filteredLeads.filter(l => l.status === col.id);
              const colCount = leadsInCol.length;
              const colUnread = leadsInCol.reduce((s, l) => {
                const u = Number((l as any).unread_count || 0);
                return s + (Number.isFinite(u) && u > 0 ? u : 0);
              }, 0);
              const colValue = canViewBudget
                ? leadsInCol.reduce((s, l) => s + toNumberSafe((l as any).value, 0), 0)
                : 0;

              return (
            <div
              key={col.id}
              className="min-w-0 flex flex-col bg-slate-900/40 rounded-xl border border-slate-800 h-full max-h-[calc(100vh-300px)]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const leadId = e.dataTransfer.getData('leadId');
                if (leadId) updateLeadStatus(leadId, col.id);
              }}
            >
              <div className="sticky top-0 z-10 p-2.5 border-b border-slate-800/70 bg-slate-950/60 backdrop-blur rounded-t-xl">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="p-1.5 rounded-lg bg-slate-950/50 border border-slate-800 shrink-0">
                      {col.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[12px] font-extrabold text-slate-100 truncate" title={col.title}>{col.title}</div>
                      {canViewBudget ? (
                        <div className="mt-0.5 text-[10px] text-slate-500 tabular-nums truncate">Budce: <span className="text-slate-300 font-semibold">{formatCurrency(colValue, 'AZN')}</span></div>
                      ) : null}
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center gap-1.5">
                    {colUnread > 0 ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-amber-500/15 bg-amber-950/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-200/90 tabular-nums"
                        title="Unread messages in this column"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        {colUnread > 999 ? '999+' : colUnread}
                      </span>
                    ) : null}

                    <Badge variant="secondary" className="bg-slate-950/50 text-slate-200 border border-slate-800 font-extrabold tabular-nums">
                      {colCount}
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="p-2.5 space-y-2.5 overflow-y-auto flex-1 custom-scrollbar">
                 {leadsInCol.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onRemove={removeLead}
                      onEdit={handleEdit}
                      onViewMessage={() => setSelectedLead(lead)}
                      customFields={customFields}
                      teamMembers={teamMembers}
                      pipelineStages={pipelineStages}
                      leadCardUi={leadCardUi}
                      delayDots={delayDotsUi}
                      slaIgnoreStages={slaIgnoreStages}
                      businessHours={businessHours}
                    />
                  ))}
                {colCount === 0 && (
                  <div className="text-center py-10 flex flex-col items-center gap-2 text-slate-600 text-xs border border-slate-800/70 bg-slate-950/10 rounded-xl">
                    <div className="w-10 h-10 rounded-2xl border border-slate-800 bg-slate-950/40 flex items-center justify-center text-slate-500">0</div>
                    No leads
                  </div>
                )}
              </div>
            </div>
              );
            })()
          ))}
        </div>

        {/* Mobile — single active tab column */}
        <div className="sm:hidden">
          {columns.filter(col => col.id === activeMobileTab).map((col) => (
            <div
              key={col.id}
              className="space-y-3 min-h-[300px] pb-20"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const leadId = e.dataTransfer.getData('leadId');
                if (leadId) updateLeadStatus(leadId, col.id);
              }}
            >
              {filteredLeads.filter(l => l.status === col.id).map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  onRemove={removeLead}
                  onEdit={handleEdit}
                  onViewMessage={() => setSelectedLead(lead)}
                  customFields={customFields}
                  teamMembers={teamMembers}
                  pipelineStages={pipelineStages}
                  leadCardUi={leadCardUi}
                  delayDots={delayDotsUi}
                  slaIgnoreStages={slaIgnoreStages}
                  businessHours={businessHours}
                />
              ))}
              {filteredLeads.filter(l => l.status === col.id).length === 0 && (
                <div className="text-center py-16 flex flex-col items-center gap-2 text-slate-600 text-sm border-2 border-dashed border-slate-800/50 rounded-lg">
                  <span>0</span>
                  No leads here
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function hashHue(input: string) {
  let h = 0;
  const s = String(input || '');
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function normalizeHexColor(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    return (`#${r}${r}${g}${g}${b}${b}`).toLowerCase();
  }
  return '';
}

function hexToRgba(hex: string, alpha: number): string {
  const h = normalizeHexColor(hex);
  if (!h) return '';
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function parseExtraData(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as any;
      return {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as any;
  return {};
}

function LeadCard({
  lead,
  onRemove,
  onEdit,
  onViewMessage,
  customFields,
  teamMembers,
  pipelineStages: _pipelineStages,
  leadCardUi,
  delayDots,
  slaIgnoreStages,
  businessHours,
}: {
  lead: Lead;
  onRemove: any;
  onEdit: any;
  onViewMessage: () => void;
  customFields: CustomField[];
  teamMembers: any[];
  pipelineStages: { id: string; label: string; color: string }[];
  leadCardUi?: LeadCardUISettings;
  delayDots?: DelayDotsSettings;
  slaIgnoreStages?: string[];
  businessHours?: BusinessHoursCfg;
}) {
  const dateStr = new Date(lead.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const unread = (lead as any).unread_count ? Number((lead as any).unread_count) : 0;

  const cfg: LeadCardUISettings = {
    showAssignee: true,
    showSource: true,
    showNameBadge: true,
    showProductBadge: true,
    showValue: true,
    showLastMessagePreview: true,
    showCustomFieldBadges: true,
    customFieldBadgeMode: 'value',
    customFieldIds: [],
    maxCustomFieldBadges: 2,
    ...(leadCardUi || {})
  };

  const extra = parseExtraData((lead as any).extra_data);
  const badgeFieldsAll = (customFields || []).filter(f => f.type === 'select' || f.type === 'datetime');
  const badgeFields = (Array.isArray(cfg.customFieldIds) && cfg.customFieldIds.length > 0)
    ? badgeFieldsAll.filter(f => cfg.customFieldIds!.includes(f.id))
    : badgeFieldsAll;

  const maxBadges = Number.isFinite(Number(cfg.maxCustomFieldBadges)) ? Math.max(0, Number(cfg.maxCustomFieldBadges)) : 2;

  const formatDatetimeBadge = (raw: any) => {
    const v = String(raw ?? '').trim();
    if (!v) return '';
    const d = new Date(v);
    if (Number.isFinite(d.getTime())) {
      return d.toLocaleString('az-AZ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    // Fallback for "YYYY-MM-DDTHH:mm"
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
      try {
        const d2 = new Date(v);
        if (Number.isFinite(d2.getTime())) {
          return d2.toLocaleString('az-AZ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        }
      } catch {
        // ignore
      }
    }
    return v;
  };

  const selectBadges = badgeFields
    .map(f => {
      const v = extra?.[f.id];
      const value = f.type === 'datetime'
        ? formatDatetimeBadge(v)
        : (typeof v === 'string' ? v.trim() : (v !== undefined && v !== null ? String(v).trim() : ''));
      if (!value) return null;
      return { id: f.id, label: f.label, value };
    })
    .filter(Boolean)
    .slice(0, maxBadges) as Array<{ id: string; label: string; value: string }>;

  const assigneeId = (lead as any).assignee_id || null;
  const assignee = assigneeId ? (teamMembers || []).find((u: any) => u.id === assigneeId) : null;
  const fallbackAdmin = (teamMembers || []).find((u: any) => u.role === 'admin') || null;
  const assigneeLabel = assignee
    ? (assignee.display_name || assignee.username || 'Operator')
    : (fallbackAdmin?.display_name || fallbackAdmin?.username || 'Admin');

  const sourceLabel = lead.source === 'manual' ? 'Manual' : 'WhatsApp';

  const primaryTitle = (cfg.showNameBadge !== false && lead.name && lead.name !== 'Unknown') ? String(lead.name) : String(lead.phone);
  const secondary = (cfg.showNameBadge !== false && lead.name && lead.name !== 'Unknown') ? String(lead.phone) : '';
  const hasValue = cfg.showValue !== false && Boolean(lead.value && lead.value > 0);

  const colorFieldId = String(cfg.colorByFieldId || '').trim();
  const colorStyle = (cfg.colorStyle === 'border' || cfg.colorStyle === 'tint') ? cfg.colorStyle : 'tint';
  const leadColorValue = colorFieldId ? String(extra?.[colorFieldId] ?? '').trim() : '';
  const mapped = leadColorValue && cfg.colorMap ? normalizeHexColor(String((cfg.colorMap as any)[leadColorValue] || '')) : '';
  const leadHue = hashHue(`${colorFieldId}:${leadColorValue}`);
  const leadAccent = leadColorValue
    ? (mapped || `hsl(${leadHue}, 85%, 60%)`)
    : '';
  const leadTint = leadColorValue
    ? (mapped ? hexToRgba(mapped, 0.12) : `hsla(${leadHue}, 85%, 60%, 0.12)`)
    : '';
  const leadBorder = leadColorValue
    ? (mapped ? hexToRgba(mapped, 0.30) : `hsla(${leadHue}, 85%, 60%, 0.30)`)
    : '';

  const nowMs = Date.now();
  const lastInMs = lead.last_inbound_at ? new Date(String(lead.last_inbound_at)).getTime() : null;
  const lastOutMs = (lead as any).last_outbound_at ? new Date(String((lead as any).last_outbound_at)).getTime() : null;
  const isClosed = Boolean((lead as any).conversation_closed);
  const ignoredForSla = Array.isArray(slaIgnoreStages) && slaIgnoreStages.includes(String(lead.status || ''));
  const waiting = !isClosed && !ignoredForSla && Boolean(lastInMs && (!lastOutMs || (lastOutMs < (lastInMs as number))));
  const waitingMin = waiting && lastInMs
    ? (businessHours?.enabled === true
      ? businessMinutesBetween(lastInMs, nowMs, businessHours)
      : (nowMs - lastInMs) / 60000)
    : 0;

  const dd = (delayDots && typeof delayDots === 'object') ? delayDots : {};
  const greenMax = Number.isFinite(Number((dd as any).greenMaxMinutes)) ? Math.max(1, Math.round(Number((dd as any).greenMaxMinutes))) : 10;
  const yellowMax = Number.isFinite(Number((dd as any).yellowMaxMinutes)) ? Math.max(greenMax + 1, Math.round(Number((dd as any).yellowMaxMinutes))) : 30;

  let responseDot = null as null | { color: string; title: string };
  if (waiting && waitingMin > 0) {
    const m = waitingMin;
    if (m <= greenMax) responseDot = { color: '#22c55e', title: `Cavab gecikmesi: ${m.toFixed(0)} dk (yasil)` };
    else if (m <= yellowMax) responseDot = { color: '#f59e0b', title: `Cavab gecikmesi: ${m.toFixed(0)} dk (sari)` };
    else responseDot = { color: '#ef4444', title: `Cavab gecikmesi: ${m.toFixed(0)} dk (qirmizi)` };
  }

  const nextDueMs = (lead as any).next_followup_due_at ? new Date(String((lead as any).next_followup_due_at)).getTime() : null;
  let followDot = null as null | { color: string; title: string };
  if (nextDueMs && Number.isFinite(nextDueMs)) {
    const diffMin = (nextDueMs - nowMs) / 60000;
    if (diffMin <= 0) followDot = { color: '#8b5cf6', title: `Follow-up kecib: ${Math.abs(diffMin).toFixed(0)} dk` };
    else if (diffMin <= 15) followDot = { color: '#a855f7', title: `Follow-up yaxindir: ${diffMin.toFixed(0)} dk` };
    else followDot = { color: '#60a5fa', title: `Follow-up plan: ${diffMin.toFixed(0)} dk` };
  }

  return (
    <div
      className={cn(
        "group relative rounded-2xl border bg-slate-950/40 p-3 shadow-sm transition-all duration-200",
        unread > 0
          ? "border-rose-500/35 hover:border-rose-400/60 shadow-rose-900/10"
          : "border-slate-800/80 hover:border-slate-700"
      )}
      style={{
        boxShadow: unread > 0 ? '0 10px 24px rgba(244,63,94,0.05)' : undefined,
        borderColor: leadBorder ? leadBorder : undefined,
        backgroundImage: (leadTint && colorStyle === 'tint') ? `linear-gradient(180deg, ${leadTint}, rgba(2,6,23,0) 55%)` : undefined,
      }}
    >
      {/* lead accent */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl"
        style={{ background: leadAccent || '#94a3b8', opacity: unread > 0 ? 0.9 : 0.55 }}
      />

       <div className="flex items-start justify-between gap-2">
         <div className="min-w-0 flex-1">
           <div className="flex items-start gap-2 min-w-0">
             <div
               draggable
               onDragStart={(e) => {
                 try {
                   e.dataTransfer.setData('leadId', lead.id);
                   e.dataTransfer.effectAllowed = 'move';
                 } catch { }
               }}
               className="shrink-0 w-7 h-7 rounded-xl border border-slate-800 bg-slate-950/50 flex items-center justify-center cursor-grab active:cursor-grabbing"
               title="Drag"
             >
               <GripVertical className="w-4 h-4 text-slate-600" />
             </div>

             <div className="min-w-0 flex-1">
               {/* Title + indicators (never share row with value) */}
               <div className="flex items-start justify-between gap-2 min-w-0">
                 <div className="min-w-0">
                   <div className="text-[13px] sm:text-[14px] font-extrabold text-slate-100 truncate" title={primaryTitle}>{primaryTitle}</div>
                   {secondary ? (
                     <div className="mt-0.5 text-[11px] text-slate-400 flex items-center gap-2 min-w-0">
                       <span className="inline-flex items-center gap-1 min-w-0">
                         <Phone className="w-3 h-3 text-green-500 shrink-0" />
                         <span className="font-mono tabular-nums truncate">{secondary}</span>
                       </span>
                     </div>
                   ) : null}
                 </div>

                 <div className="shrink-0 flex flex-col items-end gap-1">
                   {unread > 0 ? (
                     <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-950/25 px-2 py-0.5 text-[10px] font-extrabold text-rose-200 tabular-nums whitespace-nowrap">
                       <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                       {unread > 99 ? '99+' : unread}
                     </span>
                   ) : null}

                   {followDot || responseDot ? (
                     <span className="inline-flex items-center gap-1">
                       {followDot ? (
                         <span className="w-2.5 h-2.5 rounded-full border border-black/30" style={{ background: followDot.color }} title={followDot.title} />
                       ) : null}
                       {responseDot ? (
                         <span className="w-2.5 h-2.5 rounded-full border border-black/30" style={{ background: responseDot.color }} title={responseDot.title} />
                       ) : null}
                     </span>
                   ) : null}
                 </div>
               </div>

               {/* Channel + company (stacked) */}
               {(cfg.showSource !== false || cfg.showAssignee !== false) ? (
                 <div className="mt-2">
                   {cfg.showSource !== false ? (
                     <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-950/50 text-slate-300 border border-slate-800 whitespace-nowrap">
                       {sourceLabel}
                     </span>
                   ) : null}
                   {cfg.showAssignee !== false ? (
                     <div className={cn(
                       'mt-1 text-[11px] font-semibold text-slate-300 truncate',
                       cfg.showSource === false && 'mt-0'
                     )} title={assigneeLabel}>
                       {assigneeLabel}
                     </div>
                   ) : null}
                 </div>
               ) : null}

               {/* Date + value (separate row to avoid overlaps) */}
               <div className="mt-1 flex items-center justify-between gap-2 min-w-0">
                 <div className="text-[10px] text-slate-500 tabular-nums truncate">{dateStr}</div>
                 {hasValue ? (
                   <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-900/30 bg-emerald-950/15 px-2 py-0.5 text-[10px] font-extrabold text-emerald-200 tabular-nums whitespace-nowrap">
                     <DollarSign className="w-3 h-3" />
                     {formatCurrency(Number(lead.value || 0), 'AZN')}
                   </span>
                 ) : null}
               </div>
             </div>
           </div>
         </div>

        <div className={cn(
          'flex gap-1 transition-opacity',
          'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
        )}>
          <button
            type="button"
            onClick={() => onEdit(lead)}
            className="text-slate-500 hover:text-blue-300 p-1.5 rounded-lg hover:bg-slate-900/50 border border-transparent hover:border-slate-800"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onRemove(lead.id)}
            className="text-slate-500 hover:text-red-300 p-1.5 rounded-lg hover:bg-slate-900/50 border border-transparent hover:border-slate-800"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Product Name Badge */}
      {cfg.showProductBadge !== false && lead.product_name && (
        <div className="mt-3">
          <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-950/40 text-slate-200 border border-slate-800">
            <ShoppingBag className="w-3.5 h-3.5 text-slate-400" />
            <span className="truncate max-w-[260px]" title={lead.product_name}>{lead.product_name}</span>
          </span>
        </div>
      )}

      {cfg.showCustomFieldBadges !== false && selectBadges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selectBadges.map(b => {
            const hue = hashHue(`${b.id}:${b.value}`);
            const dot: React.CSSProperties = { backgroundColor: `hsl(${hue}, 85%, 70%)` };
            return (
              <span
                key={`${b.id}:${b.value}`}
                title={`${b.label}: ${b.value}`}
                className="inline-flex items-center gap-2 px-2 py-1 rounded-full text-[10px] font-bold border border-slate-800 bg-slate-950/35 text-slate-200 max-w-full"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={dot} />
                <span className="max-w-[220px] truncate">
                  {(cfg.customFieldBadgeMode || 'value') === 'label_value' ? `${b.label}: ${b.value}` : b.value}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {cfg.showLastMessagePreview !== false && lead.last_message && (
        <button
          type="button"
          onClick={onViewMessage}
          className={cn(
            'mt-3 w-full text-left rounded-xl border px-3 py-2 transition-colors',
            'border-slate-800/80 bg-slate-950/35 hover:bg-slate-950/55 hover:border-slate-700',
            unread > 0 && 'border-rose-500/20'
          )}
          title="Mesaji ac"
        >
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">Son mesaj</div>
          <p className="mt-1 text-[12px] text-slate-200 line-clamp-2 leading-snug">
            {lead.last_message}
          </p>
        </button>
      )}
    </div>
  );
}
