import React, { useState } from 'react';
import { Lock, LogIn, AlertCircle } from 'lucide-react';
import { useAppStore } from '../context/Store';

export default function Login() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const { login, isLoading, error } = useAppStore();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        await login(username, password);
    };

    return (
        <div className="min-h-screen bg-[#0d1117] flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">

                {/* Header */}
                <div className="bg-[#111827] border-b border-white/5 p-6 text-center">
                    <div className="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/20">
                        <Lock className="w-8 h-8 text-blue-400" />
                    </div>
                    <h2 className="text-2xl font-bold text-white tracking-tight">CRM Giriş</h2>
                    <p className="text-sm text-slate-500 mt-2">Davam etmək üçün deytalları daxil edin</p>
                </div>

                {/* Form Body */}
                <form onSubmit={handleLogin} className="p-6 space-y-5">
                    {error && (
                        <div className="bg-red-950/40 border border-red-900/50 rounded-lg p-3 flex items-start gap-2.5">
                            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                            <p className="text-sm text-red-300 font-medium">{error}</p>
                        </div>
                    )}

                    <div>
                        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5 ml-1">İstifadəçi Adı</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="w-full bg-[#0d1117] border border-slate-700/50 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-shadow"
                            placeholder="admin"
                            required
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5 ml-1">Şifrə</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full bg-[#0d1117] border border-slate-700/50 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-shadow"
                            placeholder="••••••••"
                            required
                        />
                    </div>

                    <div className="pt-2">
                        <button
                            type="submit"
                            disabled={isLoading || !username || !password}
                            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold py-3 px-4 rounded-xl shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                        >
                            {isLoading ? (
                                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                            ) : (
                                <>Daxil Ol <LogIn className="w-4 h-4" /></>
                            )}
                        </button>
                    </div>
                </form>

            </div>
        </div>
    );
}
