import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Calendar, Link2, RefreshCcw, Target, Wallet } from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { cn } from '../lib/utils';

type MetricType = 'message' | 'lead' | 'purchase';
type PresetType = 'today' | '7d' | '30d' | 'all' | 'custom';

type DashboardResponse = {
  metric: MetricType;
  range: { start: string | null; end: string | null };
  field: { id: string; label: string; options: string[] } | null;
  stageLegend: Array<{ id: string; label: string; color: string }>;
  warnings: string[];
  groups: Array<{
    value: string;
    campaignIds: string[];
    campaigns: Array<{ id: string; name: string; account_name?: string | null; objective?: string | null }>;
    facebook: { spend: number; impressions: number; clicks: number; ctr: number; cpm: number; results: number; cost_per_result: number };
    crm: {
      leads: number;
      won_count: number;
      pipeline_value: number;
      won_revenue: number;
      stages: Array<{ id: string; label: string; color: string; count: number; revenue: number }>;
    };
    merged: { cost_per_crm_lead: number; cost_per_sale: number; roas: number; conversion_rate: number };
  }>;
  totals: {
    facebook: { spend: number; impressions: number; clicks: number; ctr: number; cpm: number; results: number; cost_per_result: number };
    crm: { leads: number; won_count: number; pipeline_value: number; won_revenue: number };
    merged: { cost_per_crm_lead: number; cost_per_sale: number; roas: number; conversion_rate: number };
  };
};

const EMPTY_DATA: DashboardResponse = {
  metric: 'message',
  range: { start: null, end: null },
  field: null,
  stageLegend: [],
  warnings: [],
  groups: [],
  totals: {
    facebook: { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, results: 0, cost_per_result: 0 },
    crm: { leads: 0, won_count: 0, pipeline_value: 0, won_revenue: 0 },
    merged: { cost_per_crm_lead: 0, cost_per_sale: 0, roas: 0, conversion_rate: 0 },
  }
};

function formatCount(value: number) {
  return new Intl.NumberFormat('az-AZ', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatMoney(value: number, suffix = '$') {
  return `${new Intl.NumberFormat('az-AZ', { maximumFractionDigits: 2 }).format(Number(value || 0))}${suffix}`;
}

function formatPercent(value: number) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function toLocalISO(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildPresetRange(preset: Exclude<PresetType, 'custom'>) {
  if (preset === 'all') return { start: '', end: '' };
  const end = new Date();
  const start = new Date();
  if (preset === 'today') {
    const iso = toLocalISO(end);
    return { start: iso, end: iso };
  }
  if (preset === '7d') start.setDate(end.getDate() - 6);
  if (preset === '30d') start.setDate(end.getDate() - 29);
  return { start: toLocalISO(start), end: toLocalISO(end) };
}

function stageColor(value: string) {
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
  return map[String(value || '').trim()] || value || '#3b82f6';
}

function StageStrip({ stages }: { stages: DashboardResponse['groups'][number]['crm']['stages'] }) {
  const total = stages.reduce((sum, stage) => sum + Number(stage.count || 0), 0);
  return (
    <div className="space-y-2">
      <div className="h-3 overflow-hidden rounded-full border border-slate-800 bg-slate-950/60 flex">
        {stages.filter((stage) => stage.count > 0).map((stage) => (
          <div
            key={stage.id}
            className="h-full"
            style={{ flex: `${stage.count} ${stage.count} 0%`, background: stageColor(stage.color) }}
            title={`${stage.label}: ${formatCount(stage.count)}`}
          />
        ))}
        {total === 0 ? <div className="h-full w-full bg-slate-950/60" /> : null}
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
        {stages.map((stage) => (
          <div key={stage.id} className="rounded-xl border border-slate-800 bg-slate-950/30 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ background: stageColor(stage.color) }} />
              <span className="truncate">{stage.label}</span>
            </div>
            <div className="mt-1 text-sm font-bold text-slate-100 tabular-nums">{formatCount(stage.count)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ title, value, sub, icon }: { title: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/25 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">{title}</div>
          <div className="mt-1 text-2xl font-extrabold text-slate-100 tabular-nums">{value}</div>
          {sub ? <div className="mt-1 text-[11px] text-slate-500">{sub}</div> : null}
        </div>
        <div className="w-10 h-10 rounded-2xl border border-slate-800 bg-slate-950/40 flex items-center justify-center text-slate-300">
          {icon}
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardResponse>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [metric, setMetric] = useState<MetricType>('message');
  const [preset, setPreset] = useState<PresetType>('30d');
  const [refreshKey, setRefreshKey] = useState(0);
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>(() => buildPresetRange('30d'));

  const range = useMemo(() => {
    if (preset === 'custom') return customRange;
    return buildPresetRange(preset);
  }, [customRange, preset]);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError('');
      try {
        const url = CrmService.getServerUrl();
        const token = localStorage.getItem('crm_auth_token');
        if (!url || !token) throw new Error('Not authenticated');

        const qs = new URLSearchParams({ metric });
        if (range.start) qs.set('start', range.start);
        if (range.end) qs.set('end', range.end);

        const res = await fetch(`${url}/api/dashboard/combined?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || 'Dashboard yüklənmədi');
        setData(json);
      } catch (e: any) {
        setError(e?.message || 'Dashboard yüklənmədi');
        setData(EMPTY_DATA);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [metric, range.end, range.start, refreshKey]);

  const activeGroups = useMemo(
    () => data.groups.filter((group) => group.campaignIds.length > 0 || group.crm.leads > 0),
    [data.groups]
  );

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl border border-slate-800 bg-slate-950/40 flex items-center justify-center text-blue-300">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold text-slate-100">Birləşmiş Dashboard</h1>
              <p className="mt-0.5 text-[12px] text-slate-500">Facebook xərcləri ilə CRM nəticələrini seçilmiş kurs/xüsusi sahə üzrə bir yerdə göstərir.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(['message', 'lead', 'purchase'] as MetricType[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMetric(item)}
              className={cn(
                'px-3 py-2 rounded-xl border text-xs font-bold transition-colors',
                metric === item ? 'border-blue-500/40 bg-blue-500/10 text-blue-100' : 'border-slate-800 bg-slate-950/20 text-slate-400 hover:text-slate-200'
              )}
            >
              {item === 'message' ? 'Mesaj' : item === 'lead' ? 'Lead' : 'Purchase'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            className="px-3 py-2 rounded-xl border border-slate-800 bg-slate-950/20 text-slate-300 hover:bg-slate-900 text-xs font-bold inline-flex items-center gap-2"
          >
            <RefreshCcw className="w-3.5 h-3.5" /> Yenilə
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {(['today', '7d', '30d', 'all'] as Exclude<PresetType, 'custom'>[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPreset(item)}
              className={cn(
                'px-3 py-2 rounded-xl text-xs font-bold transition-colors',
                preset === item ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              )}
            >
              {item === 'today' ? 'Bugün' : item === '7d' ? '7 gün' : item === '30d' ? '30 gün' : 'Bütün zaman'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPreset('custom')}
            className={cn(
              'px-3 py-2 rounded-xl text-xs font-bold transition-colors',
              preset === 'custom' ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-slate-200'
            )}
          >
            Custom
          </button>
        </div>

        {preset === 'custom' ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="date"
                value={customRange.start}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, start: e.target.value }))}
                className="pl-9 pr-3 py-2 rounded-xl border border-slate-800 bg-slate-900 text-sm text-slate-100"
              />
            </div>
            <div className="relative">
              <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="date"
                value={customRange.end}
                onChange={(e) => setCustomRange((prev) => ({ ...prev, end: e.target.value }))}
                className="pl-9 pr-3 py-2 rounded-xl border border-slate-800 bg-slate-900 text-sm text-slate-100"
              />
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            Sahə: <span className="text-slate-200 font-semibold">{data.field?.label || 'Dashboard ayarı edilməyib'}</span>
          </div>
        )}
      </div>

      {error ? <div className="rounded-2xl border border-red-900/50 bg-red-950/15 px-4 py-3 text-sm text-red-300">{error}</div> : null}

      {(data.warnings || []).map((warning, index) => (
        <div key={index} className="rounded-2xl border border-amber-900/40 bg-amber-950/10 px-4 py-3 text-sm text-amber-300">
          {warning}
        </div>
      ))}

      {!loading && !data.field ? (
        <div className="rounded-3xl border border-slate-800 bg-slate-950/25 p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl border border-slate-800 bg-slate-900/70 flex items-center justify-center text-slate-300">
            <Link2 className="w-6 h-6" />
          </div>
          <h2 className="mt-4 text-xl font-bold text-slate-100">Dashboard hələ qurulmayıb</h2>
          <p className="mt-2 text-sm text-slate-400 max-w-2xl mx-auto">
            Ayarlarda <strong>Dashboard</strong> tabına keçin, bir <strong>select</strong> sahə seçin və hər dəyəri uyğun Facebook kampaniyaları ilə bağlayın.
          </p>
          <Link to="/settings" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-500">
            Dashboard ayarına keç
          </Link>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard title="Facebook Xərc" value={formatMoney(data.totals.facebook.spend)} sub={`${formatCount(data.totals.facebook.results)} nəticə`} icon={<Wallet className="w-5 h-5" />} />
        <StatCard title="CRM Lead" value={formatCount(data.totals.crm.leads)} sub={`CPL ${formatMoney(data.totals.merged.cost_per_crm_lead)}`} icon={<Target className="w-5 h-5" />} />
        <StatCard title="Satış" value={formatCount(data.totals.crm.won_count)} sub={`Konversiya ${formatPercent(data.totals.merged.conversion_rate)}`} icon={<BarChart3 className="w-5 h-5" />} />
        <StatCard title="ROAS" value={`${data.totals.merged.roas.toFixed(2)}x`} sub={`Gəlir ${formatMoney(data.totals.crm.won_revenue, '₼')}`} icon={<Link2 className="w-5 h-5" />} />
      </div>

      <div className="space-y-4">
        {loading ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-950/25 px-5 py-8 text-sm text-slate-400">Dashboard yüklənir...</div>
        ) : activeGroups.length === 0 ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-950/25 px-5 py-8 text-sm text-slate-400">
            Aktiv map tapılmadı. Ayarlardan bir dəyəri ən azı bir Facebook kampaniyası ilə bağlayın.
          </div>
        ) : (
          activeGroups.map((group) => (
            <div key={group.value} className="rounded-3xl border border-slate-800 bg-slate-950/25 p-5 space-y-4">
              <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
                <div>
                  <div className="text-xl font-bold text-slate-100">{group.value}</div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {group.campaigns.map((campaign) => (
                      <span key={campaign.id} className="inline-flex items-center rounded-full border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
                        {campaign.name}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 xl:min-w-[520px]">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/35 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Xərc</div>
                    <div className="mt-1 text-lg font-bold text-slate-100 tabular-nums">{formatMoney(group.facebook.spend)}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/35 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">CRM Lead</div>
                    <div className="mt-1 text-lg font-bold text-slate-100 tabular-nums">{formatCount(group.crm.leads)}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/35 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Satış</div>
                    <div className="mt-1 text-lg font-bold text-slate-100 tabular-nums">{formatCount(group.crm.won_count)}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/35 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">ROAS</div>
                    <div className="mt-1 text-lg font-bold text-slate-100 tabular-nums">{group.merged.roas.toFixed(2)}x</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4 space-y-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Facebook nəticələri</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] text-slate-500">Result</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatCount(group.facebook.results)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">CPR</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatMoney(group.facebook.cost_per_result)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">Klik</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatCount(group.facebook.clicks)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">CTR</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatPercent(group.facebook.ctr)}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4 space-y-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-500">CRM nəticələri</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] text-slate-500">Pipeline dəyəri</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatMoney(group.crm.pipeline_value, '₼')}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">Satış gəliri</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatMoney(group.crm.won_revenue, '₼')}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">CPL</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatMoney(group.merged.cost_per_crm_lead)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">Cost / sale</div>
                      <div className="text-lg font-bold text-slate-100 tabular-nums">{formatMoney(group.merged.cost_per_sale)}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">Kanban bölgüsü</div>
                <StageStrip stages={group.crm.stages} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
