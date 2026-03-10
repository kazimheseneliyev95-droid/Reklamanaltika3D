import { useState, useEffect } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { format } from 'date-fns';

interface AuditLog {
    id: number;
    tenant_id: string;
    user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    details: any;
    created_at: string;
    user_name?: string; // We might need to join or map this, assuming basic details for now
}

export function AuditLogs() {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        loadLogs();
    }, []);

    const loadLogs = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/audit-logs`, {
                headers: CrmService['getAuthHeaders']()
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Audit logları yükləmək mümkün olmadı');
            setLogs(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const getActionBadge = (action: string) => {
        if (action.includes('DELETE') || action.includes('RESET')) return 'bg-red-500/10 text-red-500 border-red-500/20';
        if (action.includes('CREATE') || action.includes('NEW')) return 'bg-green-500/10 text-green-500 border-green-500/20';
        if (action.includes('UPDATE') || action.includes('EDIT')) return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
        return 'bg-slate-800 text-slate-300 border-slate-700';
    };

    if (loading) return <div className="p-8 text-center text-slate-400">Yüklənir...</div>;

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                <div>
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                        <Activity className="w-5 h-5 text-blue-400" />
                        Audit Logları (Fəaliyyət Tarixçəsi)
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">Sistemdə baş verən əhəmiyyətli məlumat dəyişikliklərini izləyin</p>
                </div>

                <button
                    onClick={loadLogs}
                    className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm transition-colors border border-slate-700"
                >
                    <RefreshCw className="w-4 h-4" />
                    Yenilə
                </button>
            </div>

            {error && (
                <div className="bg-red-950/50 border border-red-900 rounded-lg p-4 text-sm text-red-300">
                    {error}
                </div>
            )}

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-300">
                        <thead className="bg-slate-950 border-b border-slate-800 text-xs uppercase text-slate-500">
                            <tr>
                                <th className="px-4 py-3 font-semibold">Tarix</th>
                                <th className="px-4 py-3 font-semibold">İstifadəçi</th>
                                <th className="px-4 py-3 font-semibold">Hadisə</th>
                                <th className="px-4 py-3 font-semibold">Təsir Sahəsi</th>
                                <th className="px-4 py-3 font-semibold">Detallar</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                            {logs.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                                        Heç bir qeyd tapılmadı
                                    </td>
                                </tr>
                            ) : logs.map((log) => (
                                <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                                        {format(new Date(log.created_at), 'dd MMM yyyy, HH:mm:ss')}
                                    </td>
                                    <td className="px-4 py-3 font-medium text-slate-200">
                                        {/* Ideally we join user name in backend, for now show ID fallback */}
                                        {log.user_id ? log.user_id.substring(0, 8) + '...' : 'Sistem'}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${getActionBadge(log.action)}`}>
                                            {log.action}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-slate-400 capitalize">
                                        {log.entity_type} {log.entity_id && <span className="text-slate-500 text-[10px] ml-1">({log.entity_id.substring(0, 8)})</span>}
                                    </td>
                                    <td className="px-4 py-3 text-xs font-mono text-slate-400 max-w-[200px] truncate" title={JSON.stringify(log.details)}>
                                        {JSON.stringify(log.details)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
