import React, { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '../context/Store';
import { Lead, LeadStatus } from '../types/crm';
import { Badge } from '../components/ui/Badge';
import { Trash2, Calendar, Filter, RefreshCcw, Pencil, ShoppingBag, DollarSign, TrendingUp, Users, MessageSquare, UserPlus, CheckCircle, XCircle, Phone, Route } from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { LeadDetailsPanel } from '../components/LeadDetailsPanel';
import { loadCRMSettings, CustomField, LeadCardUISettings } from '../lib/crmSettings';
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

  const { pipelineStages, customFields, ui } = loadCRMSettings();
  const leadCardUi = ui?.leadCard;

  const pipelineSig = useMemo(() => (pipelineStages || []).map(s => s.id).join('|'), [pipelineStages]);

  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<CRMFilters>(() => makeDefaultCRMFilters(pipelineStages));

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
      if (customText.length + customSelect.length + customNumber.length > 0) {
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
    const totalRevenue = filteredLeads
      .filter(l => l.status === 'won')
      .reduce((sum, l) => sum + (l.value || 0), 0);

    return { totalLeads, totalRevenue };
  }, [filteredLeads]);

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

  const kanbanMinWidth = Math.max(1000, columns.length * 290);

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

            {currentUser?.permissions?.view_budget !== false && (
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
              <span className="tabular-nums">{dateRange.start || '...'} - {dateRange.end || '...'}</span>
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
            <span className={cn(
              "text-[8px] px-1.5 py-0.5 rounded-full mt-0.5",
              activeMobileTab === col.id ? "bg-white/20 text-white" : "bg-slate-800 text-slate-400"
            )}>
              {filteredLeads.filter(l => l.status === col.id).length}
            </span>
          </button>
        ))}
      </div>

      {/* KANBAN BOARD — desktop: side-by-side | mobile: single column */}
      <div className="flex-1 overflow-x-auto pb-4">
        {/* Desktop */}
        <div className="hidden sm:flex gap-4 lg:gap-6 h-full" style={{ minWidth: kanbanMinWidth }}>
          {columns.map((col) => (
            <div
              key={col.id}
              className="flex-1 min-w-[250px] flex flex-col bg-slate-900/50 rounded-xl border border-slate-800 h-full max-h-[calc(100vh-300px)]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const leadId = e.dataTransfer.getData('leadId');
                if (leadId) updateLeadStatus(leadId, col.id);
              }}
            >
              <div className={`p-2.5 border-b border-slate-800 flex items-center justify-between`}>
                <div className="flex items-center gap-2 font-semibold text-slate-200 text-sm">
                  <div className="p-1 rounded bg-slate-800">
                    {col.icon}
                  </div>
                  {col.title}
                </div>
                <Badge variant="secondary" className="bg-slate-800 text-slate-300">
                  {filteredLeads.filter(l => l.status === col.id).length}
                </Badge>
              </div>
              <div className="p-2.5 space-y-2 overflow-y-auto flex-1 custom-scrollbar">
                {filteredLeads.filter(l => l.status === col.id).map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    onUpdateStatus={updateLeadStatus}
                    onRemove={removeLead}
                    onEdit={handleEdit}
                    onViewMessage={() => setSelectedLead(lead)}
                    customFields={customFields}
                    teamMembers={teamMembers}
                    pipelineStages={pipelineStages}
                    leadCardUi={leadCardUi}
                  />
                ))}
                {filteredLeads.filter(l => l.status === col.id).length === 0 && (
                  <div className="text-center py-10 flex flex-col items-center gap-2 text-slate-600 text-xs border-2 border-dashed border-slate-800/50 rounded-lg">
                    No leads
                  </div>
                )}
              </div>
            </div>
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
                  onUpdateStatus={updateLeadStatus}
                  onRemove={removeLead}
                  onEdit={handleEdit}
                  onViewMessage={() => setSelectedLead(lead)}
                  customFields={customFields}
                  teamMembers={teamMembers}
                  pipelineStages={pipelineStages}
                  leadCardUi={leadCardUi}
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
  onUpdateStatus,
  onRemove,
  onEdit,
  onViewMessage,
  customFields,
  teamMembers,
  pipelineStages,
  leadCardUi,
}: {
  lead: Lead;
  onUpdateStatus: any;
  onRemove: any;
  onEdit: any;
  onViewMessage: () => void;
  customFields: CustomField[];
  teamMembers: any[];
  pipelineStages: { id: string; label: string; color: string }[];
  leadCardUi?: LeadCardUISettings;
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
  const selectFieldsAll = (customFields || []).filter(f => f.type === 'select');
  const selectFields = (Array.isArray(cfg.customFieldIds) && cfg.customFieldIds.length > 0)
    ? selectFieldsAll.filter(f => cfg.customFieldIds!.includes(f.id))
    : selectFieldsAll;

  const maxBadges = Number.isFinite(Number(cfg.maxCustomFieldBadges)) ? Math.max(0, Number(cfg.maxCustomFieldBadges)) : 2;

  const selectBadges = selectFields
    .map(f => {
      const v = extra?.[f.id];
      const value = typeof v === 'string' ? v.trim() : (v !== undefined && v !== null ? String(v).trim() : '');
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

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('leadId', lead.id)}
      className={cn(
        "bg-slate-950 border p-2.5 rounded-lg shadow-sm hover:shadow-md transition-all duration-200 group relative cursor-grab active:cursor-grabbing",
        unread > 0 ? "border-rose-500/40 hover:border-rose-400/60" : "border-slate-800 hover:border-slate-600"
      )}
    >
      <div className="flex justify-between items-start mb-1.5">
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5 text-[13px] font-bold text-slate-200">
            <Phone className="w-3 h-3 text-green-500" />
            {lead.phone}
            {unread > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-extrabold">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 flex items-center gap-1">
              <Calendar className="w-2.5 h-2.5" /> {dateStr}
            </span>
            {cfg.showNameBadge !== false && lead.name && lead.name !== 'Unknown' && (
              <span className="text-[9px] text-blue-400 bg-blue-950/30 px-1 rounded truncate max-w-[140px]">{lead.name}</span>
            )}
          </div>

          {(cfg.showAssignee !== false || cfg.showSource !== false) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {cfg.showAssignee !== false && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-slate-900/60 text-slate-300 border border-slate-800">
                  <Users className="w-2.5 h-2.5" /> {assigneeLabel}
                </span>
              )}
              {cfg.showSource !== false && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-slate-900/60 text-slate-300 border border-slate-800">
                  <Route className="w-2.5 h-2.5" /> {sourceLabel}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onEdit(lead)} className="text-slate-500 hover:text-blue-400 p-1">
            <Pencil className="w-3 h-3" />
          </button>
          <button onClick={() => onRemove(lead.id)} className="text-slate-500 hover:text-red-400 p-1">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Product Name Badge */}
      {cfg.showProductBadge !== false && lead.product_name && (
        <div className="mb-2">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-300 border border-slate-700">
            <ShoppingBag className="w-2.5 h-2.5" /> {lead.product_name}
          </span>
        </div>
      )}

      {cfg.showCustomFieldBadges !== false && selectBadges.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {selectBadges.map(b => {
            const hue = hashHue(`${b.id}:${b.value}`);
            const style: React.CSSProperties = {
              backgroundColor: `hsla(${hue}, 70%, 22%, 0.45)`,
              borderColor: `hsla(${hue}, 75%, 55%, 0.55)`,
              color: `hsl(${hue}, 85%, 78%)`
            };
            return (
              <span
                key={`${b.id}:${b.value}`}
                title={`${b.label}: ${b.value}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border max-w-full"
                style={style}
              >
                <span className="max-w-[180px] truncate">
                  {(cfg.customFieldBadgeMode || 'value') === 'label_value' ? `${b.label}: ${b.value}` : b.value}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {cfg.showLastMessagePreview !== false && lead.last_message && (
        <div className="bg-slate-900/50 p-2 rounded mb-1.5 border border-slate-800/50">
          <p className="text-[11px] text-slate-300 line-clamp-2 italic leading-snug">
            "{lead.last_message}"
          </p>
        </div>
      )}

      {/* Button to open lead details explicitly */}
      <button
        onClick={onViewMessage}
        className="w-full mb-1.5 py-1 text-[9px] font-bold tracking-widest uppercase bg-blue-950/30 hover:bg-blue-900/50 text-blue-400 rounded border border-blue-900/50 transition-colors"
      >
        ƏTRAFLI
      </button>

      {cfg.showValue !== false && lead.value && lead.value > 0 ? (
        <div className="mb-2 text-xs font-mono text-green-400 flex items-center gap-1">
          <DollarSign className="w-3 h-3" /> {lead.value} AZN
        </div>
      ) : null}

      {/* Quick Actions (dynamic from Kanban stages) */}
      {Array.isArray(pipelineStages) && pipelineStages.length > 0 && (
        <div className="mt-1.5 opacity-80 hover:opacity-100 transition-opacity">
          <div className="-mx-1 px-1 overflow-x-auto no-scrollbar">
            <div className="flex gap-1 min-w-max">
              {pipelineStages.filter(s => s.id !== lead.status).map(stage => {
                const c = String(stage.color || 'slate');
                const cls = c === 'green'
                  ? 'bg-green-950/20 hover:bg-green-900/40 text-green-300 border-green-900/30'
                  : c === 'blue'
                    ? 'bg-blue-950/20 hover:bg-blue-900/40 text-blue-300 border-blue-900/30'
                    : c === 'purple'
                      ? 'bg-purple-950/20 hover:bg-purple-900/40 text-purple-300 border-purple-900/30'
                      : c === 'red'
                        ? 'bg-red-950/20 hover:bg-red-900/40 text-red-300 border-red-900/30'
                        : c === 'orange' || c === 'amber' || c === 'yellow'
                          ? 'bg-amber-950/20 hover:bg-amber-900/40 text-amber-200 border-amber-900/30'
                          : 'bg-slate-900 hover:bg-slate-800 text-slate-400 border-slate-800';

                return (
                  <button
                    key={stage.id}
                    onClick={() => onUpdateStatus(lead.id, stage.id)}
                    className={cn('px-2 py-1 text-[9px] font-semibold rounded border transition-colors whitespace-nowrap', cls)}
                    title={stage.label}
                  >
                    {stage.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
