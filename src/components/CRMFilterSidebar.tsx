import React, { useEffect, useMemo, useState } from 'react';
import { X, Filter, Calendar, CheckSquare, Square, Users, Database, DollarSign, Tag, MessageSquare, ShoppingBag, Smartphone } from 'lucide-react';
import { cn } from '../lib/utils';
import type { DateRange, User, WhatsAppAccount } from '../types/crm';
import type { CustomField, PipelineStage } from '../lib/crmSettings';
import { CrmService } from '../services/CrmService';

export type CRMFilters = {
  query: string;
  product: string;
  source: 'all' | 'whatsapp' | 'facebook' | 'instagram' | 'manual';
  whatsappAccountId: string; // '' = all accounts
  stageIds: string[];
  assigneeIds: string[]; // empty = all
  valueMin: string;
  valueMax: string;
  customText: Record<string, string>;
  customSelect: Record<string, string>;
  customNumber: Record<string, { min: string; max: string }>;
  customDate: Record<string, { start: string; end: string }>;
};

function toLocalISO(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cleanString(v: unknown) {
  return String(v ?? '').trim();
}

function isNonEmpty(v: unknown) {
  return cleanString(v) !== '';
}

export function countActiveFilters(filters: CRMFilters, pipelineStages: PipelineStage[]) {
  let n = 0;
  if (isNonEmpty(filters.query)) n++;
  if (isNonEmpty(filters.product)) n++;
  if (filters.source !== 'all') n++;
  if (isNonEmpty(filters.whatsappAccountId)) n++;
  if (filters.assigneeIds.length > 0) n++;
  if (isNonEmpty(filters.valueMin) || isNonEmpty(filters.valueMax)) n++;
  if (filters.stageIds.length !== pipelineStages.length) n++;

  for (const v of Object.values(filters.customText)) {
    if (isNonEmpty(v)) {
      n++;
      break;
    }
  }
  for (const v of Object.values(filters.customSelect)) {
    if (isNonEmpty(v)) {
      n++;
      break;
    }
  }
  for (const v of Object.values(filters.customNumber)) {
    if (isNonEmpty(v?.min) || isNonEmpty(v?.max)) {
      n++;
      break;
    }
  }

  for (const v of Object.values(filters.customDate)) {
    if (isNonEmpty(v?.start) || isNonEmpty(v?.end)) {
      n++;
      break;
    }
  }

  return n;
}

export function makeDefaultCRMFilters(pipelineStages: PipelineStage[]): CRMFilters {
  return {
    query: '',
    product: '',
    source: 'all',
    whatsappAccountId: '',
    stageIds: pipelineStages.map(s => s.id),
    assigneeIds: [],
    valueMin: '',
    valueMax: '',
    customText: {},
    customSelect: {},
    customNumber: {},
    customDate: {},
  };
}

export function CRMFilterSidebar({
  open,
  onClose,
  filters,
  setFilters,
  pipelineStages,
  customFields,
  teamMembers,
  currentUser,
  dateRange,
  setDateRange,
  resultCount,
  totalCount,
}: {
  open: boolean;
  onClose: () => void;
  filters: CRMFilters;
  setFilters: React.Dispatch<React.SetStateAction<CRMFilters>>;
  pipelineStages: PipelineStage[];
  customFields: CustomField[];
  teamMembers: User[];
  currentUser: User | null;
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  resultCount: number;
  totalCount: number;
}) {
  const selectFields = useMemo(() => (customFields || []).filter(f => f.type === 'select'), [customFields]);
  const textFields = useMemo(() => (customFields || []).filter(f => f.type === 'text'), [customFields]);
  const numberFields = useMemo(() => (customFields || []).filter(f => f.type === 'number'), [customFields]);
  const dateFields = useMemo(() => (customFields || []).filter(f => f.type === 'datetime'), [customFields]);

  // Multi-WhatsApp accounts list (for filter dropdown)
  const [waAccounts, setWaAccounts] = useState<WhatsAppAccount[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    CrmService.listWhatsAppAccounts().then((data) => {
      if (!cancelled) setWaAccounts(data.accounts || []);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const activeCount = useMemo(() => countActiveFilters(filters, pipelineStages), [filters, pipelineStages]);

  // Lock background scroll on mobile (iOS-safe)
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const prevBody = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    const prevHtmlOverflow = document.documentElement.style.overflow;

    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBody.overflow;
      document.body.style.position = prevBody.position;
      document.body.style.top = prevBody.top;
      document.body.style.width = prevBody.width;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  if (!open) return null;

  const toggleMulti = (arr: string[], id: string) => {
    if (arr.includes(id)) return arr.filter(x => x !== id);
    return [...arr, id];
  };

  const presetRange = (kind: number | 'all' | 'today' | 'yesterday') => {
    if (kind === 'all') {
      setDateRange({ start: null, end: null });
      return;
    }
    if (kind === 'today') {
      const d = new Date();
      const iso = toLocalISO(d);
      setDateRange({ start: iso, end: iso });
      return;
    }
    if (kind === 'yesterday') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const iso = toLocalISO(d);
      setDateRange({ start: iso, end: iso });
      return;
    }
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(0, kind - 1));
    setDateRange({ start: toLocalISO(start), end: toLocalISO(end) });
  };

  const allStagesSelected = filters.stageIds.length === pipelineStages.length;

  // Quick view presets — compose existing filter state, no new backend needed.
  type Preset = { id: string; label: string; dot?: string; apply: () => void; isActive: () => boolean };
  const presets: Preset[] = [
    {
      id: 'all',
      label: 'Bütün leadlər',
      apply: () => {
        setFilters(makeDefaultCRMFilters(pipelineStages));
        setDateRange({ start: null, end: null });
      },
      isActive: () => activeCount === 0 && !dateRange.start && !dateRange.end,
    },
    {
      id: 'mine',
      label: 'Mənim leadlərim',
      dot: 'bg-blue-400',
      apply: () => {
        if (currentUser?.id) {
          setFilters(p => ({ ...p, assigneeIds: [currentUser.id] }));
        }
      },
      isActive: () => Boolean(currentUser?.id && filters.assigneeIds.length === 1 && filters.assigneeIds[0] === currentUser.id),
    },
    {
      id: 'today',
      label: 'Bugün',
      dot: 'bg-emerald-400',
      apply: () => presetRange('today'),
      isActive: () => {
        const t = toLocalISO(new Date());
        return dateRange.start === t && dateRange.end === t;
      },
    },
    {
      id: 'yesterday',
      label: 'Dün',
      apply: () => presetRange('yesterday'),
      isActive: () => {
        const d = new Date(); d.setDate(d.getDate() - 1);
        const y = toLocalISO(d);
        return dateRange.start === y && dateRange.end === y;
      },
    },
    { id: '7d', label: 'Son 7 gün', apply: () => presetRange(7), isActive: () => false },
    { id: '30d', label: 'Son 30 gün', apply: () => presetRange(30), isActive: () => false },
    {
      id: 'unassigned',
      label: 'Təyin edilməyən',
      dot: 'bg-amber-400',
      apply: () => setFilters(p => ({ ...p, assigneeIds: ['unassigned'] })),
      isActive: () => filters.assigneeIds.length === 1 && filters.assigneeIds[0] === 'unassigned',
    },
  ];

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-6xl h-full sm:h-[92vh] bg-[#0d1117] border border-white/5 rounded-none sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: 'fadeInUp 0.18s ease-out' }}
        onClick={e => e.stopPropagation()}
      >
        {/* TOP HEADER — search bar + result count + close */}
        <div className="h-14 flex items-center gap-3 px-4 border-b border-white/5 bg-[#111827] shrink-0">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <Filter className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-0 max-w-xl">
            <MessageSquare className="w-4 h-4 text-slate-500 shrink-0" />
            <input
              value={filters.query}
              onChange={(e) => setFilters(p => ({ ...p, query: e.target.value }))}
              placeholder="Axtarış: ad / telefon / mesaj"
              className="flex-1 h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
            />
          </div>
          <div className="hidden sm:flex items-center gap-2 ml-auto text-[11px] text-slate-400">
            <span className="font-bold text-slate-200 tabular-nums">{resultCount}</span>
            <span className="text-slate-600">/</span>
            <span className="tabular-nums">{totalCount}</span>
            <span>lead</span>
            {activeCount > 0 ? (
              <span className="ml-2 text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-300 border border-blue-500/20">
                {activeCount} aktiv filtr
              </span>
            ) : null}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors shrink-0" title="Bağla">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 3-COLUMN BODY: Quick views | Lead properties | Tags / Quick chips */}
        <div className="flex-1 min-h-0 flex overflow-hidden">

          {/* ─── LEFT COLUMN: Quick views ─── */}
          <aside className="hidden md:flex w-[200px] shrink-0 border-r border-white/5 bg-[#111827]/60 flex-col overflow-y-auto custom-scrollbar">
            <div className="p-3 border-b border-white/5">
              <h3 className="text-[10px] uppercase font-extrabold tracking-wider text-slate-500">Tez görünüşlər</h3>
            </div>
            <div className="p-2 space-y-0.5">
              {presets.map((p) => {
                const active = p.isActive();
                return (
                  <button
                    key={p.id}
                    onClick={p.apply}
                    className={cn(
                      'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-[12px] font-semibold transition-colors',
                      active
                        ? 'bg-blue-600/15 text-blue-200 border border-blue-500/30'
                        : 'text-slate-300 hover:bg-slate-800/40 border border-transparent'
                    )}
                  >
                    {p.dot ? <span className={cn('w-2 h-2 rounded-full shrink-0', p.dot)} /> : <span className="w-2 h-2 shrink-0" />}
                    <span className="truncate">{p.label}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* ─── MIDDLE COLUMN: Lead properties ─── */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-5 space-y-3 custom-scrollbar">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] uppercase font-extrabold tracking-wider text-slate-500">Lead özəllikləri</h3>
              {activeCount > 0 ? (
                <button
                  onClick={() => {
                    setFilters(makeDefaultCRMFilters(pipelineStages));
                    setDateRange({ start: null, end: null });
                  }}
                  className="text-[10px] font-bold text-rose-400 hover:text-rose-300 underline"
                >
                  Hamısını sıfırla
                </button>
              ) : null}
            </div>
          <section className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
            <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300 mb-2">
              <ShoppingBag className="w-3.5 h-3.5 text-slate-400" />
              Məhsul / Sifariş
            </div>
            <input
              value={filters.product}
              onChange={(e) => setFilters(p => ({ ...p, product: e.target.value }))}
              placeholder="Məhsul adı və ya sifariş nömrəsi"
              className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
            />
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                Tarix (created)
              </div>
              <div className="flex flex-wrap items-center gap-1 justify-end">
                <button onClick={() => presetRange('today')} className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800">Bugun</button>
                <button onClick={() => presetRange('yesterday')} className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800">Dun</button>
                <button onClick={() => presetRange(7)} className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800">7g</button>
                <button onClick={() => presetRange(30)} className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800">30g</button>
                <button onClick={() => presetRange('all')} className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800">Hamı</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={dateRange.start || ''}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value || null })}
                className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
              />
              <input
                type="date"
                value={dateRange.end || ''}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value || null })}
                className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
              />
            </div>
          </section>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <section className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
              <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300 mb-2">
                <DollarSign className="w-3.5 h-3.5 text-slate-400" />
                Dəyər (AZN)
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={filters.valueMin}
                  onChange={(e) => setFilters(p => ({ ...p, valueMin: e.target.value }))}
                  inputMode="decimal"
                  placeholder="min"
                  className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                />
                <input
                  value={filters.valueMax}
                  onChange={(e) => setFilters(p => ({ ...p, valueMax: e.target.value }))}
                  inputMode="decimal"
                  placeholder="max"
                  className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                />
              </div>
            </section>

            <section className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
              <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300 mb-2">
                <Users className="w-3.5 h-3.5 text-slate-400" />
                Operator
              </div>
              <div className="space-y-1 max-h-28 overflow-auto custom-scrollbar pr-1">
                <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={filters.assigneeIds.includes('unassigned')}
                    onChange={() => setFilters(p => ({ ...p, assigneeIds: toggleMulti(p.assigneeIds, 'unassigned') }))}
                    className="accent-blue-600"
                  />
                  Təyin edilməyib
                </label>
                {(teamMembers || []).map(u => (
                  <label key={u.id} className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={filters.assigneeIds.includes(u.id)}
                      onChange={() => setFilters(p => ({ ...p, assigneeIds: toggleMulti(p.assigneeIds, u.id) }))}
                      className="accent-blue-600"
                    />
                    <span className="truncate" title={u.display_name || u.username}>
                      {u.display_name || u.username}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          </div>

          <section className="rounded-xl border border-slate-800 bg-slate-900/35 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
                <Tag className="w-3.5 h-3.5 text-slate-400" />
                Mərhələlər
              </div>
              <button
                onClick={() => setFilters(p => ({ ...p, stageIds: allStagesSelected ? [] : pipelineStages.map(s => s.id) }))}
                className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
              >
                {allStagesSelected ? 'Sil' : 'Hamısı'}
              </button>
            </div>
            <div className="space-y-0.5">
              {pipelineStages.map(s => {
                const checked = filters.stageIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => setFilters(p => ({ ...p, stageIds: toggleMulti(p.stageIds, s.id) }))}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md border text-left transition-colors',
                      checked ? 'border-slate-700 bg-slate-950/40' : 'border-slate-800/60 bg-transparent hover:bg-slate-950/30'
                    )}
                  >
                    {checked ? <CheckSquare className="w-3.5 h-3.5 text-blue-400 shrink-0" /> : <Square className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
                    <span className="text-[11px] font-semibold text-slate-200 truncate">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {(selectFields.length + textFields.length + numberFields.length + dateFields.length) > 0 && (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                <Tag className="w-4 h-4 text-slate-400" />
                Xüsusi sahələr
              </div>

              {selectFields.length > 0 && (
                <div className="mt-3 space-y-2">
                  {selectFields.map(f => (
                    <div key={f.id} className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                      <div className="text-[11px] font-bold text-slate-300">{f.label}</div>
                      <select
                        value={filters.customSelect[f.id] || ''}
                        onChange={(e) => setFilters(p => ({ ...p, customSelect: { ...p.customSelect, [f.id]: e.target.value } }))}
                        className="mt-2 w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                      >
                        <option value="">Hamısı</option>
                        {(f.options || []).map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}

              {textFields.length > 0 && (
                <div className="mt-3 space-y-2">
                  {textFields.map(f => (
                    <div key={f.id} className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                      <div className="text-[11px] font-bold text-slate-300">{f.label}</div>
                      <input
                        value={filters.customText[f.id] || ''}
                        onChange={(e) => setFilters(p => ({ ...p, customText: { ...p.customText, [f.id]: e.target.value } }))}
                        placeholder="contains..."
                        className="mt-2 w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                      />
                    </div>
                  ))}
                </div>
              )}

              {numberFields.length > 0 && (
                <div className="mt-3 space-y-2">
                  {numberFields.map(f => {
                    const cur = filters.customNumber[f.id] || { min: '', max: '' };
                    return (
                      <div key={f.id} className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                        <div className="text-[11px] font-bold text-slate-300">{f.label}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <input
                            value={cur.min}
                            onChange={(e) => setFilters(p => ({ ...p, customNumber: { ...p.customNumber, [f.id]: { ...cur, min: e.target.value } } }))}
                            inputMode="decimal"
                            placeholder="min"
                            className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                          />
                          <input
                            value={cur.max}
                            onChange={(e) => setFilters(p => ({ ...p, customNumber: { ...p.customNumber, [f.id]: { ...cur, max: e.target.value } } }))}
                            inputMode="decimal"
                            placeholder="max"
                            className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {dateFields.length > 0 && (
                <div className="mt-3 space-y-2">
                  {dateFields.map(f => {
                    const cur = filters.customDate[f.id] || { start: '', end: '' };
                    return (
                      <div key={f.id} className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                        <div className="text-[11px] font-bold text-slate-300">{f.label}</div>
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            type="datetime-local"
                            value={cur.start}
                            onChange={(e) => setFilters(p => ({ ...p, customDate: { ...p.customDate, [f.id]: { ...cur, start: e.target.value } } }))}
                            className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                          />
                          <input
                            type="datetime-local"
                            value={cur.end}
                            onChange={(e) => setFilters(p => ({ ...p, customDate: { ...p.customDate, [f.id]: { ...cur, end: e.target.value } } }))}
                            className="h-9 rounded-lg bg-slate-950 border border-slate-800 px-2 text-[12px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          </div>
          {/* end MIDDLE column */}

          {/* ─── RIGHT COLUMN: Tag-style quick chip filters ─── */}
          <aside className="hidden lg:flex w-[260px] shrink-0 border-l border-white/5 bg-[#111827]/60 flex-col overflow-y-auto custom-scrollbar">
            <div className="p-3 border-b border-white/5">
              <h3 className="text-[10px] uppercase font-extrabold tracking-wider text-slate-500">Etiketlər</h3>
            </div>
            <div className="p-3 space-y-4">

              {/* Source chips */}
              <div>
                <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-2">
                  <Database className="w-3 h-3" />
                  Mənbə
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { id: 'all', label: 'Hamısı', dot: 'bg-slate-500' },
                    { id: 'whatsapp', label: 'WhatsApp', dot: 'bg-emerald-500' },
                    { id: 'facebook', label: 'Facebook', dot: 'bg-blue-500' },
                    { id: 'instagram', label: 'Instagram', dot: 'bg-pink-500' },
                    { id: 'manual', label: 'Manual', dot: 'bg-slate-400' },
                  ] as const).map((opt) => {
                    const active = filters.source === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setFilters(p => ({ ...p, source: opt.id }))}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[10px] font-bold transition-colors',
                          active
                            ? 'border-blue-500/40 bg-blue-600/15 text-blue-200'
                            : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900'
                        )}
                      >
                        <span className={cn('w-1.5 h-1.5 rounded-full', opt.dot)} />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* WhatsApp accounts as chips */}
              {(filters.source === 'all' || filters.source === 'whatsapp') && waAccounts.length > 0 ? (
                <div>
                  <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-2">
                    <Smartphone className="w-3 h-3 text-emerald-400" />
                    WhatsApp hesabları
                  </div>
                  <div className="space-y-1">
                    <button
                      onClick={() => setFilters(p => ({ ...p, whatsappAccountId: '' }))}
                      className={cn(
                        'w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border text-[11px] font-semibold transition-colors',
                        !filters.whatsappAccountId
                          ? 'border-blue-500/40 bg-blue-600/15 text-blue-200'
                          : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900'
                      )}
                    >
                      <span className="truncate">Bütün hesablar</span>
                      <span className="text-[9px] text-slate-500 tabular-nums">{waAccounts.length}</span>
                    </button>
                    {waAccounts.map((acc) => {
                      const active = filters.whatsappAccountId === acc.id;
                      return (
                        <button
                          key={acc.id}
                          onClick={() => setFilters(p => ({ ...p, whatsappAccountId: acc.id }))}
                          className={cn(
                            'w-full text-left flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-[11px] font-semibold transition-colors',
                            active
                              ? 'border-emerald-500/40 bg-emerald-600/10 text-emerald-200'
                              : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900'
                          )}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0"
                            style={{ background: '#25D366' }}
                          >
                            <Smartphone className="w-2 h-2 text-white" />
                          </span>
                          <span className="truncate flex-1">{acc.label}</span>
                          {acc.is_default ? <span className="text-[9px] text-amber-400">⭐</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* Active filters summary */}
              {activeCount > 0 ? (
                <div className="rounded-lg border border-blue-900/40 bg-blue-950/20 p-2">
                  <div className="text-[10px] font-extrabold uppercase tracking-wider text-blue-300 mb-1">Aktiv filtrlər</div>
                  <p className="text-[11px] text-blue-200">{activeCount} filtr tətbiq olunub</p>
                  <button
                    onClick={() => {
                      setFilters(makeDefaultCRMFilters(pipelineStages));
                      setDateRange({ start: null, end: null });
                    }}
                    className="mt-2 w-full py-1 rounded-md text-[10px] font-bold border border-rose-900/40 bg-rose-950/15 text-rose-300 hover:bg-rose-950/25"
                  >
                    Hamısını sıfırla
                  </button>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
        {/* end body */}

        {/* FOOTER */}
        <div className="p-3 border-t border-white/5 bg-[#111827]/60 shrink-0 flex items-center gap-2">
          <button
            onClick={() => {
              setFilters(makeDefaultCRMFilters(pipelineStages));
              setDateRange({ start: null, end: null });
            }}
            className="px-4 py-2 rounded-lg text-[12px] font-extrabold text-slate-200 border border-slate-700 bg-slate-900 hover:bg-slate-800 transition-colors"
            title="Filterləri sıfırla"
          >
            Sıfırla
          </button>
          <div className="flex-1" />
          <span className="text-[11px] text-slate-400 mr-2">
            <span className="font-bold text-slate-200 tabular-nums">{resultCount}</span>
            <span className="text-slate-600 mx-1">/</span>
            <span className="tabular-nums">{totalCount}</span>
            <span className="ml-1">lead</span>
          </span>
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg text-[12px] font-extrabold text-white bg-blue-600 hover:bg-blue-500 transition-colors inline-flex items-center gap-2"
          >
            <Filter className="w-3.5 h-3.5" />
            Tətbiq et
          </button>
        </div>

        <style>{`
          @keyframes fadeInUp {
            from { transform: translateY(8px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}</style>
      </div>
    </div>
  );
}
