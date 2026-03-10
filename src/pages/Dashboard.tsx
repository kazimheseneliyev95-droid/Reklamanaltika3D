import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Calendar, ChevronRight, RefreshCcw, Wallet } from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { cn } from '../lib/utils';

type MetricType = 'message' | 'lead' | 'purchase';
type PresetType = 'today' | '7d' | '30d' | 'all' | 'custom';

type DashboardResponse = {
  metric: MetricType;
  range: { start: string | null; end: string | null };
  field: { id: string; label: string; options: string[] } | null;
  warnings: string[];
  importedCampaigns: Array<{ id: string; name: string; account_name?: string | null }>;
  summaryCards: Array<{ key: string; label: string; count: number; pct_of_total: number; cost_per: number; color: string }>;
  groups: Array<{
    value: string;
    campaigns: Array<{ id: string; name: string; account_name?: string | null }>;
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
  warnings: [],
  importedCampaigns: [],
  summaryCards: [],
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

function normalizeStageText(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function SpendHero({
  spend,
  results,
  campaignCount,
  metric,
}: {
  spend: number;
  results: number;
  campaignCount: number;
  metric: MetricType;
}) {
  return (
    <div className="rounded-[26px] border border-slate-800 bg-[linear-gradient(135deg,rgba(24,37,63,0.95),rgba(15,23,42,0.98))] p-5 shadow-[0_20px_80px_rgba(2,8,23,0.35)]">
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-blue-300">
          <Wallet className="h-8 w-8" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-200/70">Total Spend</div>
          <div className="mt-1 text-4xl font-extrabold tracking-tight text-white tabular-nums">{formatMoney(spend)}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
            <span>{campaignCount} import olunmuş kampaniya</span>
            <span>{formatCount(results)} {metric === 'message' ? 'nəticə' : metric === 'lead' ? 'lead nəticəsi' : 'purchase nəticəsi'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FunnelCard({
  title,
  count,
  percent,
  costPer,
  color,
}: {
  title: string;
  count: number;
  percent: number;
  costPer: number;
  color: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-slate-800 bg-[linear-gradient(180deg,rgba(19,31,52,0.9),rgba(9,16,31,0.98))] p-4 shadow-[0_20px_60px_rgba(2,8,23,0.28)]">
      <div className="absolute left-0 top-0 h-full w-1.5" style={{ background: color }} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">{title}</div>
          <div className="mt-5 text-5xl font-extrabold tracking-tight text-white tabular-nums">{formatCount(count)}</div>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-200">
          Total: {formatPercent(percent)}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">1 ədəd xərc</div>
          <div className="mt-1 text-lg font-bold text-white tabular-nums">{formatMoney(costPer)}</div>
        </div>
        <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.max(6, Math.min(percent, 100))}%`, background: color }} />
        </div>
      </div>
    </div>
  );
}

type GroupRow = DashboardResponse['groups'][number];

function getGroupMetricCount(group: GroupRow, key: string) {
  if (key === 'total_leads') return Number(group.crm.leads || 0);
  if (key === 'won') return Number(group.crm.won_count || 0);

  const matchers: Record<string, (id: string, label: string) => boolean> = {
    potential: (id, label) => id === 'potential' || label.includes('potential') || label.includes('kvalifikasiya') || label.includes('potensial'),
    unanswered: (id, label) => id.includes('cavabsiz') || label.includes('cavabsiz') || label.includes('unanswered') || label.includes('no answer'),
    lost: (id, label) => id === 'lost' || label.includes('ugursuz') || label.includes('uğursuz') || label.includes('unsuccessful') || label.includes('satıs olmadi') || label.includes('satış olmadı'),
  };

  const matcher = matchers[key];
  if (!matcher) return 0;
  const stage = (group.crm.stages || []).find((item) => matcher(normalizeStageText(item.id), normalizeStageText(item.label)));
  return Number(stage?.count || 0);
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

  const campaignPreview = useMemo(() => data.importedCampaigns.slice(0, 8), [data.importedCampaigns]);
  const visibleSummaryCards = useMemo(
    () => data.summaryCards.filter((card) => ['total_leads', 'potential', 'won', 'unanswered', 'lost'].includes(card.key)),
    [data.summaryCards]
  );
  const activeGroups = useMemo(
    () => data.groups.filter((group) => group.facebook.spend > 0 || group.crm.leads > 0 || group.crm.won_revenue > 0),
    [data.groups]
  );

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="rounded-[30px] border border-slate-800 bg-[linear-gradient(180deg,rgba(6,12,25,0.98),rgba(7,14,28,0.96))] overflow-hidden">
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 px-5 py-5 border-b border-slate-800/80">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/50 text-blue-300">
                <BarChart3 className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-[30px] leading-none font-extrabold tracking-tight text-white">Dashboard</h1>
                <p className="mt-1 text-sm text-slate-400">Facebook import edilən kampaniyalar və CRM nəticələrinin ümumi görünüşü.</p>
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
                  'rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors',
                  metric === item ? 'border-blue-500/40 bg-blue-500/10 text-blue-100' : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                )}
              >
                {item === 'message' ? 'Mesaj' : item === 'lead' ? 'Lead' : 'Purchase'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
              className="rounded-xl border border-slate-800 bg-slate-950/30 px-3.5 py-2 text-xs font-bold text-slate-300 hover:bg-slate-900 inline-flex items-center gap-2"
            >
              <RefreshCcw className="w-3.5 h-3.5" /> Yenilə
            </button>
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 border-b border-slate-800/60">
          <div className="flex flex-wrap items-center gap-2">
            {(['today', '7d', '30d', 'all'] as Exclude<PresetType, 'custom'>[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPreset(item)}
                className={cn(
                  'rounded-xl px-3.5 py-2 text-xs font-bold transition-colors',
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
                'rounded-xl px-3.5 py-2 text-xs font-bold transition-colors',
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
              CRM mapping sahəsi: <span className="text-slate-200 font-semibold">{data.field?.label || 'qurulmayıb'}</span>
            </div>
          )}
        </div>

        {campaignPreview.length > 0 ? (
          <div className="px-5 py-4 flex flex-wrap gap-2 border-b border-slate-800/60">
            {campaignPreview.map((campaign) => (
              <span key={campaign.id} className="inline-flex items-center rounded-full border border-slate-800 bg-slate-950/30 px-3 py-1.5 text-[11px] font-semibold text-slate-300">
                {campaign.name}
              </span>
            ))}
            {data.importedCampaigns.length > campaignPreview.length ? (
              <span className="inline-flex items-center rounded-full border border-slate-800 bg-slate-950/30 px-3 py-1.5 text-[11px] font-semibold text-slate-500">
                +{data.importedCampaigns.length - campaignPreview.length} daha
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="p-5">
          {error ? <div className="rounded-2xl border border-red-900/50 bg-red-950/15 px-4 py-3 text-sm text-red-300 mb-4">{error}</div> : null}

          {(data.warnings || []).map((warning, index) => (
            <div key={index} className="rounded-2xl border border-amber-900/40 bg-amber-950/10 px-4 py-3 text-sm text-amber-300 mb-4">
              {warning}
            </div>
          ))}

          {!loading && data.importedCampaigns.length === 0 ? (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/25 p-8 text-center">
              <h2 className="text-xl font-bold text-slate-100">Import olunmuş kampaniya tapılmadı</h2>
              <p className="mt-2 text-sm text-slate-400 max-w-2xl mx-auto">
                Əvvəlcə <strong>Facebook</strong> bölməsində kampaniyaları import edib seçin. Dashboard xərcləri həmin kampaniyalara görə hesablayır.
              </p>
              <Link to="/facebook-import" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-500">
                Facebook importa keç
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              <SpendHero
                spend={data.totals.facebook.spend}
                results={data.totals.facebook.results}
                campaignCount={data.importedCampaigns.length}
                metric={metric}
              />

              {loading ? (
                <div className="rounded-3xl border border-slate-800 bg-slate-950/20 px-5 py-8 text-sm text-slate-400">Dashboard yüklənir...</div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-[repeat(5,minmax(0,1fr))] gap-3 xl:gap-2 items-stretch">
                  {visibleSummaryCards.map((card, index) => (
                    <div key={card.key} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <FunnelCard
                          title={card.label}
                          count={card.count}
                          percent={card.pct_of_total}
                          costPer={card.cost_per}
                          color={card.color}
                        />
                      </div>
                      {index < visibleSummaryCards.length - 1 ? (
                        <div className="hidden xl:flex h-full items-center px-1 text-slate-700">
                          <ChevronRight className="w-5 h-5" />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              {!loading && activeGroups.length > 0 ? (
                <div className="rounded-[28px] border border-slate-800 bg-slate-950/18 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-[1120px] w-full">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-950/40 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                          <th className="px-5 py-4 text-left font-bold">Xüsusi Sahə</th>
                          <th className="px-4 py-4 text-right font-bold">Spend</th>
                          {visibleSummaryCards.map((card) => (
                            <th key={card.key} className="px-4 py-4 text-right font-bold">{card.label}</th>
                          ))}
                          <th className="px-4 py-4 text-right font-bold">Revenue</th>
                          <th className="px-4 py-4 text-right font-bold">ROAS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeGroups.map((group) => {
                          const totalSpend = Number(data.totals.facebook.spend || 0);
                          const totalRevenue = Number(data.totals.crm.won_revenue || 0);
                          const spendShare = totalSpend > 0 ? (Number(group.facebook.spend || 0) / totalSpend) * 100 : 0;
                          const revenueShare = totalRevenue > 0 ? (Number(group.crm.won_revenue || 0) / totalRevenue) * 100 : 0;
                          return (
                            <tr key={group.value} className="border-b border-slate-800/70 last:border-b-0 hover:bg-slate-950/25 transition-colors">
                              <td className="px-5 py-5 align-top">
                                <div className="min-w-[220px]">
                                  <div className="text-lg font-extrabold text-slate-100">{group.value}</div>
                                  <div className="mt-1 text-[11px] text-slate-500">
                                    {data.field?.label || 'Xüsusi sahə'} · {group.campaigns.length} kampaniya · {formatMoney(group.facebook.spend)}
                                  </div>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {group.campaigns.slice(0, 3).map((campaign) => (
                                      <span key={campaign.id} className="inline-flex items-center rounded-full border border-slate-800 bg-slate-900/60 px-2.5 py-1 text-[10px] font-semibold text-slate-300">
                                        {campaign.name}
                                      </span>
                                    ))}
                                    {group.campaigns.length > 3 ? (
                                      <span className="inline-flex items-center rounded-full border border-slate-800 bg-slate-900/60 px-2.5 py-1 text-[10px] font-semibold text-slate-500">
                                        +{group.campaigns.length - 3} daha
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </td>

                              <td className="px-4 py-5 text-right align-top">
                                <div className="text-2xl font-extrabold text-white tabular-nums">{formatMoney(group.facebook.spend)}</div>
                                <div className="mt-1 text-[11px] text-slate-500">Totalın {formatPercent(spendShare)}</div>
                              </td>

                              {visibleSummaryCards.map((card) => {
                                const count = getGroupMetricCount(group, card.key);
                                const costPer = count > 0 ? Number(group.facebook.spend || 0) / count : 0;
                                const pct = card.count > 0 ? (count / Number(card.count || 0)) * 100 : 0;
                                return (
                                  <td key={card.key} className="px-4 py-5 text-right align-top">
                                    <div className="text-2xl font-extrabold text-white tabular-nums">{formatCount(count)}</div>
                                    <div className="mt-1 text-[11px] text-slate-500 tabular-nums">{formatMoney(costPer)}</div>
                                    <div className="mt-1 text-[11px] font-semibold" style={{ color: card.color }}>{formatPercent(pct)}</div>
                                  </td>
                                );
                              })}

                              <td className="px-4 py-5 text-right align-top">
                                <div className="text-2xl font-extrabold text-emerald-300 tabular-nums">{formatMoney(group.crm.won_revenue, '₼')}</div>
                                <div className="mt-1 text-[11px] text-slate-500">Totalın {formatPercent(revenueShare)}</div>
                              </td>

                              <td className="px-4 py-5 text-right align-top">
                                <div className="inline-flex items-center rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xl font-extrabold text-blue-100 tabular-nums">
                                  {group.merged.roas.toFixed(2)}x
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
