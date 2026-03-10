import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../context/Store';
import { CrmService } from '../services/CrmService';
import {
  Activity,
  Archive,
  ArrowRight,
  BarChart3,
  Building2,
  Download,
  LogOut,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Server,
  ShieldAlert,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';

type TenantStatus = {
  tenant_id: string;
  display_name?: string | null;
  admin_username: string;
  admin_display_name?: string | null;
  created_at: string;
  user_count: number;
  lead_count: number;
  whatsapp_status: 'connected' | 'disconnected';
  connectedNumber?: string;
  status?: 'active' | 'archived';
  archived_at?: string | null;
  import_source?: string | null;
};

type TenantFilter = 'active' | 'archived' | 'all';

function StatusPill({ active, archivedAt }: { active: boolean; archivedAt?: string | null }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border',
        active
          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
          : 'bg-amber-500/10 border-amber-500/20 text-amber-300'
      )}
      title={!active && archivedAt ? `Arxiv: ${new Date(archivedAt).toLocaleString()}` : undefined}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', active ? 'bg-emerald-400' : 'bg-amber-400')} />
      {active ? 'Aktiv' : 'Arxiv'}
    </span>
  );
}

function parseImportRows(raw: string) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) return [] as Array<{ tenantId: string; displayName: string; adminUsername: string; adminPassword: string }>;

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const normalize = (s: string) => s.trim().replace(/^"|"$/g, '');
  const isHeader = /tenant/i.test(lines[0]) && /admin/i.test(lines[0]);
  const body = isHeader ? lines.slice(1) : lines;

  return body.map((line) => {
    const delimiter = line.includes(';') ? ';' : ',';
    const parts = line.split(delimiter).map(normalize);
    return {
      tenantId: parts[0] || '',
      displayName: parts[1] || '',
      adminUsername: parts[2] || '',
      adminPassword: parts[3] || '',
    };
  }).filter((row) => row.tenantId || row.adminUsername || row.adminPassword || row.displayName);
}

export default function SuperAdminDashboard() {
  const { currentUser, logout, impersonate } = useAppStore();
  const token = localStorage.getItem('crm_auth_token') || '';

  const [tenants, setTenants] = useState<TenantStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<TenantFilter>('active');
  const [search, setSearch] = useState('');
  const [selectedDetails, setSelectedDetails] = useState<any>(null);

  const [isCreating, setIsCreating] = useState(false);
  const [newTenantId, setNewTenantId] = useState('');
  const [newAdminUser, setNewAdminUser] = useState('');
  const [newAdminPass, setNewAdminPass] = useState('kazimks12');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [createMsg, setCreateMsg] = useState({ type: '', text: '' });

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('tenantId,displayName,adminUsername,adminPassword\nacme,Acme MMC,admin_acme,Acme12345');
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);

  const loadTenants = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants?includeArchived=1`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Tenant list yüklənmədi');
      setTenants(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Məlumatları yükləmək mümkün olmadı');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadTenants();
  }, [loadTenants]);

  const visibleTenants = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tenants.filter((t) => {
      const isArchived = t.status === 'archived';
      if (filter === 'active' && isArchived) return false;
      if (filter === 'archived' && !isArchived) return false;
      if (!q) return true;
      const hay = [t.tenant_id, t.display_name, t.admin_username, t.admin_display_name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [tenants, filter, search]);

  const globalMetrics = useMemo(() => {
    const active = tenants.filter((t) => t.status !== 'archived');
    const archived = tenants.filter((t) => t.status === 'archived');
    return {
      activeTenants: active.length,
      archivedTenants: archived.length,
      totalLeads: active.reduce((acc, t) => acc + Number(t.lead_count || 0), 0),
      totalUsers: active.reduce((acc, t) => acc + Number(t.user_count || 0), 0),
      connectedWA: active.filter((t) => t.whatsapp_status === 'connected').length,
    };
  }, [tenants]);

  const openDetails = async (tenantId: string) => {
    setSelectedDetails({ tenantId, isLoading: true });
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants/${tenantId}/details`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Detallar yüklənmədi');
      setSelectedDetails({ ...data, isLoading: false });
    } catch {
      setSelectedDetails(null);
      alert('Ətraflı məlumat yüklənərkən xəta baş verdi.');
    }
  };

  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateMsg({ type: '', text: '' });

    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          tenantId: newTenantId,
          adminUsername: newAdminUser,
          adminPassword: newAdminPass,
          displayName: newDisplayName
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server xətası');

      setCreateMsg({ type: 'success', text: 'Yeni şirkət yaradıldı.' });
      setNewTenantId('');
      setNewAdminUser('');
      setNewDisplayName('');
      setIsCreating(false);
      await loadTenants();
    } catch (err: any) {
      setCreateMsg({ type: 'error', text: err.message || 'Xəta baş verdi' });
    }
  };

  const handleImport = async () => {
    const rows = parseImportRows(importText);
    if (rows.length === 0) {
      setImportMsg('Import üçün ən azı bir sətir daxil edin.');
      return;
    }

    setImportBusy(true);
    setImportMsg(null);
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ rows })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import alınmadı');

      setImportMsg(`Hazır: ${data.created?.length || 0} yaradıldı, ${data.skipped?.length || 0} keçildi, ${data.errors?.length || 0} xəta.`);
      await loadTenants();
    } catch (err: any) {
      setImportMsg(err.message || 'Import xətası');
    } finally {
      setImportBusy(false);
    }
  };

  const handleArchiveTenant = async (tenantId: string) => {
    if (!confirm(`'${tenantId}' silinməyəcək, sadəcə arxivə gedəcək. Davam edilsin?`)) return;
    setBusyTenantId(tenantId);
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants/${tenantId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Arxiv xətası');
      await loadTenants();
    } catch (err: any) {
      alert(err.message || 'Arxiv xətası');
    } finally {
      setBusyTenantId(null);
    }
  };

  const handleRestoreTenant = async (tenantId: string) => {
    setBusyTenantId(tenantId);
    try {
      const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants/${tenantId}/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bərpa xətası');
      await loadTenants();
    } catch (err: any) {
      alert(err.message || 'Bərpa xətası');
    } finally {
      setBusyTenantId(null);
    }
  };

  const handleImpersonate = async (tenantId: string) => {
    if (!confirm(`'${tenantId}' şirkətinə Login As edilsin?`)) return;
    await impersonate(tenantId);
    window.location.href = '/crm';
  };

  if (currentUser?.role !== 'superadmin') {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <ShieldAlert className="w-16 h-16 text-rose-500 mb-4" />
        <h1 className="text-xl font-bold text-slate-200">Giriş Qadağandır</h1>
        <p className="text-slate-400 mt-2">Bu səhifəyə daxil olmaq üçün Super Admin səlahiyyəti lazımdır.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 font-sans selection:bg-rose-500/30">
      <header className="sticky top-0 z-30 border-b border-rose-900/30 bg-slate-900/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-rose-600 via-orange-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-900/20 shrink-0">
              <ShieldAlert className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                Super Admin
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/20 text-rose-300 font-bold uppercase tracking-wide">Global</span>
              </h1>
              <p className="text-xs text-slate-500">Lifecycle, import, archive və tenant idarəetməsi bir yerdə.</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={loadTenants}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-800 bg-slate-800/60 hover:bg-slate-800 text-sm text-slate-200"
            >
              <RefreshCcw className="w-4 h-4" />
              Yenilə
            </button>
            <button
              onClick={logout}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-800 bg-slate-800/60 hover:bg-slate-800 text-sm text-slate-200"
            >
              <LogOut className="w-4 h-4" />
              Çıxış
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
          <StatCard icon={<Building2 className="w-4 h-4 text-rose-400" />} label="Aktiv şirkət" value={globalMetrics.activeTenants} />
          <StatCard icon={<Archive className="w-4 h-4 text-amber-400" />} label="Arxiv şirkət" value={globalMetrics.archivedTenants} />
          <StatCard icon={<Activity className="w-4 h-4 text-blue-400" />} label="Aktiv leadlər" value={globalMetrics.totalLeads} />
          <StatCard icon={<Users className="w-4 h-4 text-emerald-400" />} label="Aktiv istifadəçi" value={globalMetrics.totalUsers} />
          <StatCard icon={<Server className="w-4 h-4 text-violet-400" />} label="Aktiv WhatsApp" value={globalMetrics.connectedWA} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.25fr_0.75fr] gap-6">
          <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/50 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Sistemdəki şirkətlər</h2>
                <p className="text-xs text-slate-500">Soft-delete, restore, import və tenant health monitorinqi.</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Tenant, şirkət adı, admin..."
                    className="w-[250px] max-w-[70vw] bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                {(['active', 'archived', 'all'] as TenantFilter[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={cn(
                      'px-3 py-2 rounded-xl text-xs font-bold border transition-colors',
                      filter === id
                        ? 'bg-blue-600/15 border-blue-500/30 text-blue-200'
                        : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {id === 'active' ? 'Aktiv' : id === 'archived' ? 'Arxiv' : 'Hamısı'}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/30 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-500">
                Görünən: <span className="text-slate-200 font-bold">{visibleTenants.length}</span> şirkət
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowImport((v) => !v)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-800 bg-slate-800/60 hover:bg-slate-800 text-sm text-slate-200"
                >
                  <Upload className="w-4 h-4" />
                  Import
                </button>
                <button
                  onClick={() => setIsCreating((v) => !v)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold shadow-lg shadow-rose-900/20"
                >
                  <Plus className="w-4 h-4" />
                  Yeni şirkət
                </button>
              </div>
            </div>

            {showImport ? (
              <div className="p-5 border-b border-slate-800 bg-slate-950/30 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-100">Bulk import</h3>
                    <p className="text-xs text-slate-500">Format: `tenantId,displayName,adminUsername,adminPassword`</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setImportText('tenantId,displayName,adminUsername,adminPassword\nacme,Acme MMC,admin_acme,Acme12345')}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-800 bg-slate-900/50 hover:bg-slate-900 text-xs font-bold text-slate-300"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Nümunə
                  </button>
                </div>

                <textarea
                  rows={7}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-slate-500">Import zamanı şirkətlər avtomatik yaradılır; “sil” əvəzinə sonra arxivə düşür.</div>
                  <div className="flex items-center gap-2">
                    {importMsg ? <span className="text-xs text-slate-400">{importMsg}</span> : null}
                    <button
                      onClick={handleImport}
                      disabled={importBusy}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-60"
                    >
                      {importBusy ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      İmport et
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {isCreating ? (
              <div className="p-5 border-b border-slate-800 bg-slate-950/20">
                {createMsg.text ? (
                  <div className={cn(
                    'mb-4 p-3 rounded-xl text-sm border',
                    createMsg.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                  )}>
                    {createMsg.text}
                  </div>
                ) : null}

                <form onSubmit={handleCreateTenant} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-end">
                  <Field label="Tenant ID" value={newTenantId} onChange={setNewTenantId} placeholder="ornek-sirket" required />
                  <Field label="Şirkət adı" value={newDisplayName} onChange={setNewDisplayName} placeholder="Məs: Acme MMC" />
                  <Field label="Admin username" value={newAdminUser} onChange={setNewAdminUser} placeholder="admin_acme" required />
                  <Field label="Admin şifrə" value={newAdminPass} onChange={setNewAdminPass} required />
                  <button type="submit" className="w-full bg-rose-600 hover:bg-rose-500 text-white rounded-xl px-4 py-2.5 text-sm font-semibold">
                    Profili yarat
                  </button>
                </form>
              </div>
            ) : null}

            <div className="overflow-x-auto">
              {loading ? (
                <div className="p-10 text-center text-slate-500">Yüklənir...</div>
              ) : error ? (
                <div className="p-10 text-center text-rose-400">{error}</div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-950 border-b border-slate-800 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                      <th className="p-4">Şirkət</th>
                      <th className="p-4">Admin</th>
                      <th className="p-4">Lifecycle</th>
                      <th className="p-4">WhatsApp</th>
                      <th className="p-4">İstifadəçi</th>
                      <th className="p-4">Lead</th>
                      <th className="p-4 text-right">Əməliyyatlar</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {visibleTenants.map((t) => {
                      const archived = t.status === 'archived';
                      return (
                        <tr key={t.tenant_id} className={cn('transition-colors', archived ? 'bg-amber-500/5' : 'hover:bg-slate-800/20')}>
                          <td className="p-4 min-w-[240px]">
                            <div className="font-semibold text-slate-100">{t.display_name || t.tenant_id}</div>
                            <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                              <span>{t.tenant_id}</span>
                              <span>{new Date(t.created_at).toLocaleDateString()}</span>
                              {t.import_source ? <span>import</span> : null}
                            </div>
                          </td>
                          <td className="p-4 text-sm">
                            <div className="text-slate-200 font-medium">{t.admin_display_name || t.admin_username || '-'}</div>
                            <div className="text-xs text-slate-500">{t.admin_username || 'admin yoxdur'}</div>
                          </td>
                          <td className="p-4">
                            <StatusPill active={!archived} archivedAt={t.archived_at} />
                          </td>
                          <td className="p-4">
                            <span className={cn(
                              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border',
                              t.whatsapp_status === 'connected'
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                                : 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                            )}>
                              <span className={cn('w-1.5 h-1.5 rounded-full', t.whatsapp_status === 'connected' ? 'bg-emerald-400' : 'bg-rose-400')} />
                              {t.whatsapp_status === 'connected' ? 'Connected' : 'Offline'}
                            </span>
                          </td>
                          <td className="p-4 text-sm text-slate-300">{t.user_count}</td>
                          <td className="p-4 text-sm text-slate-300">{t.lead_count}</td>
                          <td className="p-4">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button onClick={() => openDetails(t.tenant_id)} className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 inline-flex items-center gap-1.5">
                                <BarChart3 className="w-3.5 h-3.5" /> Ətraflı
                              </button>
                              <button
                                onClick={() => handleImpersonate(t.tenant_id)}
                                disabled={archived}
                                className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Login As <ArrowRight className="w-3.5 h-3.5" />
                              </button>
                              {t.tenant_id !== 'admin' ? (
                                archived ? (
                                  <button
                                    onClick={() => handleRestoreTenant(t.tenant_id)}
                                    disabled={busyTenantId === t.tenant_id}
                                    className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-200 inline-flex items-center gap-1.5 disabled:opacity-50"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" /> Bərpa et
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleArchiveTenant(t.tenant_id)}
                                    disabled={busyTenantId === t.tenant_id}
                                    className="px-3 py-1.5 rounded-xl text-xs font-semibold border border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/15 text-amber-200 inline-flex items-center gap-1.5 disabled:opacity-50"
                                  >
                                    <Archive className="w-3.5 h-3.5" /> Arxivə at
                                  </button>
                                )
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {visibleTenants.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-10 text-center text-slate-500">Filterə uyğun şirkət tapılmadı.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="rounded-3xl border border-slate-800 bg-slate-900/60 shadow-2xl shadow-black/20 p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-slate-100">Bu paneli niyə belə etdik</h3>
              <p className="text-sm text-slate-500 mt-1">Peşəkar CRM admin panellərində əsas 4 şey vacibdir: lifecycle, bulk əməliyyat, təhlükəsiz bərpa və sürətli tenant health görünüşü.</p>
            </div>

            <InsightCard title="Lifecycle" text="Silmək əvəzinə arxivləşdirmə riskləri azaldır və tenantı istənilən vaxt bərpa etməyə imkan verir." />
            <InsightCard title="Bulk import" text="Biznes adminlər eyni anda çox tenant yarada bilir; açılış mərhələsində vaxt itmir." />
            <InsightCard title="Search + segmented filters" text="Aktiv / Arxiv / Hamısı ayrımı böyük tenant sayında idarəetməni xeyli rahatlaşdırır." />
            <InsightCard title="Operational safety" text="Arxiv tenant üçün Login As bloklanır; əvvəl restore edilməlidir. Bu, yanlış əməliyyatların qarşısını alır." />
          </section>
        </div>
      </main>

      {selectedDetails ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-5xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-900/60">
              <div>
                <h3 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-rose-500" />
                  {selectedDetails.tenant?.display_name || selectedDetails.tenantId}
                </h3>
                <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                  <span>{selectedDetails.tenantId}</span>
                  {selectedDetails.tenant ? <StatusPill active={selectedDetails.tenant.status !== 'archived'} archivedAt={selectedDetails.tenant.archived_at} /> : null}
                </div>
              </div>
              <button onClick={() => setSelectedDetails(null)} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
              {selectedDetails.isLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                  <div className="w-8 h-8 border-4 border-slate-800 border-t-rose-500 rounded-full animate-spin mb-4" />
                  <p>Məlumatlar yüklənir...</p>
                </div>
              ) : (
                <div className="space-y-8">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <MiniStat label="Total müraciət" value={selectedDetails.leadStats?.total || 0} accent="text-white" />
                    <MiniStat label="Yeni" value={selectedDetails.leadStats?.new || 0} accent="text-blue-400" />
                    <MiniStat label="Qazanılan" value={selectedDetails.leadStats?.won || 0} accent="text-emerald-400" />
                    <MiniStat label="Gəlir" value={`₼${selectedDetails.leadStats?.total_won_value || 0}`} accent="text-yellow-400" />
                  </div>

                  <div>
                    <h4 className="text-lg font-semibold text-slate-200 mb-3 flex items-center gap-2">
                      <Users className="w-4 h-4 text-emerald-500" /> İstifadəçilər ({selectedDetails.users?.length || 0})
                    </h4>
                    <div className="bg-slate-950/50 border border-slate-800 rounded-2xl overflow-hidden">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-900 text-slate-500 border-b border-slate-800">
                          <tr>
                            <th className="px-4 py-3 font-medium">Username</th>
                            <th className="px-4 py-3 font-medium">Rol</th>
                            <th className="px-4 py-3 font-medium text-right">Yaradılıb</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {selectedDetails.users?.map((u: any) => (
                            <tr key={u.id} className="hover:bg-slate-900/50">
                              <td className="px-4 py-3 text-slate-200">{u.username}</td>
                              <td className="px-4 py-3"><span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium uppercase bg-slate-800 text-slate-300">{u.role}</span></td>
                              <td className="px-4 py-3 text-right text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-lg font-semibold text-slate-200 mb-3 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-blue-500" /> Son əlavə olan leadlər
                    </h4>
                    <div className="bg-slate-950/50 border border-slate-800 rounded-2xl overflow-hidden">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-900 text-slate-500 border-b border-slate-800">
                          <tr>
                            <th className="px-4 py-3 font-medium">Telefon / Ad</th>
                            <th className="px-4 py-3 font-medium">Məhsul</th>
                            <th className="px-4 py-3 font-medium">Status</th>
                            <th className="px-4 py-3 font-medium text-right">Tarix</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {selectedDetails.recentLeads?.length > 0 ? selectedDetails.recentLeads.map((l: any) => (
                            <tr key={l.id} className="hover:bg-slate-900/50">
                              <td className="px-4 py-3">
                                <div className="font-medium text-slate-200">{l.phone}</div>
                                {l.name ? <div className="text-xs text-slate-500">{l.name}</div> : null}
                              </td>
                              <td className="px-4 py-3 text-slate-400">{l.product_name || '-'}</td>
                              <td className="px-4 py-3"><span className="inline-flex px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-medium uppercase">{l.status}</span></td>
                              <td className="px-4 py-3 text-right text-slate-500">{new Date(l.created_at).toLocaleDateString()}</td>
                            </tr>
                          )) : (
                            <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">Heç bir müraciət tapılmadı</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 flex flex-col justify-center relative overflow-hidden min-h-[110px]">
      <div className="absolute top-0 right-0 w-32 h-32 bg-slate-500/5 rounded-full blur-2xl -mr-16 -mt-16" />
      <div className="flex items-center gap-2 text-slate-400 mb-2">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-3xl font-bold text-white">{value}</div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-2xl text-center">
      <div className="text-sm font-medium text-slate-400 mb-1">{label}</div>
      <div className={cn('text-2xl font-bold', accent || 'text-white')}>{value}</div>
    </div>
  );
}

function InsightCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4">
      <p className="text-sm font-semibold text-slate-100">{title}</p>
      <p className="mt-1 text-sm text-slate-500 leading-6">{text}</p>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      <input
        type="text"
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none"
      />
    </div>
  );
}
