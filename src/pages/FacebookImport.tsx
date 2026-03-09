import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
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

type SavedConfig = {
  hasToken: boolean;
  tokenHint: string | null;
  selectedAccountIds: string[];
  selectedAccounts: AdAccount[];
  accountCache: AdAccount[];
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

const EMPTY_CONFIG: SavedConfig = {
  hasToken: false,
  tokenHint: null,
  selectedAccountIds: [],
  selectedAccounts: [],
  accountCache: [],
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
  const [search, setSearch] = useState('');
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [message, setMessage] = useState<string>('');

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
      setSelectedIds(Array.isArray(cfg.selectedAccountIds) ? cfg.selectedAccountIds : []);
    } catch (e: any) {
      setMessage(e?.message || 'Saved config oxunmadı');
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => [a.name, a.account_id, a.business_name, a.currency, a.timezone_name].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [accounts, search]);

  const selectedCount = selectedIds.length;

  const toggleAccount = (accountId: string) => {
    setSelectedIds((prev) => prev.includes(accountId) ? prev.filter((x) => x !== accountId) : [...prev, accountId]);
  };

  const handleFetch = async () => {
    if (!tokenInput.trim()) {
      setMessage('Facebook user token daxil edin.');
      return;
    }
    setBusy(true);
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
      if (!res.ok) throw new Error(data.error || 'Ad accounts alınmadı');
      const next = Array.isArray(data.accounts) ? data.accounts : [];
      setAccounts(next);
      setSelectedIds((prev) => prev.filter((id) => next.some((a) => a.account_id === id || a.id === id || a.api_id === id)));
      setMessage(`${next.length} reklam hesabı tapıldı.`);
    } catch (e: any) {
      setMessage(e?.message || 'Fetch xətası');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (accounts.length === 0) {
      setMessage('Əvvəl token ilə hesabları gətirin və seçim edin.');
      return;
    }
    setSaveBusy(true);
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
          selectedAccountIds: selectedIds,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save xətası');
      const cfg = { ...EMPTY_CONFIG, ...(data.config || {}) } as SavedConfig;
      setSaved(cfg);
      setAccounts(cfg.accountCache);
      setSelectedIds(cfg.selectedAccountIds);
      setTokenInput('');
      setMessage('Token və seçilmiş reklam hesabları yadda saxlanıldı.');
    } catch (e: any) {
      setMessage(e?.message || 'Save xətası');
    } finally {
      setSaveBusy(false);
    }
  };

  const handleRefreshSaved = async () => {
    setRefreshBusy(true);
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
      setSelectedIds(cfg.selectedAccountIds);
      setMessage('Yadda qalan token ilə reklam hesabları yeniləndi.');
    } catch (e: any) {
      setMessage(e?.message || 'Refresh xətası');
    } finally {
      setRefreshBusy(false);
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
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl shadow-black/20">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-200">
              <Download className="w-3.5 h-3.5" /> Facebook Import
            </div>
            <h1 className="mt-3 text-2xl sm:text-3xl font-bold text-slate-100">Facebook reklam hesablarını bağla</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400">Bu səhifə CRM-dən ayrıdır. Burada user token daxil edib reklam hesablarını gətirir, lazım olan account-ları seçir və tenant üçün yadda saxlayırsan. Sonrakı addımda bu seçilmiş hesablar üçün insight sync və dashboard qurmaq asan olacaq.</p>
          </div>

          <div className="grid grid-cols-2 gap-3 min-w-[280px]">
            <MetricCard label="Yadda qalan token" value={saved.hasToken ? 'Var' : 'Yoxdur'} tone={saved.hasToken ? 'blue' : 'slate'} />
            <MetricCard label="Seçilmiş hesab" value={saved.selectedAccountIds.length} tone="emerald" />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[0.92fr_1.08fr] gap-6">
        <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5 shadow-2xl shadow-black/20 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-100">Token & Sync</h2>
            {saved.hasToken ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-200">
                <CheckCircle2 className="w-3.5 h-3.5" /> {saved.tokenHint || 'saved'}
              </span>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Facebook User Token</label>
            <textarea
              rows={6}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="EAAB... token buraya"
              className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-500">Token yalnız bu tenant üçün saxlanılır. Seçilmiş reklam hesabları sonradan API sync üçün istifadə olunacaq.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={handleFetch} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-white">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Hesabları gətir
              </button>
              <button onClick={handleSave} disabled={saveBusy || accounts.length === 0} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-white">
                {saveBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Seçimi saxla
              </button>
              <button onClick={handleRefreshSaved} disabled={refreshBusy || !saved.hasToken} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-slate-200">
                {refreshBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />} Saved token ilə yenilə
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-slate-100">Mimari hazırdır</h3>
            <ul className="space-y-2 text-sm text-slate-400 leading-6">
              <li>- token tenant üzrə backend-də saxlanılır</li>
              <li>- seçilmiş ad account-lar ayrıca yadda qalır</li>
              <li>- account cache saxlanır ki sonradan insights sync qatı qurulsun</li>
              <li>- bu səhifə CRM ilə qarışmır, ayrıca modul kimidir</li>
            </ul>
          </div>

          {message ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-sm text-slate-300">{message}</div>
          ) : null}
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5 shadow-2xl shadow-black/20 space-y-4 min-h-[520px]">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Reklam hesabları</h2>
              <p className="text-sm text-slate-500">Tapılan account-ları seç və saxla. Seçim tenant üzrə qalacaq.</p>
            </div>

            <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2">
              <Search className="w-4 h-4 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Ad, account id, business..."
                className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600 w-56 max-w-[40vw]"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
            <span>Tapılan: {accounts.length}</span>
            <span>Seçilən: {selectedCount}</span>
          </div>

          <div className="space-y-3 max-h-[700px] overflow-y-auto pr-1">
            {filteredAccounts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/20 p-10 text-center text-slate-500">Token ilə fetch edəndən sonra reklam hesabları burada görünəcək.</div>
            ) : filteredAccounts.map((account) => {
              const checked = selectedIds.includes(account.account_id) || selectedIds.includes(account.id) || selectedIds.includes(account.api_id);
              return (
                <label key={account.api_id || account.id} className={cn(
                  'block rounded-2xl border p-4 transition-colors cursor-pointer',
                  checked ? 'border-blue-500/30 bg-blue-500/10' : 'border-slate-800 bg-slate-950/30 hover:bg-slate-950/50'
                )}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex items-start gap-3">
                      <input type="checkbox" checked={checked} onChange={() => toggleAccount(account.account_id || account.id)} className="mt-1" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-semibold text-slate-100 truncate">{account.name}</div>
                          <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                            <WalletCards className="w-3 h-3" /> {account.account_id}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
                          {account.currency ? <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{account.currency}</span> : null}
                          {account.timezone_name ? <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{account.timezone_name}</span> : null}
                          <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{statusLabel(account.account_status)}</span>
                          {account.business_name ? <span className="rounded-full border border-slate-800 bg-slate-900/60 px-2 py-0.5">{account.business_name}</span> : null}
                        </div>
                      </div>
                    </div>
                    {checked ? <span className="text-xs font-bold text-blue-200">Seçildi</span> : null}
                  </div>
                </label>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: React.ReactNode; tone: 'blue' | 'emerald' | 'slate' }) {
  const toneMap = {
    blue: 'text-blue-300 border-blue-500/15 bg-blue-500/10',
    emerald: 'text-emerald-300 border-emerald-500/15 bg-emerald-500/10',
    slate: 'text-slate-200 border-slate-700 bg-slate-900/50',
  } as const;

  return (
    <div className={cn('rounded-2xl border p-4', toneMap[tone])}>
      <div className="text-[11px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}
