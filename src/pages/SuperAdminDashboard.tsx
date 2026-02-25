import React, { useState, useEffect } from 'react';
import { useAppStore } from '../context/Store';
import { CrmService } from '../services/CrmService';
import {
    Users,
    Building2,
    Activity,
    LogOut,
    Plus,
    ArrowRight,
    ShieldAlert,
    Server,
    X,
    BarChart,
    Trash2
} from 'lucide-react';

interface TenantStatus {
    tenant_id: string;
    admin_username: string;
    created_at: string;
    user_count: number;
    lead_count: number;
    whatsapp_status: 'connected' | 'disconnected';
}

export default function SuperAdminDashboard() {
    const { currentUser, logout, impersonate } = useAppStore();
    const [tenants, setTenants] = useState<TenantStatus[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Create Form State
    const [isCreating, setIsCreating] = useState(false);
    const [newTenantId, setNewTenantId] = useState('');
    const [newAdminUser, setNewAdminUser] = useState('');
    const [newAdminPass, setNewAdminPass] = useState('kazimks12'); // Default
    const [createMsg, setCreateMsg] = useState({ type: '', text: '' });

    // Details Modal State
    const [selectedDetails, setSelectedDetails] = useState<any>(null);

    // Deletion State
    const [isDeleting, setIsDeleting] = useState<string | null>(null);

    const loadTenants = async () => {
        try {
            setLoading(true);
            const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('crm_auth_token')}` }
            });
            if (!res.ok) throw new Error('API Error');
            const data = await res.json();
            setTenants(data);
        } catch (err: any) {
            setError(err.message || 'Məlumatları yükləmək mümkün olmadı');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTenants();
    }, []);

    const handleCreateTenant = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreateMsg({ type: '', text: '' });

        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('crm_auth_token')}`
                },
                body: JSON.stringify({
                    tenantId: newTenantId,
                    adminUsername: newAdminUser,
                    adminPassword: newAdminPass
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Server xətası');

            setCreateMsg({ type: 'success', text: 'Yeni müştəri profili uğurla yaradıldı!' });
            setNewTenantId('');
            setNewAdminUser('');
            setIsCreating(false);
            loadTenants(); // refresh list
        } catch (err: any) {
            setCreateMsg({ type: 'error', text: err.message });
        }
    };

    const handleImpersonate = async (targetTenantId: string) => {
        if (confirm(`Bu profildən çıxış edib '${targetTenantId}' şirkətinin sisteminə daxil olmaq istədiyinizə əminsiniz?`)) {
            try {
                await impersonate(targetTenantId);
                window.location.href = '/crm';
            } catch (err) {
                // Error is alerted inside the store
            }
        }
    };

    const handleDeleteTenant = async (targetTenantId: string) => {
        if (!confirm(`DİQQƏT! '${targetTenantId}' şirkətini və bütün aidiyyatı məlumatlarını (leadlər, mesajlar, istifadəçilər) tamamilə SİLMƏK istədiyinizə əminsiniz? Bu əməliyyat GERİ QAYTARILMAZDIR!`)) {
            return;
        }

        setIsDeleting(targetTenantId);
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants/${targetTenantId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('crm_auth_token')}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Silinmə xətası');
            alert('Şirkət uğurla silindi!');
            loadTenants(); // Refresh the list
        } catch (err: any) {
            alert(err.message || 'Server xətası baş verdi');
        } finally {
            setIsDeleting(null);
        }
    };

    const openDetails = async (tenantId: string) => {
        setSelectedDetails({ tenantId, isLoading: true }); // Open modal immediately with loading state
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/admin/tenants/${tenantId}/details`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('crm_auth_token')}` }
            });
            if (!res.ok) throw new Error('Məlumatları yükləmək mümkün olmadı');
            const data = await res.json();
            setSelectedDetails({ ...data, isLoading: false });
        } catch (err) {
            alert('Ətraflı məlumat yüklənərkən xəta baş verdi.');
            setSelectedDetails(null);
        }
    };

    if (currentUser?.role !== 'superadmin') {
        return (
            <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
                <ShieldAlert className="w-16 h-16 text-rose-500 mb-4" />
                <h1 className="text-xl font-bold text-slate-200">Giriş Qadağandır</h1>
                <p className="text-slate-400 mt-2">Bu səhifəyə daxil olmaq üçün "Super Admin" səlahiyyətləri tələb olunur.</p>
                <button
                    onClick={() => window.location.href = '/crm'}
                    className="mt-6 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                    Geri Qayıt
                </button>
            </div>
        );
    }

    const globalMetrics = {
        totalTenants: tenants.length,
        totalLeads: tenants.reduce((acc, t) => acc + parseInt(t.lead_count as any), 0),
        totalUsers: tenants.reduce((acc, t) => acc + parseInt(t.user_count as any), 0),
        connectedWA: tenants.filter(t => t.whatsapp_status === 'connected').length
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-300 font-sans selection:bg-rose-500/30">
            {/* HEADER */}
            <header className="bg-slate-900 border-b border-rose-900/30 p-4 sticky top-0 z-30">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-rose-600 to-orange-500 flex items-center justify-center shadow-lg shadow-rose-900/20">
                            <ShieldAlert className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                                Super Admin <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 font-medium">Global</span>
                            </h1>
                            <p className="text-xs text-slate-500">Bütün müştəriləri və sistem statistikasını idarə edin</p>
                        </div>
                    </div>

                    <button
                        onClick={logout}
                        className="flex items-center gap-2 px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors bg-slate-800/50 hover:bg-slate-800 rounded-lg"
                    >
                        <LogOut className="w-4 h-4" />
                        <span className="hidden sm:inline">Çıxış</span>
                    </button>
                </div>
            </header>

            {/* MAIN CONTENT */}
            <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">

                {/* METRICS */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col justify-center relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/5 rounded-full blur-2xl -mr-16 -mt-16"></div>
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                            <Building2 className="w-4 h-4 text-rose-400" />
                            <span className="text-xs font-semibold uppercase tracking-wider">Aktiv Müştəri</span>
                        </div>
                        <div className="text-3xl font-bold text-white">{globalMetrics.totalTenants}</div>
                    </div>

                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col justify-center">
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                            <Activity className="w-4 h-4 text-blue-400" />
                            <span className="text-xs font-semibold uppercase tracking-wider">Ümumi Leadlər</span>
                        </div>
                        <div className="text-3xl font-bold text-white">{globalMetrics.totalLeads}</div>
                    </div>

                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col justify-center">
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                            <Users className="w-4 h-4 text-emerald-400" />
                            <span className="text-xs font-semibold uppercase tracking-wider">Sistem İstifadəçisi</span>
                        </div>
                        <div className="text-3xl font-bold text-white">{globalMetrics.totalUsers}</div>
                    </div>

                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col justify-center">
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                            <Server className="w-4 h-4 text-violet-400" />
                            <span className="text-xs font-semibold uppercase tracking-wider">Aktiv WhatsApp</span>
                        </div>
                        <div className="text-3xl font-bold text-white relative flex items-center gap-3">
                            {globalMetrics.connectedWA}
                            <span className="relative flex h-3 w-3">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-3 w-3 bg-violet-500"></span>
                            </span>
                        </div>
                    </div>
                </div>

                {/* TENANTS LIST & CREATION */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl shadow-black/20">
                    <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
                        <h2 className="text-lg font-semibold text-slate-200">Sistemdəki Şirkətlər</h2>
                        <button
                            onClick={() => setIsCreating(!isCreating)}
                            className="flex items-center gap-2 px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-rose-900/20"
                        >
                            <Plus className="w-4 h-4" />
                            Yeni Şirkət
                        </button>
                    </div>

                    {/* CREATE TENANT FORM */}
                    {isCreating && (
                        <div className="p-6 bg-slate-800/20 border-b border-slate-800">
                            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                                <Building2 className="w-4 h-4 text-rose-400" /> Yeni Sistem İcarəçisi Əlavə Et
                            </h3>

                            {createMsg.text && (
                                <div className={`mb-4 p-3 rounded-lg text-sm ${createMsg.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'}`}>
                                    {createMsg.text}
                                </div>
                            )}

                            <form onSubmit={handleCreateTenant} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Şirkət ID (Tenant ID)</label>
                                    <input
                                        type="text"
                                        required
                                        placeholder="ornek-sirket"
                                        value={newTenantId}
                                        onChange={(e) => setNewTenantId(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none"
                                    />
                                    <p className="text-[10px] text-slate-600 mt-1">Yalnız ingilis hərfləri və rəqəm</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Admin Username</label>
                                    <input
                                        type="text"
                                        required
                                        placeholder="admin_orneksirket"
                                        value={newAdminUser}
                                        onChange={(e) => setNewAdminUser(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">Admin Şifrə (Varsayılan)</label>
                                    <input
                                        type="text"
                                        required
                                        value={newAdminPass}
                                        onChange={(e) => setNewAdminPass(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-slate-400 outline-none"
                                    />
                                </div>
                                <div>
                                    <button type="submit" className="w-full bg-rose-600 hover:bg-rose-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
                                        Profili Yarat
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}

                    {/* TENANTS TABLE */}
                    <div className="overflow-x-auto">
                        {loading ? (
                            <div className="p-8 text-center text-slate-500">Yüklənir...</div>
                        ) : error ? (
                            <div className="p-8 text-center text-rose-400">{error}</div>
                        ) : (
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="bg-slate-950 border-b border-slate-800 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                                        <th className="p-4 rounded-tl-lg">Tenant ID</th>
                                        <th className="p-4">Admin Username</th>
                                        <th className="p-4">WhatsApp Status</th>
                                        <th className="p-4">İstifadəçilər</th>
                                        <th className="p-4">Leadlər</th>
                                        <th className="p-4 text-right rounded-tr-lg">Əməliyyatlar</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/50">
                                    {tenants.map(t => (
                                        <tr key={t.tenant_id} className="hover:bg-slate-800/20 transition-colors group">
                                            <td className="p-4">
                                                <div className="font-medium text-slate-200">{t.tenant_id}</div>
                                                <div className="text-[10px] text-slate-600">{new Date(t.created_at).toLocaleDateString()}</div>
                                            </td>
                                            <td className="p-4 text-sm text-slate-300">
                                                {t.admin_username}
                                            </td>
                                            <td className="p-4">
                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${t.whatsapp_status === 'connected'
                                                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                                    : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                                                    }`}>
                                                    <span className={`w-1.5 h-1.5 rounded-full ${t.whatsapp_status === 'connected' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                                                    {t.whatsapp_status === 'connected' ? 'Connected' : 'Offline'}
                                                </span>
                                            </td>
                                            <td className="p-4 text-sm text-slate-300">
                                                <div className="flex items-center gap-1">
                                                    <Users className="w-3.5 h-3.5 text-slate-500" />
                                                    {t.user_count}
                                                </div>
                                            </td>
                                            <td className="p-4 text-sm text-slate-300">
                                                <div className="flex items-center gap-1">
                                                    <Activity className="w-3.5 h-3.5 text-slate-500" />
                                                    {t.lead_count}
                                                </div>
                                            </td>
                                            <td className="p-4 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <button
                                                        onClick={() => openDetails(t.tenant_id)}
                                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-emerald-500/30 text-slate-300 hover:text-white text-xs font-medium rounded-lg transition-all"
                                                    >
                                                        <BarChart className="w-3.5 h-3.5" /> Ətraflı
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            handleImpersonate(t.tenant_id);
                                                        }}
                                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-blue-500/30 text-slate-300 hover:text-white text-xs font-medium rounded-lg transition-all"
                                                    >
                                                        Login As <ArrowRight className="w-3.5 h-3.5" />
                                                    </button>
                                                    {t.tenant_id !== 'admin' && (
                                                        <button
                                                            type="button"
                                                            disabled={isDeleting === t.tenant_id}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                handleDeleteTenant(t.tenant_id);
                                                            }}
                                                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-rose-500/10 border border-slate-700 hover:border-rose-500/30 text-slate-300 hover:text-rose-400 text-xs font-medium rounded-lg transition-all ${isDeleting === t.tenant_id ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                        >
                                                            {isDeleting === t.tenant_id ? (
                                                                <div className="w-3.5 h-3.5 border-2 border-rose-500 border-t-transparent rounded-full animate-spin"></div>
                                                            ) : (
                                                                <Trash2 className="w-3.5 h-3.5" />
                                                            )}
                                                            Sil
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                    {tenants.length === 0 && (
                                        <tr>
                                            <td colSpan={6} className="p-8 text-center text-slate-500">
                                                Hələ heç bir şirkət profili yaradılmayıb.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>

            </main>

            {/* DETAILS MODAL */}
            {selectedDetails && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
                        <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-900/50">
                            <div>
                                <h3 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                                    <Building2 className="w-5 h-5 text-rose-500" />
                                    Şirkət Detalları: {selectedDetails.tenantId}
                                </h3>
                                <p className="text-sm text-slate-400 mt-1">Bu profil üzrə detallı statistika və istifadəçilər</p>
                            </div>
                            <button
                                onClick={() => setSelectedDetails(null)}
                                className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
                            {selectedDetails.isLoading ? (
                                <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                                    <div className="w-8 h-8 border-4 border-slate-800 border-t-rose-500 rounded-full animate-spin mb-4"></div>
                                    <p>Məlumatlar yüklənir...</p>
                                </div>
                            ) : (
                                <div className="space-y-8">
                                    {/* Stats Grid */}
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                        <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl text-center">
                                            <div className="text-sm font-medium text-slate-400 mb-1">Total Müraciət</div>
                                            <div className="text-2xl font-bold text-white">{selectedDetails.leadStats?.total || 0}</div>
                                        </div>
                                        <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl text-center">
                                            <div className="text-sm font-medium text-slate-400 mb-1">Yeni</div>
                                            <div className="text-2xl font-bold text-blue-400">{selectedDetails.leadStats?.new || 0}</div>
                                        </div>
                                        <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl text-center">
                                            <div className="text-sm font-medium text-slate-400 mb-1">Qazanılan</div>
                                            <div className="text-2xl font-bold text-emerald-400">{selectedDetails.leadStats?.won || 0}</div>
                                        </div>
                                        <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl text-center">
                                            <div className="text-sm font-medium text-slate-400 mb-1">Gəlir</div>
                                            <div className="text-2xl font-bold text-yellow-400">₼{selectedDetails.leadStats?.total_won_value || 0}</div>
                                        </div>
                                    </div>

                                    {/* Users List */}
                                    <div>
                                        <h4 className="text-lg font-semibold text-slate-200 mb-3 flex items-center gap-2">
                                            <Users className="w-4 h-4 text-emerald-500" />
                                            İstifadəçilər ({selectedDetails.users?.length || 0})
                                        </h4>
                                        <div className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden">
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
                                                            <td className="px-4 py-3">
                                                                <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium uppercase ${u.role === 'admin' ? 'bg-rose-500/10 text-rose-400' : 'bg-blue-500/10 text-blue-400'}`}>
                                                                    {u.role}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-right text-slate-500">
                                                                {new Date(u.created_at).toLocaleDateString()}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>

                                    {/* Recent Leads */}
                                    <div>
                                        <h4 className="text-lg font-semibold text-slate-200 mb-3 flex items-center gap-2">
                                            <Activity className="w-4 h-4 text-blue-500" />
                                            Son Əlavə Olan Leadlər
                                        </h4>
                                        <div className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden">
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
                                                    {selectedDetails.recentLeads?.length > 0 ? (
                                                        selectedDetails.recentLeads.map((l: any) => (
                                                            <tr key={l.id} className="hover:bg-slate-900/50">
                                                                <td className="px-4 py-3">
                                                                    <div className="font-medium text-slate-200">{l.phone}</div>
                                                                    {l.name && <div className="text-xs text-slate-500">{l.name}</div>}
                                                                </td>
                                                                <td className="px-4 py-3 text-slate-400">{l.product_name || '-'}</td>
                                                                <td className="px-4 py-3">
                                                                    <span className="inline-flex px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-medium uppercase">
                                                                        {l.status}
                                                                    </span>
                                                                </td>
                                                                <td className="px-4 py-3 text-right text-slate-500">
                                                                    {new Date(l.created_at).toLocaleDateString()}
                                                                </td>
                                                            </tr>
                                                        ))
                                                    ) : (
                                                        <tr>
                                                            <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                                                                Heç bir müraciət tapılmadı
                                                            </td>
                                                        </tr>
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
            )}
        </div>
    );
}
