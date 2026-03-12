import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3, Calendar, ChevronRight, RefreshCcw,
  CheckCircle2, Download, Filter, FolderSync,
  Loader2, Save, Search, Settings2, X,
} from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { cn } from '../lib/utils';

type MetricType = 'message' | 'lead' | 'purchase';
type PresetType = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom';
type FbSortType = 'spend_desc' | 'results_desc' | 'cost_per_result_asc' | 'ctr_desc' | 'name_asc';

// ─── Facebook Ads types ───────────────────────────────────────────
type AdAccount = { id: string; api_id: string; account_id: string; name: string; account_status: number | null; currency: string | null; timezone_name: string | null; business_name: string | null; };
type Campaign = { id: string; account_id: string; api_id?: string; account_api_id?: string; account_name: string | null; name: string; status: string | null; effective_status: string[]; objective: string | null; };
type InsightMetric = { spend: number; impressions?: number; clicks?: number; ctr: number; cpm: number; results: number; cost_per_result: number; };
type InsightCampaign = Campaign & { metrics: InsightMetric; daily: Array<InsightMetric & { date_start: string | null }> };
type InsightsPayload = { summary: InsightMetric; campaigns: InsightCampaign[]; selectedCampaignIds: string[]; metric?: MetricType; range: { start: string | null; end: string | null }; cache?: { lastSyncAt: string | null; lastSyncError: string | null }; };
type FbAutoSync = { mode: 'manual' | 'automatic'; enabled: boolean; startDate: string; endDate: string; everyHours: number; minute: number; tzOffsetMinutes: number; nextAt: string | null; lastInsightSyncAt: string | null; lastInsightSyncError: string | null; };
type SavedConfig = { hasToken: boolean; tokenHint: string | null; selectedAccountIds: string[]; selectedCampaignIds: string[]; selectedAccounts: AdAccount[]; selectedCampaigns: Campaign[]; accountCache: AdAccount[]; campaignCache: Campaign[]; autoSync: FbAutoSync; lastSyncAt: string | null; lastError: string | null; };

const EMPTY_FB_CONFIG: SavedConfig = { hasToken: false, tokenHint: null, selectedAccountIds: [], selectedCampaignIds: [], selectedAccounts: [], selectedCampaigns: [], accountCache: [], campaignCache: [], autoSync: { mode: 'manual', enabled: false, startDate: '', endDate: '', everyHours: 1, minute: 0, tzOffsetMinutes: 0, nextAt: null, lastInsightSyncAt: null, lastInsightSyncError: null }, lastSyncAt: null, lastError: null };
const EMPTY_FB_INSIGHTS: InsightsPayload = { summary: { spend: 0, ctr: 0, cpm: 0, results: 0, cost_per_result: 0 }, campaigns: [], selectedCampaignIds: [], range: { start: null, end: null } };

function formatNum(v: number) { const n = Number(v || 0); return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : '0'; }
function formatPct(v: number) { return `${Number(v || 0).toFixed(2)}%`; }
function formatMon(v: number) { return `$${Number(v || 0).toFixed(2)}`; }
function metricLabel(m: MetricType) { return m === 'lead' ? 'Lead' : m === 'purchase' ? 'Purchase' : 'Mesaj'; }
function statusLabel(code: number | null) { if (code === 1) return 'Aktiv'; if (code === 2) return 'Disabled'; if (code === 9) return 'Closed'; if (code === 100) return 'Archived'; return 'Unknown'; }
function fbDateLabel(iso: string | null | undefined) { if (!iso) return '-'; return new Date(`${iso}T00:00:00`).toLocaleDateString('az-AZ', { day: 'numeric', month: 'short', year: 'numeric' }); }

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
  if (preset === 'yesterday') {
    end.setDate(end.getDate() - 1);
    const iso = toLocalISO(end);
    return { start: iso, end: iso };
  }
  if (preset === '7d') start.setDate(end.getDate() - 6);
  if (preset === '30d') start.setDate(end.getDate() - 29);
  return { start: toLocalISO(start), end: toLocalISO(end) };
}

function FunnelCard({
  title,
  count,
  percent,
  costPer,
  color,
  accent,
}: {
  title: string;
  count: number;
  percent: number;
  costPer: number;
  color: string;
  accent?: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-slate-800 bg-[linear-gradient(180deg,rgba(19,31,52,0.9),rgba(9,16,31,0.98))] p-4 shadow-[0_20px_60px_rgba(2,8,23,0.28)]">
      <div className="absolute left-0 top-0 h-full w-1.5" style={{ background: color }} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">{title}</div>
          <div className="mt-5 text-5xl font-extrabold tracking-tight text-white tabular-nums">{formatCount(count)}</div>
          {accent ? <div className="mt-3 text-[12px] text-slate-400">{accent}</div> : null}
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

function SpendCard({ spend, campaignCount }: { spend: number; campaignCount: number }) {
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-slate-800 bg-[linear-gradient(180deg,rgba(19,31,52,0.9),rgba(9,16,31,0.98))] p-4 shadow-[0_20px_60px_rgba(2,8,23,0.28)]">
      <div className="absolute left-0 top-0 h-full w-1.5 bg-blue-500" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Total Xerc</div>
          <div className="mt-5 text-5xl font-extrabold tracking-tight text-white tabular-nums">{formatMoney(spend)}</div>
          <div className="mt-3 text-[12px] text-slate-400">{campaignCount} import olunmuş kampaniya</div>
        </div>
      </div>

      <div className="mt-5 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Campaign hovuzu</div>
          <div className="mt-1 text-lg font-bold text-white tabular-nums">{formatCount(campaignCount)}</div>
        </div>
        <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
          <div className="h-full w-full rounded-full bg-blue-500" />
        </div>
      </div>
    </div>
  );
}

function GroupMobileCard({
  group,
  visibleSummaryCards,
  totalSpend,
  totalRevenue,
  fieldLabel,
}: {
  group: GroupRow;
  visibleSummaryCards: DashboardResponse['summaryCards'];
  totalSpend: number;
  totalRevenue: number;
  fieldLabel: string;
}) {
  const spendShare = totalSpend > 0 ? (Number(group.facebook.spend || 0) / totalSpend) * 100 : 0;
  const revenueShare = totalRevenue > 0 ? (Number(group.crm.won_revenue || 0) / totalRevenue) * 100 : 0;

  return (
    <div className="rounded-[24px] border border-slate-800 bg-[linear-gradient(180deg,rgba(10,18,33,0.98),rgba(8,14,28,0.98))] p-4 shadow-[0_14px_40px_rgba(2,8,23,0.28)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xl font-extrabold text-slate-100 break-words">{group.value}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            {fieldLabel} · {group.campaigns.length} kampaniya
          </div>
        </div>
        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-right">
          <div className="text-[10px] uppercase tracking-wide text-blue-200/70">ROAS</div>
          <div className="text-lg font-extrabold text-blue-100 tabular-nums">{group.merged.roas.toFixed(2)}x</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Spend</div>
          <div className="mt-1 text-2xl font-extrabold text-white tabular-nums">{formatMoney(group.facebook.spend)}</div>
          <div className="mt-1 text-[11px] text-slate-500">Totalın {formatPercent(spendShare)}</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Revenue</div>
          <div className="mt-1 text-2xl font-extrabold text-emerald-300 tabular-nums">{formatMoney(group.crm.won_revenue, '₼')}</div>
          <div className="mt-1 text-[11px] text-slate-500">Totalın {formatPercent(revenueShare)}</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        {visibleSummaryCards.map((card) => {
          const count = getGroupMetricCount(group, card.key);
          const costPer = count > 0 ? Number(group.facebook.spend || 0) / count : 0;
          const pct = card.count > 0 ? (count / Number(card.count || 0)) * 100 : 0;
          return (
            <div key={card.key} className="rounded-2xl border border-slate-800 bg-slate-950/20 p-3">
              <div className="text-[10px] uppercase tracking-wide font-bold" style={{ color: card.color }}>{card.label}</div>
              <div className="mt-2 text-3xl font-extrabold text-white tabular-nums">{formatCount(count)}</div>
              <div className="mt-1 text-[11px] text-slate-500 tabular-nums">1 ədəd xərc {formatMoney(costPer)}</div>
              <div className="mt-1 text-[11px] font-semibold" style={{ color: card.color }}>{formatPercent(pct)}</div>
            </div>
          );
        })}
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

// ─── Facebook Ads UI components ───────────────────────────────────
function HeaderBadge({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-950/45 px-3 py-2 min-w-[94px]">
      <div className="text-[9px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold text-slate-100 whitespace-nowrap">{value}</div>
    </div>
  );
}
function FbMetricCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/25 px-4 py-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-3 text-3xl font-bold text-slate-100">{value}</div>
    </div>
  );
}
function FbStatusCell({ status }: { status: string }) {
  const active = /active/i.test(status);
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold', active ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-slate-700 bg-slate-900/50 text-slate-300')}>
      <span className={cn('w-2 h-2 rounded-full', active ? 'bg-emerald-400' : 'bg-slate-500')} />
      {status}
    </span>
  );
}
function FbTag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{children}</span>;
}
function FbDateField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/35 px-3 py-2 text-sm text-slate-300', disabled ? 'opacity-50' : '')}>
      <Calendar className="w-4 h-4 text-slate-500" />
      <input type="date" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent outline-none text-slate-100 disabled:cursor-not-allowed" />
    </label>
  );
}
function FbActionButton({ children, onClick, busy, icon, disabled, variant = 'primary' }: { children: React.ReactNode; onClick: () => void; busy?: boolean; icon?: React.ReactNode; disabled?: boolean; variant?: 'primary' | 'secondary' }) {
  return (
    <button onClick={onClick} disabled={busy || disabled} className={cn('inline-flex h-10 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold disabled:opacity-60', variant === 'primary' ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'border border-slate-700 bg-slate-800/90 hover:bg-slate-700 text-slate-200')}>
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}
function DrawerSection({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-950/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/35 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="text-base font-semibold text-slate-100">{title}</div>
        <div className="w-full sm:w-auto">{right}</div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
function SearchInline({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 w-full sm:w-auto sm:min-w-[200px]">
      <Search className="w-4 h-4 text-slate-500" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Axtar..." className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600 w-full" />
    </div>
  );
}
function SelectableCard({ title, subtitle, meta, checked, onClick, tone, compact }: { title: string; subtitle?: string; meta?: string[]; checked: boolean; onClick: () => void; tone: 'blue' | 'violet'; compact?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('w-full text-left transition-colors', compact ? 'px-4 py-3 hover:bg-slate-900/40' : 'rounded-2xl border px-4 py-3', tone === 'blue' ? (checked ? 'border-blue-500/30 bg-blue-500/10' : 'border-slate-800 bg-slate-950/30 hover:bg-slate-950/50') : (checked ? 'bg-violet-500/10' : 'hover:bg-slate-900/40'))}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('w-2 h-2 rounded-full shrink-0', checked ? (tone === 'blue' ? 'bg-blue-400' : 'bg-violet-400') : 'bg-slate-600')} />
            <div className="truncate text-sm font-medium text-slate-100">{title}</div>
          </div>
          {subtitle ? <div className="mt-1 text-[11px] text-slate-500 truncate">{subtitle}</div> : null}
          {meta && meta.filter(Boolean).length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
              {meta.filter(Boolean).map((m, i) => <FbTag key={`${m}-${i}`}>{m}</FbTag>)}
            </div>
          ) : null}
        </div>
        {checked ? <CheckCircle2 className={cn('w-4 h-4 shrink-0', tone === 'blue' ? 'text-blue-300' : 'text-violet-300')} /> : null}
      </div>
    </button>
  );
}
function EmptyHint({ text, compact }: { text: string; compact?: boolean }) {
  return <div className={cn('rounded-2xl border border-dashed border-slate-800 bg-slate-950/20 text-center text-sm text-slate-500', compact ? 'p-5' : 'p-8')}>{text}</div>;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardResponse>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<PresetType>('30d');
  const [refreshKey, setRefreshKey] = useState(0);
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>(() => buildPresetRange('30d'));
  const metric: MetricType = 'message';
  const tzOffsetMinutes = useMemo(() => new Date().getTimezoneOffset(), []);
  const dashboardRefreshTimeoutRef = useRef<number | null>(null);

  const range = useMemo(() => {
    if (preset === 'custom') return customRange;
    return buildPresetRange(preset);
  }, [customRange, preset]);

  const loadDashboardData = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    if (!opts?.silent) setError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) throw new Error('Not authenticated');

      const qs = new URLSearchParams({ metric });
      if (range.start) qs.set('start', range.start);
      if (range.end) qs.set('end', range.end);
      qs.set('tzOffsetMinutes', String(tzOffsetMinutes));

      const res = await fetch(`${url}/api/dashboard/combined?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Dashboard yüklənmədi');
      setData(json);
      if (!opts?.silent) setError('');
    } catch (e: any) {
      if (!opts?.silent) {
        setError(e?.message || 'Dashboard yüklənmədi');
        setData(EMPTY_DATA);
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [metric, range.end, range.start, tzOffsetMinutes]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData, refreshKey]);

  const visibleSummaryCards = useMemo(
    () => data.summaryCards.filter((card) => ['total_leads', 'potential', 'won', 'unanswered', 'lost'].includes(card.key)),
    [data.summaryCards]
  );
  const activeGroups = useMemo(
    () => data.groups.filter((group) => group.facebook.spend > 0 || group.crm.leads > 0 || group.crm.won_revenue > 0),
    [data.groups]
  );

  // ─── Facebook Ads state ─────────────────────────────────────────
  const fbTz = useMemo(() => new Date().getTimezoneOffset(), []);
  const [fbSaved, setFbSaved] = useState<SavedConfig>(EMPTY_FB_CONFIG);
  const [fbInsights, setFbInsights] = useState<InsightsPayload>(EMPTY_FB_INSIGHTS);
  const [fbAccounts, setFbAccounts] = useState<AdAccount[]>([]);
  const [fbCampaigns, setFbCampaigns] = useState<Campaign[]>([]);
  const [fbSelAccIds, setFbSelAccIds] = useState<string[]>([]);
  const [fbSelCampIds, setFbSelCampIds] = useState<string[]>([]);
  const [tokenInput, setTokenInput] = useState('');
  const [accSearch, setAccSearch] = useState('');
  const [campSearch, setCampSearch] = useState('');
  const [fbMetric, setFbMetric] = useState<MetricType>('message');
  const [fbDateRange, setFbDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [fbPreset, setFbPreset] = useState<Exclude<PresetType, 'custom'>>('all');
  const [fbSortBy, setFbSortBy] = useState<FbSortType>('spend_desc');
  const [fbAutoSync, setFbAutoSync] = useState<FbAutoSync>(EMPTY_FB_CONFIG.autoSync);
  const [showFbSettings, setShowFbSettings] = useState(false);
  const [busyFbAccounts, setBusyFbAccounts] = useState(false);
  const [busyFbCampaigns, setBusyFbCampaigns] = useState(false);
  const [busyFbSave, setBusyFbSave] = useState(false);
  const [busyFbRefresh, setBusyFbRefresh] = useState(false);
  const [busyFbInsights, setBusyFbInsights] = useState(false);
  const [busyFbSync, setBusyFbSync] = useState(false);
  const [fbMsg, setFbMsg] = useState('');

  const fbSelAccounts = useMemo(
    () => fbAccounts.filter((a) => fbSelAccIds.includes(a.account_id) || fbSelAccIds.includes(a.id) || fbSelAccIds.includes(a.api_id)),
    [fbAccounts, fbSelAccIds]
  );
  const fbFilteredAccounts = useMemo(() => {
    const q = accSearch.trim().toLowerCase();
    if (!q) return fbAccounts;
    return fbAccounts.filter((a) => [a.name, a.account_id, a.business_name, a.currency, a.timezone_name].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [fbAccounts, accSearch]);
  const fbFilteredCampaigns = useMemo(() => {
    const q = campSearch.trim().toLowerCase();
    return fbCampaigns.filter((c) => {
      if (!fbSelAccIds.includes(c.account_id)) return false;
      if (!q) return true;
      return [c.name, c.account_name, c.objective, ...(c.effective_status || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [fbCampaigns, campSearch, fbSelAccIds]);
  const fbCampaignsByAccount = useMemo(() => {
    const map = new Map<string, Campaign[]>();
    for (const c of fbFilteredCampaigns) { const arr = map.get(c.account_id) || []; arr.push(c); map.set(c.account_id, arr); }
    return map;
  }, [fbFilteredCampaigns]);
  const fbSortedCampaigns = useMemo(() => {
    const rows = [...fbInsights.campaigns].filter((c) => {
      const q = campSearch.trim().toLowerCase();
      if (!q) return true;
      return [c.name, c.account_name, c.objective, c.status].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    rows.sort((a, b) => {
      switch (fbSortBy) {
        case 'results_desc': return b.metrics.results - a.metrics.results;
        case 'cost_per_result_asc': return a.metrics.cost_per_result - b.metrics.cost_per_result;
        case 'ctr_desc': return b.metrics.ctr - a.metrics.ctr;
        case 'name_asc': return a.name.localeCompare(b.name);
        default: return b.metrics.spend - a.metrics.spend;
      }
    });
    return rows;
  }, [fbInsights.campaigns, campSearch, fbSortBy]);
  const fbRangeLabel = useMemo(() => !fbDateRange.start && !fbDateRange.end ? 'Tüm zamanlar' : `${fbDateLabel(fbDateRange.start)} - ${fbDateLabel(fbDateRange.end)}`, [fbDateRange]);
  const fbConfigRangeLabel = useMemo(() => {
    const start = String(fbAutoSync.startDate || '').trim();
    const end = String(fbAutoSync.endDate || '').trim();
    if (!start && !end) return 'Tüm zamanlar';
    if (start && !end) return `${fbDateLabel(start)} - ${fbAutoSync.mode === 'automatic' ? 'Bugün' : '...'}`;
    if (!start && end) return `... - ${fbDateLabel(end)}`;
    return `${fbDateLabel(start)} - ${fbDateLabel(end)}`;
  }, [fbAutoSync.endDate, fbAutoSync.mode, fbAutoSync.startDate]);

  const fbToken = localStorage.getItem('crm_auth_token') || '';

  const loadFbConfig = useCallback(async () => {
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/config`, { headers: { Authorization: `Bearer ${fbToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'FB config yüklənmədi');
      const cfg = { ...EMPTY_FB_CONFIG, ...(data || {}) } as SavedConfig;
      setFbSaved(cfg); setFbAccounts(cfg.accountCache || []); setFbCampaigns(cfg.campaignCache || []);
      setFbSelAccIds(cfg.selectedAccountIds || []); setFbSelCampIds(cfg.selectedCampaignIds || []);
      setFbAutoSync({ ...EMPTY_FB_CONFIG.autoSync, ...(cfg.autoSync || {}), tzOffsetMinutes: fbTz });
    } catch (e: any) { setFbMsg(e?.message || 'FB config xətası'); }
  }, [fbToken, fbTz]);

  const loadFbInsights = useCallback(async (range = fbDateRange, m = fbMetric) => {
    setBusyFbInsights(true);
    try {
      const p = new URLSearchParams();
      if (range.start) p.set('start', range.start);
      if (range.end) p.set('end', range.end);
      p.set('metric', m); p.set('tzOffsetMinutes', String(fbTz));
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/insights?${p.toString()}`, { headers: { Authorization: `Bearer ${fbToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Insights alınmadı');
      setFbInsights({ ...EMPTY_FB_INSIGHTS, ...(data || {}) });
      setFbMetric((data?.metric || m || 'message') as MetricType);
    } catch (e: any) { setFbInsights(EMPTY_FB_INSIGHTS); setFbMsg(e?.message || 'Insights xətası'); }
    finally { setBusyFbInsights(false); }
  }, [fbToken, fbTz, fbDateRange, fbMetric]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (document.visibilityState === 'hidden') return;
      if (dashboardRefreshTimeoutRef.current != null) {
        window.clearTimeout(dashboardRefreshTimeoutRef.current);
      }
      dashboardRefreshTimeoutRef.current = window.setTimeout(() => {
        dashboardRefreshTimeoutRef.current = null;
        loadDashboardData({ silent: true });
        loadFbConfig();
      }, 350);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleRefresh();
    };

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') scheduleRefresh();
    }, 5000);

    const cleanupNewMessage = CrmService.onNewMessage(() => scheduleRefresh());
    const cleanupLeadUpdated = CrmService.onLeadUpdated(() => scheduleRefresh());
    const cleanupLeadsUpdated = CrmService.onLeadsUpdated(() => scheduleRefresh());
    const cleanupReconnect = CrmService.onReconnect(() => scheduleRefresh());
    const cleanupSettings = CrmService.onSettingsUpdated(() => scheduleRefresh());

    window.addEventListener('focus', scheduleRefresh);
    window.addEventListener('online', scheduleRefresh);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (dashboardRefreshTimeoutRef.current != null) {
        window.clearTimeout(dashboardRefreshTimeoutRef.current);
        dashboardRefreshTimeoutRef.current = null;
      }
      window.clearInterval(intervalId);
      window.removeEventListener('focus', scheduleRefresh);
      window.removeEventListener('online', scheduleRefresh);
      document.removeEventListener('visibilitychange', onVisible);
      cleanupNewMessage();
      cleanupLeadUpdated();
      cleanupLeadsUpdated();
      cleanupReconnect();
      cleanupSettings();
    };
  }, [loadDashboardData, loadFbConfig]);

  const applyFbPreset = async (p: Exclude<PresetType, 'custom'>) => {
    const next = buildPresetRange(p); setFbPreset(p); setFbDateRange(next); await loadFbInsights(next, fbMetric);
  };

  const handleFbFetchAccounts = async () => {
    if (!tokenInput.trim()) return setFbMsg('Facebook token daxil edin.');
    setBusyFbAccounts(true); setFbMsg('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fbToken}` }, body: JSON.stringify({ token: tokenInput.trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Hesablar alınmadı');
      setFbAccounts(Array.isArray(data.accounts) ? data.accounts : []); setFbCampaigns([]); setFbSelCampIds([]);
      setFbMsg(`${Array.isArray(data.accounts) ? data.accounts.length : 0} hesab tapıldı.`);
    } catch (e: any) { setFbMsg(e?.message || 'Hesab xətası'); } finally { setBusyFbAccounts(false); }
  };

  const handleFbFetchCampaigns = async () => {
    if (fbSelAccIds.length === 0) return setFbMsg('Əvvəl hesab seçin.');
    setBusyFbCampaigns(true); setFbMsg('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fbToken}` }, body: JSON.stringify({ token: tokenInput.trim() || undefined, accountIds: fbSelAccIds, accounts: fbAccounts }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kampaniyalar alınmadı');
      const next = Array.isArray(data.campaigns) ? data.campaigns : [];
      setFbCampaigns(next); setFbSelCampIds((prev) => prev.filter((id) => next.some((c: Campaign) => c.id === id)));
      setFbMsg(`${next.length} kampaniya tapıldı.`);
    } catch (e: any) { setFbMsg(e?.message || 'Kampaniya xətası'); } finally { setBusyFbCampaigns(false); }
  };

  const handleFbSave = async () => {
    if (fbSelAccIds.length === 0) return setFbMsg('Ən azı bir hesab seçin.');
    setBusyFbSave(true); setFbMsg('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fbToken}` }, body: JSON.stringify({ token: tokenInput.trim() || undefined, accounts: fbAccounts, campaigns: fbCampaigns, selectedAccountIds: fbSelAccIds, selectedCampaignIds: fbSelCampIds, autoSync: { ...fbAutoSync, tzOffsetMinutes: fbTz } }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Saxlama xətası');
      const cfg = { ...EMPTY_FB_CONFIG, ...(data.config || {}) } as SavedConfig;
      setFbSaved(cfg); setFbAccounts(cfg.accountCache); setFbCampaigns(cfg.campaignCache);
      setFbSelAccIds(cfg.selectedAccountIds); setFbSelCampIds(cfg.selectedCampaignIds);
      setFbAutoSync({ ...EMPTY_FB_CONFIG.autoSync, ...(cfg.autoSync || {}), tzOffsetMinutes: fbTz });
      setTokenInput(''); setFbMsg('Facebook ayarları saxlandı.'); setShowFbSettings(false);
    } catch (e: any) { setFbMsg(e?.message || 'Saxlama xətası'); } finally { setBusyFbSave(false); }
  };

  const handleFbRefresh = async () => {
    setBusyFbRefresh(true); setFbMsg('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${fbToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh xətası');
      const cfg = { ...EMPTY_FB_CONFIG, ...(data.config || {}) } as SavedConfig;
      setFbSaved(cfg); setFbAccounts(cfg.accountCache); setFbCampaigns(cfg.campaignCache);
      setFbSelAccIds(cfg.selectedAccountIds); setFbSelCampIds(cfg.selectedCampaignIds);
      setFbMsg('Facebook cache yeniləndi.');
    } catch (e: any) { setFbMsg(e?.message || 'Refresh xətası'); } finally { setBusyFbRefresh(false); }
  };

  const handleFbSyncNow = async () => {
    setBusyFbSync(true); setFbMsg('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/sync`, { method: 'POST', headers: { Authorization: `Bearer ${fbToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync xətası');
      const cfg = { ...EMPTY_FB_CONFIG, ...(data.config || {}) } as SavedConfig;
      setFbSaved(cfg); setFbAutoSync({ ...EMPTY_FB_CONFIG.autoSync, ...(cfg.autoSync || {}), tzOffsetMinutes: fbTz });
      setFbMsg('Facebook insight cache yeniləndi.');
      await loadFbInsights(fbDateRange, fbMetric);
    } catch (e: any) { setFbMsg(e?.message || 'Sync xətası'); } finally { setBusyFbSync(false); }
  };

  const toggleFbAccount = (accountId: string) => {
    setFbSelAccIds((prev) => {
      const next = prev.includes(accountId) ? prev.filter((x) => x !== accountId) : [...prev, accountId];
      setFbSelCampIds((cur) => cur.filter((id) => { const c = fbCampaigns.find((c) => c.id === id); return c ? next.includes(c.account_id) : true; }));
      return next;
    });
  };
  const toggleFbCampaign = (id: string) => setFbSelCampIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  useEffect(() => { loadFbConfig(); }, [loadFbConfig]);

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-5">
      <div className="rounded-[28px] border border-slate-800 bg-[linear-gradient(180deg,rgba(6,12,25,0.98),rgba(7,14,28,0.96))] overflow-hidden shadow-[0_18px_60px_rgba(2,8,23,0.22)]">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-800/80">
          <div className="min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/50 text-blue-300 shrink-0">
                <BarChart3 className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0">
                <h1 className="text-[22px] sm:text-[28px] leading-none font-extrabold tracking-tight text-white">Dashboard</h1>
                <p className="mt-1 text-[11px] sm:text-xs text-slate-500 truncate sm:whitespace-normal">Facebook import kampaniyaları və CRM nəticələrinin ümumi görünüşü.</p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 px-3 py-2 text-[11px] font-bold text-slate-300">
              {data.importedCampaigns.length} kampaniya import olunub
            </div>
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/30 px-3 py-2 text-[11px] font-bold text-slate-300 hover:bg-slate-900"
            >
              <RefreshCcw className="w-3.5 h-3.5" /> Yenilə
            </button>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3.5 border-b border-slate-800/60">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-1.5 w-full lg:w-auto">
            {(['today', 'yesterday', '7d', '30d', 'all'] as Exclude<PresetType, 'custom'>[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPreset(item)}
                className={cn(
                  'rounded-xl px-3 py-2 text-[11px] font-bold transition-colors',
                  preset === item ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                )}
              >
                {item === 'today' ? 'Bugün' : item === 'yesterday' ? 'Dün' : item === '7d' ? '7 gün' : item === '30d' ? '30 gün' : 'Bütün zaman'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset('custom')}
              className={cn(
                'rounded-xl px-3.5 py-2 text-[11px] font-bold transition-colors',
                preset === 'custom' ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              )}
            >
              Custom
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
          {preset === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="date"
                  value={customRange.start}
                  onChange={(e) => setCustomRange((prev) => ({ ...prev, start: e.target.value }))}
                  className="h-9 w-full rounded-xl border border-slate-800 bg-slate-900 pl-9 pr-3 text-sm text-slate-100"
                />
              </div>
              <div className="relative">
                <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="date"
                  value={customRange.end}
                  onChange={(e) => setCustomRange((prev) => ({ ...prev, end: e.target.value }))}
                  className="h-9 w-full rounded-xl border border-slate-800 bg-slate-900 pl-9 pr-3 text-sm text-slate-100"
                />
              </div>
            </div>
          ) : null}
          </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span className="rounded-full border border-slate-800 bg-slate-950/35 px-3 py-1.5">CRM sahəsi: <span className="font-semibold text-slate-200">{data.field?.label || 'qurulmayıb'}</span></span>
            <span className="rounded-full border border-slate-800 bg-slate-950/35 px-3 py-1.5">Data mənbəyi: <span className="font-semibold text-slate-200">Facebook cache + CRM</span></span>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3.5 border-b border-slate-800/60">
          <div className="rounded-[22px] border border-slate-800 bg-slate-950/20 px-4 py-4 sm:px-5">
            <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-blue-200">
                  <BarChart3 className="w-3.5 h-3.5" /> Facebook Ads
                </div>
                <div className="mt-2 text-base sm:text-lg font-bold text-slate-100">Facebook sync və ayarlar</div>
                <div className="mt-1 text-sm text-slate-500">Manual sync, cache və kampaniya seçimi üçün qısa idarə paneli.</div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <FbActionButton variant="secondary" onClick={() => setShowFbSettings(true)} icon={<Settings2 className="w-4 h-4" />}>Ayarlar</FbActionButton>
                <FbActionButton variant="secondary" onClick={handleFbRefresh} busy={busyFbRefresh} icon={<RefreshCcw className="w-4 h-4" />} disabled={!fbSaved.hasToken}>Yenilə</FbActionButton>
                <FbActionButton variant="secondary" onClick={handleFbSyncNow} busy={busyFbSync} icon={<FolderSync className="w-4 h-4" />} disabled={!fbSaved.hasToken || fbSelCampIds.length === 0}>İndi Sync</FbActionButton>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 xl:grid-cols-4 gap-2">
              <HeaderBadge label="Range" value={fbConfigRangeLabel} />
              <HeaderBadge label="Campaigns" value={String(fbSelCampIds.length)} />
              <HeaderBadge label="Sync Mode" value={fbAutoSync.mode === 'automatic' ? `Auto · hər ${fbAutoSync.everyHours}s` : 'Manual'} />
              <HeaderBadge label="Cache" value={fbSaved.autoSync.lastInsightSyncAt ? fbDateLabel(String(fbSaved.autoSync.lastInsightSyncAt).slice(0, 10)) : 'Boş'} />
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          {error ? <div className="mb-3 rounded-xl border border-red-900/40 bg-red-950/10 px-3.5 py-2.5 text-xs font-medium text-red-300">{error}</div> : null}

          {(data.warnings || []).map((warning, index) => (
            <div key={index} className="mb-3 rounded-xl border border-amber-900/30 bg-amber-950/10 px-3.5 py-2.5 text-xs font-medium text-amber-300">
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
              {loading ? (
                <div className="rounded-3xl border border-slate-800 bg-slate-950/20 px-5 py-8 text-sm text-slate-400">Dashboard yüklənir...</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:hidden">
                    <SpendCard spend={data.totals.facebook.spend} campaignCount={data.importedCampaigns.length} />
                    {visibleSummaryCards.map((card) => (
                      <FunnelCard
                        key={card.key}
                        title={card.label}
                        count={card.count}
                        percent={card.pct_of_total}
                        costPer={card.cost_per}
                        color={card.color}
                      />
                    ))}
                  </div>

                  <div className="hidden md:grid grid-cols-1 xl:grid-cols-[repeat(6,minmax(0,1fr))] gap-3 xl:gap-2 items-stretch">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <SpendCard spend={data.totals.facebook.spend} campaignCount={data.importedCampaigns.length} />
                      </div>
                      <div className="hidden xl:flex h-full items-center px-1 text-slate-700">
                        <ChevronRight className="w-5 h-5" />
                      </div>
                    </div>
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
                </>
              )}

              {!loading && activeGroups.length > 0 ? (
                <>
                  <div className="space-y-3 md:hidden">
                    {activeGroups.map((group) => (
                      <GroupMobileCard
                        key={group.value}
                        group={group}
                        visibleSummaryCards={visibleSummaryCards}
                        totalSpend={Number(data.totals.facebook.spend || 0)}
                        totalRevenue={Number(data.totals.crm.won_revenue || 0)}
                        fieldLabel={data.field?.label || 'Xüsusi sahə'}
                      />
                    ))}
                  </div>

                  <div className="hidden md:block rounded-[28px] border border-slate-800 bg-slate-950/18 overflow-hidden">
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
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>


      {
        showFbSettings ? (
          <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex justify-end">
            <div className="h-full w-full max-w-[720px] border-l border-slate-800 bg-slate-900 shadow-2xl flex flex-col">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
                <div><div className="text-xl font-semibold text-slate-100">Facebook ayarları</div><div className="text-sm text-slate-500">Token, hesab və kampaniya seçimi</div></div>
                <button onClick={() => setShowFbSettings(false)} className="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
              </div>
              <div className="flex-1 overflow-auto p-5 space-y-5">
                <DrawerSection title="1. Token">
                  <textarea rows={5} value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="EAAB... token buraya" className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:ring-1 focus:ring-blue-500" />
                  <div className="mt-3 flex flex-wrap gap-2"><FbActionButton onClick={handleFbFetchAccounts} busy={busyFbAccounts} icon={<Download className="w-4 h-4" />}>Hesabları gətir</FbActionButton></div>
                </DrawerSection>
                <DrawerSection title="Metric tipi">
                  <div className="flex flex-wrap gap-2">
                    {(['message', 'lead', 'purchase'] as MetricType[]).map((m) => (
                      <button key={m} type="button" onClick={() => setFbMetric(m)} className={cn('rounded-xl border px-3 py-2 text-sm font-semibold transition-colors', fbMetric === m ? 'border-blue-500/30 bg-blue-600/15 text-blue-200' : 'border-slate-700 bg-slate-900/50 text-slate-300 hover:bg-slate-800')}>
                        {metricLabel(m)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-slate-500">Bu seçim əsas paneldən görünmür. Yalnız hansı nəticə tipinin hesablanacağını idarə edir.</div>
                </DrawerSection>
                <DrawerSection title="2. Reklam hesabları" right={<SearchInline value={accSearch} onChange={setAccSearch} />}>
                  <div className="space-y-2 max-h-[260px] overflow-auto pr-1">
                    {fbFilteredAccounts.length === 0 ? <EmptyHint text="Token ilə hesabları gətirdikdən sonra burada görünəcək." compact /> : fbFilteredAccounts.map((a) => (
                      <SelectableCard key={a.api_id || a.id} checked={fbSelAccIds.includes(a.account_id) || fbSelAccIds.includes(a.id) || fbSelAccIds.includes(a.api_id)} title={a.name} subtitle={a.account_id} meta={[a.currency || '', a.timezone_name || '', statusLabel(a.account_status)]} onClick={() => toggleFbAccount(a.account_id || a.id)} tone="blue" />
                    ))}
                  </div>
                </DrawerSection>
                <DrawerSection title="3. Kampaniyalar" right={<SearchInline value={campSearch} onChange={setCampSearch} />}>
                  <div className="mb-3 flex flex-wrap gap-2"><FbActionButton onClick={handleFbFetchCampaigns} busy={busyFbCampaigns} icon={<FolderSync className="w-4 h-4" />} disabled={fbSelAccIds.length === 0}>Kampaniyaları gətir</FbActionButton></div>
                  <div className="space-y-4 max-h-[360px] overflow-auto pr-1">
                    {fbCampaigns.length === 0 ? <EmptyHint text="Əvvəl hesab seçib kampaniyaları gətir." compact /> : fbSelAccounts.map((a) => {
                      const rows = fbCampaignsByAccount.get(a.account_id) || [];
                      if (rows.length === 0) return null;
                      const allSelected = rows.every((r) => fbSelCampIds.includes(r.id));
                      return (
                        <div key={a.account_id} className="rounded-2xl border border-slate-800 bg-slate-950/25 overflow-hidden">
                          <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between gap-3">
                            <div><div className="text-sm font-semibold text-slate-100">{a.name}</div><div className="text-[11px] text-slate-500">{rows.length} kampaniya</div></div>
                            <button type="button" onClick={() => { const ids = rows.map((r) => r.id); setFbSelCampIds((prev) => allSelected ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))); }} className="text-xs font-semibold text-blue-200 hover:text-white">{allSelected ? 'Hamısını sil' : 'Hamısını seç'}</button>
                          </div>
                          <div className="divide-y divide-slate-800/60">
                            {rows.map((c) => <SelectableCard key={c.id} checked={fbSelCampIds.includes(c.id)} title={c.name} subtitle={c.objective || c.status || ''} meta={[c.effective_status?.[0] || '', c.status || '']} onClick={() => toggleFbCampaign(c.id)} tone="violet" compact />)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </DrawerSection>
                <DrawerSection title="4. Avtomatik import cache">
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <button type="button" onClick={() => setFbAutoSync((p) => ({ ...p, mode: 'manual', enabled: false }))} className={cn('rounded-2xl border px-4 py-4 text-left transition-colors', fbAutoSync.mode === 'manual' ? 'border-blue-500/40 bg-blue-500/10' : 'border-slate-800 bg-slate-950/30 hover:border-slate-700')}>
                        <div className="text-sm font-semibold text-slate-100">Manual</div>
                        <div className="mt-1 text-xs text-slate-500">Yalnız `İndi Sync` etdikdə Facebook-dan çəkəcək. Saatbasaat avtomatik işləməyəcək.</div>
                      </button>
                      <button type="button" onClick={() => setFbAutoSync((p) => ({ ...p, mode: 'automatic', enabled: true, endDate: '' }))} className={cn('rounded-2xl border px-4 py-4 text-left transition-colors', fbAutoSync.mode === 'automatic' ? 'border-blue-500/40 bg-blue-500/10' : 'border-slate-800 bg-slate-950/30 hover:border-slate-700')}>
                        <div className="text-sm font-semibold text-slate-100">Avtomatik</div>
                        <div className="mt-1 text-xs text-slate-500">Server seçilən tarix aralığı üçün hər saat cache-i yeniləyəcək.</div>
                      </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Başlanğıc tarixi</div><FbDateField value={fbAutoSync.startDate} onChange={(v) => setFbAutoSync((p) => ({ ...p, startDate: v }))} /></div>
                      <div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bitiş tarixi</div><FbDateField value={fbAutoSync.endDate} disabled={fbAutoSync.mode === 'automatic'} onChange={(v) => setFbAutoSync((p) => ({ ...p, endDate: v }))} /><div className="mt-2 text-[11px] text-slate-500">Avtomatik rejimdə hər zaman bugünə qədər.</div></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Hər neçə saatdan bir</div><input type="number" min={1} max={24} value={fbAutoSync.everyHours} disabled={fbAutoSync.mode !== 'automatic'} onChange={(e) => setFbAutoSync((p) => ({ ...p, everyHours: Math.max(1, Number(e.target.value || 1)) }))} className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-40" /></label>
                      <label className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Saatdakı dəqiqə</div><input type="number" min={0} max={59} value={fbAutoSync.minute} disabled={fbAutoSync.mode !== 'automatic'} onChange={(e) => setFbAutoSync((p) => ({ ...p, minute: Math.min(59, Math.max(0, Number(e.target.value || 0))) }))} className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-40" /></label>
                    </div>
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-xs text-slate-400 space-y-1">
                      <div>Son cache sync: <span className="text-slate-200 font-semibold">{fbSaved.autoSync.lastInsightSyncAt ? new Date(fbSaved.autoSync.lastInsightSyncAt).toLocaleString('az-AZ') : 'Yoxdur'}</span></div>
                      <div>Növbəti sync: <span className="text-slate-200 font-semibold">{fbSaved.autoSync.mode === 'automatic' ? (fbSaved.autoSync.nextAt ? new Date(fbSaved.autoSync.nextAt).toLocaleString('az-AZ') : 'Təyin edilməyib') : 'Manual rejimdə deaktivdir'}</span></div>
                      {fbSaved.autoSync.lastInsightSyncError ? <div className="text-rose-300">Son xəta: {fbSaved.autoSync.lastInsightSyncError}</div> : null}
                    </div>
                  </div>
                </DrawerSection>
              </div>
              <div className="px-5 py-4 border-t border-slate-800 bg-slate-950/40 flex items-center justify-between gap-3">
                <div className="text-sm text-slate-500 flex-1">Secilən hesab və kampaniyalar saxlanandan sonra dəyərlər görünəcək.</div>
                <FbActionButton onClick={handleFbSave} busy={busyFbSave} icon={<Save className="w-4 h-4" />} disabled={fbSelAccIds.length === 0}>Ayarları saxla</FbActionButton>
              </div>
            </div>
          </div>
        ) : null
      }

      {
        fbMsg ? (
          <div className="fixed bottom-4 right-4 z-50 rounded-2xl border border-slate-800 bg-slate-900/90 backdrop-blur-md px-6 py-4 shadow-2xl flex items-center justify-between gap-4 max-w-sm w-full">
            <div className="text-sm font-medium text-slate-200">{fbMsg}</div>
            <button onClick={() => setFbMsg('')} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        ) : null
      }

    </div >
  );
}
