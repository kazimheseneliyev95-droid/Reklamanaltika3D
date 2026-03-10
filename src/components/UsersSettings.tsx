import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Shield, User as UserIcon, AlertCircle, Settings2, CheckSquare, Square } from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { UserPermissions, User as StoreUser } from '../types/crm';

interface User extends StoreUser { }

const DEFAULT_PERMISSIONS: Record<string, UserPermissions> = {
    worker: { view_all_leads: false, send_messages: true, change_status: true, view_budget: false },
    manager: { view_all_leads: true, change_status: true, view_budget: true, view_stats: true, view_other_operator_stats: true },
    admin: { view_all_leads: true, change_status: true, view_budget: true, edit_budget: true, send_messages: true, manage_users: true, view_stats: true, view_roi: true, view_other_operator_stats: true },
    viewer: { view_all_leads: true, view_budget: false, send_messages: false, change_status: false }
};

const PERMISSION_LABELS: Record<keyof UserPermissions, string> = {
    view_all_leads: 'Bütün leadləri görə bilər',
    create_lead: 'Yeni lead yarada bilər',
    delete_lead: 'Lead silə bilər',
    change_status: 'Status (Mərhələ) dəyişə bilər',
    view_budget: 'Büdcəni görə bilər',
    edit_budget: 'Büdcəni redaktə edə bilər',
    send_messages: 'Mesaj yaza bilər',
    use_templates: 'Hazır şablonlardan istifadə edə bilər',
    delete_message_history: 'Mesaj tarixçəsini silə bilər',
    send_media: 'Media (şəkil/video) göndərə bilər',
    view_stats: 'Statistika panelini görə bilər',
    view_roi: 'ROI (Gəlirlilik) görə bilər',
    view_other_operator_stats: 'Digər operatorların statistikasını görə bilər',
    manage_users: 'İstifadəçi əlavə/redaktə edə bilər',
    manage_kanban_columns: 'Kanban sütunlarını dəyişə bilər',
    create_custom_fields: 'Xüsusi sahə (custom field) yarada bilər',
    factory_reset: 'Sistemi sıfırlaya bilər (Formatla)'
};

export function UsersSettings() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    // New user form state
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<'admin' | 'worker' | 'manager' | 'viewer'>('worker');
    const [newPermissions, setNewPermissions] = useState<UserPermissions>(DEFAULT_PERMISSIONS['worker']);
    const [showAdvancedPerms, setShowAdvancedPerms] = useState(false);

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users`, {
                headers: CrmService['getAuthHeaders']()
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'İstifadəçiləri yükləmək mümkün olmadı');
            setUsers(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleRoleChange = (role: any) => {
        setNewRole(role);
        setNewPermissions(DEFAULT_PERMISSIONS[role] || {});
    };

    const togglePermission = (key: keyof UserPermissions) => {
        setNewPermissions(prev => ({
            ...prev,
            [key]: !prev[key]
        }));
    };

    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...CrmService['getAuthHeaders']()
                },
                body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole, permissions: newPermissions })
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'İstifadəçi yaradıla bilmədi');

            setUsers([data, ...users]);
            setIsCreating(false);
            setNewUsername('');
            setNewPassword('');
            setNewRole('worker');
            setNewPermissions(DEFAULT_PERMISSIONS['worker']);
            setShowAdvancedPerms(false);
        } catch (err: any) {
            setError(err.message);
        }
    };

    const handleDeleteUser = async (id: string, username: string) => {
        if (!window.confirm(`"${username}" istifadəçisini silmək istədiyinizə əminsiniz?`)) return;

        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users/${id}`, {
                method: 'DELETE',
                headers: CrmService['getAuthHeaders']()
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Silinmə zamanı xəta baş verdi');
            }

            setUsers(users.filter(u => u.id !== id));
        } catch (err: any) {
            alert(err.message);
        }
    };

    const roleColors: Record<string, string> = {
        admin: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        manager: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        worker: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
        viewer: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
        superadmin: 'bg-purple-500/10 text-purple-500 border-purple-500/20'
    };

    if (loading) return <div className="p-4 text-center text-slate-400 text-sm">Yüklənir...</div>;

    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-sm font-bold text-white">İstifadəçilər & İcazələr</h2>
                <p className="text-xs text-slate-500 mt-0.5">Sistemə giriş icazəsi olan əməkdaşları idarə edin</p>
            </div>

            {error && (
                <div className="bg-red-950/40 border border-red-900/50 rounded-lg p-3 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-red-300 font-medium">{error}</p>
                </div>
            )}

            {isCreating ? (
                <form onSubmit={handleCreateUser} className="bg-slate-900 border border-slate-700 rounded-xl p-4 space-y-4">
                    <h3 className="text-xs font-semibold text-white mb-2">Yeni İstifadəçi</h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1 m-1">İstifadəçi Adı</label>
                            <input
                                required
                                value={newUsername}
                                onChange={e => setNewUsername(e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1 m-1">Şifrə</label>
                            <input
                                required
                                type="password"
                                value={newPassword}
                                onChange={e => setNewPassword(e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1 m-1">Rol Şablonu</label>
                        <select
                            value={newRole}
                            onChange={(e: any) => handleRoleChange(e.target.value)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors appearance-none"
                        >
                            <option value="worker">Operator (Yalnız öz leadləri)</option>
                            <option value="manager">Satış Meneceri (Hamını görür, admin deyil)</option>
                            <option value="admin">İdarəçi (Tam yetkili)</option>
                            <option value="viewer">Müşahidəçi (Yalnız Oxuma)</option>
                        </select>
                    </div>

                    <div className="border border-slate-800 rounded-lg bg-slate-950 p-3">
                        <button
                            type="button"
                            onClick={() => setShowAdvancedPerms(!showAdvancedPerms)}
                            className="flex items-center justify-between w-full text-xs font-medium text-slate-300 hover:text-white"
                        >
                            <span className="flex items-center gap-2">
                                <Settings2 className="w-3.5 h-3.5 text-blue-400" />
                                Ətraflı İcazələr (Custom Permissions)
                            </span>
                            <span className="text-[10px] text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded-full">
                                {Object.keys(newPermissions).filter(k => (newPermissions as any)[k]).length} aktiv
                            </span>
                        </button>

                        {showAdvancedPerms && (
                            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">
                                {(Object.keys(PERMISSION_LABELS) as Array<keyof UserPermissions>).map(key => {
                                    const isChecked = !!newPermissions[key];
                                    return (
                                        <div
                                            key={key}
                                            onClick={() => togglePermission(key)}
                                            className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors border ${isChecked ? 'bg-blue-500/10 border-blue-500/30' : 'bg-slate-900 border-slate-800 hover:border-slate-700'}`}
                                        >
                                            <div className="mt-0.5 text-blue-500 shrink-0">
                                                {isChecked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-slate-500" />}
                                            </div>
                                            <span className={`text-[11px] leading-snug ${isChecked ? 'text-blue-100 font-medium' : 'text-slate-400'}`}>
                                                {PERMISSION_LABELS[key]}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" onClick={() => setIsCreating(false)} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">Ləğv et</button>
                        <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition-colors">Yarat</button>
                    </div>
                </form>
            ) : (
                <button
                    onClick={() => setIsCreating(true)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-xs font-medium transition-colors w-full justify-center"
                >
                    <Plus className="w-3.5 h-3.5" />
                    Yeni İstifadəçi Əlavə Et
                </button>
            )}

            <div className="space-y-2">
                {users.map(user => {
                    const activePermsCount = user.permissions ? Object.keys(user.permissions).filter(k => (user.permissions as any)[k]).length : 0;

                    return (
                        <div key={user.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center border ${roleColors[user.role] || roleColors['worker']}`}>
                                    {user.role === 'admin' || user.role === 'superadmin' ? <Shield className="w-4 h-4" /> : <UserIcon className="w-4 h-4" />}
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-white flex flex-wrap items-center gap-2">
                                        <span className="truncate max-w-[170px] sm:max-w-none">{user.username}</span>
                                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider border ${roleColors[user.role] || roleColors['worker']}`}>
                                            {user.role}
                                        </span>
                                    </p>
                                    <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1.5">
                                        <Settings2 className="w-3 h-3" />
                                        {activePermsCount} xüsusi icazə
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-2 sm:self-auto self-end">
                                {/* Future: Edit User button could go here */}
                                <button onClick={() => handleDeleteUser(user.id, user.username)} className="p-2 text-slate-600 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

