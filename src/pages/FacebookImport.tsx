import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  Download,
  Filter,
  FolderSync,
  Loader2,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { useAppStore } from '../context/Store';
import { cn } from '../lib/utils';

type AdAccount = {
  id: string;
  api_id: string;
  account_id: string;
  name: string;
  account_status: number | null;
  currency: string | null;
  timezone_name: string | null;
  timezone_offset_hours_utc: number | null;
  business_name: string | null;
  business_id: string | null;
};

type Campaign = {
  id: string;
  account_id: string;
  account_api_id: string;
  account_name: string | null;
  name: string;
  status: string | null;
  effective_status: string[];
  objective: string | null;
  updated_time: string | null;
};

type InsightMetric = {
  spend: number;
  impressions?: number;
  clicks?: number;
  ctr: number;
  cpm: number;
  results: number;
  cost_per_result: number;
};

type InsightCampaign = Campaign & {
  metrics: InsightMetric;
  daily: Array<InsightMetric & { date_start: string | null; date_stop: string | null }>;
};

type InsightsPayload = {
  summary: InsightMetric;
  daily: Array<InsightMetric & { date: string }>;
  campaigns: InsightCampaign[];
  selectedCampaignIds: string[];
  metric?: 'message' | 'lead' | 'purchase';
  range: { start: string | null; end: string | null };
  cache?: { lastSyncAt: string | null; lastSyncError: string | null };
};

type SavedConfig = {
  hasToken: boolean;
  tokenHint: string | null;
  selectedAccountIds: string[];
  selectedCampaignIds: string[];
  selectedAccounts: AdAccount[];
  selectedCampaigns: Campaign[];
  accountCache: AdAccount[];
  campaignCache: Campaign[];
  autoSync: {
    mode: 'manual' | 'automatic';
    enabled: boolean;
    startDate: string;
    endDate: string;
    everyHours: number;
    minute: number;
    nextAt: string | null;
    lastInsightSyncAt: string | null;
    lastInsightSyncError: string | null;
  };
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

type MetricType = 'message' | 'lead' | 'purchase';
type PresetType = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom';
type SortType = 'spend_desc' | 'results_desc' | 'cost_per_result_asc' | 'ctr_desc' | 'name_asc';

const EMPTY_CONFIG: SavedConfig = {
  hasToken: false,
  tokenHint: null,
  selectedAccountIds: [],
  selectedCampaignIds: [],
  selectedAccounts: [],
  selectedCampaigns: [],
  accountCache: [],
  campaignCache: [],
  autoSync: {
    mode: 'manual',
    enabled: false,
    startDate: '',
    endDate: '',
    everyHours: 1,
    minute: 0,
    nextAt: null,
    lastInsightSyncAt: null,
    lastInsightSyncError: null,
  },
  lastSyncAt: null,
  lastError: null,
  updatedAt: null,
};

const EMPTY_INSIGHTS: InsightsPayload = {
  summary: { spend: 0, ctr: 0, cpm: 0, results: 0, cost_per_result: 0, impressions: 0, clicks: 0 },
  daily: [],
  campaigns: [],
  selectedCampaignIds: [],
  metric: 'message',
  range: { start: null, end: null },
  cache: { lastSyncAt: null, lastSyncError: null },
};

function formatMoney(v: number) {
  return `$${Number(v || 0).toFixed(2)}`;
}

function formatNum(v: number) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : '0';
}

function formatPct(v: number) {
  return `${Number(v || 0).toFixed(2)}%`;
}

function toLocalISO(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLabel(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('az-AZ', { day: 'numeric', month: 'long', year: 'numeric' });
}

function statusLabel(code: number | null) {
  if (code === 1) return 'Aktiv';
  if (code === 2) return 'Disabled';
  if (code === 3) return 'Unsettled';
  if (code === 7) return 'Pending Review';
  if (code === 8) return 'Pending Closure';
  if (code === 9) return 'Closed';
  if (code === 100) return 'Archived';
  return 'Unknown';
}

function metricLabel(metric: MetricType) {
  if (metric === 'lead') return 'Lead';
  if (metric === 'purchase') return 'Purchase';
  return 'Mesaj';
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
    start.setDate(start.getDate() - 1);
    const iso = toLocalISO(start);
    return { start: iso, end: iso };
  }

  if (preset === '7d') start.setDate(end.getDate() - 6);
  if (preset === '30d') start.setDate(end.getDate() - 29);
  return { start: toLocalISO(start), end: toLocalISO(end) };
}

export default function FacebookImportPage() {
  const { currentUser } = useAppStore();
  const token = localStorage.getItem('crm_auth_token') || '';

  const [saved, setSaved] = useState<SavedConfig>(EMPTY_CONFIG);
  const [insights, setInsights] = useState<InsightsPayload>(EMPTY_INSIGHTS);
  const [tokenInput, setTokenInput] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [campaignSearch, setCampaignSearch] = useState('');
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([]);
  const [busyFetchAccounts, setBusyFetchAccounts] = useState(false);
  const [busyFetchCampaigns, setBusyFetchCampaigns] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [busyRefresh, setBusyRefresh] = useState(false);
  const [busyInsights, setBusyInsights] = useState(false);
  const [busySyncNow, setBusySyncNow] = useState(false);
  const [message, setMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [metric, setMetric] = useState<MetricType>('message');
  const [activePreset, setActivePreset] = useState<PresetType>('all');
  const [sortBy, setSortBy] = useState<SortType>('spend_desc');
  const [autoSync, setAutoSync] = useState(EMPTY_CONFIG.autoSync);

  const selectedAccounts = useMemo(
    () => accounts.filter((a) => selectedAccountIds.includes(a.account_id) || selectedAccountIds.includes(a.id) || selectedAccountIds.includes(a.api_id)),
    [accounts, selectedAccountIds]
  );

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => [a.name, a.account_id, a.business_name, a.currency, a.timezone_name].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [accounts, accountSearch]);

  const filteredCampaigns = useMemo(() => {
    const q = campaignSearch.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (!selectedAccountIds.includes(c.account_id)) return false;
      if (!q) return true;
      return [c.name, c.account_name, c.objective, ...(c.effective_status || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [campaigns, campaignSearch, selectedAccountIds]);

  const campaignsByAccount = useMemo(() => {
    const map = new Map<string, Campaign[]>();
    for (const c of filteredCampaigns) {
      const arr = map.get(c.account_id) || [];
      arr.push(c);
      map.set(c.account_id, arr);
    }
    return map;
  }, [filteredCampaigns]);

  const sortedCampaigns = useMemo(() => {
    const rows = [...insights.campaigns].filter((campaign) => {
      const q = campaignSearch.trim().toLowerCase();
      if (!q) return true;
      return [campaign.name, campaign.account_name, campaign.objective, campaign.status].filter(Boolean).join(' ').toLowerCase().includes(q);
    });

    rows.sort((a, b) => {
      switch (sortBy) {
        case 'results_desc':
          return b.metrics.results - a.metrics.results;
        case 'cost_per_result_asc':
          return a.metrics.cost_per_result - b.metrics.cost_per_result;
        case 'ctr_desc':
          return b.metrics.ctr - a.metrics.ctr;
        case 'name_asc':
          return a.name.localeCompare(b.name);
        case 'spend_desc':
        default:
          return b.metrics.spend - a.metrics.spend;
      }
    });

    return rows;
  }, [insights.campaigns, campaignSearch, sortBy]);

  const rangeLabel = useMemo(() => {
    if (!dateRange.start && !dateRange.end) return 'Tum zamanlar';
    return `${formatDateLabel(dateRange.start)} - ${formatDateLabel(dateRange.end)}`;
  }, [dateRange]);

  const loadConfig = useCallback(async () => {
    const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/config`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Facebook config yuklenmedi');
    const cfg = { ...EMPTY_CONFIG, ...(data || {}) } as SavedConfig;
    setSaved(cfg);
    setAccounts(cfg.accountCache || []);
    setCampaigns(cfg.campaignCache || []);
    setSelectedAccountIds(cfg.selectedAccountIds || []);
    setSelectedCampaignIds(cfg.selectedCampaignIds || []);
    setAutoSync({ ...EMPTY_CONFIG.autoSync, ...(cfg.autoSync || {}) });
    return cfg;
  }, [token]);

  const loadInsights = async (range = dateRange, metricType = metric) => {
    setBusyInsights(true);
    try {
      const params = new URLSearchParams();
      if (range.start) params.set('start', range.start);
      if (range.end) params.set('end', range.end);
      params.set('metric', metricType);
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/insights?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Insights alina bilmedi');
      setInsights({ ...EMPTY_INSIGHTS, ...(data || {}) });
      setMetric((data?.metric || metricType || 'message') as MetricType);
    } catch (e: any) {
      setInsights(EMPTY_INSIGHTS);
      setMessage(e?.message || 'Insights xetasi');
    } finally {
      setBusyInsights(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await loadConfig();
      } catch (e: any) {
        setMessage(e?.message || 'Facebook config oxunmadi');
      }
    })();
  }, [loadConfig]);

  const toggleAccount = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const next = prev.includes(accountId) ? prev.filter((x) => x !== accountId) : [...prev, accountId];
      setSelectedCampaignIds((cur) => cur.filter((id) => {
        const campaign = campaigns.find((c) => c.id === id);
        return campaign ? next.includes(campaign.account_id) : true;
      }));
      return next;
    });
  };

  const toggleCampaign = (campaignId: string) => {
    setSelectedCampaignIds((prev) => prev.includes(campaignId) ? prev.filter((x) => x !== campaignId) : [...prev, campaignId]);
  };

  const handleFetchAccounts = async () => {
    if (!tokenInput.trim()) return setMessage('Facebook token daxil edin.');
    setBusyFetchAccounts(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: tokenInput.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Hesablar alina bilmedi');
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setCampaigns([]);
      setSelectedCampaignIds([]);
      setMessage(`${Array.isArray(data.accounts) ? data.accounts.length : 0} hesab tapildi.`);
    } catch (e: any) {
      setMessage(e?.message || 'Hesab getirme xetasi');
    } finally {
      setBusyFetchAccounts(false);
    }
  };

  const handleFetchCampaigns = async () => {
    if (selectedAccountIds.length === 0) return setMessage('Evvel hesab secin.');
    setBusyFetchCampaigns(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: tokenInput.trim() || undefined, accountIds: selectedAccountIds, accounts })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kampaniyalar alina bilmedi');
      const next = Array.isArray(data.campaigns) ? data.campaigns : [];
      setCampaigns(next);
      setSelectedCampaignIds((prev) => prev.filter((id) => next.some((c: Campaign) => c.id === id)));
      setMessage(`${next.length} kampaniya tapildi.`);
    } catch (e: any) {
      setMessage(e?.message || 'Kampaniya getirme xetasi');
    } finally {
      setBusyFetchCampaigns(false);
    }
  };

  const handleSave = async () => {
    if (selectedAccountIds.length === 0) return setMessage('En azi bir hesab secin.');
    setBusySave(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          token: tokenInput.trim() || undefined,
          accounts,
          campaigns,
          selectedAccountIds,
          selectedCampaignIds,
          autoSync,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save xetasi');
      const cfg = { ...EMPTY_CONFIG, ...(data.config || {}) } as SavedConfig;
      setSaved(cfg);
      setAccounts(cfg.accountCache);
      setCampaigns(cfg.campaignCache);
      setSelectedAccountIds(cfg.selectedAccountIds);
      setSelectedCampaignIds(cfg.selectedCampaignIds);
      setAutoSync({ ...EMPTY_CONFIG.autoSync, ...(cfg.autoSync || {}) });
      setTokenInput('');
      setMessage('Facebook ayarlari saxlanildi.');
      setShowSettings(false);
    } catch (e: any) {
      setMessage(e?.message || 'Save xetasi');
    } finally {
      setBusySave(false);
    }
  };

  const handleRefreshSaved = async () => {
    setBusyRefresh(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Yadda qalan token refresh alinmadi');
      const cfg = { ...EMPTY_CONFIG, ...(data.config || {}) } as SavedConfig;
      setSaved(cfg);
      setAccounts(cfg.accountCache);
      setCampaigns(cfg.campaignCache);
      setSelectedAccountIds(cfg.selectedAccountIds);
      setSelectedCampaignIds(cfg.selectedCampaignIds);
      setAutoSync({ ...EMPTY_CONFIG.autoSync, ...(cfg.autoSync || {}) });
      setMessage('Facebook cache yenilendi.');
    } catch (e: any) {
      setMessage(e?.message || 'Refresh xetasi');
    } finally {
      setBusyRefresh(false);
    }
  };

  const handleSyncNow = async () => {
    setBusySyncNow(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync xetasi');
      const cfg = { ...EMPTY_CONFIG, ...(data.config || {}) } as SavedConfig;
      setSaved(cfg);
      setAutoSync({ ...EMPTY_CONFIG.autoSync, ...(cfg.autoSync || {}) });
      setMessage('Facebook insight cache yeniləndi.');
      await loadInsights(dateRange, metric);
    } catch (e: any) {
      setMessage(e?.message || 'Sync xetasi');
    } finally {
      setBusySyncNow(false);
    }
  };

  const applyDateFilter = async () => {
    if ((dateRange.start && !dateRange.end) || (!dateRange.start && dateRange.end)) {
      setMessage('Tarix filterinde hem start, hem end secilmelidir.');
      return;
    }
    setActivePreset(dateRange.start || dateRange.end ? 'custom' : 'all');
    await loadInsights(dateRange, metric);
  };

  const applyPreset = async (preset: Exclude<PresetType, 'custom'>) => {
    const next = buildPresetRange(preset);
    setActivePreset(preset);
    setDateRange(next);
    // only set the range; fetch happens on manual update
  };

  const handleMetricChange = (nextMetric: MetricType) => {
    setMetric(nextMetric);
  };

  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    return (
      <div className="p-8">
        <div className="max-w-xl rounded-3xl border border-rose-500/20 bg-rose-500/10 p-6 text-rose-200">
          <ShieldAlert className="w-5 h-5 mb-3" /> Bu sehife yalniz admin istifadeciler ucundur.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/35 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-200">
              <BarChart3 className="w-3.5 h-3.5" /> Facebook Ads
            </div>
            <h1 className="mt-3 text-3xl font-bold text-slate-100">Kampaniya performansi</h1>
            <p className="mt-1 text-sm text-slate-500">Secilmis kampaniyalar uzre yekun performans ve kampaniya setirleri.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <HeaderBadge label="Range" value={rangeLabel} />
            <HeaderBadge label="Campaigns" value={String(selectedCampaignIds.length)} />
            <HeaderBadge label="Sync Mode" value={autoSync.mode === 'automatic' ? `Auto · her ${autoSync.everyHours}s` : 'Manual'} />
            <HeaderBadge label="Cache" value={saved.autoSync.lastInsightSyncAt ? formatDateLabel(String(saved.autoSync.lastInsightSyncAt).slice(0, 10)) : 'Bos'} />
            <ActionButton variant="secondary" onClick={() => setShowSettings(true)} icon={<Settings2 className="w-4 h-4" />}>
              Ayarlar
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleRefreshSaved} busy={busyRefresh} icon={<RefreshCcw className="w-4 h-4" />} disabled={!saved.hasToken}>
              Yenile
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleSyncNow} busy={busySyncNow} icon={<FolderSync className="w-4 h-4" />} disabled={!saved.hasToken || selectedCampaignIds.length === 0}>
              Indi Sync
            </ActionButton>
          </div>
        </div>

        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/30 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <span>Metric:</span>
            <span className="rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2 font-semibold text-slate-200">{metricLabel(metric)}</span>
            <span className="text-xs text-slate-500">Bu panel Facebook API-ni hər baxışda çağırmır; DB cache-dən oxuyur.</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {([
              ['today', 'Bugun'],
              ['yesterday', 'Dun'],
              ['7d', 'Son 7 gun'],
              ['30d', 'Son 30 gun'],
              ['all', 'Tum zamanlar'],
            ] as Array<[Exclude<PresetType, 'custom'>, string]>).map(([preset, label]) => (
              <button
                key={preset}
                type="button"
                onClick={() => applyPreset(preset)}
                className={cn(
                  'rounded-xl border px-3 py-2 text-sm font-semibold transition-colors',
                  activePreset === preset
                    ? 'border-slate-200 bg-slate-100 text-slate-950'
                    : 'border-slate-700 bg-slate-900/50 text-slate-300 hover:bg-slate-800'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/20 flex flex-wrap items-center gap-2">
          <DateField value={dateRange.start} onChange={(v) => { setDateRange((p) => ({ ...p, start: v })); setActivePreset('custom'); }} />
          <span className="text-slate-500 text-sm">-</span>
          <DateField value={dateRange.end} onChange={(v) => { setDateRange((p) => ({ ...p, end: v })); setActivePreset('custom'); }} />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortType)}
            className="rounded-xl border border-slate-800 bg-slate-950/35 px-3 py-2 text-sm text-slate-200 outline-none"
            title="Sort by"
          >
            <option value="spend_desc">Sort: Spend high-low</option>
            <option value="results_desc">Sort: Results high-low</option>
            <option value="cost_per_result_asc">Sort: Cost/result low-high</option>
            <option value="ctr_desc">Sort: CTR high-low</option>
            <option value="name_asc">Sort: Name A-Z</option>
          </select>
          <ActionButton onClick={applyDateFilter} busy={busyInsights} icon={<Filter className="w-4 h-4" />} disabled={selectedCampaignIds.length === 0}>
            Cache-ni goster
          </ActionButton>
        </div>

        <div className="p-5 grid grid-cols-2 xl:grid-cols-5 gap-4">
          <MetricCard label="Harcanan Tutar" value={formatMoney(insights.summary.spend)} />
          <MetricCard label="Sonuclar" value={formatNum(insights.summary.results)} />
          <MetricCard label="Sonuc basina ucret" value={formatMoney(insights.summary.cost_per_result)} />
          <MetricCard label="CPM" value={formatMoney(insights.summary.cpm)} />
          <MetricCard label="CTR" value={formatPct(insights.summary.ctr)} />
        </div>
      </section>

      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/35 flex items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-slate-100">Kampaniya cedveli</div>
            <div className="text-sm text-slate-500">Facebook Ads Manager uslubunda yekun setirler</div>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-500" />
            <input
              value={campaignSearch}
              onChange={(e) => setCampaignSearch(e.target.value)}
              placeholder="Kampaniya axtar..."
              className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600 w-full"
            />
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Kampaniya</th>
                <th className="px-4 py-3 text-left">Yayin durumu</th>
                <th className="px-4 py-3 text-right">{metricLabel(metric)}</th>
                <th className="px-4 py-3 text-right">Sonuc basina ucret</th>
                <th className="px-4 py-3 text-right">Harcanan Tutar</th>
                <th className="px-4 py-3 text-right">CPM</th>
                <th className="px-4 py-3 text-right">CTR</th>
                <th className="px-4 py-3 text-left">Hesab</th>
              </tr>
            </thead>
            <tbody>
              {sortedCampaigns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-slate-500">Secilmis kampaniyalar ucun data gorunmur. Ayarlardan kampaniya secib sonra tarix filtrini tetbiq et.</td>
                </tr>
              ) : sortedCampaigns.map((campaign, idx) => (
                <tr key={campaign.id} className={cn('border-t border-slate-800/60', idx % 2 === 0 ? 'bg-slate-900/20' : 'bg-slate-950/10')}>
                  <td className="px-4 py-4 align-top min-w-[320px]">
                    <div className="font-semibold text-slate-100">{campaign.name}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      {campaign.objective ? <Tag>{campaign.objective}</Tag> : null}
                      {campaign.effective_status?.[0] ? <Tag>{campaign.effective_status[0]}</Tag> : null}
                    </div>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <StatusCell status={campaign.status || campaign.effective_status?.[0] || 'Unknown'} />
                  </td>
                  <td className="px-4 py-4 align-top text-right font-semibold text-slate-100">{formatNum(campaign.metrics.results)}</td>
                  <td className="px-4 py-4 align-top text-right text-slate-200">{formatMoney(campaign.metrics.cost_per_result)}</td>
                  <td className="px-4 py-4 align-top text-right text-slate-200">{formatMoney(campaign.metrics.spend)}</td>
                  <td className="px-4 py-4 align-top text-right text-slate-200">{formatMoney(campaign.metrics.cpm)}</td>
                  <td className="px-4 py-4 align-top text-right text-slate-200">{formatPct(campaign.metrics.ctr)}</td>
                  <td className="px-4 py-4 align-top text-slate-300">{campaign.account_name || '-'}</td>
                </tr>
              ))}
            </tbody>
            {sortedCampaigns.length > 0 ? (
              <tfoot className="border-t border-slate-800 bg-slate-950/50">
                <tr className="text-sm font-semibold text-slate-100">
                  <td className="px-4 py-4">{sortedCampaigns.length} kampaniyadan netice</td>
                  <td className="px-4 py-4 text-slate-400">Toplam</td>
                  <td className="px-4 py-4 text-right">{formatNum(insights.summary.results)}</td>
                  <td className="px-4 py-4 text-right">{formatMoney(insights.summary.cost_per_result)}</td>
                  <td className="px-4 py-4 text-right">{formatMoney(insights.summary.spend)}</td>
                  <td className="px-4 py-4 text-right">{formatMoney(insights.summary.cpm)}</td>
                  <td className="px-4 py-4 text-right">{formatPct(insights.summary.ctr)}</td>
                  <td className="px-4 py-4" />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      {showSettings ? (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex justify-end">
          <div className="h-full w-full max-w-[720px] border-l border-slate-800 bg-slate-900 shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-slate-100">Facebook ayarlari</div>
                <div className="text-sm text-slate-500">Token, hesab ve kampaniya secimi</div>
              </div>
              <button onClick={() => setShowSettings(false)} className="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-5 space-y-5">
              <DrawerSection title="1. Token">
                <textarea
                  rows={5}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="EAAB... token buraya"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton onClick={handleFetchAccounts} busy={busyFetchAccounts} icon={<Download className="w-4 h-4" />}>
                    Hesablari getir
                  </ActionButton>
                </div>
              </DrawerSection>

              <DrawerSection title="Metric tipi">
                <div className="flex flex-wrap gap-2">
                  {(['message', 'lead', 'purchase'] as MetricType[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleMetricChange(m)}
                      className={cn(
                        'rounded-xl border px-3 py-2 text-sm font-semibold transition-colors',
                        metric === m
                          ? 'border-blue-500/30 bg-blue-600/15 text-blue-200'
                          : 'border-slate-700 bg-slate-900/50 text-slate-300 hover:bg-slate-800'
                      )}
                    >
                      {metricLabel(m)}
                    </button>
                  ))}
                </div>
                <div className="mt-3 text-xs text-slate-500">Bu secim ana panelde gorunmur. Yalniz hansı netice tipinin hesablanacagini idare edir.</div>
              </DrawerSection>

              <DrawerSection title="2. Reklam hesablari" right={<SearchInline value={accountSearch} onChange={setAccountSearch} />}>
                <div className="space-y-2 max-h-[260px] overflow-auto pr-1">
                  {filteredAccounts.length === 0 ? <EmptyHint text="Token ile hesablari getirdikden sonra burada gorunecek." compact /> : filteredAccounts.map((account) => (
                    <SelectableCard
                      key={account.api_id || account.id}
                      checked={selectedAccountIds.includes(account.account_id) || selectedAccountIds.includes(account.id) || selectedAccountIds.includes(account.api_id)}
                      title={account.name}
                      subtitle={account.account_id}
                      meta={[account.currency || '', account.timezone_name || '', statusLabel(account.account_status)]}
                      onClick={() => toggleAccount(account.account_id || account.id)}
                      tone="blue"
                    />
                  ))}
                </div>
              </DrawerSection>

              <DrawerSection title="3. Kampaniyalar" right={<SearchInline value={campaignSearch} onChange={setCampaignSearch} />}>
                <div className="mb-3 flex flex-wrap gap-2">
                  <ActionButton onClick={handleFetchCampaigns} busy={busyFetchCampaigns} icon={<FolderSync className="w-4 h-4" />} disabled={selectedAccountIds.length === 0}>
                    Kampaniyalari getir
                  </ActionButton>
                </div>
                <div className="space-y-4 max-h-[360px] overflow-auto pr-1">
                  {campaigns.length === 0 ? <EmptyHint text="Evvel hesab secib kampaniyalari getir." compact /> : selectedAccounts.map((account) => {
                    const rows = campaignsByAccount.get(account.account_id) || [];
                    if (rows.length === 0) return null;
                    const allSelected = rows.every((r) => selectedCampaignIds.includes(r.id));
                    return (
                      <div key={account.account_id} className="rounded-2xl border border-slate-800 bg-slate-950/25 overflow-hidden">
                        <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-100">{account.name}</div>
                            <div className="text-[11px] text-slate-500">{rows.length} kampaniya</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const ids = rows.map((r) => r.id);
                              setSelectedCampaignIds((prev) => allSelected ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids])));
                            }}
                            className="text-xs font-semibold text-blue-200 hover:text-white"
                          >
                            {allSelected ? 'Hamisini sil' : 'Hamisini sec'}
                          </button>
                        </div>
                        <div className="divide-y divide-slate-800/60">
                          {rows.map((campaign) => (
                            <SelectableCard
                              key={campaign.id}
                              checked={selectedCampaignIds.includes(campaign.id)}
                              title={campaign.name}
                              subtitle={campaign.objective || campaign.status || ''}
                              meta={[campaign.effective_status?.[0] || '', campaign.status || '']}
                              onClick={() => toggleCampaign(campaign.id)}
                              tone="violet"
                              compact
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </DrawerSection>

              <DrawerSection title="4. Avtomatik import cache">
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setAutoSync((prev) => ({ ...prev, mode: 'manual', enabled: false }))}
                      className={cn(
                        'rounded-2xl border px-4 py-4 text-left transition-colors',
                        autoSync.mode === 'manual'
                          ? 'border-blue-500/40 bg-blue-500/10'
                          : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'
                      )}
                    >
                      <div className="text-sm font-semibold text-slate-100">Manual</div>
                      <div className="mt-1 text-xs text-slate-500">Yalnız sən `İndi Sync` etdikdə Facebook-dan çəkəcək. Saxlanandan sonra saatbasaat avtomatik işləməyəcək.</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAutoSync((prev) => ({ ...prev, mode: 'automatic', enabled: true }))}
                      className={cn(
                        'rounded-2xl border px-4 py-4 text-left transition-colors',
                        autoSync.mode === 'automatic'
                          ? 'border-blue-500/40 bg-blue-500/10'
                          : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'
                      )}
                    >
                      <div className="text-sm font-semibold text-slate-100">Avtomatik</div>
                      <div className="mt-1 text-xs text-slate-500">Server seçilən tarix aralığı üçün hər saat cache-i yeniləyəcək və DB-yə yazacaq.</div>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Baslangic tarixi</div>
                      <DateField value={autoSync.startDate} onChange={(v) => setAutoSync((prev) => ({ ...prev, startDate: v }))} />
                    </div>
                    <div>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bitis tarixi</div>
                      <DateField value={autoSync.endDate} onChange={(v) => setAutoSync((prev) => ({ ...prev, endDate: v }))} />
                      <div className="mt-2 text-[11px] text-slate-500">Bos qalsa sistem her sync zamani bugune qeder hesaplayacaq.</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Her nece saatdan bir</div>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={autoSync.everyHours}
                        disabled={autoSync.mode !== 'automatic'}
                        onChange={(e) => setAutoSync((prev) => ({ ...prev, everyHours: Math.max(1, Number(e.target.value || 1)) }))}
                        className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-40"
                      />
                    </label>
                    <label className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Saatdaki deqiqe</div>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={autoSync.minute}
                        disabled={autoSync.mode !== 'automatic'}
                        onChange={(e) => setAutoSync((prev) => ({ ...prev, minute: Math.min(59, Math.max(0, Number(e.target.value || 0))) }))}
                        className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-40"
                      />
                    </label>
                  </div>

                  <div className="rounded-2xl border border-slate-800 bg-slate-950/30 px-4 py-3 text-xs text-slate-400 space-y-1">
                    <div>Son cache sync: <span className="text-slate-200 font-semibold">{saved.autoSync.lastInsightSyncAt ? new Date(saved.autoSync.lastInsightSyncAt).toLocaleString('az-AZ') : 'Yoxdur'}</span></div>
                    <div>Növbəti sync: <span className="text-slate-200 font-semibold">{saved.autoSync.mode === 'automatic' ? (saved.autoSync.nextAt ? new Date(saved.autoSync.nextAt).toLocaleString('az-AZ') : 'Təyin edilməyib') : 'Manual rejimdə deaktivdir'}</span></div>
                    {saved.autoSync.lastInsightSyncError ? <div className="text-rose-300">Son xəta: {saved.autoSync.lastInsightSyncError}</div> : null}
                  </div>
                </div>
              </DrawerSection>
            </div>

            <div className="px-5 py-4 border-t border-slate-800 bg-slate-950/40 flex items-center justify-between gap-3">
              <div className="text-sm text-slate-500">Secilen hesab ve kampaniyalar saxlanandan sonra ana panelde datalar gorunecek.</div>
              <ActionButton onClick={handleSave} busy={busySave} icon={<Save className="w-4 h-4" />} disabled={selectedAccountIds.length === 0}>
                Ayarlari saxla
              </ActionButton>
            </div>
          </div>
        </div>
      ) : null}

      {message ? <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">{message}</div> : null}
    </div>
  );
}

function HeaderBadge({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/25 px-4 py-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-3 text-3xl font-bold text-slate-100">{value}</div>
    </div>
  );
}

function StatusCell({ status }: { status: string }) {
  const active = /active/i.test(status);
  return (
    <span className={cn(
      'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold',
      active ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-slate-700 bg-slate-900/50 text-slate-300'
    )}>
      <span className={cn('w-2 h-2 rounded-full', active ? 'bg-emerald-400' : 'bg-slate-500')} />
      {status}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{children}</span>;
}

function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/35 px-3 py-2 text-sm text-slate-300">
      <Calendar className="w-4 h-4 text-slate-500" />
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent outline-none text-slate-100" />
    </label>
  );
}

function ActionButton({ children, onClick, busy, icon, disabled, variant = 'primary' }: { children: React.ReactNode; onClick: () => void; busy?: boolean; icon?: React.ReactNode; disabled?: boolean; variant?: 'primary' | 'secondary' }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={cn(
        'inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60',
        variant === 'primary'
          ? 'bg-blue-600 hover:bg-blue-500 text-white'
          : 'border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200'
      )}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

function DrawerSection({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-950/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/35 flex items-center justify-between gap-3">
        <div className="text-base font-semibold text-slate-100">{title}</div>
        <div>{right}</div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function SearchInline({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 min-w-[220px]">
      <Search className="w-4 h-4 text-slate-500" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Axtar..." className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600 w-full" />
    </div>
  );
}

function SelectableCard({ title, subtitle, meta, checked, onClick, tone, compact }: { title: string; subtitle?: string; meta?: string[]; checked: boolean; onClick: () => void; tone: 'blue' | 'violet'; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left transition-colors',
        compact ? 'px-4 py-3 hover:bg-slate-900/40' : 'rounded-2xl border px-4 py-3',
        tone === 'blue'
          ? (checked ? 'border-blue-500/30 bg-blue-500/10' : 'border-slate-800 bg-slate-950/30 hover:bg-slate-950/50')
          : (checked ? 'bg-violet-500/10' : 'hover:bg-slate-900/40')
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('w-2 h-2 rounded-full shrink-0', checked ? (tone === 'blue' ? 'bg-blue-400' : 'bg-violet-400') : 'bg-slate-600')} />
            <div className="truncate text-sm font-medium text-slate-100">{title}</div>
          </div>
          {subtitle ? <div className="mt-1 text-[11px] text-slate-500 truncate">{subtitle}</div> : null}
          {meta && meta.filter(Boolean).length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
              {meta.filter(Boolean).map((m, i) => <Tag key={`${m}-${i}`}>{m}</Tag>)}
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
