import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Save, Check, AlertTriangle, LayoutGrid, Users, BarChart2, PieChart } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAppStore } from '../context/Store';
import { loadCRMSettings } from '../lib/crmSettings';
import { CrmService } from '../services/CrmService';

type ChartKind = 'bar' | 'donut' | 'table';
type DisplayMode = 'value' | 'percent' | 'both';
type WidgetKind = 'pipeline' | 'custom_select' | 'assignee';

type WidgetBase = {
  id: string;
  title: string;
  kind: WidgetKind;
  chart: ChartKind;
  display: DisplayMode;
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

type Layout = {
  version: 1;
  schema: 'grid-2x2';
  scope: 'all' | 'mine';
  widgets: Widget[]; // 4 slots
};

type Datum = { label: string; value: number; color: string };

function makeId() {
  return `aw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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

function valueLabel(value: number, total: number, mode: DisplayMode, isMoney: boolean) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const v = isMoney ? `${formatMoney(value)}₼` : formatNumber(value);
  const p = `${pct.toFixed(0)}%`;
  if (mode === 'value') return v;
  if (mode === 'percent') return p;
  return `${v} · ${p}`;
}

function BarList({ data, total, mode, isMoney }: { data: Datum[]; total: number; mode: DisplayMode; isMoney: boolean }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2">
          <div className="w-28 sm:w-36 text-[11px] text-slate-300 truncate" title={d.label}>{d.label}</div>
          <div className="flex-1 h-2.5 bg-slate-900 border border-slate-800 rounded-full overflow-hidden">
            <div className="h-full" style={{ width: `${Math.round((d.value / max) * 100)}%`, background: d.color }} />
          </div>
          <div className="w-24 text-right text-[11px] font-semibold text-slate-200 tabular-nums">
            {valueLabel(d.value, total, mode, isMoney)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Donut({ data, total, mode, isMoney }: { data: Datum[]; total: number; mode: DisplayMode; isMoney: boolean }) {
  const size = 140;
  const r = 52;
  const c = 2 * Math.PI * r;
  let acc = 0;

  const shown = data.filter(d => d.value > 0).slice(0, 9);
  const sumShown = shown.reduce((s, d) => s + d.value, 0);
  const denom = sumShown || 1;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 140 140" className="shrink-0">
        <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="14" />
        {shown.map((d) => {
          const frac = d.value / denom;
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
        <text x="70" y="66" textAnchor="middle" fill="#e2e8f0" fontSize="14" fontWeight="700">{isMoney ? formatMoney(total) : formatNumber(total)}</text>
        <text x="70" y="84" textAnchor="middle" fill="#94a3b8" fontSize="10">Toplam</text>
      </svg>

      <div className="flex-1 min-w-0 space-y-2">
        {shown.map((d) => (
          <div key={d.label} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
              <span className="text-[11px] text-slate-300 truncate" title={d.label}>{d.label}</span>
            </div>
            <span className="text-[11px] font-semibold text-slate-200 tabular-nums">{valueLabel(d.value, total, mode, isMoney)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TableList({ data, total, mode, isMoney }: { data: Datum[]; total: number; mode: DisplayMode; isMoney: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div className="grid grid-cols-12 bg-slate-950/40 text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
        <div className="col-span-7 px-3 py-2">Basliq</div>
        <div className="col-span-5 px-3 py-2 text-right">Deger</div>
      </div>
      <div className="divide-y divide-slate-800">
        {data.map((d) => (
          <div key={d.label} className="grid grid-cols-12 items-center">
            <div className="col-span-7 px-3 py-2 text-[11px] text-slate-300 truncate" title={d.label}>{d.label}</div>
            <div className="col-span-5 px-3 py-2 text-right text-[11px] font-semibold text-slate-200 tabular-nums">{valueLabel(d.value, total, mode, isMoney)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { leads, currentUser, teamMembers } = useAppStore();

  const tenantId = currentUser?.tenant_id || localStorage.getItem('crm_tenant_id') || 'admin';
  const crmSettings = useMemo(() => loadCRMSettings(), [tenantId]);
  const pipelineStages = crmSettings.pipelineStages;
  const customFields = crmSettings.customFields;
  const selectFields = useMemo(() => customFields.filter(f => f.type === 'select' && f.id !== 'product_name'), [customFields]);

  const firstSelectFieldId = selectFields[0]?.id || '';

  const defaultLayout = useMemo<Layout>(() => {
    const firstField = firstSelectFieldId;
    return {
      version: 1,
      schema: 'grid-2x2',
      scope: 'all',
      widgets: [
        { id: makeId(), kind: 'pipeline', title: 'Kanban (Say)', chart: 'bar', display: 'both', metric: 'count' },
        { id: makeId(), kind: 'pipeline', title: 'Kanban (Budce)', chart: 'donut', display: 'both', metric: 'revenue' },
        firstField
          ? { id: makeId(), kind: 'custom_select', title: 'Xususi Saha', chart: 'bar', display: 'both', fieldId: firstField, topN: 8, ignoreEmpty: true }
          : { id: makeId(), kind: 'assignee', title: 'Operatorlar', chart: 'bar', display: 'both', includeUnassigned: true },
        { id: makeId(), kind: 'assignee', title: 'Operatorlar', chart: 'table', display: 'both', includeUnassigned: true },
      ]
    };
  }, [firstSelectFieldId]);

  const [layout, setLayout] = useState<Layout>(defaultLayout);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const remote = await CrmService.getAnalyticsLayout();
        if (!mounted) return;
        if (remote && typeof remote === 'object' && remote.version === 1 && Array.isArray(remote.widgets) && remote.widgets.length === 4) {
          setLayout(remote as Layout);
        } else {
          setLayout(defaultLayout);
        }
      } catch {
        if (!mounted) return;
        setLayout(defaultLayout);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [tenantId, currentUser?.id, defaultLayout]);

  const scopedLeads = useMemo(() => {
    if (layout.scope !== 'mine' || !currentUser?.id) return leads;
    return leads.filter(l => l.assignee_id === currentUser.id);
  }, [leads, layout.scope, currentUser?.id]);

  const pipelineDataBase = useMemo(() => {
    const byStage: Record<string, { label: string; color: string }> = {};
    for (const s of pipelineStages) {
      byStage[s.id] = { label: s.label, color: stageToColor(s.color) };
    }
    return byStage;
  }, [pipelineStages]);

  const getWidgetData = useMemo(() => {
    const palette = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#22c55e', '#f97316', '#38bdf8', '#e879f9'];
    const assigneeName = (id: string) => teamMembers.find(t => t.id === id)?.username || 'Operator';

    return (w: Widget): { data: Datum[]; total: number; isMoney: boolean } => {
      if (w.kind === 'pipeline') {
        const byStage: Record<string, Datum> = {};
        for (const [id, meta] of Object.entries(pipelineDataBase)) {
          byStage[id] = { label: meta.label, value: 0, color: meta.color };
        }
        for (const l of scopedLeads) {
          const key = l.status;
          if (!byStage[key]) byStage[key] = { label: key, value: 0, color: '#60a5fa' };
          byStage[key].value += w.metric === 'count' ? 1 : (l.value || 0);
        }
        const out = Object.values(byStage);
        out.sort((a, b) => b.value - a.value);
        const total = out.reduce((s, d) => s + d.value, 0);
        return { data: out, total, isMoney: w.metric === 'revenue' };
      }

      if (w.kind === 'custom_select') {
        const field = selectFields.find(f => f.id === w.fieldId);
        if (!field) return { data: [], total: 0, isMoney: false };

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
        const sliced = rows.slice(0, Math.max(3, Math.min(24, w.topN)));
        const total = sliced.reduce((s, d) => s + d.value, 0);
        return { data: sliced, total, isMoney: false };
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
      const rows: Datum[] = keys.map((k, idx) => ({
        label: k === 'unassigned' ? 'Teyin edilmedi' : assigneeName(k),
        value: counts.get(k) || 0,
        color: palette[idx % palette.length]
      }));
      const total = rows.reduce((s, d) => s + d.value, 0);
      return { data: rows, total, isMoney: false };
    };
  }, [pipelineDataBase, scopedLeads, selectFields, teamMembers]);

  const handleSave = async () => {
    setSaving(true);
    setSavedOk(false);
    setError('');
    try {
      await CrmService.saveAnalyticsLayout(layout);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 1200);
    } catch (e: any) {
      setError(e?.message || 'Saxlama zamani xeta');
    } finally {
      setSaving(false);
    }
  };

  const updateWidget = (index: number, updates: Partial<Widget>) => {
    setLayout(prev => {
      const next = { ...prev };
      const widgets = [...next.widgets];
      widgets[index] = { ...(widgets[index] as any), ...updates } as any;
      next.widgets = widgets;
      return next;
    });
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-10 w-10 border-4 border-slate-800 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-6 max-w-[1600px] mx-auto h-full flex flex-col space-y-4">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-blue-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-2xl font-bold text-white truncate">Analitika</h1>
              <p className="text-[11px] text-slate-500 flex items-center gap-2">
                <LayoutGrid className="w-3.5 h-3.5" /> Schema: 2x2 (4 chart)
                <span className="text-slate-600">•</span>
                <span>Lead: <span className="text-slate-200 font-semibold">{formatNumber(scopedLeads.length)}</span></span>
              </p>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-1">
              <button
                onClick={() => setLayout(prev => ({ ...prev, scope: 'all' }))}
                className={cn('px-3 py-1 rounded-md text-[11px] font-semibold', layout.scope === 'all' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}
              >
                Hamisi
              </button>
              <button
                onClick={() => setLayout(prev => ({ ...prev, scope: 'mine' }))}
                className={cn('px-3 py-1 rounded-md text-[11px] font-semibold', layout.scope === 'mine' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}
                disabled={!currentUser?.id}
              >
                Menim
              </button>
            </div>
            <Link to="/crm" className="text-[11px] text-slate-500 hover:text-slate-200">CRM-e qayit</Link>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {error && (
            <div className="max-w-[360px] rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-2 text-[11px] text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className={cn(
              'px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 border transition-colors',
              savedOk ? 'bg-green-600 border-green-500/40 text-white' : 'bg-slate-900 border-slate-800 text-slate-200 hover:bg-slate-800',
              saving && 'opacity-50'
            )}
          >
            {savedOk ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saxlanir...' : savedOk ? 'Saxlandi' : 'Yadda Saxla (DB)'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {layout.widgets.map((w, idx) => {
          const info = getWidgetData(w);
          const icon = w.kind === 'pipeline' ? <BarChart2 className="w-4 h-4 text-slate-400" /> : w.kind === 'custom_select' ? <PieChart className="w-4 h-4 text-slate-400" /> : <Users className="w-4 h-4 text-slate-400" />;

          return (
            <div key={w.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {icon}
                    <input
                      value={w.title}
                      onChange={(e) => updateWidget(idx, { title: e.target.value })}
                      className="bg-transparent text-sm font-bold text-white focus:outline-none border-b border-transparent focus:border-slate-700 pb-1 w-full"
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">Slot {idx + 1} • {w.kind}</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <select
                  value={w.kind}
                  onChange={(e) => {
                    const next = e.target.value as WidgetKind;
                    if (next === 'pipeline') {
                      updateWidget(idx, { kind: 'pipeline', metric: 'count', chart: 'bar', display: 'both' } as any);
                    } else if (next === 'custom_select') {
                      const fieldId = selectFields[0]?.id || '';
                      updateWidget(idx, { kind: 'custom_select', fieldId, topN: 8, ignoreEmpty: true, chart: 'bar', display: 'both' } as any);
                    } else {
                      updateWidget(idx, { kind: 'assignee', includeUnassigned: true, chart: 'table', display: 'both' } as any);
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
                  onChange={(e) => updateWidget(idx, { chart: e.target.value as any })}
                  className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                >
                  <option value="bar">Bar</option>
                  <option value="donut">Donut</option>
                  <option value="table">Cədvəl</option>
                </select>

                <select
                  value={w.display}
                  onChange={(e) => updateWidget(idx, { display: e.target.value as any })}
                  className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                >
                  <option value="value">Say</option>
                  <option value="percent">Faiz</option>
                  <option value="both">Say + Faiz</option>
                </select>

                {w.kind === 'pipeline' ? (
                  <select
                    value={w.metric}
                    onChange={(e) => updateWidget(idx, { metric: e.target.value as any } as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                  >
                    <option value="count">Lead sayi</option>
                    <option value="revenue">Budce (AZN)</option>
                  </select>
                ) : w.kind === 'custom_select' ? (
                  <select
                    value={w.fieldId}
                    onChange={(e) => updateWidget(idx, { fieldId: e.target.value } as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                    disabled={selectFields.length === 0}
                  >
                    {selectFields.length === 0 ? (
                      <option value="">Select saha yoxdur</option>
                    ) : (
                      selectFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)
                    )}
                  </select>
                ) : (
                  <select
                    value={w.includeUnassigned ? 'yes' : 'no'}
                    onChange={(e) => updateWidget(idx, { includeUnassigned: e.target.value === 'yes' } as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-2"
                  >
                    <option value="yes">Teyin edilmedi daxil</option>
                    <option value="no">Yalniz teyinli</option>
                  </select>
                )}
              </div>

              {w.kind === 'custom_select' && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-[11px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={w.ignoreEmpty}
                      onChange={(e) => updateWidget(idx, { ignoreEmpty: e.target.checked } as any)}
                    />
                    Boslari gizlet
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">Top</span>
                    <input
                      type="number"
                      min={3}
                      max={24}
                      value={w.topN}
                      onChange={(e) => updateWidget(idx, { topN: parseInt(e.target.value || '8', 10) } as any)}
                      className="w-16 bg-slate-950 border border-slate-800 text-slate-200 text-[11px] rounded-lg px-2 py-1"
                    />
                  </div>
                </div>
              )}

              <div className="mt-4">
                {info.data.length === 0 ? (
                  <div className="text-xs text-slate-500">Data yoxdur.</div>
                ) : w.chart === 'bar' ? (
                  <BarList data={info.data} total={info.total} mode={w.display} isMoney={info.isMoney} />
                ) : w.chart === 'donut' ? (
                  <Donut data={info.data} total={info.total} mode={w.display} isMoney={info.isMoney} />
                ) : (
                  <TableList data={info.data} total={info.total} mode={w.display} isMoney={info.isMoney} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
