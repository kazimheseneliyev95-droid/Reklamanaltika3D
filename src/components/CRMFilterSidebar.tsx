import React, { useMemo } from 'react';
import { X, Filter, Calendar, CheckSquare, Square, Users, Database, DollarSign, Tag, MessageSquare, ShoppingBag } from 'lucide-react';
import { cn } from '../lib/utils';
import type { DateRange, User } from '../types/crm';
import type { CustomField, PipelineStage } from '../lib/crmSettings';

export type CRMFilters = {
  query: string;
  product: string;
  source: 'all' | 'whatsapp' | 'manual';
  stageIds: string[];
  assigneeIds: string[]; // empty = all
  valueMin: string;
  valueMax: string;
  customText: Record<string, string>;
  customSelect: Record<string, string>;
  customNumber: Record<string, { min: string; max: string }>;
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

  return n;
}

export function makeDefaultCRMFilters(pipelineStages: PipelineStage[]): CRMFilters {
  return {
    query: '',
    product: '',
    source: 'all',
    stageIds: pipelineStages.map(s => s.id),
    assigneeIds: [],
    valueMin: '',
    valueMax: '',
    customText: {},
    customSelect: {},
    customNumber: {},
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

  const activeCount = useMemo(() => countActiveFilters(filters, pipelineStages), [filters, pipelineStages]);

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
    const start = new Date(end.getTime() - (kind * 24 * 60 * 60 * 1000));
    setDateRange({ start: toLocalISO(start), end: toLocalISO(end) });
  };

  const allStagesSelected = filters.stageIds.length === pipelineStages.length;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex justify-end" onClick={onClose}>
      <div
        className="h-full w-full sm:w-[440px] bg-[#0d1117] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="h-14 flex items-center justify-between px-5 border-b border-white/5 bg-[#111827] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
              <Filter className="w-4 h-4 text-blue-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-base">Filtrlər</span>
                {activeCount > 0 && (
                  <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-300 border border-blue-500/20">
                    {activeCount}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-500 truncate">
                {resultCount} / {totalCount} lead
                {currentUser?.display_name ? ` · ${currentUser.display_name}` : ''}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors" title="Bağla">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
              <MessageSquare className="w-4 h-4 text-slate-400" />
              Axtarış
            </div>
            <div className="mt-2 space-y-2">
              <input
                value={filters.query}
                onChange={(e) => setFilters(p => ({ ...p, query: e.target.value }))}
                placeholder="Ad / Telefon / Mesaj"
                className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
              />
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-slate-500" />
                <input
                  value={filters.product}
                  onChange={(e) => setFilters(p => ({ ...p, product: e.target.value }))}
                  placeholder="Məhsul / Sifariş"
                  className="flex-1 h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                <Calendar className="w-4 h-4 text-slate-400" />
                Tarix (created)
              </div>
              <div className="flex flex-wrap items-center gap-1 justify-end">
                <button
                  onClick={() => presetRange('today')}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                >
                  Bugun
                </button>
                <button
                  onClick={() => presetRange('yesterday')}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                >
                  Dun
                </button>
                <button
                  onClick={() => presetRange(7)}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                >
                  7g
                </button>
                <button
                  onClick={() => presetRange(30)}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                >
                  30g
                </button>
                <button
                  onClick={() => presetRange('all')}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                >
                  Hamısı
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
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
            <div className="mt-2 text-[10px] text-slate-600 flex items-center justify-between">
              <span>{dateRange.start || '...'} → {dateRange.end || '...'}</span>
              <span className="text-slate-500">server range</span>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                <Database className="w-4 h-4 text-slate-400" />
                Mənbə
              </div>
              <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-1">
                {([
                  { id: 'all', label: 'Hamısı' },
                  { id: 'whatsapp', label: 'WA' },
                  { id: 'manual', label: 'Manual' },
                ] as const).map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setFilters(p => ({ ...p, source: opt.id }))}
                    className={cn(
                      'px-2 py-1 rounded-md text-[10px] font-extrabold transition-colors',
                      filters.source === opt.id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-2">
                <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
                  <DollarSign className="w-4 h-4 text-slate-500" />
                  Dəyər (AZN)
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
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
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-2">
                <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
                  <Users className="w-4 h-4 text-slate-500" />
                  Operator
                </div>
                <div className="mt-2 space-y-1 max-h-24 overflow-auto custom-scrollbar pr-1">
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
                <div className="mt-1 text-[10px] text-slate-600">Boş burax: hamısı</div>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                <Tag className="w-4 h-4 text-slate-400" />
                Mərhələlər
              </div>
              <button
                onClick={() => setFilters(p => ({ ...p, stageIds: allStagesSelected ? [] : pipelineStages.map(s => s.id) }))}
                className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800"
                title={allStagesSelected ? 'Hamısını sil' : 'Hamısını seç'}
              >
                {allStagesSelected ? 'Hamısını sil' : 'Hamısını seç'}
              </button>
            </div>
            <div className="mt-3 space-y-1">
              {pipelineStages.map(s => {
                const checked = filters.stageIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => setFilters(p => ({ ...p, stageIds: toggleMulti(p.stageIds, s.id) }))}
                    className={cn(
                      'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-left transition-colors',
                      checked ? 'border-slate-700 bg-slate-950/40 hover:bg-slate-950/60' : 'border-slate-800 bg-transparent hover:bg-slate-950/30'
                    )}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {checked ? <CheckSquare className="w-4 h-4 text-blue-400" /> : <Square className="w-4 h-4 text-slate-600" />}
                      <span className="text-[12px] font-semibold text-slate-200 truncate">{s.label}</span>
                    </span>
                    <span className="text-[10px] text-slate-500 font-bold">{s.id}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {(selectFields.length + textFields.length + numberFields.length) > 0 && (
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
            </section>
          )}
        </div>

        <div className="p-4 border-t border-white/5 bg-[#111827]/60 shrink-0 flex items-center gap-2">
          <button
            onClick={() => setFilters(makeDefaultCRMFilters(pipelineStages))}
            className="flex-1 py-2 rounded-lg text-xs font-extrabold text-slate-200 border border-slate-700 bg-slate-900 hover:bg-slate-800 transition-colors"
            title="Filterləri sıfırla"
          >
            Sıfırla
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-xs font-extrabold text-white bg-blue-600 hover:bg-blue-500 transition-colors"
          >
            Bağla
          </button>
        </div>

        <style>{`
          @keyframes slideInRight {
            from { transform: translateX(40px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        `}</style>
      </div>
    </div>
  );
}
