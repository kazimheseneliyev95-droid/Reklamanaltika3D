import { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, CheckCircle2, XCircle, RotateCcw, Trash2, Clock,
    User as UserIcon, RefreshCcw, Archive, ShieldAlert
} from 'lucide-react';
import { cn } from '../lib/utils';
import { CrmService } from '../services/CrmService';

type DangerRequest = {
    id: string;
    tenant_id: string;
    requester_user_id: string | null;
    requester_username: string | null;
    action_type: 'factory_reset' | 'delete_all_data' | 'clear_chat_history';
    payload?: any;
    reason?: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'cancelled';
    decided_by_username?: string | null;
    decided_at?: string | null;
    decision_reason?: string | null;
    executed_at?: string | null;
    archive_expires_at?: string | null;
    affected_count?: number | null;
    last_error?: string | null;
    created_at: string;
};

const ACTION_LABELS: Record<string, string> = {
    factory_reset: 'Sistemi sıfırla (Bütün leadlər + mesajlar)',
    delete_all_data: 'Bütün məlumatları sil',
    clear_chat_history: 'Bütün mesaj tarixçəsini sil',
};

const STATUS_THEME: Record<string, { dot: string; text: string; label: string; border: string; bg: string }> = {
    pending: { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-200', label: 'Gözləyir', border: 'border-amber-900/50', bg: 'bg-amber-950/15' },
    executed: { dot: 'bg-rose-500', text: 'text-rose-200', label: 'İcra olundu (arxivdə)', border: 'border-rose-900/50', bg: 'bg-rose-950/15' },
    rejected: { dot: 'bg-slate-500', text: 'text-slate-300', label: 'Rədd edildi', border: 'border-slate-800', bg: 'bg-slate-950/40' },
    failed: { dot: 'bg-rose-600', text: 'text-rose-300', label: 'Uğursuz oldu', border: 'border-rose-900/50', bg: 'bg-rose-950/25' },
    cancelled: { dot: 'bg-emerald-500', text: 'text-emerald-200', label: 'Bərpa edildi', border: 'border-emerald-900/50', bg: 'bg-emerald-950/15' },
    approved: { dot: 'bg-blue-500', text: 'text-blue-200', label: 'Təsdiqləndi', border: 'border-blue-900/50', bg: 'bg-blue-950/15' },
};

function timeAgo(iso?: string | null): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = Math.floor((Date.now() - t) / 1000);
    if (diff < 60) return diff + 's əvvəl';
    if (diff < 3600) return Math.floor(diff / 60) + ' dəq əvvəl';
    if (diff < 86400) return Math.floor(diff / 3600) + ' saat əvvəl';
    return Math.floor(diff / 86400) + ' gün əvvəl';
}

function daysUntil(iso?: string | null): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    return Math.ceil((t - Date.now()) / (1000 * 60 * 60 * 24));
}

export function DangerActionRequests() {
    const [requests, setRequests] = useState<DangerRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [filter, setFilter] = useState<'all' | 'pending' | 'executed' | 'rejected'>('pending');

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const url = CrmService.getServerUrl();
            const token = localStorage.getItem('crm_auth_token');
            const params = filter === 'all' ? '' : `?status=${filter}`;
            const res = await fetch(`${url}/api/danger-actions${params}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Sorğular oxunmadı');
            setRequests(Array.isArray(data?.requests) ? data.requests : []);
        } catch (e: any) {
            setError(e?.message || 'Sorğular oxunmadı');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 15000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter]);

    const callAction = async (id: string, action: 'approve' | 'reject' | 'restore' | 'purge', body?: any) => {
        setBusyId(id);
        try {
            const url = CrmService.getServerUrl();
            const token = localStorage.getItem('crm_auth_token');
            const method = action === 'purge' ? 'DELETE' : 'POST';
            const res = await fetch(`${url}/api/danger-actions/${id}/${action}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Əməliyyat uğursuz oldu');
            await refresh();
        } catch (e: any) {
            alert(e?.message || 'Əməliyyat uğursuz oldu');
        } finally {
            setBusyId(null);
        }
    };

    const handleApprove = (req: DangerRequest) => {
        if (!window.confirm(`"${ACTION_LABELS[req.action_type]}" əməliyyatını təsdiqlə?\n\nMəlumatlar 30 günlük arxivə daşınacaq və istənilən vaxt bərpa edə bilərsən.`)) return;
        callAction(req.id, 'approve');
    };

    const handleReject = (req: DangerRequest) => {
        const reason = window.prompt('Rədd səbəbi (operatora göstəriləcək):') || '';
        callAction(req.id, 'reject', { reason });
    };

    const handleRestore = (req: DangerRequest) => {
        if (!window.confirm('Arxivdəki bütün məlumatlar bərpa olunacaq. Davam edək?')) return;
        callAction(req.id, 'restore');
    };

    const handlePurge = (req: DangerRequest) => {
        if (!window.confirm('⚠️ Arxiv DƏRHAL HARD-DELETE olacaq. Bu əməliyyat geri alına bilməz!\n\nDavam edək?')) return;
        callAction(req.id, 'purge');
    };

    const pendingCount = useMemo(() => requests.filter(r => r.status === 'pending').length, [requests]);
    const executedCount = useMemo(() => requests.filter(r => r.status === 'executed').length, [requests]);

    return (
        <section className="rounded-3xl border border-rose-900/30 bg-slate-900/60 shadow-2xl shadow-black/20 p-5 sm:p-6 space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                        <ShieldAlert className="w-5 h-5 text-rose-400" />
                    </div>
                    <div>
                        <h2 className="text-base font-bold text-slate-100">Təhlükəli Əməliyyatlar (Approval Queue)</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            Operatorlar tərəfindən tələb edilən əməliyyatlar. Təsdiqdən sonra məlumatlar 30 günlük arxivə daşınır.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {pendingCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs font-extrabold">
                            <Clock className="w-3 h-3" />
                            {pendingCount} gözləyir
                        </span>
                    ) : null}
                    {executedCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-200 text-xs font-extrabold">
                            <Archive className="w-3 h-3" />
                            {executedCount} arxivdə
                        </span>
                    ) : null}
                    <button
                        onClick={refresh}
                        className="p-2 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300"
                        title="Yenilə"
                    >
                        <RefreshCcw className={cn('w-4 h-4', loading && 'animate-spin')} />
                    </button>
                </div>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/40 p-1 w-fit">
                {(['pending', 'executed', 'rejected', 'all'] as const).map((f) => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={cn(
                            'px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors',
                            filter === f ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                        )}
                    >
                        {f === 'pending' ? 'Gözləyən' : f === 'executed' ? 'Arxivdə' : f === 'rejected' ? 'Rədd' : 'Hamısı'}
                    </button>
                ))}
            </div>

            {error ? (
                <div className="rounded-lg border border-rose-900/40 bg-rose-950/15 px-3 py-2 text-[11px] text-rose-300">
                    {error}
                </div>
            ) : null}

            {requests.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/20 p-8 text-center">
                    <CheckCircle2 className="w-10 h-10 text-emerald-400/40 mx-auto mb-2" />
                    <p className="text-sm text-slate-400">Sorğu yoxdur</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {requests.map((req) => {
                        const theme = STATUS_THEME[req.status] || STATUS_THEME.pending;
                        const isPending = req.status === 'pending';
                        const isExecuted = req.status === 'executed';
                        const expiresIn = daysUntil(req.archive_expires_at);
                        const expired = expiresIn !== null && expiresIn <= 0;

                        return (
                            <div
                                key={req.id}
                                className={cn('rounded-xl border p-4', theme.border, theme.bg)}
                            >
                                <div className="flex items-start justify-between gap-3 flex-wrap">
                                    <div className="flex items-start gap-3 min-w-0 flex-1">
                                        <div className="w-10 h-10 rounded-xl border border-rose-500/30 bg-rose-950/40 flex items-center justify-center shrink-0">
                                            <AlertTriangle className="w-5 h-5 text-rose-400" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h3 className="text-sm font-bold text-slate-100 truncate">
                                                    {ACTION_LABELS[req.action_type] || req.action_type}
                                                </h3>
                                                <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-extrabold border', theme.border, theme.bg, theme.text)}>
                                                    <span className={cn('w-1.5 h-1.5 rounded-full', theme.dot)} />
                                                    {theme.label}
                                                </span>
                                            </div>
                                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                                                <span className="inline-flex items-center gap-1">
                                                    <UserIcon className="w-3 h-3" />
                                                    {req.requester_username || 'naməlum'}
                                                </span>
                                                <span className="text-slate-600">·</span>
                                                <span className="inline-flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {timeAgo(req.created_at)}
                                                </span>
                                                <span className="text-slate-600">·</span>
                                                <span className="font-mono text-slate-500">tenant: {req.tenant_id}</span>
                                                {typeof req.affected_count === 'number' && req.affected_count > 0 ? (
                                                    <>
                                                        <span className="text-slate-600">·</span>
                                                        <span className="text-rose-300 font-bold">{req.affected_count} satır</span>
                                                    </>
                                                ) : null}
                                            </div>
                                            {req.reason ? (
                                                <p className="mt-2 text-[11px] text-slate-300 italic">"{req.reason}"</p>
                                            ) : null}
                                            {req.last_error ? (
                                                <p className="mt-2 text-[11px] text-rose-300 font-bold">Xəta: {req.last_error}</p>
                                            ) : null}
                                            {req.decision_reason && req.status === 'rejected' ? (
                                                <p className="mt-2 text-[11px] text-slate-400">Rədd səbəbi: {req.decision_reason}</p>
                                            ) : null}
                                            {isExecuted && expiresIn !== null ? (
                                                <p className={cn('mt-2 text-[11px] font-bold', expired ? 'text-rose-400' : expiresIn < 5 ? 'text-amber-300' : 'text-slate-400')}>
                                                    {expired ? '⚠ Arxiv müddəti bitib' : `🗄 ${expiresIn} gün arxivdə qalır`}
                                                </p>
                                            ) : null}
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                        {isPending ? (
                                            <>
                                                <button
                                                    onClick={() => handleApprove(req)}
                                                    disabled={busyId === req.id}
                                                    className="px-3 py-1.5 rounded-lg text-[11px] font-extrabold bg-rose-600 hover:bg-rose-500 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
                                                >
                                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                                    Təsdiqlə
                                                </button>
                                                <button
                                                    onClick={() => handleReject(req)}
                                                    disabled={busyId === req.id}
                                                    className="px-3 py-1.5 rounded-lg text-[11px] font-extrabold border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
                                                >
                                                    <XCircle className="w-3.5 h-3.5" />
                                                    Rədd et
                                                </button>
                                            </>
                                        ) : null}
                                        {isExecuted && !expired ? (
                                            <>
                                                <button
                                                    onClick={() => handleRestore(req)}
                                                    disabled={busyId === req.id}
                                                    className="px-3 py-1.5 rounded-lg text-[11px] font-extrabold bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
                                                    title="Arxivdən bütün məlumatları bərpa et"
                                                >
                                                    <RotateCcw className="w-3.5 h-3.5" />
                                                    Bərpa et
                                                </button>
                                                <button
                                                    onClick={() => handlePurge(req)}
                                                    disabled={busyId === req.id}
                                                    className="px-3 py-1.5 rounded-lg text-[11px] font-extrabold border border-rose-900/40 bg-rose-950/20 text-rose-300 hover:bg-rose-950/30 inline-flex items-center gap-1.5 disabled:opacity-50"
                                                    title="Arxivi indi həmişəlik sil (geri alınmaz!)"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                    Tam sil
                                                </button>
                                            </>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
