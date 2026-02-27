import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Lead, LeadStatus } from '../types/crm';
import {
    User, Phone, Package, MessageSquare, Clock, Hash,
    Save, CheckCircle2, TrendingUp, BarChart2, Edit3, Check, Route
} from 'lucide-react';
import { cn } from '../lib/utils';
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
    const [replyText, setReplyText] = useState('');
    const [isSending, setIsSending] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const prevLenRef = useRef(0);
    const [showJump, setShowJump] = useState(false);

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

    const loadMessages = useCallback(async () => {
        if (!serverUrl || !lead.id) { setLoading(false); return; }
        setLoading(true);
        try {
            const token = localStorage.getItem('crm_auth_token') || '';
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/messages`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setMessages(data);
            }
        } catch { /* non-fatal */ }
        finally { setLoading(false); }
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
        const cleanupUpdate = CrmService.onLeadUpdated((updated) => {
            if (updated.id === lead.id || updated.phone === lead.phone) {
                loadMessages();
            }
        });
        const cleanupNew = CrmService.onNewMessage((newLead) => {
            if (newLead.id === lead.id || newLead.phone === lead.phone) {
                loadMessages();
            }
        });
        return () => {
            cleanupUpdate();
            cleanupNew();
        };
    }, [lead.id, lead.phone, loadMessages]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        const outgoing = replyText.trim();
        if (!outgoing || isSending) return;
        setIsSending(true);

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
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ body: outgoing })
            });
            if (res.ok) {
                loadMessages();
            }
        } catch (err) {
            console.error('Failed to send message', err);
        } finally {
            setIsSending(false);
        }
    };

    if (loading) return (
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
                <button onClick={loadMessages} className="text-[10px] text-blue-400 hover:text-blue-300">
                    ↺ Yenilə
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
                                    <p className="whitespace-pre-wrap break-words">{msg.body}</p>
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
                <form onSubmit={handleSend} className="flex gap-2">
                    <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Mesaj yazın..."
                        disabled={isSending}
                        enterKeyHint="send"
                        autoComplete="off"
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                    />
                    <button
                        type="submit"
                        disabled={!replyText.trim() || isSending}
                        className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg px-3 sm:px-4 py-2 text-sm font-semibold transition-colors flex items-center justify-center min-w-[70px] sm:min-w-[80px]"
                    >
                        {isSending ? <span className="animate-spin">⌛</span> : 'Göndər'}
                    </button>
                </form>
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
    const { teamMembers, currentUser, crmSettingsRev } = useAppStore();
    const [localStatus, setLocalStatus] = useState<LeadStatus>(lead.status);
    const [formData, setFormData] = useState({
        name: lead.name || '',
        value: lead.value?.toString() || '0',
        product_name: lead.product_name || '',
        note: lead.last_message || '',
        assignee_id: lead.assignee_id || '',
    });
    const [activeTab, setActiveTab] = useState<'info' | 'feed' | 'chat' | 'stats'>('chat');
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
            const res = await fetch(`${serverUrl}/api/leads/${lead.id}/story?limit=1200`, {
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
    const crmSettings = useMemo(() => loadCRMSettings(), [crmSettingsRev, lead.id]);
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
            value: lead.value?.toString() || '0',
            product_name: lead.product_name || '',
            note: lead.last_message || '',
            assignee_id: lead.assignee_id || '',
        });
        const extra = (lead as any).extra_data;
        setCustomValues(extra ? (typeof extra === 'string' ? JSON.parse(extra) : extra) : {});
    }, [lead.id]);

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
                <div className="min-h-14 flex items-center justify-between px-2 sm:px-4 border-b border-white/5 bg-[#111827] shrink-0 gap-2 sm:gap-3">

                    {/* Back Button (Mobile) & Lead ID badge */}
                    <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                        <button onClick={onClose} className="md:hidden p-1.5 text-slate-400 hover:text-white transition-colors">
                            <span className="text-xl leading-none">&larr;</span>
                        </button>
                        <div className="flex items-center gap-1.5 bg-slate-800/80 px-2 sm:px-2.5 py-1 rounded-md border border-slate-700/50" title="Sistem Tərəfindən Verilmiş Müştəri Kodu">
                            <span className="hidden sm:inline text-slate-500 text-[10px] uppercase font-bold tracking-wider">Kod:</span>
                            <span className="text-[10px] sm:text-sm font-mono text-slate-300 font-semibold">{leadIdShort}</span>
                        </div>
                        <span className="text-slate-300 text-xs sm:text-sm font-semibold truncate max-w-[140px] sm:max-w-[180px]">
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
                                    <span className="hidden xs:inline sm:inline">{s.label}</span>
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
                <div className="md:hidden px-2 py-2 border-b border-white/5 bg-[#0d1117]">
                    <div className="flex gap-1 bg-[#1c2436] p-1 rounded-xl w-full mx-auto shadow-md overflow-x-auto no-scrollbar">
                        {([
                            { id: 'info', label: 'Məlumat' },
                            { id: 'feed', label: 'Gedişat' },
                            { id: 'chat', label: 'Yazışma' },
                            { id: 'stats', label: 'Statistika' },
                        ] as const).map((t) => (
                            <button
                                key={t.id}
                                onClick={() => setActiveTab(t.id as any)}
                                className={cn(
                                    'flex-1 min-w-[78px] py-2 px-2 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap',
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
                        ['feed', 'chat', 'stats'].includes(activeTab) ? "hidden md:flex" : "flex"
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
                                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                                )}>
                                    {lead.source === 'whatsapp' ? '📱 WhatsApp' : '✍️ Manual'}
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
                        ['feed', 'chat', 'stats'].includes(activeTab) ? "flex" : "hidden md:flex"
                    )}>

                        {/* Tab Bar (Desktop only) */}
                        <div className="hidden md:flex items-end px-2 sm:px-5 gap-1 border-b border-white/5 bg-[#111827]/40 shrink-0 overflow-x-auto no-scrollbar">
                            {[
                                { id: 'feed', label: 'Gedişat', icon: <MessageSquare className="w-3.5 h-3.5" /> },
                                { id: 'chat', label: 'Yazışmalar', icon: <Edit3 className="w-3.5 h-3.5" /> },
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

                                    {storyLoading && (
                                        <div className="flex items-center justify-center h-24 text-slate-500 text-sm">
                                            <span className="animate-pulse">Yüklənir...</span>
                                        </div>
                                    )}

                                    {storyError && !storyLoading && (
                                        <div className="rounded-xl border border-red-900/40 bg-red-950/15 p-3 text-xs text-red-300">
                                            {storyError}
                                        </div>
                                    )}

                                    {!storyLoading && (!story || story.length === 0) && (
                                        <div className="flex flex-col items-center py-12 gap-3 text-slate-600">
                                            <MessageSquare className="w-10 h-10" />
                                            <p className="text-sm">Hələ heç bir tarixçə yoxdur</p>
                                            <p className="text-xs text-slate-700">Mesaj, status və qeydlər burada görünəcək</p>
                                        </div>
                                    )}

                                    {!storyLoading && Array.isArray(story) && story.length > 0 && (() => {
                                        let lastDay = '';
                                        const rows: React.ReactNode[] = [];

                                        for (const ev of story) {
                                            const at = ev?.at ? new Date(ev.at) : new Date();
                                            const day = at.toLocaleDateString('az-AZ');
                                            const time = at.toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' });

                                            if (day !== lastDay) {
                                                lastDay = day;
                                                rows.push(
                                                    <div key={`day-${day}-${rows.length}`} className="flex items-center gap-3">
                                                        <div className="h-px flex-1 bg-slate-800" />
                                                        <span className="text-[10px] font-mono text-slate-500 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-full">
                                                            {day}
                                                        </span>
                                                        <div className="h-px flex-1 bg-slate-800" />
                                                    </div>
                                                );
                                            }

                                            if (ev.kind === 'message') {
                                                const isOut = ev.message.direction === 'out';
                                                rows.push(
                                                    <div key={ev.id} className="flex gap-3 items-start">
                                                        <div className={cn(
                                                            'w-7 h-7 rounded-full border flex items-center justify-center shrink-0 mt-0.5',
                                                            isOut ? 'bg-blue-900/40 border-blue-800' : 'bg-green-900/40 border-green-800'
                                                        )}>
                                                            <MessageSquare className={cn('w-3.5 h-3.5', isOut ? 'text-blue-300' : 'text-green-300')} />
                                                        </div>
                                                        <div className={cn(
                                                            'flex-1 border rounded-xl rounded-tl-sm p-3',
                                                            isOut ? 'bg-blue-950/10 border-blue-900/40' : 'bg-slate-900/60 border-slate-800'
                                                        )}>
                                                            <div className="flex justify-between items-start gap-2">
                                                                <span className="text-xs font-bold text-slate-200">
                                                                    {isOut ? 'Biz' : (lead.name || lead.phone)}
                                                                </span>
                                                                <span className="text-[10px] text-slate-500">{time}</span>
                                                            </div>
                                                            <p className="text-xs text-slate-300 mt-1 whitespace-pre-wrap break-words">
                                                                {String(ev.message.body || '').trim()}
                                                            </p>
                                                        </div>
                                                    </div>
                                                );
                                                continue;
                                            }

                                            // audit
                                            const who = ev.user?.displayName || ev.user?.username || 'Sistem';
                                            const action = String(ev.action || '');
                                            const details = ev.details || {};

                                            const lines: string[] = [];
                                            let icon = <User className="w-3.5 h-3.5 text-blue-400" />;
                                            let bubble = 'bg-slate-900/60 border-slate-800';

                                            if (action === 'LEAD_CREATED') {
                                                icon = <User className="w-3.5 h-3.5 text-blue-300" />;
                                                bubble = 'bg-blue-950/10 border-blue-900/40';
                                                const src = details.source === 'manual' ? 'Manual' : 'WhatsApp';
                                                lines.push(`Yeni əlaqə yaradıldı (mənbə: ${src})`);
                                            } else if (action === 'UPDATE_STATUS') {
                                                icon = <CheckCircle2 className="w-3.5 h-3.5 text-purple-300" />;
                                                bubble = 'bg-purple-950/10 border-purple-900/40';
                                                const oldS = details.oldStatus;
                                                const newS = details.newStatus;
                                                lines.push(`Status: ${stageLabel(oldS)} -> ${stageLabel(newS)}`);
                                            } else if (action === 'UPDATE_FIELDS') {
                                                icon = <Edit3 className="w-3.5 h-3.5 text-slate-300" />;
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

                                                const fieldById = new Map((customFields || []).map((f: any) => [f.id, f]));
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
                                                icon = <Route className="w-3.5 h-3.5 text-emerald-300" />;
                                                bubble = 'bg-emerald-950/10 border-emerald-900/40';
                                                const field = (customFields || []).find((f: any) => f.id === details.fieldId);
                                                const label = field?.label || details.fieldId || 'Field';
                                                lines.push(`Routing: ${label} = ${details.setValue || ''}`);
                                                if (details.targetStage) lines.push(`Mərhələ: ${stageLabel(details.targetStage)}`);
                                            } else if (action === 'LEAD_NOTE') {
                                                icon = <Edit3 className="w-3.5 h-3.5 text-amber-300" />;
                                                bubble = 'bg-amber-950/10 border-amber-900/40';
                                                lines.push(String(details.note || ''));
                                            } else {
                                                lines.push(action);
                                            }

                                            if (lines.length === 0) continue;
                                            rows.push(
                                                <div key={ev.id} className="flex gap-3 items-start">
                                                    <div className={cn('w-7 h-7 rounded-full border flex items-center justify-center shrink-0 mt-0.5', bubble)}>
                                                        {icon}
                                                    </div>
                                                    <div className={cn('flex-1 border rounded-xl rounded-tl-sm p-3', bubble)}>
                                                        <div className="flex justify-between items-start gap-2">
                                                            <span className="text-xs font-bold text-slate-200">{who}</span>
                                                            <span className="text-[10px] text-slate-500">{time}</span>
                                                        </div>
                                                        <div className="mt-1 space-y-1">
                                                            {lines.map((ln, i) => (
                                                                <p key={i} className="text-xs text-slate-300 whitespace-pre-wrap">{ln}</p>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        }

                                        return rows;
                                    })()}
                                    </div>
                                </div>
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
                                        <StatCard label="Mənbə" value={lead.source === 'whatsapp' ? 'WhatsApp' : 'Manual'} accent="text-sky-400" />
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

function MessageBubble({ name, message, time }: { name: string; message: string; time: string }) {
    return (
        <div className="flex gap-3 items-start">
            <div className="w-7 h-7 rounded-full bg-green-900/50 border border-green-800 flex items-center justify-center shrink-0 mt-0.5">
                <MessageSquare className="w-3.5 h-3.5 text-green-400" />
            </div>
            <div className="flex-1 bg-[#162032] border border-slate-700/60 rounded-xl rounded-tl-sm p-3 max-w-[90%]">
                <div className="flex justify-between items-center mb-1.5">
                    <span className="text-xs font-bold text-green-400">{name}</span>
                    <span className="text-[10px] text-slate-500">{time}</span>
                </div>
                <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{message}</p>
            </div>
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
