import React, { useState, useEffect } from 'react';
import QRCode from 'react-qr-code';
import {
    Settings, X, Plus, Trash2, GripVertical,
    Type, Hash, List, ChevronDown, ChevronUp, Save, Check,
    Zap, ToggleLeft, ToggleRight, AlertTriangle, Users, Activity, Smartphone, Wifi, WifiOff, RefreshCcw, Route, LayoutGrid
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
    CustomField, CRMSettings, FieldType, PipelineStage, AutoRule, RoutingRule,
    loadCRMSettings, saveCRMSettings, generateFieldId, applyRoutingRules, LeadCardUISettings
} from '../lib/crmSettings';
import { CrmService } from '../services/CrmService';
import { UsersSettings } from './UsersSettings';
import { AuditLogs } from './AuditLogs';
import { useAppStore } from '../context/Store';

// ─── Format (Factory Reset) Button ────────────────────────────────────────────
function FormatButton({ serverUrl, onClose }: { serverUrl: string; onClose: () => void }) {
    const { currentUser } = useAppStore();
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    if (currentUser?.permissions?.factory_reset === false && currentUser?.role !== 'superadmin') {
        return null; // Don't even show the button if no permission
    }

    const handleReset = async () => {
        if (!password) {
            setError('Şifrə daxil edilməlidir');
            return;
        }

        setBusy(true);
        setError('');
        try {
            if (serverUrl) {
                const res = await fetch(`${serverUrl}/api/leads/all`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        ...CrmService['getAuthHeaders']()
                    },
                    body: JSON.stringify({ password })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Silinmə zamanı xəta baş verdi');
            }
            // Also wipe localStorage
            Object.keys(localStorage).forEach(k => {
                if (k.includes('lead') || k.includes('crm')) localStorage.removeItem(k);
            });
            onClose();
            window.location.reload();
        } catch (e: any) {
            setError(e.message || 'Silinmə uğursuz oldu');
        } finally {
            setBusy(false);
        }
    };

    if (confirm) return (
        <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3 space-y-3">
            <p className="text-xs text-red-400 font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Bütün leadlar və yazışmalar silinəcək! Geri qaytarıla bilməz.
            </p>

            <div>
                <input
                    type="password"
                    placeholder="Təsdiq üçün şifrənizi yazın"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-red-500"
                />
                {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
            </div>

            <div className="flex gap-2">
                <button
                    onClick={handleReset}
                    disabled={busy || !password}
                    className="flex-1 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-lg transition-colors disabled:opacity-50"
                >
                    {busy ? 'Silinir...' : 'Bəli, sil!'}
                </button>
                <button
                    onClick={() => {
                        setConfirm(false);
                        setPassword('');
                        setError('');
                    }}
                    className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-lg transition-colors"
                >
                    Ləğv et
                </button>
            </div>
        </div>
    );

    return (
        <button
            onClick={() => setConfirm(true)}
            className="w-full py-2 rounded-lg text-xs font-semibold text-red-500 hover:text-red-400 border border-red-900/30 hover:border-red-800/60 bg-transparent hover:bg-red-950/20 flex items-center justify-center gap-1.5 transition-colors"
        >
            <Trash2 className="w-3.5 h-3.5" />
            Formatla (Bütün Datanı Sil)
        </button>
    );
}


interface CRMSettingsPanelProps {
    onClose?: () => void;
    variant?: 'modal' | 'page';
}

const TYPE_LABELS: Record<FieldType, { label: string; icon: React.ReactNode }> = {
    text: { label: 'Mətn', icon: <Type className="w-3.5 h-3.5" /> },
    number: { label: 'Rəqəm', icon: <Hash className="w-3.5 h-3.5" /> },
    select: { label: 'Seçim', icon: <List className="w-3.5 h-3.5" /> },
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────
type Tab = 'connection' | 'rules' | 'routing' | 'stages' | 'cards' | 'fields' | 'users' | 'audit';

const TABS: { id: Tab; label: string; icon: React.ReactNode; reqRole?: string[] }[] = [
    { id: 'connection', label: 'Bağlantı', icon: <Smartphone className="w-3.5 h-3.5" /> },
    { id: 'rules', label: 'Avtomatik Qaydalar', icon: <Zap className="w-3.5 h-3.5" /> },
    { id: 'routing', label: 'Mənbə (Routing)', icon: <Route className="w-3.5 h-3.5" /> },
    { id: 'stages', label: 'Kanban Sütunları', icon: <List className="w-3.5 h-3.5" /> },
    { id: 'cards', label: 'Lead Kartları', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
    { id: 'fields', label: 'Xüsusi Sahələr', icon: <Type className="w-3.5 h-3.5" /> },
    { id: 'users', label: 'İstifadəçilər', icon: <Users className="w-3.5 h-3.5" />, reqRole: ['admin', 'manager'] },
    { id: 'audit', label: 'Audit Log', icon: <Activity className="w-3.5 h-3.5" />, reqRole: ['admin'] },
];

function ConnectionSettings() {
    const { isWhatsAppConnected } = useAppStore();
    const [health, setHealth] = useState<any | null>(null);
    const [qr, setQr] = useState<string>('');
    const [busy, setBusy] = useState(false);

    const refreshHealth = async () => {
        const h = await CrmService.fetchHealth();
        if (h) setHealth(h);
    };

    useEffect(() => {
        const cleanupHealth = CrmService.onHealthCheck((h: any) => setHealth(h));
        const cleanupQr = CrmService.onQrCode((q: string) => setQr(q));
        const cleanupAuth = CrmService.onAuthenticated(() => {
            setQr('');
            refreshHealth();
        });
        refreshHealth();

        return () => {
            cleanupHealth();
            cleanupQr();
            cleanupAuth();
        };
    }, []);

    const handleQrRefresh = async () => {
        setBusy(true);
        setQr('');
        try {
            await CrmService.startWhatsApp();
            await refreshHealth();
        } finally {
            setBusy(false);
        }
    };

    const handleReconnect = async () => {
        setBusy(true);
        setQr('');
        try {
            await CrmService.reconnect();
            await CrmService.startWhatsApp();
            await refreshHealth();
        } finally {
            setBusy(false);
        }
    };

    const info = CrmService.getConnectionInfo();
    const waStatus = health?.whatsapp || (isWhatsAppConnected ? 'CONNECTED' : 'OFFLINE');

    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-sm font-bold text-white">WhatsApp Bağlantısı</h2>
                <p className="text-xs text-slate-500 mt-0.5">QR, Socket və sistem statusunu buradan idarə edin</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">WhatsApp</p>
                    <div className="mt-1 flex items-center gap-2">
                        <span className={cn('w-2 h-2 rounded-full', waStatus === 'CONNECTED' ? 'bg-green-500' : waStatus === 'SYNCING' ? 'bg-yellow-500' : 'bg-rose-500')} />
                        <p className={cn('text-xs font-bold', waStatus === 'CONNECTED' ? 'text-green-400' : waStatus === 'SYNCING' ? 'text-yellow-400' : 'text-rose-400')}>{waStatus}</p>
                    </div>
                    {health?.connectedNumber && (
                        <p className="mt-1 text-[10px] text-slate-400 truncate">{health.connectedNumber}</p>
                    )}
                    {health?.timestamp && (
                        <p className="mt-1 text-[10px] text-slate-600 truncate">Son yoxlama: {new Date(health.timestamp).toLocaleString()}</p>
                    )}
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">Socket</p>
                    <div className="mt-1 flex items-center gap-2">
                        {info.socketConnected ? <Wifi className="w-4 h-4 text-blue-400" /> : <WifiOff className="w-4 h-4 text-slate-500" />}
                        <p className={cn('text-xs font-bold', info.socketConnected ? 'text-blue-300' : 'text-slate-400')}>{info.socketConnected ? 'CONNECTED' : 'DISCONNECTED'}</p>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-500 truncate">{info.serverUrl}</p>
                    {typeof health?.socket_clients === 'number' && (
                        <p className="mt-1 text-[10px] text-slate-600">UI client sayi: {health.socket_clients}</p>
                    )}
                </div>
            </div>

            <div className="flex gap-2">
                <button
                    onClick={handleQrRefresh}
                    disabled={busy}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    <RefreshCcw className={cn('w-4 h-4', busy && 'animate-spin')} />
                    QR Yenilə
                </button>
                <button
                    onClick={handleReconnect}
                    disabled={busy}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 border border-blue-500/30 text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    <RefreshCcw className={cn('w-4 h-4', busy && 'animate-spin')} />
                    Socket Yenilə
                </button>
            </div>

                    {waStatus !== 'CONNECTED' && (
                        <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-slate-200">QR Kod</p>
                        <p className="text-[10px] text-slate-500">WhatsApp → Linked devices</p>
                    </div>
                            <div className="mt-3 flex items-center justify-center min-h-[220px] rounded-lg bg-slate-900 border border-slate-800">
                                {qr ? (
                                    <div className="bg-white rounded-lg p-3 shadow-sm">
                                        <QRCode value={qr} size={180} />
                                    </div>
                                ) : (
                                    <div className="text-center text-slate-500">
                                        <div className={cn('mx-auto w-6 h-6 border-2 border-slate-600 border-t-transparent rounded-full', busy && 'animate-spin')} />
                                        <p className="mt-2 text-xs">QR gözlənilir...</p>
                                        <p className="mt-1 text-[10px]">QR Yenilə düyməsini basın</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
        </section>
    );
}

function KeywordChipsInput({
    value,
    onChange,
    placeholder,
    disabled,
}: {
    value: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
    disabled?: boolean;
}) {
    const [draft, setDraft] = useState('');

    const normalize = (s: string) => String(s || '').trim().replace(/\s+/g, ' ');

    const splitRaw = (raw: string) => {
        // Support comma / semicolon / newline separated input (paste friendly)
        return String(raw || '')
            .split(/[,;\n\r\t]+/g)
            .map(normalize)
            .filter(Boolean);
    };

    const dedupe = (items: string[]) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const it of items) {
            const key = it.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(it);
        }
        return out;
    };

    const commitDraft = () => {
        const parts = splitRaw(draft);
        if (parts.length === 0) return;
        onChange(dedupe([...(value || []), ...parts]));
        setDraft('');
    };

    const removeAt = (idx: number) => {
        const next = (value || []).filter((_, i) => i !== idx);
        onChange(next);
    };

    return (
        <div className={cn(
            'w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-200',
            'focus-within:outline-none focus-within:ring-1 focus-within:ring-emerald-500',
            disabled && 'opacity-60 pointer-events-none'
        )}>
            <div className="flex flex-wrap items-center gap-1.5">
                {(value || []).map((kw, idx) => (
                    <span
                        key={`${kw}-${idx}`}
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-950/30 border border-emerald-900/40 text-emerald-200 px-2 py-1"
                        title={kw}
                    >
                        <span className="max-w-[220px] truncate">{kw}</span>
                        <button
                            type="button"
                            onClick={() => removeAt(idx)}
                            className="p-0.5 text-emerald-200/70 hover:text-white"
                            aria-label="Remove keyword"
                            title="Sil"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </span>
                ))}

                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitDraft}
                    onPaste={(e) => {
                        const text = e.clipboardData?.getData('text') || '';
                        // If user pasted multiple keywords, commit immediately
                        if (/[,;\n\r\t]/.test(text)) {
                            e.preventDefault();
                            const parts = splitRaw(text);
                            if (parts.length > 0) onChange(dedupe([...(value || []), ...parts]));
                        }
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
                            e.preventDefault();
                            commitDraft();
                            return;
                        }
                        if (e.key === 'Backspace' && draft.trim() === '' && (value || []).length > 0) {
                            e.preventDefault();
                            onChange((value || []).slice(0, -1));
                        }
                    }}
                    placeholder={placeholder || 'Acar soz yazin ve Enter basin...'}
                    className="flex-1 min-w-[160px] bg-transparent outline-none px-1 py-1 placeholder:text-slate-600"
                    disabled={disabled}
                    inputMode="text"
                />
            </div>

            <div className="mt-1 flex items-center justify-between gap-2">
                <p className="text-[10px] text-slate-600">Enter/Tab ile elave edin, Backspace ile sonuncunu silin. Paste: vergul/enter ile bolunecek.</p>
                <span className="text-[10px] text-slate-600 shrink-0">{(value || []).length} soz</span>
            </div>
        </div>
    );
}

export function CRMSettingsPanel({ onClose, variant = 'modal' }: CRMSettingsPanelProps) {
    const safeOnClose = onClose || (() => { });
    const { currentUser, isWhatsAppConnected } = useAppStore();
    const [settings, setSettings] = useState<CRMSettings>(loadCRMSettings());
    const [saved, setSaved] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [activeTab, setActiveTab] = useState<Tab>(() => (isWhatsAppConnected ? 'rules' : 'connection'));
    const serverUrl = CrmService.getServerUrl();

    const canSaveToDb = currentUser?.role === 'admin' || currentUser?.role === 'superadmin';


    // Fields UI state
    const [expandedFieldId, setExpandedFieldId] = useState<string | null>(null);
    const [newOptionText, setNewOptionText] = useState<Record<string, string>>({});

    const [draggedStageIdx, setDraggedStageIdx] = useState<number | null>(null);

    const [draggedRoutingIdx, setDraggedRoutingIdx] = useState<number | null>(null);
    const [routingTestText, setRoutingTestText] = useState('');
    const [routingStats, setRoutingStats] = useState<Record<string, { count: number; last_at?: string }>>({});

    // ESC close (modal only)
    useEffect(() => {
        if (variant !== 'modal') return;
        if (!onClose) return;
        const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', fn);
        return () => window.removeEventListener('keydown', fn);
    }, [onClose, variant]);

    const handleSave = async () => {
        setSaving(true);
        setSaveError('');
        try {
            if (!canSaveToDb) {
                throw new Error('Ayarları yadda saxlamaq üçün Admin icazəsi lazımdır');
            }
            await saveCRMSettings(settings);
            setSaved(true);
            setTimeout(() => {
                setSaved(false);
                window.location.reload();
            }, 900);
        } catch (e: any) {
            setSaveError(e?.message || 'Saxlama zamanı xəta baş verdi');
        } finally {
            setSaving(false);
        }
    };

    // ─── Auto-Rules CRUD ───────────────────────────────────────────────────────

    const addRule = () => {
        const newRule: AutoRule = {
            id: generateFieldId(),
            enabled: true,
            keyword: '',
            targetStage: settings.pipelineStages[0]?.id || 'new',
            extractValue: false,
            note: '',
        };
        setSettings(prev => ({ ...prev, autoRules: [...prev.autoRules, newRule] }));
    };

    const updateRule = (id: string, updates: Partial<AutoRule>) => {
        setSettings(prev => ({
            ...prev,
            autoRules: prev.autoRules.map(r => r.id === id ? { ...r, ...updates } : r)
        }));
    };

    const removeRule = (id: string) => {
        setSettings(prev => ({
            ...prev,
            autoRules: prev.autoRules.filter(r => r.id !== id)
        }));
    };

    // ─── Routing Rules (message -> custom select field) ───────────────────────

    const selectFields = settings.customFields.filter(f => f.type === 'select');

    const addRoutingRule = () => {
        const firstField = selectFields[0];
        const defaultFieldId = firstField?.id || '';
        const defaultValue = (firstField?.options || [])[0] || '';
        const newRule: RoutingRule = {
            id: generateFieldId(),
            enabled: true,
            fieldId: defaultFieldId,
            setValue: defaultValue,
            keywords: [],
            excludeKeywords: [],
            matchMode: 'any',
            matchType: 'contains',
            caseSensitive: false,
            lockFieldAfterMatch: true,
            targetStage: ''
        };
        setSettings(prev => ({
            ...prev,
            routingRules: [...(prev.routingRules || []), newRule]
        }));
    };

    const updateRoutingRule = (id: string, updates: Partial<RoutingRule>) => {
        setSettings(prev => ({
            ...prev,
            routingRules: (prev.routingRules || []).map(r => r.id === id ? { ...r, ...updates } : r)
        }));
    };

    const removeRoutingRule = (id: string) => {
        setSettings(prev => ({
            ...prev,
            routingRules: (prev.routingRules || []).filter(r => r.id !== id)
        }));
    };

    const updateLeadCardUi = (updates: Partial<LeadCardUISettings>) => {
        setSettings(prev => ({
            ...prev,
            ui: {
                ...(prev.ui || {}),
                leadCard: {
                    ...((prev.ui && prev.ui.leadCard) || {}),
                    ...updates
                }
            }
        }));
    };

    const handleRoutingDragStart = (e: React.DragEvent, idx: number) => {
        setDraggedRoutingIdx(idx);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleRoutingDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        if (draggedRoutingIdx === null || draggedRoutingIdx === idx) return;

        const newRules = [...(settings.routingRules || [])];
        const draggedItem = newRules[draggedRoutingIdx];
        newRules.splice(draggedRoutingIdx, 1);
        newRules.splice(idx, 0, draggedItem);

        setDraggedRoutingIdx(idx);
        setSettings(prev => ({ ...prev, routingRules: newRules }));
    };

    const handleRoutingDragEnd = () => {
        setDraggedRoutingIdx(null);
    };

    // Load routing rule stats when routing tab opens
    useEffect(() => {
        if (activeTab !== 'routing') return;
        if (!canSaveToDb) return;
        if (!serverUrl) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${serverUrl}/api/routing-rules/stats?days=7`, {
                    headers: CrmService['getAuthHeaders']()
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) return;
                if (cancelled) return;
                setRoutingStats(data?.stats || {});
            } catch {
                // ignore
            }
        })();
        return () => { cancelled = true; };
    }, [activeTab, canSaveToDb, serverUrl]);

    // ─── Pipeline Stage CRUD ───────────────────────────────────────────────────

    const addStage = () => {
        const newStage: PipelineStage = { id: generateFieldId(), label: 'Yeni Sütun', color: 'slate' };
        setSettings(prev => ({ ...prev, pipelineStages: [...prev.pipelineStages, newStage] }));
    };

    const updateStage = (id: string, updates: Partial<PipelineStage>) => {
        setSettings(prev => ({
            ...prev,
            pipelineStages: prev.pipelineStages.map(s => s.id === id ? { ...s, ...updates } : s)
        }));
    };

    const removeStage = (id: string) => {
        if (settings.pipelineStages.length <= 1) { alert('Ən azı 1 sütun olmalıdır!'); return; }
        setSettings(prev => ({ ...prev, pipelineStages: prev.pipelineStages.filter(s => s.id !== id) }));
    };

    const handleStageDragStart = (e: React.DragEvent, idx: number) => {
        setDraggedStageIdx(idx);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleStageDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        if (draggedStageIdx === null || draggedStageIdx === idx) return;

        const newStages = [...settings.pipelineStages];
        const draggedItem = newStages[draggedStageIdx];
        newStages.splice(draggedStageIdx, 1);
        newStages.splice(idx, 0, draggedItem);

        setDraggedStageIdx(idx);
        setSettings(prev => ({ ...prev, pipelineStages: newStages }));
    };

    const handleStageDragEnd = () => {
        setDraggedStageIdx(null);
    };

    // ─── Custom Field CRUD ─────────────────────────────────────────────────────

    const addField = (type: FieldType) => {
        const newField: CustomField = {
            id: generateFieldId(),
            label: type === 'text' ? 'Yeni Mətn Sahəsi' : type === 'number' ? 'Yeni Rəqəm Sahəsi' : 'Yeni Seçim Sahəsi',
            type,
            options: type === 'select' ? [] : undefined,
        };
        setSettings(prev => ({ ...prev, customFields: [...prev.customFields, newField] }));
        setExpandedFieldId(newField.id);
    };

    const updateField = (id: string, updates: Partial<CustomField>) => {
        setSettings(prev => ({
            ...prev,
            customFields: prev.customFields.map(f => f.id === id ? { ...f, ...updates } : f)
        }));
    };

    const removeField = (id: string) => {
        setSettings(prev => ({ ...prev, customFields: prev.customFields.filter(f => f.id !== id) }));
    };

    const addOption = (fieldId: string) => {
        const text = (newOptionText[fieldId] || '').trim();
        if (!text) return;
        updateField(fieldId, { options: [...(settings.customFields.find(f => f.id === fieldId)?.options || []), text] });
        setNewOptionText(prev => ({ ...prev, [fieldId]: '' }));
    };

    const removeOption = (fieldId: string, optIdx: number) => {
        const field = settings.customFields.find(f => f.id === fieldId);
        if (!field?.options) return;
        updateField(fieldId, { options: field.options.filter((_, i) => i !== optIdx) });
    };

    // ─── Render ────────────────────────────────────────────────────────────────

    return (
        <div
            className={cn(
                variant === 'modal'
                    ? 'fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex justify-end'
                    : 'p-3 sm:p-6 max-w-[1600px] mx-auto h-full'
            )}
            onClick={variant === 'modal' ? safeOnClose : undefined}
        >
            <div
                className={cn(
                    'bg-[#0d1117] shadow-2xl flex flex-col overflow-hidden',
                    variant === 'modal'
                        ? 'h-full w-full sm:w-[500px] border-l border-white/5'
                        : 'w-full max-w-[1280px] mx-auto border border-slate-800 rounded-2xl min-h-[calc(100vh-160px)]'
                )}
                style={variant === 'modal' ? { animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)' } : undefined}
                onClick={variant === 'modal' ? (e) => e.stopPropagation() : undefined}
            >
                {/* Header */}
                <div className="h-14 flex items-center justify-between px-5 border-b border-white/5 bg-[#111827] shrink-0">
                    <div className="flex items-center gap-2">
                        <Settings className="w-5 h-5 text-blue-400" />
                        <span className="font-bold text-white text-base">CRM Ayarları</span>
                    </div>
                    {onClose && (
                        <button onClick={safeOnClose} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors" title="Bağla">
                            <X className="w-5 h-5" />
                        </button>
                    )}
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-800 bg-[#0d1117] shrink-0 overflow-x-auto custom-scrollbar">
                    {TABS.filter(t => !t.reqRole || t.reqRole.includes(currentUser?.role || '') || currentUser?.role === 'superadmin').map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                'flex-1 min-w-[max-content] px-3 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-all border-b-2',
                                activeTab === tab.id
                                    ? 'border-blue-500 text-blue-400'
                                    : 'border-transparent text-slate-500 hover:text-slate-300'
                            )}
                        >
                            {tab.icon}
                            <span className="hidden sm:inline">{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4">

                    {/* ─── TAB: Connection ─────────────────────────────────────── */}
                    {activeTab === 'connection' && (
                        <ConnectionSettings />
                    )}

                    {/* ─── TAB: Auto Rules ──────────────────────────────────────── */}
                    {activeTab === 'rules' && (
                        <section className="space-y-4">
                            <div>
                                <h2 className="text-sm font-bold text-white">Avtomatik Keçid Qaydaları</h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Mesajın içərisində açar söz tapılsa lead avtomatik həmin mərhələyə keçir.
                                </p>
                            </div>

                            {/* Rule Cards */}
                            <div className="space-y-3">
                                {settings.autoRules.map((rule, index) => (
                                    <div key={rule.id} className={cn(
                                        'rounded-xl border overflow-hidden transition-all',
                                        rule.enabled ? 'border-blue-900/50 bg-blue-950/10' : 'border-slate-800 bg-slate-900/40 opacity-60'
                                    )}>
                                        {/* Rule Header Row */}
                                        <div className="flex items-center gap-2 px-4 py-3">
                                            {/* Enable Toggle */}
                                            <button
                                                onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}
                                                className={cn(
                                                    'shrink-0 transition-colors',
                                                    rule.enabled ? 'text-blue-400' : 'text-slate-600'
                                                )}
                                                title={rule.enabled ? 'Söndür' : 'Yandır'}
                                            >
                                                {rule.enabled
                                                    ? <ToggleRight className="w-6 h-6" />
                                                    : <ToggleLeft className="w-6 h-6" />
                                                }
                                            </button>

                                            <span className="text-slate-500 text-xs font-bold shrink-0">#{index + 1}</span>

                                            {/* Keyword */}
                                            <input
                                                value={rule.keyword}
                                                onChange={e => updateRule(rule.id, { keyword: e.target.value })}
                                                placeholder="Açar söz (məs: qiymət)"
                                                className="flex-1 bg-transparent text-white text-sm focus:outline-none border-b border-transparent focus:border-slate-600 pb-0.5 min-w-0"
                                            />

                                            <button
                                                onClick={() => removeRule(rule.id)}
                                                className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>

                                        {/* Rule Body */}
                                        <div className="border-t border-slate-800/60 px-4 py-3 grid grid-cols-2 gap-3">
                                            {/* Target Stage */}
                                            <div>
                                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                    Keçəcəyi Mərhələ
                                                </label>
                                                <select
                                                    value={rule.targetStage}
                                                    onChange={e => updateRule(rule.id, { targetStage: e.target.value })}
                                                    className="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                                                >
                                                    {settings.pipelineStages.map(s => (
                                                        <option key={s.id} value={s.id}>{s.label}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Extract Value Toggle & Fixed Value & Currency Tag */}
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                                <div>
                                                    <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                        Mətndən Qiymət
                                                    </label>
                                                    <button
                                                        onClick={() => updateRule(rule.id, { extractValue: !rule.extractValue })}
                                                        className={cn(
                                                            'flex items-center gap-2 w-full px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all',
                                                            rule.extractValue
                                                                ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-400'
                                                                : 'bg-slate-900 border-slate-700 text-slate-500'
                                                        )}
                                                    >
                                                        {rule.extractValue
                                                            ? <><ToggleRight className="w-4 h-4" /> Açıqdır</>
                                                            : <><ToggleLeft className="w-4 h-4" /> Bağlıdır</>
                                                        }
                                                    </button>
                                                </div>

                                                {rule.extractValue ? (
                                                    <div>
                                                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1" title="Yalnız bu sözlə (məs: azn) yazılmış rəqəmi tapır">
                                                            Format (məs: azn)
                                                        </label>
                                                        <input
                                                            type="text"
                                                            value={rule.currencyTag || ''}
                                                            onChange={e => updateRule(rule.id, { currencyTag: e.target.value })}
                                                            placeholder="Məs: azn"
                                                            className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                        />
                                                    </div>
                                                ) : <div className="hidden sm:block" />}

                                                <div>
                                                    <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1" title="Açar söz tapıldıqda bu məbləği təyin et">
                                                        Sabit Qiymət (₼)
                                                    </label>
                                                    <input
                                                        type="number"
                                                        value={rule.fixedValue || ''}
                                                        onChange={e => updateRule(rule.id, { fixedValue: e.target.value ? parseFloat(e.target.value) : undefined })}
                                                        placeholder="Məs: 50"
                                                        className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                    />
                                                </div>
                                            </div>

                                            {/* Optional Note */}
                                            <div className="col-span-2">
                                                <input
                                                    value={rule.note || ''}
                                                    onChange={e => updateRule(rule.id, { note: e.target.value })}
                                                    placeholder="Qeyd (isteğe bağlı, məs: 'Qiymət soruşur')"
                                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-600"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {settings.autoRules.length === 0 && (
                                <p className="text-center text-xs text-slate-600 py-4 italic">
                                    Heç bir qayda yoxdur. Aşağıdan əlavə edin.
                                </p>
                            )}

                            <button
                                onClick={addRule}
                                className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-xs font-medium transition-colors w-full justify-center"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Yeni Qayda Əlavə Et
                            </button>

                            {/* How it works info box */}
                            <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-4 space-y-1.5">
                                <p className="text-xs text-amber-400 font-semibold">⚡ Necə işləyir?</p>
                                <p className="text-xs text-slate-400 leading-relaxed">
                                    Yeni mesaj gəldikdə (gələn <strong>və</strong> gedən) mesajın mətni hər qaydanın açar sözü ilə yoxlanılır.
                                    Tapılarsa, lead avtomatik seçilmiş mərhələyə keçir.
                                </p>
                                <p className="text-xs text-slate-400 leading-relaxed">
                                    <strong className="text-emerald-400">Mətndən Qiymət</strong> açıqdırsa, mesajdakı rəqəm (əgər <em>"Format"</em> təyin edilibsə yalnız o sözlə birgə olan rəqəm, məs: 30azn) və ya <strong className="text-emerald-400">Sabit Qiymət</strong> təyin edilibsə, birbaşa büdcəyə yazılır.
                                </p>
                            </div>
                        </section>
                    )}

                    {/* ─── TAB: Routing Rules ─────────────────────────────────── */}
                    {activeTab === 'routing' && (
                        <section className="space-y-4">
                            <div>
                                <h2 className="text-sm font-bold text-white">Mətnə Görə Mənbə (Routing)</h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Mesajın içində açar söz tapılsa seçilmiş <strong>select</strong> sahəyə dəyər yazılır (məs: “Maraqlandığı kurs → Mahmud Dizayn”).
                                </p>
                            </div>

                            {/* Test box */}
                            <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-xs font-bold text-slate-200">Test Mesaj</p>
                                    <button
                                        type="button"
                                        onClick={() => setRoutingTestText('')}
                                        className="text-[10px] text-slate-500 hover:text-slate-300"
                                    >
                                        Təmizlə
                                    </button>
                                </div>
                                <textarea
                                    value={routingTestText}
                                    onChange={(e) => setRoutingTestText(e.target.value)}
                                    placeholder="Mesaj yazın... (routing qaydalarının hansının işə düşdüyünü görəcəksiniz)"
                                    rows={3}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-600"
                                />
                                {routingTestText.trim() !== '' && (
                                    <div className="text-[11px] text-slate-400">
                                        {(() => {
                                            const match = applyRoutingRules(routingTestText, settings.routingRules || []);
                                            if (!match) return <span className="text-slate-500">Heç bir qayda uyğun gəlmədi.</span>;
                                            const fieldId = Object.keys(match.extra || {})[0] || '';
                                            const field = settings.customFields.find(f => f.id === fieldId);
                                            const val = match.extra?.[fieldId] || '';
                                            return (
                                                <span>
                                                    Uyğun qayda: <span className="text-emerald-300 font-semibold">{match.ruleId}</span>
                                                    {' '}→ <span className="text-slate-200 font-semibold">{field?.label || fieldId}</span>
                                                    {' '}= <span className="text-slate-200 font-semibold">{val}</span>
                                                    {match.targetStage ? <span className="text-slate-500"> (mərhələ: {match.targetStage})</span> : null}
                                                </span>
                                            );
                                        })()}
                                    </div>
                                )}
                            </div>

                            {selectFields.length === 0 ? (
                                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-500">
                                    Select tipli xususi saha yoxdur. Əvvəlcə <strong>Xüsusi Sahələr</strong> bölməsində select field yaradın.
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-3">
                                        {(settings.routingRules || []).map((r, idx) => {
                                            const field = settings.customFields.find(f => f.id === r.fieldId);
                                            const options = (field && field.type === 'select' ? (field.options || []) : []);

                                            const stat = routingStats[r.id];

                                            return (
                                                <div
                                                    key={r.id}
                                                    onDragOver={(e) => handleRoutingDragOver(e, idx)}
                                                    onDragEnd={handleRoutingDragEnd}
                                                    className={cn(
                                                    'rounded-xl border overflow-hidden',
                                                    r.enabled ? 'border-emerald-900/40 bg-emerald-950/10' : 'border-slate-800 bg-slate-900/40 opacity-60'
                                                )}>
                                                    <div className="flex items-center gap-2 px-4 py-3">
                                                        <button
                                                            type="button"
                                                            draggable
                                                            onDragStart={(e) => handleRoutingDragStart(e, idx)}
                                                            className="p-1 text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing shrink-0"
                                                            title="Sırala"
                                                        >
                                                            <GripVertical className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => updateRoutingRule(r.id, { enabled: !r.enabled })}
                                                            className={cn('shrink-0 transition-colors', r.enabled ? 'text-emerald-400' : 'text-slate-600')}
                                                            title={r.enabled ? 'Söndür' : 'Yandır'}
                                                        >
                                                            {r.enabled ? <ToggleRight className="w-6 h-6" /> : <ToggleLeft className="w-6 h-6" />}
                                                        </button>
                                                        <span className="text-slate-500 text-xs font-bold shrink-0">#{idx + 1}</span>

                                                        {typeof stat?.count === 'number' && (
                                                            <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-700 bg-slate-950/40 text-slate-300 shrink-0" title="Son 7 gün">
                                                                7g: {stat.count}
                                                            </span>
                                                        )}

                                                        <select
                                                            value={r.fieldId}
                                                            onChange={(e) => {
                                                                const nextFieldId = e.target.value;
                                                                const nextField = settings.customFields.find(f => f.id === nextFieldId);
                                                                const nextDefault = (nextField && nextField.type === 'select' ? (nextField.options || [])[0] : '') || '';
                                                                updateRoutingRule(r.id, { fieldId: nextFieldId, setValue: nextDefault });
                                                            }}
                                                            className="flex-1 bg-slate-900 border border-slate-700 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                                                        >
                                                            {selectFields.map(f => (
                                                                <option key={f.id} value={f.id}>{f.label}</option>
                                                            ))}
                                                        </select>

                                                        <button
                                                            onClick={() => removeRoutingRule(r.id)}
                                                            className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0"
                                                            title="Sil"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </div>

                                                    <div className="border-t border-slate-800/60 px-4 py-3 space-y-3">
                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div>
                                                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                    Seçiləcək Dəyər
                                                                </label>
                                                                <select
                                                                    value={r.setValue}
                                                                    onChange={(e) => updateRoutingRule(r.id, { setValue: e.target.value })}
                                                                    className="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                                                                >
                                                                    <option value="">-- Seçin --</option>
                                                                    {options.map(opt => (
                                                                        <option key={opt} value={opt}>{opt}</option>
                                                                    ))}
                                                                </select>
                                                            </div>

                                                            <div>
                                                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                    Uyğunluq Rejimi
                                                                </label>
                                                                <select
                                                                    value={r.matchMode || 'any'}
                                                                    onChange={(e) => updateRoutingRule(r.id, { matchMode: e.target.value as any })}
                                                                    className="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                                                                >
                                                                    <option value="any">Hər hansı (OR)</option>
                                                                    <option value="all">Hamısı (AND)</option>
                                                                </select>
                                                                <p className="mt-1 text-[10px] text-slate-600">"Hər hansı" seçilsə, açar sözlərdən 1-i kifayətdir. "Hamısı" seçilsə, hamısı mesajda olmalıdır.</p>
                                                            </div>
                                                        </div>

                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div>
                                                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                    Uyğunluq Növü (Match Type)
                                                                </label>
                                                                <select
                                                                    value={r.matchType || 'contains'}
                                                                    onChange={(e) => updateRoutingRule(r.id, { matchType: e.target.value as any })}
                                                                    className="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                                                                >
                                                                    <option value="contains">Mətnin içində keçir</option>
                                                                    <option value="startsWith">Mətn bununla başlayır</option>
                                                                    <option value="exact">Tam eynidir</option>
                                                                    <option value="regex">Regex (qayda)</option>
                                                                </select>
                                                                <p className="mt-1 text-[10px] text-slate-600">"Mətnin içində keçir": söz mesajın istənilən yerində ola bilər. "Tam eynidir": mesaj yalnız həmin söz olmalıdır. "Regex": çətin axtarış üçündür.</p>
                                                            </div>

                                                            <div>
                                                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                    Davranış
                                                                </label>
                                                                <div className="flex gap-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => updateRoutingRule(r.id, { caseSensitive: !r.caseSensitive })}
                                                                        className={cn(
                                                                            'flex-1 px-2 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors',
                                                                            r.caseSensitive
                                                                                ? 'border-emerald-700/50 bg-emerald-950/20 text-emerald-200'
                                                                                : 'border-slate-700 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                                        )}
                                                                        title="Böyük/kiçik hərf fərqi"
                                                                    >
                                                                        Aa
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => updateRoutingRule(r.id, { lockFieldAfterMatch: r.lockFieldAfterMatch === false ? true : false })}
                                                                        className={cn(
                                                                            'flex-[1.4] px-2 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors',
                                                                            r.lockFieldAfterMatch !== false
                                                                                ? 'border-emerald-700/50 bg-emerald-950/20 text-emerald-200'
                                                                                : 'border-slate-700 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                                        )}
                                                                        title="Bir dəfə tətbiq et (sahə doludursa toxunma)"
                                                                    >
                                                                        1x Lock
                                                                    </button>
                                                                </div>
                                                                <p className="mt-1 text-[10px] text-slate-600">"Aa" açıqdırsa, böyük/kiçik hərf fərqi nəzərə alınır. "1x Lock" açıqdırsa, sahə doludursa bu qayda bir daha tətbiq olunmur.</p>
                                                            </div>
                                                        </div>

                                                        <div>
                                                            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                Açar Sözlər
                                                            </label>
                                                            <KeywordChipsInput
                                                                value={r.keywords || []}
                                                                onChange={(next) => updateRoutingRule(r.id, { keywords: next })}
                                                                placeholder={r.matchType === 'regex' ? 'məs: \\b(dizayn|interyer)\\b (Enter)' : 'məs: mahmud, dizayn, masterclass (Enter)'}
                                                            />
                                                            <p className="mt-1 text-[10px] text-slate-600">Qayda: mesaj mətni bu sözləri ehtiva edərsə dəyər yazılır.</p>
                                                        </div>

                                                        <div>
                                                            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                İstisna Sözlər (olarsa işləməsin)
                                                            </label>
                                                            <KeywordChipsInput
                                                                value={r.excludeKeywords || []}
                                                                onChange={(next) => updateRoutingRule(r.id, { excludeKeywords: next })}
                                                                placeholder="məs: spam, test (Enter)"
                                                            />
                                                            <p className="mt-1 text-[10px] text-slate-600">Bu sözlərdən biri varsa qayda işə düşməyəcək.</p>
                                                        </div>

                                                        <div>
                                                            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                                                                (İstəyə bağlı) Mərhələ
                                                            </label>
                                                            <select
                                                                value={r.targetStage || ''}
                                                                onChange={(e) => updateRoutingRule(r.id, { targetStage: e.target.value })}
                                                                className="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                                                            >
                                                                <option value="">-- Dəyişmə --</option>
                                                                {settings.pipelineStages.map(s => (
                                                                    <option key={s.id} value={s.id}>{s.label}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {(settings.routingRules || []).length === 0 && (
                                        <p className="text-center text-xs text-slate-600 py-4 italic">Heç bir routing qaydası yoxdur.</p>
                                    )}

                                    <button
                                        onClick={addRoutingRule}
                                        className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-xs font-medium transition-colors w-full justify-center"
                                    >
                                        <Plus className="w-3.5 h-3.5" />
                                        Yeni Routing Qaydası Əlavə Et
                                    </button>
                                </>
                            )}
                        </section>
                    )}

                    {/* ─── TAB: Pipeline Stages ─────────────────────────────────── */}
                    {activeTab === 'stages' && (
                        <section className="space-y-4">
                            <div>
                                <h2 className="text-sm font-bold text-white">Kanban Sütunları</h2>
                                <p className="text-xs text-slate-500 mt-0.5">CRM lövhəsindəki satış mərhələləri</p>
                            </div>

                            <div className="space-y-2">
                                {settings.pipelineStages.map((stage, idx) => (
                                    <div
                                        key={stage.id}
                                        draggable
                                        onDragStart={(e) => handleStageDragStart(e, idx)}
                                        onDragOver={(e) => handleStageDragOver(e, idx)}
                                        onDragEnd={handleStageDragEnd}
                                        className={cn(
                                            "flex items-center gap-3 border rounded-xl px-4 py-3 transition-colors",
                                            draggedStageIdx === idx ? 'bg-slate-800 border-slate-600 opacity-50' : 'bg-slate-900 border-slate-800'
                                        )}
                                    >
                                        <GripVertical className="w-4 h-4 text-slate-600 cursor-grab shrink-0" />
                                        <input
                                            value={stage.label}
                                            onChange={e => updateStage(stage.id, { label: e.target.value })}
                                            className="flex-1 bg-transparent text-white text-sm font-bold focus:outline-none border-b border-transparent focus:border-slate-600 pb-0.5 min-w-0"
                                        />
                                        <select
                                            value={stage.color}
                                            onChange={e => updateStage(stage.id, { color: e.target.value })}
                                            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1 focus:outline-none appearance-none cursor-pointer"
                                        >
                                            <option value="blue">Mavi</option>
                                            <option value="purple">Bənövşəyi</option>
                                            <option value="green">Yaşıl</option>
                                            <option value="emerald">Zümrüd</option>
                                            <option value="teal">Firuzəyi</option>
                                            <option value="red">Qırmızı</option>
                                            <option value="orange">Narıncı</option>
                                            <option value="amber">Kəhrəba</option>
                                            <option value="yellow">Sarı</option>
                                            <option value="slate">Boz</option>
                                            <option value="zinc">Tünd Boz</option>
                                        </select>
                                        <button onClick={() => removeStage(stage.id)} className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <button
                                onClick={addStage}
                                className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-xs font-medium transition-colors"
                            >
                                <Plus className="w-3 h-3" />
                                Yeni Sütun əlavə et
                            </button>
                        </section>
                    )}

                    {/* ─── TAB: Lead Card UI ───────────────────────────────────── */}
                    {activeTab === 'cards' && (
                        <section className="space-y-4">
                            <div>
                                <h2 className="text-sm font-bold text-white">Lead Kartları</h2>
                                <p className="text-xs text-slate-500 mt-0.5">Kanban kartlarının üstündə hansı məlumatlar görünsün</p>
                            </div>

                            {(() => {
                                const ui = settings.ui?.leadCard || {};
                                const selectFieldsAll = settings.customFields.filter(f => f.type === 'select');
                                const enabledIds = Array.isArray(ui.customFieldIds) ? ui.customFieldIds : [];
                                const useAll = (ui.showCustomFieldBadges !== false) && (enabledIds.length === 0);

                                return (
                                    <>
                                        <div className="grid grid-cols-2 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showNameBadge: !(ui.showNameBadge !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showNameBadge !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Ad
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showAssignee: !(ui.showAssignee !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showAssignee !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Operator
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showSource: !(ui.showSource !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showSource !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Mənbə
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showProductBadge: !(ui.showProductBadge !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showProductBadge !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Məhsul
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showLastMessagePreview: !(ui.showLastMessagePreview !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showLastMessagePreview !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Mesaj Preview
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showValue: !(ui.showValue !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showValue !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Büdcə
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLeadCardUi({ showCustomFieldBadges: !(ui.showCustomFieldBadges !== false) })}
                                                className={cn(
                                                    'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                    ui.showCustomFieldBadges !== false
                                                        ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                )}
                                            >
                                                Xüsusi Sahələr
                                            </button>
                                        </div>

                                        <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 space-y-3">
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs font-bold text-slate-200">Xüsusi Sahə Badge-ləri</p>
                                                <span className="text-[10px] text-slate-600">Select field-lər</span>
                                            </div>

                                            <div className="grid grid-cols-2 gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => updateLeadCardUi({ customFieldBadgeMode: 'value' })}
                                                    className={cn(
                                                        'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                        (ui.customFieldBadgeMode || 'value') === 'value'
                                                            ? 'border-blue-800/40 bg-blue-950/20 text-blue-200'
                                                            : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                    )}
                                                >
                                                    Yalnız dəyər
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => updateLeadCardUi({ customFieldBadgeMode: 'label_value' })}
                                                    className={cn(
                                                        'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                                                        (ui.customFieldBadgeMode || 'value') === 'label_value'
                                                            ? 'border-blue-800/40 bg-blue-950/20 text-blue-200'
                                                            : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                                    )}
                                                >
                                                    Başlıq + dəyər
                                                </button>
                                            </div>

                                            <div className="flex items-center justify-between gap-2">
                                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Max badge</label>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={8}
                                                    value={Number.isFinite(Number(ui.maxCustomFieldBadges)) ? Number(ui.maxCustomFieldBadges) : 2}
                                                    onChange={(e) => {
                                                        const n = parseInt(e.target.value, 10);
                                                        updateLeadCardUi({ maxCustomFieldBadges: Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : 2 });
                                                    }}
                                                    className="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                />
                                            </div>

                                            {selectFieldsAll.length === 0 ? (
                                                <p className="text-xs text-slate-600 italic">Heç bir select tipli xüsusi sahə yoxdur.</p>
                                            ) : (
                                                <>
                                                    <div className="flex items-center justify-between gap-2">
                                                        <p className="text-[10px] text-slate-600">Hansı sahələr kartda görünsün</p>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateLeadCardUi({ customFieldIds: [] })}
                                                            className="text-[10px] text-slate-500 hover:text-slate-300"
                                                            title="Boş olduqda: hamısı"
                                                        >
                                                            Hamısı (default)
                                                        </button>
                                                    </div>

                                                    <div className="space-y-1">
                                                        {selectFieldsAll.map(f => {
                                                            const checked = useAll ? true : enabledIds.includes(f.id);
                                                            return (
                                                                <label key={f.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/30">
                                                                    <div className="min-w-0">
                                                                        <p className="text-xs text-slate-200 font-semibold truncate">{f.label}</p>
                                                                        <p className="text-[10px] text-slate-600 truncate">{f.id}</p>
                                                                    </div>
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={checked}
                                                                        onChange={(e) => {
                                                                            // If user is in "all" mode (empty list), convert to explicit list on first change.
                                                                            if (enabledIds.length === 0) {
                                                                                if (!e.target.checked) {
                                                                                    const explicit = selectFieldsAll.map(sf => sf.id).filter(id => id !== f.id);
                                                                                    updateLeadCardUi({ customFieldIds: explicit });
                                                                                } else {
                                                                                    // no-op: already all
                                                                                }
                                                                                return;
                                                                            }

                                                                            const next = new Set(enabledIds);
                                                                            if (e.target.checked) next.add(f.id);
                                                                            else next.delete(f.id);
                                                                            updateLeadCardUi({ customFieldIds: Array.from(next) });
                                                                        }}
                                                                        className="h-4 w-4 accent-blue-500"
                                                                        disabled={ui.showCustomFieldBadges === false}
                                                                    />
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                    <p className="text-[10px] text-slate-600">Qeyd: siyahı boşdursa kartda bütün select sahələr (dəyəri olanlar) görünəcək.</p>
                                                </>
                                            )}
                                        </div>
                                    </>
                                );
                            })()}
                        </section>
                    )}

                    {/* ─── TAB: Custom Fields ───────────────────────────────────── */}
                    {activeTab === 'fields' && (
                        <section className="space-y-4">
                            <div>
                                <h2 className="text-sm font-bold text-white">Xüsusi Sahələr</h2>
                                <p className="text-xs text-slate-500 mt-0.5">Lead panelində görünəcək əlavə məlumatlar</p>
                            </div>

                            <div className="space-y-2">
                                {settings.customFields.map(field => {
                                    const isExpanded = expandedFieldId === field.id;
                                    return (
                                        <div key={field.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                                            <div className="flex items-center gap-3 px-4 py-3">
                                                <GripVertical className="w-4 h-4 text-slate-600 cursor-grab shrink-0" />
                                                <input
                                                    value={field.label}
                                                    onChange={e => updateField(field.id, { label: e.target.value })}
                                                    className="flex-1 bg-transparent text-white text-sm font-medium focus:outline-none border-b border-transparent focus:border-slate-600 pb-0.5 min-w-0"
                                                />
                                                <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-slate-800 px-2 py-1 rounded shrink-0">
                                                    {TYPE_LABELS[field.type].icon}
                                                    <span className="hidden sm:inline">{TYPE_LABELS[field.type].label}</span>
                                                </div>
                                                {field.type === 'select' && (
                                                    <button onClick={() => setExpandedFieldId(isExpanded ? null : field.id)} className="p-1 text-slate-500 hover:text-slate-300 transition-colors shrink-0">
                                                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                    </button>
                                                )}
                                                <button onClick={() => removeField(field.id)} className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0">
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>

                                            {field.type === 'select' && isExpanded && (
                                                <div className="border-t border-slate-800 bg-slate-950/40 px-4 py-3 space-y-2">
                                                    <p className="text-[10px] font-semibold text-slate-500 uppercase mb-2">Seçim Variantları</p>
                                                    {(field.options || []).length === 0 && (
                                                        <p className="text-xs text-slate-600 italic">Hələ seçim yoxdur. Aşağıdan əlavə edin.</p>
                                                    )}
                                                    {(field.options || []).map((opt, idx) => (
                                                        <div key={idx} className="flex items-center gap-2">
                                                            <div className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-300">{opt}</div>
                                                            <button onClick={() => removeOption(field.id, idx)} className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0">
                                                                <X className="w-3.5 h-3.5" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <div className="flex gap-2 mt-2">
                                                        <input
                                                            value={newOptionText[field.id] || ''}
                                                            onChange={e => setNewOptionText(prev => ({ ...prev, [field.id]: e.target.value }))}
                                                            onKeyDown={e => e.key === 'Enter' && addOption(field.id)}
                                                            placeholder="Yeni variant yazın..."
                                                            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                        />
                                                        <button onClick={() => addOption(field.id)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition-colors shrink-0">
                                                            <Plus className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="mt-3 flex flex-wrap gap-2">
                                {(Object.keys(TYPE_LABELS) as FieldType[]).map(type => (
                                    <button key={type} onClick={() => addField(type)} className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-xs font-medium transition-colors">
                                        <Plus className="w-3 h-3" />
                                        {TYPE_LABELS[type].icon}
                                        {TYPE_LABELS[type].label} əlavə et
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* ─── TAB: Users ───────────────────────────────────────────── */}
                    {activeTab === 'users' && (
                        <UsersSettings />
                    )}

                    {/* ─── TAB: Audit Logs ──────────────────────────────────────── */}
                    {activeTab === 'audit' && (
                        <AuditLogs />
                    )}

                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-[#111827]/60 shrink-0 space-y-2">
                    {saveError && (
                        <div className="rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-2 text-[11px] text-red-300">
                            {saveError}
                        </div>
                    )}

                    {!canSaveToDb && (
                        <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-[11px] text-amber-300">
                            Qeyd: Bu ayarları database-ə yazmaq üçün Admin rol lazımdır.
                        </div>
                    )}

                    <button
                        onClick={handleSave}
                        disabled={saving || !canSaveToDb}
                        className={cn(
                            'w-full py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                            saved
                                ? 'bg-green-600 text-white'
                                : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 disabled:hover:bg-blue-600'
                        )}
                    >
                        {saving
                            ? <><span className="animate-spin">↻</span> Saxlanır...</>
                            : saved
                                ? <><Check className="w-4 h-4" /> Saxlandı!</>
                                : <><Save className="w-4 h-4" /> Ayarları Saxla</>
                        }
                    </button>

                    {/* Factory Reset */}
                    <FormatButton serverUrl={serverUrl} onClose={safeOnClose} />
                </div>

            </div>

            <style>{`
        @keyframes slideInRight {
          from { transform: translateX(40px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
        </div >
    );
}
