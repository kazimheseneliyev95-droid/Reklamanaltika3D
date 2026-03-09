import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  Filter,
  FolderSync,
  Loader2,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  WalletCards,
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

type InsightDaily = InsightMetric & { date: string };

type InsightCampaign = Campaign & {
  metrics: InsightMetric;
  daily: Array<InsightMetric & { date_start: string | null; date_stop: string | null }>;
};

type InsightsPayload = {
  summary: InsightMetric;
  daily: InsightDaily[];
  campaigns: InsightCampaign[];
  selectedCampaignIds: string[];
  metric?: 'message' | 'lead' | 'purchase';
  range: { start: string | null; end: string | null };
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
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

const EMPTY_CONFIG: SavedConfig = {
  hasToken: false,
  tokenHint: null,
  selectedAccountIds: [],
  selectedCampaignIds: [],
  selectedAccounts: [],
  selectedCampaigns: [],
  accountCache: [],
  campaignCache: [],
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
};

function toLocalISO(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function metricLabel(metric: string | undefined) {
  if (metric === 'lead') return 'Lead';
  if (metric === 'purchase') return 'Purchase';
  return 'Mesaj';
}

function formatMoney(v: number) {
  return `₼ ${Number(v || 0).toFixed(2)}`;
}

function formatNum(v: number) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : '0';
}

function formatPct(v: number) {
  return `${Number(v || 0).toFixed(2)}%`;
}

function statusLabel(code: number | null) {
  if (code === 1) return 'Active';
  if (code === 2) return 'Disabled';
  if (code === 3) return 'Unsettled';
  if (code === 7) return 'Pending Review';
  if (code === 8) return 'Pending Closure';
  if (code === 9) return 'Closed';
  if (code === 100) return 'Archived';
  return 'Unknown';
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
  const [message, setMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [metric, setMetric] = useState<'message' | 'lead' | 'purchase'>('message');

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

  const loadConfig = async () => {
    const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/config`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Facebook config yüklənmədi');
    const cfg = { ...EMPTY_CONFIG, ...(data || {}) } as SavedConfig;
    setSaved(cfg);
    setAccounts(cfg.accountCache || []);
    setCampaigns(cfg.campaignCache || []);
    setSelectedAccountIds(cfg.selectedAccountIds || []);
    setSelectedCampaignIds(cfg.selectedCampaignIds || []);
    return cfg;
  };

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
      if (!res.ok) throw new Error(data.error || 'Insights alınmadı');
      setInsights({ ...EMPTY_INSIGHTS, ...(data || {}) });
      setMetric((data?.metric || metricType || 'message') as any);
    } catch (e: any) {
      setInsights(EMPTY_INSIGHTS);
      setMessage(e?.message || 'Insights xətası');
    } finally {
      setBusyInsights(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const cfg = await loadConfig();
        if ((cfg.selectedCampaignIds || []).length > 0) {
          await loadInsights({ start: '', end: '' }, 'message');
        }
      } catch (e: any) {
        setMessage(e?.message || 'Facebook config oxunmadı');
      }
    })();
  }, []);

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
      if (!res.ok) throw new Error(data.error || 'Hesablar alınmadı');
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setCampaigns([]);
      setSelectedCampaignIds([]);
      setMessage(`${Array.isArray(data.accounts) ? data.accounts.length : 0} hesab tapıldı.`);
    } catch (e: any) {
      setMessage(e?.message || 'Hesab gətirmə xətası');
    } finally {
      setBusyFetchAccounts(false);
    }
  };

  const handleFetchCampaigns = async () => {
    if (selectedAccountIds.length === 0) return setMessage('Əvvəl hesab seçin.');
    setBusyFetchCampaigns(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: tokenInput.trim() || undefined, accountIds: selectedAccountIds, accounts })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kampaniyalar alınmadı');
      const next = Array.isArray(data.campaigns) ? data.campaigns : [];
      setCampaigns(next);
      setSelectedCampaignIds((prev) => prev.filter((id) => next.some((c) => c.id === id)));
      setMessage(`${next.length} kampaniya tapıldı.`);
    } catch (e: any) {
      setMessage(e?.message || 'Kampaniya gətirmə xətası');
    } finally {
      setBusyFetchCampaigns(false);
    }
  };

  const handleSave = async () => {
    if (selectedAccountIds.length === 0) return setMessage('Ən azı bir hesab seçin.');
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
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save xətası');
      const cfg = { ...EMPTY_CONFIG, ...(data.config || {}) } as SavedConfig;
      setSaved(cfg);
      setAccounts(cfg.accountCache);
      setCampaigns(cfg.campaignCache);
      setSelectedAccountIds(cfg.selectedAccountIds);
      setSelectedCampaignIds(cfg.selectedCampaignIds);
      setShowSettings(false);
      setTokenInput('');
      setMessage('Facebook ayarları saxlanıldı.');
      await loadInsights(dateRange, metric);
    } catch (e: any) {
      setMessage(e?.message || 'Save xətası');
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
      if (!res.ok) throw new Error(data.error || 'Saved token refresh alınmadı');
      const cfg = { ...EMPTY_CONFIG, ...(data.config || {}) } as SavedConfig;
      setSaved(cfg);
      setAccounts(cfg.accountCache);
      setCampaigns(cfg.campaignCache);
      setSelectedAccountIds(cfg.selectedAccountIds);
      setSelectedCampaignIds(cfg.selectedCampaignIds);
      setMessage('Facebook cache yeniləndi.');
      await loadInsights(dateRange, metric);
    } catch (e: any) {
      setMessage(e?.message || 'Refresh xətası');
    } finally {
      setBusyRefresh(false);
    }
  };

  const applyDateFilter = async () => {
    if ((dateRange.start && !dateRange.end) || (!dateRange.start && dateRange.end)) {
      setMessage('Tarix filterində həm start, həm end seçilməlidir.');
      return;
    }
    await loadInsights(dateRange, metric);
  };

  const applyPreset = async (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    const next = { start: toLocalISO(start), end: toLocalISO(end) };
    setDateRange(next);
    await loadInsights(next, metric);
  };

  const handleMetricChange = async (nextMetric: 'message' | 'lead' | 'purchase') => {
    setMetric(nextMetric);
    await loadInsights(dateRange, nextMetric);
  };

  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    return (
      <div className="p-8">
        <div className="max-w-xl rounded-3xl border border-rose-500/20 bg-rose-500/10 p-6 text-rose-200">
          <ShieldAlert className="w-5 h-5 mb-3" /> Bu səhifə yalnız admin istifadəçilər üçündür.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl shadow-black/20">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-200">
              <BarChart3 className="w-3.5 h-3.5" /> Facebook
            </div>
            <h1 className="mt-3 text-3xl font-bold text-slate-100">Facebook kampaniya paneli</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400">Burada seçilmiş kampaniyaların ümumi xərci, gələn mesaj nəticələri, CPM, CTR və nəticə başına xərc görünür. Ayarlar bu səhifənin içində saxlanılır.</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <TopPill label="Token" value={saved.hasToken ? 'Var' : 'Yox'} tone={saved.hasToken ? 'blue' : 'slate'} />
            <TopPill label="Hesab" value={selectedAccountIds.length} tone="emerald" />
            <TopPill label="Kampaniya" value={selectedCampaignIds.length} tone="violet" />
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/35 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-semibold text-slate-100">Facebook ayarları</div>
            <div className="text-sm text-slate-500">Token, hesab və kampaniya seçimi burada idarə olunur.</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {saved.hasToken ? <StatusBadge>{saved.tokenHint || 'saved'}</StatusBadge> : null}
            <ActionButton variant="secondary" onClick={() => setShowSettings((v) => !v)} icon={<Settings2 className="w-4 h-4" />}>
              {showSettings ? 'Ayarları gizlət' : 'Ayarları aç'}
            </ActionButton>
            <ActionButton variant="secondary" onClick={handleRefreshSaved} busy={busyRefresh} icon={<RefreshCcw className="w-4 h-4" />} disabled={!saved.hasToken}>
              Yenilə
            </ActionButton>
          </div>
        </div>

        {showSettings ? (
          <div className="p-5 grid grid-cols-1 xl:grid-cols-[0.86fr_1.14fr] gap-5">
            <div className="space-y-5">
              <Panel title="Token">
                <textarea
                  rows={5}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="EAAB... token buraya"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:ring-1 focus:ring-blue-500"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton onClick={handleFetchAccounts} busy={busyFetchAccounts} icon={<Download className="w-4 h-4" />}>
                    Hesabları getir
                  </ActionButton>
                </div>
              </Panel>

              <Panel title="Seçilmişlər">
                <div className="flex flex-wrap gap-2">
                  {selectedAccounts.length > 0 ? selectedAccounts.map((a) => (
                    <span key={a.account_id} className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-200">
                      <Check className="w-3 h-3" /> {a.name}
                    </span>
                  )) : <EmptyHint text="Hesab seçilməyib." compact />}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton onClick={handleFetchCampaigns} busy={busyFetchCampaigns} icon={<FolderSync className="w-4 h-4" />} disabled={selectedAccountIds.length === 0}>
                    Kampaniyaları getir
                  </ActionButton>
                  <ActionButton onClick={handleSave} busy={busySave} icon={<Save className="w-4 h-4" />} disabled={selectedAccountIds.length === 0}>
                    Ayarları saxla
                  </ActionButton>
                </div>
              </Panel>
            </div>

            <div className="space-y-5">
              <Panel title="Reklam hesabları" right={<SearchBox value={accountSearch} onChange={setAccountSearch} placeholder="Hesab axtar..." />}>
                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                  {filteredAccounts.length === 0 ? <EmptyHint text="Token ilə hesabları gətirəndən sonra burada görünəcək." compact /> : filteredAccounts.map((account) => {
                    const checked = selectedAccountIds.includes(account.account_id) || selectedAccountIds.includes(account.id) || selectedAccountIds.includes(account.api_id);
                    return (
                      <SelectableRow
                        key={account.api_id || account.id}
                        checked={checked}
                        title={account.name}
                        badges={[account.account_id, account.currency || '', account.timezone_name || '', statusLabel(account.account_status)]}
                        onClick={() => toggleAccount(account.account_id || account.id)}
                        tone="blue"
                      />
                    );
                  })}
                </div>
              </Panel>

              <Panel title="Kampaniyalar" right={<SearchBox value={campaignSearch} onChange={setCampaignSearch} placeholder="Kampaniya axtar..." />}>
                <div className="space-y-4 max-h-[420px] overflow-y-auto pr-1">
                  {campaigns.length === 0 ? <EmptyHint text="Əvvəl hesab seçib kampaniyaları gətirin." compact /> : selectedAccounts.map((account) => {
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
                            className="text-xs font-semibold text-violet-200 hover:text-white"
                          >
                            {allSelected ? 'Hamısını sil' : 'Hamısını seç'}
                          </button>
                        </div>
                        <div className="divide-y divide-slate-800/60">
                          {rows.map((campaign) => (
                            <SelectableRow
                              key={campaign.id}
                              checked={selectedCampaignIds.includes(campaign.id)}
                              title={campaign.name}
                              badges={[campaign.objective || '', campaign.status || '', campaign.effective_status?.[0] || '']}
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
              </Panel>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/35 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-slate-100">Kampaniya nəticələri</div>
            <div className="text-sm text-slate-500">Ümumi nəticələr və seçilmiş kampaniyalar üzrə breakdown</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(['message', 'lead', 'purchase'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => handleMetricChange(m)}
                className={cn(
                  'rounded-xl px-3 py-2 text-sm font-semibold border transition-colors',
                  metric === m
                    ? 'bg-violet-600/20 border-violet-500/30 text-violet-200'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
                )}
                disabled={busyInsights || selectedCampaignIds.length === 0}
              >
                {metricLabel(m)}
              </button>
            ))}
            <DateField label="Başlanğıc" value={dateRange.start} onChange={(v) => setDateRange((p) => ({ ...p, start: v }))} />
            <DateField label="Bitiş" value={dateRange.end} onChange={(v) => setDateRange((p) => ({ ...p, end: v }))} />
            <ActionButton variant="secondary" onClick={() => applyPreset(1)} icon={<Calendar className="w-4 h-4" />}>
              Bugün
            </ActionButton>
            <ActionButton variant="secondary" onClick={() => applyPreset(7)} icon={<Calendar className="w-4 h-4" />}>
              Son 7 gün
            </ActionButton>
            <ActionButton variant="secondary" onClick={() => applyPreset(30)} icon={<Calendar className="w-4 h-4" />}>
              Son 30 gün
            </ActionButton>
            <ActionButton variant="secondary" onClick={() => { setDateRange({ start: '', end: '' }); loadInsights({ start: '', end: '' }, metric); }} icon={<Calendar className="w-4 h-4" />}>
              Tüm zamanlar
            </ActionButton>
            <ActionButton onClick={applyDateFilter} busy={busyInsights} icon={<Filter className="w-4 h-4" />} disabled={selectedCampaignIds.length === 0}>
              Tətbiq et
            </ActionButton>
          </div>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
            <MetricCard label="Ümumi xərc" value={formatMoney(insights.summary.spend)} tone="blue" />
            <MetricCard label={`${metricLabel(metric)} sayı`} value={formatNum(insights.summary.results)} tone="emerald" />
            <MetricCard label="CPM" value={formatMoney(insights.summary.cpm)} tone="violet" />
            <MetricCard label="CTR" value={formatPct(insights.summary.ctr)} tone="amber" />
            <MetricCard label={`${metricLabel(metric)} başına xərc`} value={formatMoney(insights.summary.cost_per_result)} tone="rose" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[0.78fr_1.22fr] gap-5">
            <Panel title="Günlük ümumi nəticə">
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {insights.daily.length === 0 ? <EmptyHint text="Seçilmiş kampaniyalar üçün hələ insight məlumatı görünmür." compact /> : insights.daily.map((day) => (
                  <div key={day.date} className="rounded-2xl border border-slate-800 bg-slate-950/25 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-100">{day.date}</div>
                      <div className="text-sm font-bold text-blue-300">{formatMoney(day.spend)}</div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                      <MiniTag label={metricLabel(metric)} value={formatNum(day.results)} />
                      <MiniTag label="CTR" value={formatPct(day.ctr)} />
                      <MiniTag label="CPM" value={formatMoney(day.cpm)} />
                      <MiniTag label="Result Cost" value={formatMoney(day.cost_per_result)} />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Kampaniyalar üzrə breakdown">
              <div className="space-y-3 max-h-[620px] overflow-y-auto pr-1">
                {insights.campaigns.length === 0 ? <EmptyHint text="Ayarları saxlayıb tarix filterini tətbiq etdikdən sonra kampaniya dataları burada görünəcək." compact /> : insights.campaigns.map((campaign) => (
                  <div key={campaign.id} className="rounded-2xl border border-slate-800 bg-slate-950/30 overflow-hidden">
                    <div className="px-4 py-4 border-b border-slate-800 bg-slate-900/40 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-100 truncate">{campaign.name}</div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-400">
                          {campaign.account_name ? <Tag>{campaign.account_name}</Tag> : null}
                          {campaign.objective ? <Tag>{campaign.objective}</Tag> : null}
                          {campaign.status ? <Tag>{campaign.status}</Tag> : null}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 min-w-[320px]">
                        <CampaignMetric label="Spend" value={formatMoney(campaign.metrics.spend)} />
                        <CampaignMetric label={metricLabel(metric)} value={formatNum(campaign.metrics.results)} />
                        <CampaignMetric label="CPM" value={formatMoney(campaign.metrics.cpm)} />
                        <CampaignMetric label="CTR" value={formatPct(campaign.metrics.ctr)} />
                        <CampaignMetric label="Cost/Result" value={formatMoney(campaign.metrics.cost_per_result)} />
                      </div>
                    </div>

                    <div className="px-4 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Günlük breakdown</div>
                      <div className="space-y-2">
                        {campaign.daily.length === 0 ? <div className="text-sm text-slate-500">Bu tarix aralığında data yoxdur.</div> : campaign.daily.map((row, idx) => (
                          <div key={`${campaign.id}-${idx}`} className="grid grid-cols-2 lg:grid-cols-6 gap-2 rounded-xl border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px]">
                            <MiniTag label="Tarix" value={row.date_start || '-'} />
                            <MiniTag label="Spend" value={formatMoney(row.spend)} />
                            <MiniTag label={metricLabel(metric)} value={formatNum(row.results)} />
                            <MiniTag label="CPM" value={formatMoney(row.cpm)} />
                            <MiniTag label="CTR" value={formatPct(row.ctr)} />
                            <MiniTag label="Cost/Result" value={formatMoney(row.cost_per_result)} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </section>

      {message ? <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">{message}</div> : null}
    </div>
  );
}

function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
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

function TopPill({ label, value, tone }: { label: string; value: React.ReactNode; tone: 'blue' | 'emerald' | 'violet' | 'slate' }) {
  const tones = {
    blue: 'border-blue-500/20 bg-blue-500/10 text-blue-200',
    emerald: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
    violet: 'border-violet-500/20 bg-violet-500/10 text-violet-200',
    slate: 'border-slate-700 bg-slate-900/50 text-slate-200',
  } as const;
  return (
    <div className={cn('rounded-2xl border px-4 py-3 min-w-[100px]', tones[tone])}>
      <div className="text-[11px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: React.ReactNode; tone: 'blue' | 'emerald' | 'violet' | 'amber' | 'rose' }) {
  const tones = {
    blue: 'border-blue-500/15 bg-blue-500/10 text-blue-200',
    emerald: 'border-emerald-500/15 bg-emerald-500/10 text-emerald-200',
    violet: 'border-violet-500/15 bg-violet-500/10 text-violet-200',
    amber: 'border-amber-500/15 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/15 bg-rose-500/10 text-rose-200',
  } as const;
  return (
    <div className={cn('rounded-2xl border p-4', tones[tone])}>
      <div className="text-[11px] uppercase tracking-wide opacity-75">{label}</div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

function CampaignMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/25 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2 min-w-[220px]">
      <Search className="w-4 h-4 text-slate-500" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600 w-full" />
    </div>
  );
}

function SelectableRow({ title, badges, checked, onClick, tone, compact }: { title: string; badges: string[]; checked: boolean; onClick: () => void; tone: 'blue' | 'violet'; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left transition-colors',
        compact ? 'px-4 py-3' : 'rounded-2xl border px-4 py-3',
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
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
            {badges.filter(Boolean).map((b, i) => <Tag key={`${b}-${i}`}>{b}</Tag>)}
          </div>
        </div>
        {checked ? <CheckCircle2 className={cn('w-4 h-4 shrink-0', tone === 'blue' ? 'text-blue-300' : 'text-violet-300')} /> : null}
      </div>
    </button>
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

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/35 px-3 py-2 text-sm text-slate-300">
      <Calendar className="w-4 h-4 text-slate-500" />
      <span className="text-xs text-slate-500">{label}</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent outline-none text-slate-100" />
    </label>
  );
}

function MiniTag({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-slate-100">{value}</div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{children}</span>;
}

function EmptyHint({ text, compact }: { text: string; compact?: boolean }) {
  return <div className={cn('rounded-2xl border border-dashed border-slate-800 bg-slate-950/20 text-center text-sm text-slate-500', compact ? 'p-5' : 'p-8')}>{text}</div>;
}

function StatusBadge({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-200"><CheckCircle2 className="w-3.5 h-3.5" />{children}</span>;
}
