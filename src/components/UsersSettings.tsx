import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Shield, User as UserIcon, AlertCircle } from 'lucide-react';
import { CrmService } from '../services/CrmService';

interface User {
    id: string;
    username: string;
    role: 'admin' | 'worker';
    created_at: string;
}

export function UsersSettings() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    // New user form state
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<'admin' | 'worker'>('worker');

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
                body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
            });
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'İstifadəçi yaradıla bilmədi');

            setUsers([data, ...users]);
            setIsCreating(false);
            setNewUsername('');
            setNewPassword('');
            setNewRole('worker');
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

    if (loading) return <div className="p-4 text-center text-slate-400 text-sm">Yüklənir...</div>;

    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-sm font-bold text-white">İstifadəçilər</h2>
                <p className="text-xs text-slate-500 mt-0.5">Sistemə giriş icazəsi olan əməkdaşları idarə edin</p>
            </div>

            {error && (
                <div className="bg-red-950/40 border border-red-900/50 rounded-lg p-3 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-red-300 font-medium">{error}</p>
                </div>
            )}

            {isCreating ? (
                <form onSubmit={handleCreateUser} className="bg-slate-900 border border-slate-700 rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-semibold text-white mb-2">Yeni İstifadəçi</h3>

                    <div className="grid grid-cols-2 gap-3">
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
                        <label className="block text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1 m-1">Rol</label>
                        <select
                            value={newRole}
                            onChange={(e: any) => setNewRole(e.target.value)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors appearance-none"
                        >
                            <option value="worker">İşçi (Yalnız daxil ola və öz leadlarını idarə edə bilər)</option>
                            <option value="admin">İdarəçi (Bütün hüquqlara sahibdir)</option>
                        </select>
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
                {users.map(user => (
                    <div key={user.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${user.role === 'admin' ? 'bg-amber-500/10 text-amber-500' : 'bg-blue-500/10 text-blue-500'}`}>
                                {user.role === 'admin' ? <Shield className="w-4 h-4" /> : <UserIcon className="w-4 h-4" />}
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-white leading-none">{user.username}</p>
                                <p className="text-[10px] text-slate-500 mt-1 capitalize">{user.role === 'admin' ? 'İdarəçi' : 'İşçi'}</p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <button onClick={() => handleDeleteUser(user.id, user.username)} className="p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800">
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
