import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Lead, LeadStatus } from '../types/crm';
import {
    User, Phone, Package, MessageSquare, Clock, Hash,
    Save, CheckCircle2, TrendingUp, BarChart2, Edit3, Check, Route
} from 'lucide-react';
import { cn, toNumberSafe } from '../lib/utils';
import { loadCRMSettings } from '../lib/crmSettings';
import { CrmService } from '../services/CrmService';
import { useAppStore } from '../context/Store';

// ─── Chat History Sub-component ───────────────────────────────────────────────

interface ChatMessage {
    id: string;
    body: string;
    direction: 'in' | 'out';
    created_at: string;
    metadata?: any;
}

type StoryEvent =
    | {
        id: string;
        kind: 'message';
        at: string;
        message: {
            id: string;
            body: string;
            direction: 'in' | 'out';
            status?: string;
            metadata?: any;
        };
    }
    | {
        id: string;
        kind: 'audit';
        at: string;
        action: string;
        user: null | { id: string; username: string | null; displayName: string | null };
        details: any;
    };

function ChatHistoryTab({ lead, serverUrl }: { lead: Lead; serverUrl: string }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [replyText, setReplyText] = useState('');
    const [isSending, setIsSending] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const prevLenRef = useRef(0);
    const [showJump, setShowJump] = useState(false);

    const messagesRef = useRef<ChatMessage[]>([]);
    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const isMeta = lead.source === 'facebook' || lead.source === 'instagram';
    const [metaMode, setMetaMode] = useState<'dm' | 'comment' | 'private'>(isMeta ? 'comment' : 'dm');
    const [sendError, setSendError] = useState('');

    const canSend = lead.source === 'whatsapp' || isMeta;

    const buildMediaSrc = useCallback((rawUrl: string) => {
        const u = String(rawUrl || '').trim();
        if (!u) return '';
        const base = serverUrl ? String(serverUrl).replace(/\/$/, '') : '';
        const full = u.startsWith('http://') || u.startsWith('https://')
            ? u
            : `${base}${u.startsWith('/') ? '' : '/'}${u}`;

        const tokenNow = localStorage.getItem('crm_auth_token') || '';
        if (!tokenNow) return full;
        const sep = full.includes('?') ? '&' : '?';
        return `${full}${sep}token=${encodeURIComponent(tokenNow)}`;
    }, [serverUrl]);

    const isWorkerPlaceholder = useCallback((text: string) => {
        const t = String(text || '').trim();
        if (!t) return true;
        return /^\[(?:Image|Video|Document|Audio|Sticker|Location|Contact|Reaction|Button|List|Template|Unsupported message)\]$/i.test(t);
    }, []);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        const el = listRef.current;
        if (!el) return;
        try {
            el.scrollTo({ top: el.scrollHeight, behavior });
        } catch {
            // Safari/older browsers fallback
            el.scrollTop = el.scrollHeight;
        }
    }, []);

    const loadLockRef = useRef(false);
    const loadPendingRef = useRef(false);

    const loadMessages = useCallback(async (opts?: { background?: boolean }) => {
        if (!serverUrl || !lead.id) { setLoading(false); setRefreshing(false); return; }

        if (loadLockRef.current) {
            loadPendingRef.current = true;
            return;
        }
        loadLockRef.current = true;

        const background = Boolean(opts?.background) || messagesRef.current.length > 0;
        if (background) setRefreshing(true);
        else setLoading(true);

        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/messages`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setMessages(data);
            }
        } catch {
            /* non-fatal */
        } finally {
            loadLockRef.current = false;
            setLoading(false);
            setRefreshing(false);
            if (loadPendingRef.current) {
                loadPendingRef.current = false;
                setTimeout(() => {
                    loadMessages({ background: true });
                }, 0);
            }
        }
    }, [serverUrl, lead.id]);

    useEffect(() => { loadMessages(); }, [loadMessages]);

    // Only auto-scroll if user is already at the bottom
    useEffect(() => {
        if (loading) return;
        const len = messages.length;
        const prevLen = prevLenRef.current;
        prevLenRef.current = len;

        if (len <= prevLen) return;

        if (stickToBottomRef.current) {
            scrollToBottom('smooth');
            setShowJump(false);
        } else {
            setShowJump(true);
        }
    }, [messages, loading, scrollToBottom]);

    const handleScroll = () => {
        const el = listRef.current;
        if (!el) return;
        const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
        const atBottom = distance < 24;
        stickToBottomRef.current = atBottom;
        if (atBottom) setShowJump(false);
    };

    // Live: listen for new socket messages
    useEffect(() => {
        let t: any = null;
        const schedule = () => {
            if (t) clearTimeout(t);
            t = setTimeout(() => loadMessages({ background: true }), 250);
        };

        const cleanupUpdate = CrmService.onLeadUpdated((updated) => {
            if (updated.id === lead.id || updated.phone === lead.phone) schedule();
        });
        const cleanupNew = CrmService.onNewMessage((newLead) => {
            if (newLead.id === lead.id || newLead.phone === lead.phone) schedule();
        });
        return () => {
            if (t) clearTimeout(t);
            cleanupUpdate();
            cleanupNew();
        };
    }, [lead.id, lead.phone, loadMessages]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSend) return;
        const outgoing = replyText.trim();
        if (!outgoing || isSending) return;
        setIsSending(true);
        setSendError('');

        // Optimistic: show immediately (important on mobile)
        const optimisticId = `tmp-${Date.now()}`;
        setMessages(prev => ([
            ...prev,
            { id: optimisticId, body: outgoing, direction: 'out', created_at: new Date().toISOString() }
        ]));
        setReplyText('');
        requestAnimationFrame(() => scrollToBottom('smooth'));
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const endpoint = lead.source === 'whatsapp'
                ? `${serverUrl}/api/leads/${lead.id}/messages`
                : `${serverUrl}/api/meta/leads/${lead.id}/reply`;

            const payload = lead.source === 'whatsapp'
                ? { body: outgoing }
                : { body: outgoing, mode: metaMode };

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                loadMessages({ background: true });
            } else {
                const data = await res.json().catch(() => ({}));
                setSendError(String(data?.error || 'Mesaj gonderilemedi'));
            }
        } catch (err) {
            console.error('Failed to send message', err);
            setSendError('Mesaj gonderilemedi');
        } finally {
            setIsSending(false);
        }
    };

    if (loading && messages.length === 0) return (
        <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
            <span className="animate-pulse">Yüklənir...</span>
        </div>
    );

    return (
        <div className="relative flex flex-col flex-1 min-h-0 bg-[#0d1117]">
            {/* Header */}
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between shrink-0 bg-[#111827]">
                <span className="text-xs font-semibold text-slate-400">
                    {messages.length} mesaj
                </span>
                <button
                    onClick={() => loadMessages({ background: true })}
                    className={cn(
                        "text-[10px] text-blue-400 hover:text-blue-300",
                        refreshing && "opacity-70"
                    )}
                >
                    {refreshing ? '↻ Yenilənir…' : '↺ Yenilə'}
                </button>
            </div>

            {/* Message list */}
            <div
                ref={listRef}
                onScroll={handleScroll}
                onWheel={(e) => e.stopPropagation()}
                className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2 overscroll-contain touch-pan-y"
                style={{ WebkitOverflowScrolling: 'touch' }}
            >
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-slate-600 gap-3">
                        <MessageSquare className="w-10 h-10" />
                        <p className="text-sm">Hələ heç bir mesaj saxlanılmayıb</p>
                        <p className="text-xs text-slate-700">Yeni mesajlar avtomatik burada görünəcək</p>
                    </div>
                ) : (
                    messages.map((msg) => {
                        const isOut = msg.direction === 'out';
                        const timeStr = new Date(msg.created_at).toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' });
                        const dateStr2 = new Date(msg.created_at).toLocaleDateString('az-AZ', { day: '2-digit', month: 'short' });
                        const ad = msg?.metadata?.ad;
                        const qAd = msg?.metadata?.quotedAd;
                        const ctwa = msg?.metadata?.ctwa;
                        const adUrl = ad?.sourceUrl || ad?.wtwaWebsiteUrl || ad?.adPreviewUrl || ad?.mediaUrl;

                        const media = msg?.metadata?.media;
                        const mediaKind = String(media?.kind || '').toLowerCase();
                        const mediaSrc = media?.url ? buildMediaSrc(String(media.url)) : '';
                        const hideBody = Boolean(mediaSrc) && isWorkerPlaceholder(msg.body);

                        return (
                            <div key={msg.id} className={cn('flex', isOut ? 'justify-end' : 'justify-start')}>
                                <div className={cn(
                                    'max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed',
                                    isOut
                                        ? 'bg-blue-600/90 text-white rounded-br-sm'
                                        : 'bg-slate-800 text-slate-200 rounded-bl-sm'
                                )}>
                                    {(adUrl || qAd?.advertiserName || qAd?.caption) && (
                                        <div className={cn(
                                            'mb-2 rounded-xl border p-2',
                                            isOut ? 'border-blue-300/30 bg-blue-500/10' : 'border-slate-700 bg-slate-900/30'
                                        )}>
                                            <p className={cn('text-[10px] font-bold uppercase tracking-wide', isOut ? 'text-blue-100/80' : 'text-slate-400')}>
                                                Ad / Creative
                                            </p>
                                            {(qAd?.advertiserName || ad?.sourceApp) && (
                                                <p className={cn('text-[11px] mt-1', isOut ? 'text-blue-50' : 'text-slate-200')}>
                                                    <span className="font-semibold">Advertiser:</span> {qAd?.advertiserName || ad?.sourceApp}
                                                </p>
                                            )}

                                            {(ad?.title || ad?.body || qAd?.caption) && (
                                                <p className={cn('text-xs mt-1', isOut ? 'text-blue-50' : 'text-slate-200')}>
                                                    <span className="font-semibold">{ad?.title || 'Reklam'}:</span> {ad?.body || qAd?.caption || ''}
                                                </p>
                                            )}

                                            {adUrl && (
                                                <a
                                                    href={adUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className={cn('mt-1 inline-block text-[11px] underline break-all', isOut ? 'text-blue-100' : 'text-blue-300')}
                                                >
                                                    {adUrl}
                                                </a>
                                            )}

                                            {(ad?.sourceId || ad?.ctwaClid) && (
                                                <p className={cn('mt-1 text-[10px] break-all', isOut ? 'text-blue-100/70' : 'text-slate-500')}>
                                                    {ad?.sourceId ? `sourceId: ${ad.sourceId}` : ''}{ad?.sourceId && ad?.ctwaClid ? ' · ' : ''}{ad?.ctwaClid ? `clid: ${ad.ctwaClid}` : ''}
                                                </p>
                                            )}

                                            {ctwa?.smbClientCampaignId && (
                                                <p className={cn('mt-1 text-[10px] break-all', isOut ? 'text-blue-100/70' : 'text-slate-500')}>
                                                    campaign: {ctwa.smbClientCampaignId}
                                                </p>
                                            )}
                                        </div>
                                    )}

                                    {media && media.tooLarge ? (
                                        <div className={cn(
                                            'mb-2 rounded-xl border px-3 py-2 text-xs',
                                            isOut ? 'border-blue-300/30 bg-blue-500/10 text-blue-50' : 'border-slate-700 bg-slate-900/30 text-slate-200'
                                        )}>
                                            Fayl cox boyuk oldugu ucun gosterilmedi ({Math.round(Number(media.declaredBytes || media.actualBytes || 0) / (1024 * 1024) * 10) / 10}MB)
                                        </div>
                                    ) : null}

                                    {mediaSrc && mediaKind === 'image' ? (
                                        <a href={mediaSrc} target="_blank" rel="noreferrer" className="block mb-2">
                                            <img
                                                src={mediaSrc}
                                                alt={String(media?.fileName || 'Image')}
                                                className="max-h-80 w-auto max-w-full rounded-xl border border-white/10"
                                                loading="lazy"
                                            />
                                        </a>
                                    ) : null}

                                    {mediaSrc && mediaKind === 'audio' ? (
                                        <div className="mb-2">
                                            <audio controls src={mediaSrc} className="w-[260px] max-w-full" />
                                            <div className="mt-1">
                                                <a href={mediaSrc} target="_blank" rel="noreferrer" className={cn('text-[11px] underline', isOut ? 'text-blue-100' : 'text-blue-300')}>
                                                    Sesi yukle
                                                </a>
                                            </div>
                                        </div>
                                    ) : null}

                                    {mediaSrc && mediaKind === 'video' ? (
                                        <div className="mb-2">
                                            <video controls src={mediaSrc} className="max-h-80 w-auto max-w-full rounded-xl border border-white/10" />
                                        </div>
                                    ) : null}

                                    {mediaSrc && mediaKind === 'document' ? (
                                        <div className="mb-2">
                                            <a
                                                href={mediaSrc}
                                                target="_blank"
                                                rel="noreferrer"
                                                className={cn('inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold underline break-all', isOut ? 'border-blue-300/30 bg-blue-500/10 text-blue-50' : 'border-slate-700 bg-slate-900/30 text-slate-200')}
                                            >
                                                {String(media?.fileName || 'Document')}
                                            </a>
                                        </div>
                                    ) : null}

                                    {!hideBody ? (
                                        <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                                    ) : null}
                                    <p className={cn(
                                        'text-[10px] mt-1 text-right',
                                        isOut ? 'text-blue-200/70' : 'text-slate-500'
                                    )}>
                                        {dateStr2} · {timeStr} · {isOut ? '📤' : '📥'}
                                    </p>
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={bottomRef} className="h-4" />
            </div>

            {showJump && (
                <button
                    onClick={() => {
                        stickToBottomRef.current = true;
                        scrollToBottom('smooth');
                        setShowJump(false);
                    }}
                    className="absolute right-4 bottom-16 bg-blue-600/90 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg"
                >
                    Yeni mesajlar ↓
                </button>
            )}

            {/* Reply Input Area */}
            <div className="shrink-0 p-2 sm:p-3 border-t border-slate-800 bg-[#111827]" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}>
                {isMeta ? (
                    <div className="mb-2 flex flex-col sm:flex-row sm:items-center gap-2">
                        <div className="text-[10px] uppercase font-bold text-slate-500">Reply mode</div>
                        <select
                            value={metaMode}
                            onChange={(e) => setMetaMode(e.target.value as any)}
                            className="h-9 rounded-lg bg-slate-900 border border-slate-700 px-3 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                        >
                            <option value="comment">Reply with comment</option>
                            <option value="private">Reply with message (private)</option>
                            <option value="dm">DM (requires existing DM)</option>
                        </select>
                        <div className="text-[10px] text-slate-600">
                            IG/FB limitleri var (permission + 24h pəncərə). Comment gelmeyibse once webhook subscribe edin.
                        </div>
                    </div>
                ) : null}

                {sendError ? (
                    <div className="mb-2 rounded-lg border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] text-red-300">
                        {sendError}
                    </div>
                ) : null}
                <form onSubmit={handleSend} className="flex gap-2">
                    <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={'Mesaj yazın...'}
                        disabled={isSending || !canSend}
                        enterKeyHint="send"
                        autoComplete="off"
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                    />
                    <button
                        type="submit"
                        disabled={!canSend || !replyText.trim() || isSending}
                        className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg px-3 sm:px-4 py-2 text-sm font-semibold transition-colors flex items-center justify-center min-w-[70px] sm:min-w-[80px]"
                    >
                        {isSending ? <span className="animate-spin">⌛</span> : 'Göndər'}
                    </button>
                </form>
            </div>
        </div>
    );
}

type FollowUpItem = {
    id: string;
    lead_id: string;
    assignee_id: string | null;
    created_by: string | null;
    status: 'open' | 'done' | 'cancelled';
    due_at: string;
    note: string | null;
    notified_at: string | null;
    done_at: string | null;
    created_at: string;
    updated_at: string;
};

function toDateTimeLocalValue(d: Date): string {
    const dt = new Date(d);
    // Convert to local datetime-local string
    dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
    return dt.toISOString().slice(0, 16);
}

function FollowUpsTab({
    lead,
    serverUrl,
    teamMembers,
    currentUserId: _currentUserId,
}: {
    lead: Lead;
    serverUrl: string;
    teamMembers: any[];
    currentUserId?: string | null;
}) {
    const [items, setItems] = useState<FollowUpItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    const [dueAt, setDueAt] = useState(() => toDateTimeLocalValue(new Date(Date.now() + 60 * 60 * 1000)));
    const [note, setNote] = useState('');
    const [assigneeId, setAssigneeId] = useState<string>(() => String((lead as any).assignee_id || '') || '');

    const load = useCallback(async () => {
        if (!serverUrl || !lead?.id) return;
        setBusy(true);
        setErr('');
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/follow-ups`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(String(data?.error || 'Follow-up yuklenmedi'));
            }
            const data = await res.json();
            setItems(Array.isArray(data) ? data : []);
        } catch (e: any) {
            setErr(e?.message || 'Follow-up yuklenmedi');
        } finally {
            setBusy(false);
        }
    }, [serverUrl, lead?.id]);

    useEffect(() => {
        load();
    }, [load]);

    const create = async () => {
        if (!serverUrl || !lead?.id) return;
        setBusy(true);
        setErr('');
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const iso = new Date(dueAt).toISOString();
            const payload: any = { due_at: iso, note: note.trim() };
            if (assigneeId) payload.assignee_id = assigneeId;

            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/follow-ups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Follow-up yaradilmedi'));
            setNote('');
            await load();
        } catch (e: any) {
            setErr(e?.message || 'Follow-up yaradilmedi');
        } finally {
            setBusy(false);
        }
    };

    const patchItem = async (id: string, patch: any) => {
        if (!serverUrl) return;
        setBusy(true);
        setErr('');
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const res = await fetch(`${serverUrl}/api/follow-ups/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(patch)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Follow-up update olmadi'));
            await load();
        } catch (e: any) {
            setErr(e?.message || 'Follow-up update olmadi');
        } finally {
            setBusy(false);
        }
    };

    const snooze = async (id: string, minutes: number) => {
        const it = items.find(x => x.id === id);
        if (!it) return;
        const base = new Date(it.due_at);
        const next = new Date(base.getTime() + minutes * 60000);
        await patchItem(id, { due_at: next.toISOString() });
    };

    const now = Date.now();
    const open = items.filter(x => x.status === 'open');
    const done = items.filter(x => x.status !== 'open');

    const nameFor = (uid: string | null) => {
        if (!uid) return 'Unassigned';
        const u = (teamMembers || []).find((x: any) => x.id === uid);
        return u?.display_name || u?.username || uid;
    };

    return (
        <div className="h-full overflow-y-auto overscroll-contain touch-pan-y" style={{ WebkitOverflowScrolling: 'touch' }}>
            <div className="p-4 sm:p-6 space-y-4 max-w-2xl mx-auto w-full">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <div className="text-sm font-extrabold text-white">Follow-up</div>
                        <div className="text-[12px] text-slate-500">Vaxt qoyun, vaxti gelende operatora bildiris gedecek.</div>
                    </div>
                    <button
                        type="button"
                        onClick={load}
                        disabled={busy}
                        className="text-[11px] font-bold text-blue-400 hover:text-blue-300"
                    >
                        {busy ? '...' : '↺ Yenilə'}
                    </button>
                </div>

                {err ? (
                    <div className="rounded-xl border border-red-900/40 bg-red-950/15 px-3 py-2 text-[12px] text-red-300">{err}</div>
                ) : null}

                <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
                    <div className="text-[11px] uppercase font-bold text-slate-500">Yeni follow-up</div>
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-500">Vaxt</label>
                            <input
                                type="datetime-local"
                                value={dueAt}
                                onChange={(e) => setDueAt(e.target.value)}
                                className="mt-1 w-full h-10 rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] uppercase font-bold text-slate-500">Operator</label>
                            <select
                                value={assigneeId}
                                onChange={(e) => setAssigneeId(e.target.value)}
                                className="mt-1 w-full h-10 rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100"
                            >
                                <option value="">(lead-in operatoru)</option>
                                {(teamMembers || []).map((u: any) => (
                                    <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="mt-2">
                        <label className="text-[10px] uppercase font-bold text-slate-500">Qeyd</label>
                        <input
                            type="text"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="məs: Teklif yaz / cavab gozle"
                            className="mt-1 w-full h-10 rounded-xl bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
                        />
                    </div>
                    <div className="mt-3 flex justify-end">
                        <button
                            type="button"
                            onClick={create}
                            disabled={busy || !dueAt}
                            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-extrabold disabled:opacity-60"
                        >
                            {busy ? '...' : 'Elave et'}
                        </button>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="text-[11px] uppercase font-bold text-slate-500">Acıq ({open.length})</div>
                    {open.length === 0 ? (
                        <div className="text-sm text-slate-600">Acıq follow-up yoxdur.</div>
                    ) : open.map((it) => {
                        const dueMs = new Date(it.due_at).getTime();
                        const diffMin = (dueMs - now) / 60000;
                        const overdue = diffMin <= 0;
                        const pill = overdue
                            ? 'border-violet-700/40 bg-violet-950/15 text-violet-200'
                            : diffMin <= 15
                                ? 'border-amber-900/40 bg-amber-950/10 text-amber-200'
                                : 'border-slate-800 bg-slate-950/20 text-slate-300';
                        return (
                            <div key={it.id} className="rounded-2xl border border-slate-800 bg-slate-950/20 p-3">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-extrabold border', pill)}>
                                                {overdue ? 'DUE' : 'Plan'}
                                            </span>
                                            <span className="text-[12px] font-extrabold text-white tabular-nums">{new Date(it.due_at).toLocaleString()}</span>
                                        </div>
                                        <div className="mt-1 text-[11px] text-slate-400">Operator: <span className="text-slate-200 font-semibold">{nameFor(it.assignee_id)}</span></div>
                                        {it.note ? <div className="mt-1 text-[12px] text-slate-200">{it.note}</div> : null}
                                    </div>
                                    <div className="shrink-0 flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => patchItem(it.id, { status: 'done' })}
                                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold bg-emerald-600/20 border border-emerald-900/30 text-emerald-200 hover:bg-emerald-600/30"
                                        >
                                            Done
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => patchItem(it.id, { status: 'cancelled' })}
                                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <button type="button" onClick={() => snooze(it.id, 10)} className="px-2 py-1 rounded-lg text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-900">+10dk</button>
                                    <button type="button" onClick={() => snooze(it.id, 60)} className="px-2 py-1 rounded-lg text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-900">+1saat</button>
                                    <button type="button" onClick={() => snooze(it.id, 24 * 60)} className="px-2 py-1 rounded-lg text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-900">+1gun</button>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {done.length > 0 ? (
                    <details className="rounded-2xl border border-slate-800 bg-slate-950/15 p-3">
                        <summary className="cursor-pointer text-[11px] font-extrabold text-slate-300 select-none">Tarixce ({done.length})</summary>
                        <div className="mt-3 space-y-2">
                            {done.slice(-20).reverse().map((it) => (
                                <div key={it.id} className="rounded-xl border border-slate-800 bg-slate-950/20 px-3 py-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-[12px] font-bold text-slate-200">{new Date(it.due_at).toLocaleString()}</div>
                                        <div className="text-[10px] font-extrabold text-slate-500">{it.status.toUpperCase()}</div>
                                    </div>
                                    {it.note ? <div className="mt-1 text-[12px] text-slate-400">{it.note}</div> : null}
                                </div>
                            ))}
                        </div>
                    </details>
                ) : null}
            </div>
        </div>
    );
}


// ─── Types ───────────────────────────────────────────────────────────────────

interface LeadDetailsPanelProps {
    lead: Lead;
    onSave: (id: string, updates: Partial<Lead>) => void;
    onClose: () => void;
    onUpdateStatus: (id: string, status: LeadStatus) => void;
}

// Status colors dynamically generated inside the component

// ─── Main Component ───────────────────────────────────────────────────────────

export function LeadDetailsPanel({ lead, onSave, onClose, onUpdateStatus }: LeadDetailsPanelProps) {

    // LOCAL STATE (mirrors lead props - updated on save)
    const { teamMembers, currentUser } = useAppStore();
    const [localStatus, setLocalStatus] = useState<LeadStatus>(lead.status);
    const [formData, setFormData] = useState({
        name: lead.name || '',
        value: String(toNumberSafe((lead as any).value, 0)),
        product_name: lead.product_name || '',
        note: lead.last_message || '',
        assignee_id: lead.assignee_id || '',
    });
    const [activeTab, setActiveTab] = useState<'info' | 'feed' | 'chat' | 'follow' | 'stats'>('chat');
    const [isSaving, setIsSaving] = useState(false);
    const [savedOk, setSavedOk] = useState(false);
    const feedRef = useRef<HTMLDivElement>(null);
    const drawerRef = useRef<HTMLDivElement>(null);
    const serverUrl = CrmService.getServerUrl();

    const [story, setStory] = useState<StoryEvent[]>([]);
    const [storyLoading, setStoryLoading] = useState(false);
    const [storyError, setStoryError] = useState('');
    const [noteDraft, setNoteDraft] = useState('');
    const [noteBusy, setNoteBusy] = useState(false);

    const loadStory = useCallback(async () => {
        if (!serverUrl || !lead?.id) return;
        setStoryLoading(true);
        setStoryError('');
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/story?limit=1200&includeMessages=0`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || 'Story yuklenmedi');
            }
            const data = await res.json();
            const events = Array.isArray(data?.events) ? data.events : [];
            setStory(events);
        } catch (e: any) {
            setStoryError(e?.message || 'Story yuklenmedi');
        } finally {
            setStoryLoading(false);
        }
    }, [serverUrl, lead?.id]);

    useEffect(() => {
        loadStory();
    }, [loadStory]);

    // Refresh story on live updates
    useEffect(() => {
        if (!lead?.id) return;
        let t: any = null;
        const schedule = () => {
            if (t) clearTimeout(t);
            t = setTimeout(() => loadStory(), 300);
        };
        const cleanupUpdate = CrmService.onLeadUpdated((updated) => {
            if (updated.id === lead.id || updated.phone === lead.phone) schedule();
        });
        const cleanupNew = CrmService.onNewMessage((newLead) => {
            if (newLead.id === lead.id || newLead.phone === lead.phone) schedule();
        });
        return () => {
            if (t) clearTimeout(t);
            cleanupUpdate();
            cleanupNew();
        };
    }, [lead.id, lead.phone, loadStory]);

    const canAddNote = currentUser?.role !== 'viewer';
    const addNote = async () => {
        const note = noteDraft.trim();
        if (!note || !serverUrl || noteBusy) return;
        setNoteBusy(true);
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ note })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || 'Qeyd elave olunmadi');
            }
            setNoteDraft('');
            await loadStory();
        } catch (e) {
            // non-fatal
            console.warn('Failed to add note');
        } finally {
            setNoteBusy(false);
        }
    };

    const markReadLockRef = useRef(false);
    const markRead = useCallback(() => {
        if (!lead?.id) return;
        if (markReadLockRef.current) return;
        markReadLockRef.current = true;
        CrmService.markLeadRead(lead.id)
            .catch(() => { })
            .finally(() => {
                setTimeout(() => { markReadLockRef.current = false; }, 800);
            });
    }, [lead?.id]);

    // Mark as read when opened
    useEffect(() => {
        markRead();
    }, [markRead]);

    // If a new message arrives while this lead is open, keep it read (pro UX)
    useEffect(() => {
        if (!lead?.id) return;
        const cleanupNew = CrmService.onNewMessage((newLead) => {
            if (newLead.id === lead.id || newLead.phone === lead.phone) {
                markRead();
            }
        });
        const cleanupUpd = CrmService.onLeadUpdated((updated) => {
            if (updated.id === lead.id || updated.phone === lead.phone) {
                const unread = (updated as any).unread_count ? Number((updated as any).unread_count) : 0;
                if (unread > 0) markRead();
            }
        });
        return () => {
            cleanupNew();
            cleanupUpd();
        };
    }, [lead?.id, lead.phone, markRead]);

    // App-like modal behavior: prevent background page scroll (iOS-safe)
    useEffect(() => {
        const scrollY = window.scrollY;
        const prevBody = {
            overflow: document.body.style.overflow,
            position: document.body.style.position,
            top: document.body.style.top,
            width: document.body.style.width,
        };
        const prevHtmlOverflow = document.documentElement.style.overflow;

        document.body.classList.add('lead-panel-open');
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.width = '100%';

        return () => {
            document.body.classList.remove('lead-panel-open');
            document.documentElement.style.overflow = prevHtmlOverflow;
            document.body.style.overflow = prevBody.overflow;
            document.body.style.position = prevBody.position;
            document.body.style.top = prevBody.top;
            document.body.style.width = prevBody.width;
            window.scrollTo(0, scrollY);
        };
    }, []);

    // Keep drawer height aligned to the visual viewport (mobile keyboard-safe)
    useEffect(() => {
        const vv = window.visualViewport;
        const el = drawerRef.current;
        if (!vv || !el) return;

        const apply = () => {
            const h = Math.max(320, Math.round(vv.height));
            el.style.height = `${h}px`;
            el.style.maxHeight = `${h}px`;
        };

        apply();
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        return () => {
            vv.removeEventListener('resize', apply);
            vv.removeEventListener('scroll', apply);
        };
    }, []);


    // ─── Custom fields from CRM settings ─────────────────────────────────────
    const crmSettings = loadCRMSettings();
    const customFields = crmSettings.customFields;
    const pipelineStages = crmSettings.pipelineStages;

    const STATUSES = React.useMemo(() => pipelineStages.map(stage => {
        const colors: Record<string, { accent: string, bg: string }> = {
            blue: { accent: 'border-blue-500 text-blue-400', bg: 'bg-blue-500' },
            purple: { accent: 'border-purple-500 text-purple-400', bg: 'bg-purple-500' },
            green: { accent: 'border-green-500 text-green-400', bg: 'bg-green-500' },
            emerald: { accent: 'border-emerald-500 text-emerald-400', bg: 'bg-emerald-500' },
            teal: { accent: 'border-teal-500 text-teal-400', bg: 'bg-teal-500' },
            red: { accent: 'border-red-500 text-red-400', bg: 'bg-red-500' },
            orange: { accent: 'border-orange-500 text-orange-400', bg: 'bg-orange-500' },
            amber: { accent: 'border-amber-500 text-amber-400', bg: 'bg-amber-500' },
            yellow: { accent: 'border-yellow-500 text-yellow-400', bg: 'bg-yellow-500' },
            slate: { accent: 'border-slate-600 text-slate-400', bg: 'bg-slate-600' },
            zinc: { accent: 'border-zinc-600 text-zinc-400', bg: 'bg-zinc-600' },
        };
        const theme = colors[stage.color] || colors.slate;
        return {
            id: stage.id,
            label: stage.label,
            accent: theme.accent,
            bg: theme.bg,
            icon: <div className={cn("w-2.5 h-2.5 rounded-full shadow-sm", theme.bg)} />
        };
    }), [pipelineStages]);

    const [customValues, setCustomValues] = useState<Record<string, string>>(() => {
        // Try to read saved extra data from lead object
        const extra = (lead as any).extra_data;
        return extra ? (typeof extra === 'string' ? JSON.parse(extra) : extra) : {};
    });

    // Keep localStatus in sync if parent changes the lead
    useEffect(() => { setLocalStatus(lead.status); }, [lead.status]);
    useEffect(() => {
        setFormData({
            name: lead.name || '',
            value: String(toNumberSafe((lead as any).value, 0)),
            product_name: lead.product_name || '',
            note: lead.last_message || '',
            assignee_id: lead.assignee_id || '',
        });
        const extra = (lead as any).extra_data;
        setCustomValues(extra ? (typeof extra === 'string' ? JSON.parse(extra) : extra) : {});
    }, [lead]);

    // ESC to close
    useEffect(() => {
        const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', fn);
        return () => window.removeEventListener('keydown', fn);
    }, [onClose]);

    // ─── Handlers ──────────────────────────────────────────────────────────────

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleStatusClick = (statusId: LeadStatus) => {
        setLocalStatus(statusId);  // Optimistic: update UI immediately
        onUpdateStatus(lead.id, statusId);
    };

    const handleSave = async () => {
        setIsSaving(true);
        await onSave(lead.id, {
            name: formData.name,
            value: parseFloat(formData.value) || 0,
            product_name: formData.product_name,
            last_message: formData.note,
            status: localStatus,
            assignee_id: formData.assignee_id || null,
            // Persist custom field values as extra_data JSON string (send '{}' to allow clearing)
            extra_data: JSON.stringify(customValues || {}),
        });
        setIsSaving(false);
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 1800);
    };

    // Conversation close/reopen (pause delay/SLA until next inbound)
    const [convBusy, setConvBusy] = useState(false);
    const [convClosed, setConvClosed] = useState<boolean>(Boolean((lead as any)?.conversation_closed));
    useEffect(() => {
        setConvClosed(Boolean((lead as any)?.conversation_closed));
    }, [lead]);

    const toggleConversation = async () => {
        if (!serverUrl || !lead?.id || convBusy) return;
        if (currentUser?.role === 'viewer') return;
        setConvBusy(true);
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const endpoint = convClosed ? 'reopen' : 'close';
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/${endpoint}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                setConvClosed(!convClosed);
                // Refresh story so the event appears immediately
                setTimeout(() => loadStory(), 250);
            }
        } catch {
            // non-fatal
        } finally {
            setConvBusy(false);
        }
    };

    // ─── UI Helpers ────────────────────────────────────────────────────────────

    const toDatetimeLocal = (raw: any) => {
        const v = String(raw ?? '').trim();
        if (!v) return '';
        // Already in input format
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v;
        // Date-only
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00`;
        // Try to parse ISO-like values
        const d = new Date(v);
        if (!Number.isFinite(d.getTime())) {
            // Best-effort truncate
            if (v.includes('T')) return v.slice(0, 16);
            return v;
        }
        const pad = (n: number) => String(n).padStart(2, '0');
        const yyyy = d.getFullYear();
        const mm = pad(d.getMonth() + 1);
        const dd = pad(d.getDate());
        const hh = pad(d.getHours());
        const mi = pad(d.getMinutes());
        return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
    };

    const activeStatus = STATUSES.find(s => s.id === localStatus) || STATUSES[0];
    const dateStr = new Date(lead.created_at).toLocaleString('az-AZ', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const leadIdShort = lead.id.split('-')[0].toUpperCase();

    const stageLabel = (statusId: any) => {
        const s = (pipelineStages || []).find(x => x.id === statusId);
        return s ? s.label : String(statusId || '');
    };

    const formatMaybeDatetime = (raw: any) => {
        const v = String(raw ?? '').trim();
        if (!v) return '';
        const d = new Date(v);
        if (Number.isFinite(d.getTime())) {
            return d.toLocaleString('az-AZ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        }
        return v;
    };

    if (typeof document === 'undefined') return null;

    return createPortal(
        // OVERLAY
        <div
            className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[2px] flex justify-end overflow-hidden"
            onClick={onClose}
        >
            {/* DRAWER — stops propagation so clicks inside don't close */}
            <div
                ref={drawerRef}
                className="relative h-screen h-[100dvh] w-full sm:w-[96%] md:w-[88%] lg:w-[78%] xl:w-[72%] max-w-5xl bg-[#0d1117] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
                style={{ paddingTop: 'env(safe-area-inset-top)', animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)' }}
                onClick={e => e.stopPropagation()}
            >

                {/* ════════════════════ TOP PIPELINE BAR ════════════════════ */}
                <div className="flex items-center justify-between px-2 sm:px-4 py-2 border-b border-white/5 bg-[#111827] shrink-0 gap-2 sm:gap-3">

                    {/* Back Button (Mobile) & Lead ID badge */}
                    <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                        <button onClick={onClose} className="md:hidden p-1.5 text-slate-400 hover:text-white transition-colors">
                            <span className="text-xl leading-none">&larr;</span>
                        </button>
                        <div className="flex items-center gap-1.5 bg-slate-800/80 px-2 sm:px-2.5 py-1 rounded-md border border-slate-700/50" title="Sistem Tərəfindən Verilmiş Müştəri Kodu">
                            <span className="hidden sm:inline text-slate-500 text-[10px] uppercase font-bold tracking-wider">Kod:</span>
                            <span className="text-[10px] sm:text-sm font-mono text-slate-300 font-semibold">{leadIdShort}</span>
                        </div>
                        <span className="text-slate-300 text-[11px] sm:text-sm font-semibold truncate max-w-[96px] xs:max-w-[120px] sm:max-w-[180px]">
                            {lead.name || lead.phone}
                        </span>
                    </div>

                    {/* Pipeline Status Buttons */}
                    <div className="flex-1 flex items-center justify-center gap-1 overflow-x-auto no-scrollbar px-2">
                        {STATUSES.map((s, i) => {
                            const isActive = localStatus === s.id;
                            const pastIdx = STATUSES.findIndex(x => x.id === localStatus);
                            const isPast = pastIdx > i;
                            return (
                                <button
                                    key={s.id}
                                    onClick={() => handleStatusClick(s.id)}
                                    className={cn(
                                        'flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-md text-[10px] sm:text-xs font-bold uppercase tracking-wide border transition-all whitespace-nowrap shrink-0',
                                        isActive
                                            ? `${s.bg} text-white border-transparent shadow-lg`
                                            : isPast
                                                ? 'bg-slate-800/70 text-slate-400 border-slate-700 hover:bg-slate-700'
                                                : 'bg-transparent text-slate-500 border-slate-800 hover:border-slate-600 hover:text-slate-300'
                                    )}
                                >
                                    {s.icon}
                                    <span className="hidden sm:inline">{s.label}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Close (Mobile) */}
                    <button
                        onClick={onClose}
                        className="md:hidden shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                        aria-label="Close"
                    >
                        <span className="text-xl leading-none">&times;</span>
                    </button>

                    {/* Close (Desktop) */}
                    <button
                        onClick={onClose}
                        className="hidden md:flex shrink-0 p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
                    >
                        <span className="text-xl leading-none">&times;</span>
                    </button>
                </div>

                {/* Mobile: single tab bar (app-like) */}
                <div className="md:hidden px-2 py-1.5 border-b border-white/5 bg-[#0d1117]">
                    <div className="flex gap-1 bg-[#1c2436] p-1 rounded-xl w-full mx-auto shadow-md overflow-x-auto no-scrollbar">
                        {([
                            { id: 'info', label: 'Məlumat' },
                            { id: 'feed', label: 'Gedişat' },
                            { id: 'chat', label: 'Yazışma' },
                            { id: 'follow', label: 'Follow-up' },
                            { id: 'stats', label: 'Statistika' },
                        ] as const).map((t) => (
                            <button
                                key={t.id}
                                onClick={() => setActiveTab(t.id as any)}
                                className={cn(
                                    'flex-1 min-w-[68px] py-1.5 px-2 rounded-lg text-[10px] font-semibold transition-all whitespace-nowrap',
                                    activeTab === t.id
                                        ? 'bg-blue-600 text-white shadow-sm'
                                        : 'text-slate-400 hover:text-slate-200'
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ════════════════════ BODY (2-column on md+) ════════════════════ */}
                <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden relative">

                    {/* ───── LEFT SIDEBAR ───── */}
                    <aside className={cn(
                        "w-full md:w-72 lg:w-80 shrink-0 min-h-0 border-r border-white/5 bg-[#111827]/60 flex flex-col overflow-hidden overscroll-contain relative",
                        ['feed', 'chat', 'follow', 'stats'].includes(activeTab) ? "hidden md:flex" : "flex"
                    )}>

                        {/* Avatar / Name Block */}
                        <div className="p-4 border-b border-white/5 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                                {(lead.name || lead.phone || 'U')[0].toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-white font-semibold text-sm truncate">{lead.name || 'Ad yoxdur'}</p>
                                <p className="text-slate-500 text-xs flex items-center gap-1">
                                    <Phone className="w-2.5 h-2.5" /> {lead.phone}
                                </p>
                            </div>
                            <div className={cn('w-2 h-2 rounded-full shrink-0', activeStatus.bg)} title={activeStatus.label} />
                        </div>

                        {/* Fields (scrollable) */}
                        <div
                            className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y"
                            style={{ WebkitOverflowScrolling: 'touch' }}
                        >
                            <div className="p-4 space-y-4">

                            {/* Məsul Şəxs (Assignee) */}
                            <FieldGroup label="Məsul Şəxs" icon={<User className="w-3 h-3" />}>
                                <div className="flex gap-2">
                                    <select
                                        name="assignee_id"
                                        value={formData.assignee_id}
                                        onChange={(e: any) => handleChange(e)}
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                                    >
                                        <option value="">-- Təyin Edilməyib --</option>
                                        {teamMembers.map(tm => (
                                            <option key={tm.id} value={tm.id}>{tm.username}</option>
                                        ))}
                                    </select>

                                    {currentUser && formData.assignee_id !== currentUser.id && (
                                        <button
                                            onClick={() => setFormData(prev => ({ ...prev, assignee_id: currentUser.id }))}
                                            className="whitespace-nowrap px-3 py-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border border-blue-500/30 rounded-lg text-[10px] font-bold uppercase shrink-0 transition-colors"
                                            title="Özümə Təyin Et"
                                        >
                                            Mən Baxıram
                                        </button>
                                    )}
                                </div>
                            </FieldGroup>

                            {/* Büdcə */}
                            {currentUser?.permissions?.view_budget !== false && (
                                <FieldGroup label="Büdcə (₼)" icon={<TrendingUp className="w-3 h-3" />}>
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">₼</span>
                                        <input
                                            type="number"
                                            name="value"
                                            value={formData.value}
                                            onChange={handleChange}
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            disabled={currentUser?.permissions?.edit_budget === false}
                                        />
                                    </div>
                                    {currentUser?.permissions?.edit_budget === false && (
                                        <p className="text-[10px] text-amber-500/70 mt-1">Dəyişmək icazəniz yoxdur</p>
                                    )}
                                </FieldGroup>
                            )}

                            {/* Ad */}
                            <FieldGroup label="Ad Soyad" icon={<User className="w-3 h-3" />}>
                                <input
                                    name="name"
                                    value={formData.name}
                                    onChange={handleChange}
                                    placeholder="Müştərinin adı"
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                            </FieldGroup>

                            {/* Telefon (readonly) */}
                            <FieldGroup label="Telefon" icon={<Phone className="w-3 h-3" />}>
                                <div className="w-full bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-2 text-slate-300 text-sm font-mono select-all">
                                    {lead.phone}
                                </div>
                            </FieldGroup>

                            {/* Dynamic Custom Fields from CRM Settings */}
                             {customFields.map(field => {
                                const isBuiltin = field.id === 'product_name';
                                const value = isBuiltin ? formData.product_name : (customValues[field.id] || '');
                                const handleFieldChange = (val: string) => {
                                    if (isBuiltin) {
                                        setFormData(prev => ({ ...prev, product_name: val }));
                                    } else {
                                        setCustomValues(prev => ({ ...prev, [field.id]: val }));
                                    }
                                };

                                 return (
                                     <FieldGroup key={field.id} label={field.label} icon={<Package className="w-3 h-3" />}>
                                         {field.type === 'select' ? (
                                             <select
                                                value={value}
                                                onChange={e => handleFieldChange(e.target.value)}
                                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                                            >
                                                <option value="">-- Seçin --</option>
                                                {(field.options || []).map(opt => (
                                                    <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                             </select>
                                        ) : field.type === 'datetime' ? (
                                            <input
                                                type="datetime-local"
                                                value={toDatetimeLocal(value)}
                                                onChange={e => handleFieldChange(e.target.value)}
                                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            />
                                        ) : (
                                             <input
                                                 type={field.type === 'number' ? 'number' : 'text'}
                                                 value={value}
                                                 onChange={e => handleFieldChange(e.target.value)}
                                                placeholder={field.label}
                                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            />
                                        )}
                                    </FieldGroup>
                                );
                            })}

                            {/* Status göstəricisi */}
                            <FieldGroup label="Cari Status" icon={<BarChart2 className="w-3 h-3" />}>
                                <div className={cn(
                                    'w-full px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 border',
                                    activeStatus.accent, 'bg-slate-900'
                                )}>
                                    {activeStatus.icon}
                                    {activeStatus.label}
                                </div>
                            </FieldGroup>

                            {/* Conversation close/reopen */}
                            <FieldGroup label="Söhbət" icon={<MessageSquare className="w-3 h-3" />}>
                                <div className="flex items-center justify-between gap-2">
                                    <span className={cn(
                                        'text-[10px] font-extrabold uppercase tracking-wide',
                                        convClosed ? 'text-amber-300' : 'text-emerald-300'
                                    )}>
                                        {convClosed ? 'Bağlı' : 'Açıq'}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={toggleConversation}
                                        disabled={convBusy || currentUser?.role === 'viewer'}
                                        className={cn(
                                            'px-3 py-2 rounded-lg text-[11px] font-extrabold border transition-colors disabled:opacity-60',
                                            convClosed
                                                ? 'border-emerald-800/40 bg-emerald-600/15 text-emerald-200 hover:bg-emerald-600/20'
                                                : 'border-amber-800/40 bg-amber-600/15 text-amber-200 hover:bg-amber-600/20'
                                        )}
                                        title={convClosed ? 'Söhbəti yenidən aç' : 'Söhbəti bağla (gecikmə saymasın)'}
                                    >
                                        {convBusy ? '...' : (convClosed ? 'Aç' : 'Bağla')}
                                    </button>
                                </div>
                                <p className="mt-1 text-[10px] text-slate-500">
                                    Close edəndə gecikmə/SLA dayanır, yeni inbound gələndə avtomatik açılır.
                                </p>
                            </FieldGroup>

                            {/* Tarix */}
                            <FieldGroup label="Yaranma Tarixi" icon={<Clock className="w-3 h-3" />}>
                                <p className="text-slate-400 text-xs">{dateStr}</p>
                            </FieldGroup>

                            {/* Mənbə */}
                            <FieldGroup label="Mənbə" icon={<Hash className="w-3 h-3" />}>
                                <span className={cn(
                                    'text-[10px] font-bold uppercase px-2 py-0.5 rounded',
                                    lead.source === 'whatsapp'
                                        ? 'bg-green-900/50 text-green-400 border border-green-900'
                                        : lead.source === 'facebook'
                                            ? 'bg-blue-900/40 text-blue-300 border border-blue-900/60'
                                            : lead.source === 'instagram'
                                                ? 'bg-pink-900/30 text-pink-300 border border-pink-900/60'
                                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                                )}>
                                    {lead.source === 'whatsapp'
                                        ? '📱 WhatsApp'
                                        : lead.source === 'facebook'
                                            ? 'Facebook'
                                            : lead.source === 'instagram'
                                                ? 'Instagram'
                                                : '✍️ Manual'}
                                </span>
                            </FieldGroup>
                        </div>
                        </div>

                        {/* Save button */}
                        <div className="p-4 border-t border-white/5 bg-[#0d1117]/80 shrink-0">
                            <button
                                onClick={handleSave}
                                disabled={isSaving}
                                className={cn(
                                    'w-full py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                                    savedOk
                                        ? 'bg-green-600 text-white'
                                        : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60'
                                )}
                            >
                                {isSaving
                                    ? <><span className="animate-spin">↻</span> Saxlanır...</>
                                    : savedOk
                                        ? <><Check className="w-4 h-4" /> Saxlandı!</>
                                        : <><Save className="w-4 h-4" /> Yadda Saxla</>
                                }
                            </button>
                        </div>
                    </aside>

                    {/* ───── RIGHT MAIN AREA ───── */}
                    <main className={cn(
                        "flex-1 min-h-0 flex flex-col min-w-0 bg-[#0d1117]",
                        ['feed', 'chat', 'follow', 'stats'].includes(activeTab) ? "flex" : "hidden md:flex"
                    )}>

                        {/* Tab Bar (Desktop only) */}
                        <div className="hidden md:flex items-end px-2 sm:px-5 gap-1 border-b border-white/5 bg-[#111827]/40 shrink-0 overflow-x-auto no-scrollbar">
                            {[
                                { id: 'feed', label: 'Gedişat', icon: <MessageSquare className="w-3.5 h-3.5" /> },
                                { id: 'chat', label: 'Yazışmalar', icon: <Edit3 className="w-3.5 h-3.5" /> },
                                { id: 'follow', label: 'Follow-up', icon: <Clock className="w-3.5 h-3.5" /> },
                                { id: 'stats', label: 'Statistika', icon: <BarChart2 className="w-3.5 h-3.5" /> },
                            ].map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id as any)}
                                    className={cn(
                                        'flex items-center gap-1.5 px-3 py-3 text-xs font-semibold border-b-2 transition-all whitespace-nowrap',
                                        activeTab === tab.id
                                            ? 'border-blue-500 text-blue-400'
                                            : 'border-transparent text-slate-500 hover:text-slate-300'
                                    )}
                                >
                                    {tab.icon} {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Tab Content */}
                        <div className="flex-1 min-h-0 overflow-hidden flex flex-col" ref={feedRef}>

                            {/* ── TAB: FEED ── */}
                            {activeTab === 'feed' && (
                                <div className="h-full overflow-y-auto overscroll-contain touch-pan-y" style={{ WebkitOverflowScrolling: 'touch' }}>
                                    <div className="p-4 sm:p-6 space-y-4 max-w-2xl mx-auto w-full">

                                        {/* Qeyd əlavə et (operation) */}
                                        {serverUrl && canAddNote && (
                                            <div className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
                                                <div className="flex items-center justify-between gap-2">
                                                    <p className="text-xs font-bold text-slate-200">Qeyd əlavə et</p>
                                                    <button
                                                        onClick={loadStory}
                                                        className="text-[10px] text-blue-400 hover:text-blue-300"
                                                        title="Yenilə"
                                                    >
                                                        ↺ Yenilə
                                                    </button>
                                                </div>
                                                <textarea
                                                    value={noteDraft}
                                                    onChange={(e) => setNoteDraft(e.target.value)}
                                                    placeholder="məs: Bu gün 16:30 randevuya yazdıq"
                                                    rows={3}
                                                    className="mt-2 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"
                                                />
                                                <div className="mt-2 flex justify-end">
                                                    <button
                                                        onClick={addNote}
                                                        disabled={noteBusy || !noteDraft.trim()}
                                                        className="px-3 py-2 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60"
                                                    >
                                                        {noteBusy ? 'Saxlanır...' : 'Əlavə et'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {/* Operations timeline (no messages) */}
                                        <div className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-xs font-bold text-slate-200 uppercase tracking-wide">Gedişat</p>
                                                <span className="text-[10px] text-slate-500">Yalnız əməliyyatlar</span>
                                            </div>

                                            {storyLoading ? (
                                                <div className="flex items-center justify-center h-24 text-slate-500 text-sm">
                                                    <span className="animate-pulse">Yüklənir...</span>
                                                </div>
                                            ) : storyError ? (
                                                <div className="mt-3 rounded-xl border border-red-900/40 bg-red-950/15 p-3 text-xs text-red-300">{storyError}</div>
                                            ) : (
                                                (() => {
                                                    const ops = (Array.isArray(story) ? story : []).filter((ev) => ev && ev.kind === 'audit') as any[];
                                                    if (ops.length === 0) {
                                                        return (
                                                            <div className="mt-4 flex flex-col items-center py-10 gap-3 text-slate-600">
                                                                <MessageSquare className="w-10 h-10" />
                                                                <p className="text-sm">Hələ heç bir əməliyyat yoxdur</p>
                                                            </div>
                                                        );
                                                    }

                                                    const fieldById = new Map((customFields || []).map((f: any) => [f.id, f]));

                                                    const items: Array<any> = [];
                                                    let lastDay = '';
                                                    for (const ev of ops) {
                                                        const at = ev?.at ? new Date(ev.at) : new Date();
                                                        const day = at.toLocaleDateString('az-AZ');
                                                        const time = at.toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' });
                                                        if (day !== lastDay) {
                                                            lastDay = day;
                                                            items.push({ type: 'day', day });
                                                        }
                                                        items.push({ type: 'op', ev, at, time });
                                                    }

                                                    const findNextOp = (fromIdx: number) => {
                                                        for (let j = fromIdx + 1; j < items.length; j++) {
                                                            if (items[j]?.type === 'op') return true;
                                                        }
                                                        return false;
                                                    };

                                                    return (
                                                        <div className="mt-3">
                                                            {items.map((it, idx) => {
                                                                if (it.type === 'day') {
                                                                    return (
                                                                        <div key={`day-${it.day}-${idx}`} className="flex items-center gap-3 mt-3">
                                                                            <div className="h-px flex-1 bg-slate-800" />
                                                                            <span className="text-[10px] font-mono text-slate-500 bg-slate-950 border border-slate-800 px-2 py-0.5 rounded-full">{it.day}</span>
                                                                            <div className="h-px flex-1 bg-slate-800" />
                                                                        </div>
                                                                    );
                                                                }

                                                                const ev = it.ev;
                                                                const who = ev.user?.displayName || ev.user?.username || 'Sistem';
                                                                const action = String(ev.action || '');
                                                                const details = ev.details || {};
                                                                const hasNext = findNextOp(idx);

                                                                const lines: string[] = [];
                                                                let dot = 'bg-slate-500';
                                                                let icon = <Edit3 className="w-3.5 h-3.5 text-slate-200" />;
                                                                let title = action;

                                                                if (action === 'LEAD_CREATED') {
                                                                    dot = 'bg-blue-500';
                                                                    icon = <User className="w-3.5 h-3.5 text-blue-200" />;
                                                                    const src = details.source === 'manual' ? 'Manual' : 'WhatsApp';
                                                                    title = 'Yeni lead yaradıldı';
                                                                    lines.push(`Mənbə: ${src}`);
                                                                } else if (action === 'UPDATE_STATUS') {
                                                                    dot = 'bg-purple-500';
                                                                    icon = <CheckCircle2 className="w-3.5 h-3.5 text-purple-200" />;
                                                                    title = 'Status dəyişdi';
                                                                    lines.push(`${stageLabel(details.oldStatus)} -> ${stageLabel(details.newStatus)}`);
                                                                } else if (action === 'UPDATE_FIELDS') {
                                                                    dot = 'bg-slate-500';
                                                                    icon = <Edit3 className="w-3.5 h-3.5 text-slate-200" />;
                                                                    title = 'Dəyişiklik';
                                                                    const ch = details.changed || {};
                                                                    const chExtra = details.changedExtra || {};

                                                                    if (ch.assignee_id) {
                                                                        const fromId = ch.assignee_id.from;
                                                                        const toId = ch.assignee_id.to;
                                                                        const fromU = fromId ? teamMembers.find((u: any) => u.id === fromId) : null;
                                                                        const toU = toId ? teamMembers.find((u: any) => u.id === toId) : null;
                                                                        const fromLabel = fromU ? (fromU.display_name || fromU.username) : (fromId ? String(fromId) : '--');
                                                                        const toLabel = toU ? (toU.display_name || toU.username) : (toId ? String(toId) : '--');
                                                                        lines.push(`Operator: ${fromLabel} -> ${toLabel}`);
                                                                    }
                                                                    if (ch.status) {
                                                                        lines.push(`Status: ${stageLabel(ch.status.from)} -> ${stageLabel(ch.status.to)}`);
                                                                    }
                                                                    if (ch.value) {
                                                                        lines.push(`Büdcə: ${ch.value.from ?? 0} -> ${ch.value.to ?? 0}`);
                                                                    }
                                                                    if (ch.product_name) {
                                                                        lines.push(`Məhsul: ${ch.product_name.from || '--'} -> ${ch.product_name.to || '--'}`);
                                                                    }
                                                                    if (ch.name) {
                                                                        lines.push(`Ad: ${ch.name.from || '--'} -> ${ch.name.to || '--'}`);
                                                                    }

                                                                    for (const k of Object.keys(chExtra || {})) {
                                                                        const meta = fieldById.get(k);
                                                                        const label = meta?.label || k;
                                                                        const fromV = chExtra[k]?.from;
                                                                        const toV = chExtra[k]?.to;
                                                                        const showFrom = meta?.type === 'datetime' ? formatMaybeDatetime(fromV) : String(fromV ?? '--');
                                                                        const showTo = meta?.type === 'datetime' ? formatMaybeDatetime(toV) : String(toV ?? '--');
                                                                        lines.push(`${label}: ${showFrom || '--'} -> ${showTo || '--'}`);
                                                                    }
                                                                } else if (action === 'ROUTING_MATCH') {
                                                                    dot = 'bg-emerald-500';
                                                                    icon = <Route className="w-3.5 h-3.5 text-emerald-200" />;
                                                                    title = 'Routing tətbiq olundu';
                                                                    const field = (customFields || []).find((f: any) => f.id === details.fieldId);
                                                                    const label = field?.label || details.fieldId || 'Field';
                                                                    lines.push(`${label}: ${details.setValue || ''}`);
                                                                    if (details.targetStage) lines.push(`Mərhələ: ${stageLabel(details.targetStage)}`);
                                                                } else if (action === 'LEAD_NOTE') {
                                                                    dot = 'bg-amber-500';
                                                                    icon = <Edit3 className="w-3.5 h-3.5 text-amber-200" />;
                                                                    title = 'Qeyd';
                                                                    lines.push(String(details.note || ''));
                                                                } else if (action === 'AUTO_STAGE_RETURN') {
                                                                    dot = 'bg-cyan-500';
                                                                    icon = <Route className="w-3.5 h-3.5 text-cyan-200" />;
                                                                    title = 'Lead avtomatik qaytarıldı';
                                                                    lines.push(`${stageLabel(details.from_status)} -> ${stageLabel(details.to_status)}`);
                                                                    if (details.reason === 'inbound_message') lines.push('Səbəb: müştəridən yeni mesaj gəldi');
                                                                } else if (action === 'AUTO_STAGE_ON_CLOSE') {
                                                                    dot = 'bg-orange-500';
                                                                    icon = <Route className="w-3.5 h-3.5 text-orange-200" />;
                                                                    title = 'Bağlananda mərhələ dəyişdi';
                                                                    lines.push(`${stageLabel(details.from_status)} -> ${stageLabel(details.to_status)}`);
                                                                    lines.push('Səbəb: söhbət bağlandı');
                                                                } else if (action === 'FOLLOWUP_CREATED') {
                                                                    dot = 'bg-violet-500';
                                                                    icon = <Clock className="w-3.5 h-3.5 text-violet-200" />;
                                                                    title = 'Follow-up yaradıldı';
                                                                    if (details.due_at) lines.push(`Vaxt: ${formatMaybeDatetime(details.due_at)}`);
                                                                    if (details.note) lines.push(`Qeyd: ${String(details.note)}`);
                                                                } else if (action === 'FOLLOWUP_RESCHEDULED') {
                                                                    dot = 'bg-sky-500';
                                                                    icon = <Clock className="w-3.5 h-3.5 text-sky-200" />;
                                                                    title = 'Follow-up vaxtı dəyişdi';
                                                                    if (details.due_at) lines.push(`Yeni vaxt: ${formatMaybeDatetime(details.due_at)}`);
                                                                    if (details.note) lines.push(`Qeyd: ${String(details.note)}`);
                                                                } else if (action === 'FOLLOWUP_DONE') {
                                                                    dot = 'bg-emerald-500';
                                                                    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-200" />;
                                                                    title = 'Follow-up tamamlandı';
                                                                    if (details.note) lines.push(`Qeyd: ${String(details.note)}`);
                                                                } else if (action === 'FOLLOWUP_CANCELLED') {
                                                                    dot = 'bg-rose-500';
                                                                    icon = <Edit3 className="w-3.5 h-3.5 text-rose-100" />;
                                                                    title = 'Follow-up ləğv edildi';
                                                                    if (details.note) lines.push(`Qeyd: ${String(details.note)}`);
                                                                } else if (action === 'FOLLOWUP_REASSIGNED') {
                                                                    dot = 'bg-indigo-500';
                                                                    icon = <User className="w-3.5 h-3.5 text-indigo-200" />;
                                                                    title = 'Follow-up operatoru dəyişdi';
                                                                } else if (action === 'CONVERSATION_CLOSED') {
                                                                    dot = 'bg-amber-500';
                                                                    icon = <MessageSquare className="w-3.5 h-3.5 text-amber-200" />;
                                                                    title = 'Söhbət bağlandı';
                                                                    lines.push('Gecikmə/SLA dayandırıldı');
                                                                    if (details.moved_to_stage) lines.push(`Hədəf mərhələ: ${stageLabel(details.moved_to_stage)}`);
                                                                } else if (action === 'CONVERSATION_REOPENED') {
                                                                    dot = 'bg-emerald-500';
                                                                    icon = <MessageSquare className="w-3.5 h-3.5 text-emerald-200" />;
                                                                    title = 'Söhbət açıldı';
                                                                    lines.push('Gecikmə/SLA yenidən aktivdir');
                                                                    if (details.reason === 'inbound_message') lines.push('Səbəb: müştəridən yeni mesaj gəldi');
                                                                    if (details.previous_status) lines.push(`Əvvəlki mərhələ: ${stageLabel(details.previous_status)}`);
                                                                }

                                                                return (
                                                                    <div key={ev.id} className="flex gap-3 mt-3">
                                                                        <div className="flex flex-col items-center">
                                                                            <div className={cn('w-8 h-8 rounded-full flex items-center justify-center', dot)}>
                                                                                {icon}
                                                                            </div>
                                                                            {hasNext ? <div className="w-px flex-1 mt-1 bg-slate-800" /> : null}
                                                                        </div>
                                                                        <div className="flex-1 pb-1">
                                                                            <div className="flex items-start justify-between gap-2">
                                                                                <div className="min-w-0">
                                                                                    <p className="text-xs font-bold text-slate-200 truncate">{title}</p>
                                                                                    <p className="text-[10px] text-slate-500 truncate">{who}</p>
                                                                                </div>
                                                                                <span className="text-[10px] text-slate-500 shrink-0">{it.time}</span>
                                                                            </div>
                                                                            {lines.length ? (
                                                                                <div className="mt-2 space-y-1">
                                                                                    {lines.map((ln, i) => (
                                                                                        <p key={i} className="text-xs text-slate-300 whitespace-pre-wrap">{ln}</p>
                                                                                    ))}
                                                                                </div>
                                                                            ) : null}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    );
                                                })()
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'follow' && (
                                <FollowUpsTab
                                    lead={lead}
                                    serverUrl={serverUrl}
                                    teamMembers={teamMembers}
                                    currentUserId={currentUser?.id || null}
                                />
                            )}

                            {/* ── TAB: CHAT History ── */}
                            {activeTab === 'chat' && (
                                <ChatHistoryTab lead={lead} serverUrl={serverUrl} />
                            )}


                            {/* ── TAB: STATS ── */}
                            {activeTab === 'stats' && (
                                <div className="h-full overflow-y-auto overscroll-contain touch-pan-y" style={{ WebkitOverflowScrolling: 'touch' }}>
                                    <div className="p-4 sm:p-6 max-w-2xl mx-auto w-full space-y-4">
                                    <h3 className="text-sm font-semibold text-slate-300 mb-4">Statistika</h3>

                                    <div className="grid grid-cols-2 gap-3">
                                        <StatCard label="Cari Status" value={activeStatus.label} accent="text-blue-400" />
                                        {currentUser?.permissions?.view_budget !== false && (
                                            <StatCard label="Büdcə" value={`₼ ${formData.value} `} accent="text-green-400" />
                                        )}
                                        <StatCard
                                            label="Mənbə"
                                            value={lead.source === 'whatsapp' ? 'WhatsApp' : lead.source === 'facebook' ? 'Facebook' : lead.source === 'instagram' ? 'Instagram' : 'Manual'}
                                            accent="text-sky-400"
                                        />
                                        <StatCard label="Yaradılma" value={new Date(lead.created_at).toLocaleDateString()} accent="text-slate-400" />
                                        {lead.product_name && (
                                            <StatCard label="Məhsul" value={lead.product_name} accent="text-purple-400" className="col-span-2" />
                                        )}
                                    </div>

                                    {/* Conversion status indicator */}
                                    <div className="mt-6 bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                                        <p className="text-xs text-slate-500 font-semibold uppercase mb-3">Satış Gedişatı</p>
                                        <div className="flex flex-wrap sm:flex-nowrap items-center gap-1">
                                            {STATUSES.map((s, i) => {
                                                const currentIdx = STATUSES.findIndex(x => x.id === localStatus);
                                                const done = currentIdx >= i;
                                                return (
                                                    <React.Fragment key={s.id}>
                                                        <div className={cn(
                                                            'flex flex-col items-center gap-1',
                                                        )}>
                                                            <div className={cn('w-7 h-7 rounded-full flex items-center justify-center text-white transition-all shrink-0', done ? s.bg : 'bg-slate-800')}>
                                                                {s.icon}
                                                            </div>
                                                            <span className="text-[9px] text-slate-500 hidden sm:block">{s.label}</span>
                                                        </div>
                                                        {i < STATUSES.length - 1 && (
                                                            <div className={cn('flex-1 h-0.5 mb-0 sm:mb-4 transition-all min-w-[8px]', done && currentIdx > i ? 'bg-blue-500' : 'bg-slate-800')} />
                                                        )}
                                                    </React.Fragment>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    </div>
                                </div>
                            )}
                        </div>

                    </main>
                </div>
            </div>
        </div>
    , document.body);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FieldGroup({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div>
            <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-slate-500 mb-1.5">
                {icon} {label}
            </label>
            {children}
        </div>
    );
}

function StatCard({ label, value, accent, className }: { label: string; value: string; accent: string; className?: string }) {
    return (
        <div className={cn('bg-slate-900 border border-slate-800 rounded-xl p-3', className)}>
            <p className="text-[10px] font-semibold uppercase text-slate-500 mb-1">{label}</p>
            <p className={cn('text-sm font-bold', accent)}>{value}</p>
        </div>
    );
}
