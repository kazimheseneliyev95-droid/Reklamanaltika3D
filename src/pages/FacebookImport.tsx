import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FolderSync,
  Loader2,
  RefreshCcw,
  Save,
  Search,
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
  const [message, setMessage] = useState('');
  const [showTokenPanel, setShowTokenPanel] = useState(true);
  const [showAccountsPanel, setShowAccountsPanel] = useState(true);
  const [showCampaignsPanel, setShowCampaignsPanel] = useState(true);

  const loadConfig = async () => {
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/config`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Saved config yüklənmədi');
      const cfg = { ...EMPTY_CONFIG, ...(data || {}) } as SavedConfig;
      setSaved(cfg);
      setAccounts(Array.isArray(cfg.accountCache) ? cfg.accountCache : []);
      setCampaigns(Array.isArray(cfg.campaignCache) ? cfg.campaignCache : []);
      setSelectedAccountIds(Array.isArray(cfg.selectedAccountIds) ? cfg.selectedAccountIds : []);
      setSelectedCampaignIds(Array.isArray(cfg.selectedCampaignIds) ? cfg.selectedCampaignIds : []);
      if (cfg.hasToken) setShowTokenPanel(false);
    } catch (e: any) {
      setMessage(e?.message || 'Saved config oxunmadı');
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => [a.name, a.account_id, a.business_name, a.currency, a.timezone_name].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [accounts, accountSearch]);

  const filteredCampaigns = useMemo(() => {
    const q = campaignSearch.trim().toLowerCase();
    return campaigns.filter((c) => {
      const accountSelected = selectedAccountIds.includes(c.account_id);
      if (!accountSelected) return false;
      if (!q) return true;
      return [c.name, c.account_name, c.objective, ...(c.effective_status || [])].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [campaigns, campaignSearch, selectedAccountIds]);

  const campaignsByAccount = useMemo(() => {
    const m = new Map<string, Campaign[]>();
    for (const c of filteredCampaigns) {
      const arr = m.get(c.account_id) || [];
      arr.push(c);
      m.set(c.account_id, arr);
    }
    return m;
  }, [filteredCampaigns]);

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
    if (!tokenInput.trim()) {
      setMessage('Facebook user token daxil edin.');
      return;
    }
    setBusyFetchAccounts(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ token: tokenInput.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Hesablar alınmadı');
      const nextAccounts = Array.isArray(data.accounts) ? data.accounts : [];
      setAccounts(nextAccounts);
      setCampaigns([]);
      setSelectedCampaignIds([]);
      setMessage(`${nextAccounts.length} reklam hesabı tapıldı.`);
      setShowAccountsPanel(true);
      setShowCampaignsPanel(false);
    } catch (e: any) {
      setMessage(e?.message || 'Fetch xətası');
    } finally {
      setBusyFetchAccounts(false);
    }
  };

  const handleFetchCampaigns = async () => {
    if (selectedAccountIds.length === 0) {
      setMessage('Əvvəl ən azı bir reklam hesabı seçin.');
      return;
    }
    setBusyFetchCampaigns(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          token: tokenInput.trim() || undefined,
          accountIds: selectedAccountIds,
          accounts,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kampaniyalar alınmadı');
      const nextCampaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      setCampaigns(nextCampaigns);
      setSelectedCampaignIds((prev) => prev.filter((id) => nextCampaigns.some((c) => c.id === id)));
      setShowCampaignsPanel(true);
      setMessage(`${nextCampaigns.length} kampaniya tapıldı.`);
    } catch (e: any) {
      setMessage(e?.message || 'Campaign fetch xətası');
    } finally {
      setBusyFetchCampaigns(false);
    }
  };

  const handleSave = async () => {
    if (selectedAccountIds.length === 0) {
      setMessage('Ən azı bir reklam hesabı seçin.');
      return;
    }
    setBusySave(true);
    setMessage('');
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/facebook-import/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
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
      setTokenInput('');
      setShowTokenPanel(false);
      setMessage('Seçilmiş hesab və kampaniyalar yadda saxlanıldı.');
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
      setMessage('Yadda qalan token ilə hesab və kampaniyalar yeniləndi.');
    } catch (e: any) {
      setMessage(e?.message || 'Refresh xətası');
    } finally {
      setBusyRefresh(false);
    }
  };

  if (currentUser?.role !== 'admin' && currentUser?.role !== 'superadmin') {
    return (
      <div className="p-8">
        <div className="max-w-xl rounded-3xl border border-rose-500/20 bg-rose-500/10 p-6 text-rose-200">
          Bu səhifə yalnız admin istifadəçilər üçündür.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5 shadow-2xl shadow-black/20">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-200">
              <Download className="w-3.5 h-3.5" /> Facebook Import
            </div>
            <h1 className="mt-3 text-2xl font-bold text-slate-100">Hesab ve kampaniya seçimi</h1>
            <p className="mt-1 text-sm text-slate-500">Əvvəl reklam hesablarını seç, sonra yalnız CRM-ə aid kampaniyaları işarələ. Beləliklə başqa kampaniyaların datasi gəlməz.</p>
          </div>

          <div className="grid grid-cols-3 gap-3 min-w-[320px]">
            <MiniMetric label="Token" value={saved.hasToken ? 'Var' : 'Yox'} tone={saved.hasToken ? 'blue' : 'slate'} />
            <MiniMetric label="Hesab" value={selectedAccountIds.length} tone="emerald" />
            <MiniMetric label="Kampaniya" value={selectedCampaignIds.length} tone="violet" />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[0.86fr_1.14fr] gap-5">
        <div className="space-y-5">
          <CompactPanel
            title="1. Token"
            subtitle={saved.hasToken ? `Yadda qalan token: ${saved.tokenHint || 'saved'}` : 'Facebook user token daxil edin'}
            open={showTokenPanel}
            onToggle={() => setShowTokenPanel((v) => !v)}
            right={saved.hasToken ? <StatusBadge>Aktiv</StatusBadge> : null}
          >
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
              <ActionButton variant="secondary" onClick={handleRefreshSaved} busy={busyRefresh} icon={<RefreshCcw className="w-4 h-4" />} disabled={!saved.hasToken}>
                Saved token ilə yenilə
              </ActionButton>
            </div>
          </CompactPanel>

          <CompactPanel
            title="2. Seçilmiş hesablar"
            subtitle={selectedAccountIds.length > 0 ? `${selectedAccountIds.length} hesab seçilib` : 'Əvvəl reklam hesablarını seçin'}
            open={showAccountsPanel}
            onToggle={() => setShowAccountsPanel((v) => !v)}
            right={selectedAccountIds.length > 0 ? <StatusBadge>{selectedAccountIds.length}</StatusBadge> : null}
          >
            {selectedAccountIds.length === 0 ? (
              <EmptyHint text="Hələ hesab seçilməyib." />
            ) : (
              <div className="flex flex-wrap gap-2">
                {accounts.filter((a) => selectedAccountIds.includes(a.account_id)).map((a) => (
                  <span key={a.account_id} className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-200">
                    <Check className="w-3 h-3" /> {a.name}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton onClick={handleFetchCampaigns} busy={busyFetchCampaigns} icon={<FolderSync className="w-4 h-4" />} disabled={selectedAccountIds.length === 0}>
                Kampaniyaları getir
              </ActionButton>
              <ActionButton onClick={handleSave} busy={busySave} icon={<Save className="w-4 h-4" />} disabled={selectedAccountIds.length === 0}>
                Seçimi saxla
              </ActionButton>
            </div>
          </CompactPanel>

          {message ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">{message}</div>
          ) : null}
        </div>

        <div className="space-y-5">
          <CompactPanel
            title="Reklam hesabları"
            subtitle="Çox yazı yox, yalnız seçmək üçün kompakt siyahı"
            open={true}
            onToggle={() => {}}
            lockOpen
            right={<SearchBox value={accountSearch} onChange={setAccountSearch} placeholder="Hesab axtar..." />}
          >
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {filteredAccounts.length === 0 ? (
                <EmptyHint text="Token ilə hesabları gətirəndən sonra burada görünəcək." />
              ) : filteredAccounts.map((account) => {
                const checked = selectedAccountIds.includes(account.account_id) || selectedAccountIds.includes(account.id) || selectedAccountIds.includes(account.api_id);
                return (
                  <button
                    key={account.api_id || account.id}
                    type="button"
                    onClick={() => toggleAccount(account.account_id || account.id)}
                    className={cn(
                      'w-full rounded-2xl border px-4 py-3 text-left transition-colors',
                      checked ? 'border-blue-500/30 bg-blue-500/10' : 'border-slate-800 bg-slate-950/30 hover:bg-slate-950/50'
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn('w-2 h-2 rounded-full shrink-0', checked ? 'bg-blue-400' : 'bg-slate-600')} />
                          <div className="truncate text-sm font-semibold text-slate-100">{account.name}</div>
                          <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[10px] font-bold text-slate-300">{account.account_id}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
                          {account.currency ? <Tag>{account.currency}</Tag> : null}
                          {account.timezone_name ? <Tag>{account.timezone_name}</Tag> : null}
                          <Tag>{statusLabel(account.account_status)}</Tag>
                        </div>
                      </div>
                      {checked ? <CheckCircle2 className="w-4 h-4 text-blue-300 shrink-0" /> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </CompactPanel>

          <CompactPanel
            title="Kampaniyalar"
            subtitle="Yalnız seçilmiş hesablara aid kampaniyaları işarələ"
            open={showCampaignsPanel}
            onToggle={() => setShowCampaignsPanel((v) => !v)}
            right={<SearchBox value={campaignSearch} onChange={setCampaignSearch} placeholder="Kampaniya axtar..." />}
          >
            {campaigns.length === 0 ? (
              <EmptyHint text="Əvvəl hesab seçin, sonra “Kampaniyaları getir” basın." />
            ) : (
              <div className="space-y-4 max-h-[520px] overflow-y-auto pr-1">
                {accounts.filter((a) => selectedAccountIds.includes(a.account_id)).map((account) => {
                  const rows = campaignsByAccount.get(account.account_id) || [];
                  if (rows.length === 0) return null;
                  return (
                    <div key={account.account_id} className="rounded-2xl border border-slate-800 bg-slate-950/25 overflow-hidden">
                      <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-100 truncate">{account.name}</div>
                          <div className="text-[11px] text-slate-500">{rows.length} kampaniya</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const ids = rows.map((r) => r.id);
                            const allSelected = ids.every((id) => selectedCampaignIds.includes(id));
                            setSelectedCampaignIds((prev) => allSelected ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids])));
                          }}
                          className="text-xs font-semibold text-blue-200 hover:text-white"
                        >
                          {rows.every((r) => selectedCampaignIds.includes(r.id)) ? 'Hamısını sil' : 'Hamısını seç'}
                        </button>
                      </div>

                      <div className="divide-y divide-slate-800/60">
                        {rows.map((campaign) => {
                          const checked = selectedCampaignIds.includes(campaign.id);
                          return (
                            <button
                              key={campaign.id}
                              type="button"
                              onClick={() => toggleCampaign(campaign.id)}
                              className={cn(
                                'w-full px-4 py-3 text-left transition-colors',
                                checked ? 'bg-violet-500/10' : 'hover:bg-slate-900/40'
                              )}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className={cn('w-2 h-2 rounded-full shrink-0', checked ? 'bg-violet-400' : 'bg-slate-600')} />
                                    <div className="truncate text-sm font-medium text-slate-100">{campaign.name}</div>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
                                    {campaign.objective ? <Tag>{campaign.objective}</Tag> : null}
                                    {campaign.status ? <Tag>{campaign.status}</Tag> : null}
                                    {campaign.effective_status?.[0] ? <Tag>{campaign.effective_status[0]}</Tag> : null}
                                  </div>
                                </div>
                                {checked ? <CheckCircle2 className="w-4 h-4 text-violet-300 shrink-0" /> : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CompactPanel>
        </div>
      </div>
    </div>
  );
}

function CompactPanel({ title, subtitle, open, onToggle, children, right, lockOpen }: { title: string; subtitle?: string; open: boolean; onToggle: () => void; children: React.ReactNode; right?: React.ReactNode; lockOpen?: boolean }) {
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/35 flex items-center justify-between gap-3">
        <button type="button" onClick={lockOpen ? undefined : onToggle} className={cn('min-w-0 text-left', !lockOpen && 'hover:opacity-90')}>
          <div className="flex items-center gap-2">
            {!lockOpen ? <ChevronDown className={cn('w-4 h-4 text-slate-500 transition-transform', open && 'rotate-180')} /> : null}
            <div>
              <div className="text-lg font-semibold text-slate-100">{title}</div>
              {subtitle ? <div className="text-sm text-slate-500 mt-0.5">{subtitle}</div> : null}
            </div>
          </div>
        </button>
        <div className="shrink-0">{right}</div>
      </div>
      {open ? <div className="p-5">{children}</div> : null}
    </section>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2 min-w-[220px]">
      <Search className="w-4 h-4 text-slate-500" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600 w-full" />
    </div>
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

function MiniMetric({ label, value, tone }: { label: string; value: React.ReactNode; tone: 'blue' | 'emerald' | 'violet' | 'slate' }) {
  const toneMap = {
    blue: 'text-blue-300 border-blue-500/15 bg-blue-500/10',
    emerald: 'text-emerald-300 border-emerald-500/15 bg-emerald-500/10',
    violet: 'text-violet-300 border-violet-500/15 bg-violet-500/10',
    slate: 'text-slate-200 border-slate-700 bg-slate-900/50',
  } as const;
  return (
    <div className={cn('rounded-2xl border p-4', toneMap[tone])}>
      <div className="text-[11px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{children}</span>;
}

function EmptyHint({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/20 p-8 text-center text-sm text-slate-500">{text}</div>;
}

function StatusBadge({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-200"><CheckCircle2 className="w-3.5 h-3.5" />{children}</span>;
}
