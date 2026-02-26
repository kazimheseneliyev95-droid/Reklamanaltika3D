import React, { useState, useEffect } from 'react';
import {
    Settings, X, Plus, Trash2, GripVertical,
    Type, Hash, List, ChevronDown, ChevronUp, Save, Check,
    Zap, ToggleLeft, ToggleRight, AlertTriangle, Users, Activity
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
    CustomField, CRMSettings, FieldType, PipelineStage, AutoRule,
    loadCRMSettings, saveCRMSettings, generateFieldId
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
    onClose: () => void;
}

const TYPE_LABELS: Record<FieldType, { label: string; icon: React.ReactNode }> = {
    text: { label: 'Mətn', icon: <Type className="w-3.5 h-3.5" /> },
    number: { label: 'Rəqəm', icon: <Hash className="w-3.5 h-3.5" /> },
    select: { label: 'Seçim', icon: <List className="w-3.5 h-3.5" /> },
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────
type Tab = 'rules' | 'stages' | 'fields' | 'users' | 'audit';

const TABS: { id: Tab; label: string; icon: React.ReactNode; reqRole?: string[] }[] = [
    { id: 'rules', label: 'Avtomatik Qaydalar', icon: <Zap className="w-3.5 h-3.5" /> },
    { id: 'stages', label: 'Kanban Sütunları', icon: <List className="w-3.5 h-3.5" /> },
    { id: 'fields', label: 'Xüsusi Sahələr', icon: <Type className="w-3.5 h-3.5" /> },
    { id: 'users', label: 'İstifadəçilər', icon: <Users className="w-3.5 h-3.5" />, reqRole: ['admin', 'manager'] },
    { id: 'audit', label: 'Audit Log', icon: <Activity className="w-3.5 h-3.5" />, reqRole: ['admin'] },
];

export function CRMSettingsPanel({ onClose }: CRMSettingsPanelProps) {
    const { currentUser } = useAppStore();
    const [settings, setSettings] = useState<CRMSettings>(loadCRMSettings());
    const [saved, setSaved] = useState(false);
    const [activeTab, setActiveTab] = useState<Tab>('rules');
    const serverUrl = CrmService.getServerUrl();


    // Fields UI state
    const [expandedFieldId, setExpandedFieldId] = useState<string | null>(null);
    const [newOptionText, setNewOptionText] = useState<Record<string, string>>({});

    const [draggedStageIdx, setDraggedStageIdx] = useState<number | null>(null);

    // ESC close
    useEffect(() => {
        const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', fn);
        return () => window.removeEventListener('keydown', fn);
    }, [onClose]);

    const handleSave = () => {
        saveCRMSettings(settings);
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
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
            className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex justify-end"
            onClick={onClose}
        >
            <div
                className="h-full w-full sm:w-[500px] bg-[#0d1117] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
                style={{ animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)' }}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="h-14 flex items-center justify-between px-5 border-b border-white/5 bg-[#111827] shrink-0">
                    <div className="flex items-center gap-2">
                        <Settings className="w-5 h-5 text-blue-400" />
                        <span className="font-bold text-white text-base">CRM Ayarları</span>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors">
                        <X className="w-5 h-5" />
                    </button>
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
                    <button
                        onClick={handleSave}
                        className={cn(
                            'w-full py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                            saved ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'
                        )}
                    >
                        {saved ? <><Check className="w-4 h-4" /> Saxlandı!</> : <><Save className="w-4 h-4" /> Ayarları Saxla</>}
                    </button>

                    {/* Factory Reset */}
                    <FormatButton serverUrl={serverUrl} onClose={onClose} />
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
