import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, X, PieChart, BarChart2, Filter, Plus, Trash2, GripVertical } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAppStore } from '../context/Store';
import { loadCRMSettings } from '../lib/crmSettings';

type ChartKind = 'bar' | 'donut';

type WidgetKind = 'pipeline' | 'custom_select' | 'assignee';

type WidgetBase = {
  id: string;
  title: string;
  chart: ChartKind;
  kind: WidgetKind;
};

type PipelineWidget = WidgetBase & {
  kind: 'pipeline';
  metric: 'count' | 'revenue';
};

type CustomSelectWidget = WidgetBase & {
  kind: 'custom_select';
  fieldId: string;
  topN: number;
  ignoreEmpty: boolean;
};

type AssigneeWidget = WidgetBase & {
  kind: 'assignee';
  includeUnassigned: boolean;
};

type Widget = PipelineWidget | CustomSelectWidget | AssigneeWidget;

type Datum = {
  label: string;
  value: number;
  color: string;
};

function safeParseExtra(extra: any): Record<string, any> {
  try {
    if (!extra) return {};
    if (typeof extra === 'string') return JSON.parse(extra) || {};
    if (typeof extra === 'object' && !Array.isArray(extra)) return extra;
    return {};
  } catch {
    return {};
  }
}

function formatNumber(n: number) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

function formatMoney(n: number) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
}

function makeId() {
  return `w-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function BarList({ data, valueLabel }: { data: Datum[]; valueLabel?: (v: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2">
          <div className="w-28 sm:w-36 text-[11px] text-slate-300 truncate" title={d.label}>{d.label}</div>
          <div className="flex-1 h-2.5 bg-slate-900 border border-slate-800 rounded-full overflow-hidden">
            <div className="h-full" style={{ width: `${Math.round((d.value / max) * 100)}%`, background: d.color }} />
          </div>
          <div className="w-16 text-right text-[11px] font-semibold text-slate-200 tabular-nums">
            {valueLabel ? valueLabel(d.value) : formatNumber(d.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Donut({ data }: { data: Datum[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const size = 140;
  const r = 52;
  const c = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 140 140" className="shrink-0">
        <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="14" />
        {data.map((d) => {
          const frac = d.value / total;
          const dash = frac * c;
          const gap = c - dash;
          const offset = acc;
          acc += dash;
          return (
            <circle
              key={d.label}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={d.color}
              strokeWidth="14"
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
              strokeLinecap="butt"
            />
          );
        })}
        <text x="70" y="66" textAnchor="middle" fill="#e2e8f0" fontSize="14" fontWeight="700">{formatNumber(total)}</text>
        <text x="70" y="84" textAnchor="middle" fill="#94a3b8" fontSize="10">Toplam</text>
      </svg>

      <div className="flex-1 min-w-0 space-y-2">
        {data.map((d) => (
          <div key={d.label} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
              <span className="text-[11px] text-slate-300 truncate" title={d.label}>{d.label}</span>
            </div>
            <span className="text-[11px] font-semibold text-slate-200 tabular-nums">{formatNumber(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function stageToColor(stageColor: string) {
  const map: Record<string, string> = {
    blue: '#3b82f6',
    purple: '#a855f7',
    green: '#22c55e',
    emerald: '#10b981',
    teal: '#14b8a6',
    red: '#ef4444',
    orange: '#f97316',
    amber: '#f59e0b',
    yellow: '#eab308',
    slate: '#94a3b8',
    zinc: '#a1a1aa',
  };
  return map[stageColor] || '#60a5fa';
}

export function CRMAnalyticsPanel({ onClose }: { onClose: () => void }) {
  const { leads, currentUser, dateRange, teamMembers } = useAppStore();
  const { pipelineStages, customFields } = loadCRMSettings();

  const selectFields = useMemo(() => customFields.filter(f => f.type === 'select' && f.id !== 'product_name'), [customFields]);

  const [scope, setScope] = useState<'all' | 'mine'>('all');

  const widgetsKey = useMemo(() => {
    const tenant = currentUser?.tenant_id || localStorage.getItem('crm_tenant_id') || 'admin';
    return `crm_analytics_widgets_${tenant}`;
  }, [currentUser?.tenant_id]);

  const defaultWidgets = useMemo<Widget[]>(() => {
    const firstField = selectFields[0]?.id || '';
    const base: Widget[] = [
      { id: makeId(), kind: 'pipeline', title: 'Kanban (Say)', chart: 'bar', metric: 'count' },
      { id: makeId(), kind: 'pipeline', title: 'Kanban (Budce)', chart: 'bar', metric: 'revenue' },
    ];
    if (firstField) {
      base.push({ id: makeId(), kind: 'custom_select', title: 'Xususi Saha', chart: 'bar', fieldId: firstField, topN: 8, ignoreEmpty: true });
    }
    base.push({ id: makeId(), kind: 'assignee', title: 'Operatorlar', chart: 'bar', includeUnassigned: true });
    return base;
  }, [selectFields]);

  const [widgets, setWidgets] = useState<Widget[]>(defaultWidgets);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(widgetsKey);
      if (!raw) {
        setWidgets(defaultWidgets);
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setWidgets(parsed);
      } else {
        setWidgets(defaultWidgets);
      }
    } catch {
      setWidgets(defaultWidgets);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetsKey]);

  useEffect(() => {
    try {
      localStorage.setItem(widgetsKey, JSON.stringify(widgets));
    } catch {
      // ignore
    }
  }, [widgets, widgetsKey]);

  const scopedLeads = useMemo(() => {
    if (scope !== 'mine' || !currentUser?.id) return leads;
    return leads.filter(l => l.assignee_id === currentUser.id);
  }, [leads, scope, currentUser?.id]);

  const widgetData = useMemo(() => {
    const palette = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#22c55e', '#f97316', '#38bdf8', '#e879f9'];

    const byStageBase: Record<string, { label: string; color: string }> = {};
    for (const s of pipelineStages) {
      byStageBase[s.id] = { label: s.label, color: stageToColor(s.color) };
    }

    const assigneeName = (id: string) => teamMembers.find(t => t.id === id)?.username || 'Operator';

    function dataFor(w: Widget): Datum[] {
      if (w.kind === 'pipeline') {
        const byStage: Record<string, Datum> = {};
        for (const [id, meta] of Object.entries(byStageBase)) {
          byStage[id] = { label: meta.label, value: 0, color: meta.color };
        }
        for (const l of scopedLeads) {
          const key = l.status;
          if (!byStage[key]) byStage[key] = { label: key, value: 0, color: '#60a5fa' };
          byStage[key].value += w.metric === 'count' ? 1 : (l.value || 0);
        }
        const out = Object.values(byStage);
        out.sort((a, b) => b.value - a.value);
        return out;
      }

      if (w.kind === 'custom_select') {
        const field = selectFields.find(f => f.id === w.fieldId);
        if (!field) return [];

        const counts = new Map<string, number>();
        for (const l of scopedLeads) {
          const extra = safeParseExtra((l as any).extra_data);
          const v = String(extra[w.fieldId] ?? '').trim();
          if (!v && w.ignoreEmpty) continue;
          const key = v || '(bos)';
          counts.set(key, (counts.get(key) || 0) + 1);
        }

        const options = (field.options || []).slice();
        for (const k of counts.keys()) {
          if (k !== '(bos)' && !options.includes(k)) options.push(k);
        }
        if (!w.ignoreEmpty && counts.has('(bos)')) options.unshift('(bos)');

        const rows: Datum[] = options.map((opt, idx) => ({
          label: opt,
          value: counts.get(opt) || 0,
          color: palette[idx % palette.length]
        }));
        rows.sort((a, b) => b.value - a.value);
        return rows.slice(0, Math.max(3, Math.min(24, w.topN)));
      }

      // assignee
      const counts = new Map<string, number>();
      for (const l of scopedLeads) {
        const k = l.assignee_id ? String(l.assignee_id) : (w.includeUnassigned ? 'unassigned' : '');
        if (!k) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const keys = Array.from(counts.keys());
      keys.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
      return keys.map((k, idx) => ({
        label: k === 'unassigned' ? 'Teyin edilmedi' : assigneeName(k),
        value: counts.get(k) || 0,
        color: palette[idx % palette.length]
      }));
    }

    const out: Record<string, Datum[]> = {};
    for (const w of widgets) {
      out[w.id] = dataFor(w);
    }
    return out;
  }, [widgets, scopedLeads, pipelineStages, selectFields, teamMembers]);

  const revenueTotal = useMemo(() => scopedLeads.filter(l => l.status === 'won').reduce((s, l) => s + (l.value || 0), 0), [scopedLeads]);
  const leadsTotal = scopedLeads.length;

  const addWidget = (kind: WidgetKind) => {
    const id = makeId();
    if (kind === 'pipeline') {
      setWidgets(prev => ([...prev, { id, kind, title: 'Kanban (Say)', chart: 'bar', metric: 'count' }]));
      return;
    }
    if (kind === 'custom_select') {
      const fieldId = selectFields[0]?.id || '';
      if (!fieldId) return;
      setWidgets(prev => ([...prev, { id, kind, title: 'Xususi Saha', chart: 'bar', fieldId, topN: 8, ignoreEmpty: true }]));
      return;
    }
    setWidgets(prev => ([...prev, { id, kind, title: 'Operatorlar', chart: 'bar', includeUnassigned: true }]));
  };

  const removeWidget = (id: string) => setWidgets(prev => prev.filter(w => w.id !== id));
  const updateWidget = (id: string, updates: Partial<Widget>) => setWidgets(prev => prev.map(w => (w.id === id ? ({ ...w, ...updates } as any) : w)));

  return (
    <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-[2px] flex justify-end" onClick={onClose}>
      <div
        className="h-[100dvh] w-full sm:w-[560px] bg-[#0d1117] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)', paddingTop: 'env(safe-area-inset-top)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-h-14 flex items-center justify-between px-4 border-b border-white/5 bg-[#111827] shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <BarChart3 className="w-4.5 h-4.5 text-blue-400" />
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-tight">Analitika</p>
              <p className="text-[10px] text-slate-500">{dateRange.start || '...'} - {dateRange.end || '...'}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 border-b border-white/5 bg-[#0d1117] shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-500" />
              <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-1">
                <button
                  onClick={() => setScope('all')}
                  className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold', scope === 'all' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}
                >
                  Hamisi
                </button>
                <button
                  onClick={() => setScope('mine')}
                  className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold', scope === 'mine' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}
                  disabled={!currentUser?.id}
                >
                  Menim
                </button>
              </div>
            </div>

            <div className="text-right">
              <p className="text-[10px] text-slate-500">Lead: <span className="text-slate-200 font-semibold">{formatNumber(leadsTotal)}</span></p>
              <p className="text-[10px] text-slate-500">Satish: <span className="text-emerald-300 font-semibold">{formatMoney(revenueTotal)} AZN</span></p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <GripVertical className="w-4 h-4 text-slate-600" />
                <p className="text-xs font-bold text-white">Chart Builder</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => addWidget('pipeline')}
                  className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-950 border border-slate-800 text-slate-200 hover:bg-slate-900 transition-colors flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" /> Kanban
                </button>
                <button
                  onClick={() => addWidget('custom_select')}
                  disabled={selectFields.length === 0}
                  className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-950 border border-slate-800 text-slate-200 hover:bg-slate-900 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Xususi
                </button>
                <button
                  onClick={() => addWidget('assignee')}
                  className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-950 border border-slate-800 text-slate-200 hover:bg-slate-900 transition-colors flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" /> Operator
                </button>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Chart-lari buradan secib duze bilirsiniz. (Saxlama avtomatik localStorage)
            </p>
          </div>

          {widgets.map((w) => {
            const data = widgetData[w.id] || [];
            return (
              <div key={w.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0 flex-1">
                    <input
                      value={w.title}
                      onChange={(e) => updateWidget(w.id, { title: e.target.value })}
                      className="w-full bg-transparent text-sm font-bold text-white focus:outline-none border-b border-transparent focus:border-slate-700 pb-1"
                    />
                    <p className="mt-1 text-[10px] text-slate-500">
                      {w.kind === 'pipeline' ? 'Kanban sutunlari uzre' : w.kind === 'custom_select' ? 'Select saha uzre' : 'Operator uzre'}
                    </p>
                  </div>
                  <button
                    onClick={() => removeWidget(w.id)}
                    className="p-2 rounded-lg text-slate-600 hover:text-red-400 hover:bg-slate-950 transition-colors"
                    title="Sil"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <select
                    value={w.kind}
                    onChange={(e) => {
                      const next = e.target.value as WidgetKind;
                      if (next === w.kind) return;
                      if (next === 'pipeline') {
                        updateWidget(w.id, { kind: 'pipeline', metric: 'count', chart: w.chart } as any);
                      } else if (next === 'custom_select') {
                        const fieldId = selectFields[0]?.id || '';
                        if (!fieldId) return;
                        updateWidget(w.id, { kind: 'custom_select', fieldId, topN: 8, ignoreEmpty: true, chart: w.chart } as any);
                      } else {
                        updateWidget(w.id, { kind: 'assignee', includeUnassigned: true, chart: w.chart } as any);
                      }
                    }}
                    className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                  >
                    <option value="pipeline">Kanban</option>
                    <option value="custom_select">Xususi (Select)</option>
                    <option value="assignee">Operator</option>
                  </select>

                  <select
                    value={w.chart}
                    onChange={(e) => updateWidget(w.id, { chart: e.target.value as any })}
                    className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                  >
                    <option value="bar">Bar</option>
                    <option value="donut">Donut</option>
                  </select>
                </div>

                {w.kind === 'pipeline' && (
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <BarChart2 className="w-4 h-4" />
                      Metric
                    </div>
                    <select
                      value={w.metric}
                      onChange={(e) => updateWidget(w.id, { metric: e.target.value as any } as any)}
                      className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-1"
                    >
                      <option value="count">Say</option>
                      <option value="revenue">Budce</option>
                    </select>
                  </div>
                )}

                {w.kind === 'custom_select' && (
                  <div className="space-y-2 mb-3">
                    <select
                      value={w.fieldId}
                      onChange={(e) => updateWidget(w.id, { fieldId: e.target.value } as any)}
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                    >
                      {selectFields.map(f => (
                        <option key={f.id} value={f.id}>{f.label}</option>
                      ))}
                    </select>

                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-[11px] text-slate-400">
                        <input type="checkbox" checked={w.ignoreEmpty} onChange={(e) => updateWidget(w.id, { ignoreEmpty: e.target.checked } as any)} />
                        Boslari gizlet
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500">Top</span>
                        <input
                          type="number"
                          min={3}
                          max={24}
                          value={w.topN}
                          onChange={(e) => updateWidget(w.id, { topN: parseInt(e.target.value || '8', 10) } as any)}
                          className="w-16 bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-1"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {w.kind === 'assignee' && (
                  <div className="flex items-center justify-between mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-slate-400">
                      <input type="checkbox" checked={w.includeUnassigned} onChange={(e) => updateWidget(w.id, { includeUnassigned: e.target.checked } as any)} />
                      Teyin edilmedileri daxil et
                    </label>
                    <div className="text-[10px] text-slate-600">{teamMembers.length} operator</div>
                  </div>
                )}

                {data.length === 0 ? (
                  <div className="text-xs text-slate-500">Data yoxdur.</div>
                ) : w.chart === 'bar' ? (
                  <BarList
                    data={data}
                    valueLabel={w.kind === 'pipeline' && w.metric === 'revenue' ? (v) => `${formatMoney(v)}₼` : undefined}
                  />
                ) : (
                  <Donut data={data.filter(d => d.value > 0).slice(0, 9)} />
                )}
              </div>
            );
          })}

          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
            <p className="text-[11px] text-slate-400">
              Not: Xususi saha analitikasi ucun lead-larda `extra_data` saxlanilmalidir.
            </p>
          </div>
        </div>

        <div className="p-4 border-t border-white/5 bg-[#111827]/60 shrink-0">
          <p className="text-[10px] text-slate-500">
            Operatorlar: {teamMembers.length}
          </p>
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
