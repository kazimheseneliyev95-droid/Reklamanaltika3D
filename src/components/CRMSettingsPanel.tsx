import React, { useState, useEffect } from 'react';
import {
    Settings, X, Plus, Trash2, GripVertical,
    Type, Hash, List, ChevronDown, ChevronUp, Save, Check
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
    CustomField, CRMSettings, FieldType,
    loadCRMSettings, saveCRMSettings, generateFieldId
} from '../lib/crmSettings';

interface CRMSettingsPanelProps {
    onClose: () => void;
}

const TYPE_LABELS: Record<FieldType, { label: string; icon: React.ReactNode }> = {
    text: { label: 'Mətn', icon: <Type className="w-3.5 h-3.5" /> },
    number: { label: 'Rəqəm', icon: <Hash className="w-3.5 h-3.5" /> },
    select: { label: 'Seçim', icon: <List className="w-3.5 h-3.5" /> },
};

export function CRMSettingsPanel({ onClose }: CRMSettingsPanelProps) {
    const [settings, setSettings] = useState<CRMSettings>(loadCRMSettings());
    const [saved, setSaved] = useState(false);
    const [expandedFieldId, setExpandedFieldId] = useState<string | null>(null);
    const [newOptionText, setNewOptionText] = useState<Record<string, string>>({});

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

    const addField = (type: FieldType) => {
        const newField: CustomField = {
            id: generateFieldId(),
            label: type === 'text' ? 'Yeni Mətn Sahəsi'
                : type === 'number' ? 'Yeni Rəqəm Sahəsi'
                    : 'Yeni Seçim Sahəsi',
            type,
            options: type === 'select' ? [] : undefined,
        };
        setSettings(prev => ({
            ...prev,
            customFields: [...prev.customFields, newField]
        }));
        setExpandedFieldId(newField.id);
    };

    const updateField = (id: string, updates: Partial<CustomField>) => {
        setSettings(prev => ({
            ...prev,
            customFields: prev.customFields.map(f => f.id === id ? { ...f, ...updates } : f)
        }));
    };

    const removeField = (id: string) => {
        setSettings(prev => ({
            ...prev,
            customFields: prev.customFields.filter(f => f.id !== id)
        }));
    };

    const addOption = (fieldId: string) => {
        const text = (newOptionText[fieldId] || '').trim();
        if (!text) return;
        updateField(fieldId, {
            options: [...(settings.customFields.find(f => f.id === fieldId)?.options || []), text]
        });
        setNewOptionText(prev => ({ ...prev, [fieldId]: '' }));
    };

    const removeOption = (fieldId: string, optIdx: number) => {
        const field = settings.customFields.find(f => f.id === fieldId);
        if (!field?.options) return;
        updateField(fieldId, {
            options: field.options.filter((_, i) => i !== optIdx)
        });
    };

    return (
        <div
            className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex justify-end"
            onClick={onClose}
        >
            <div
                className="h-full w-full sm:w-[480px] bg-[#0d1117] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
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

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-6">

                    {/* Section: Custom Fields */}
                    <section>
                        <div className="flex items-center justify-between mb-3">
                            <div>
                                <h2 className="text-sm font-bold text-white">Xüsusi Sahələr</h2>
                                <p className="text-xs text-slate-500 mt-0.5">Lead panelinde gösterecek ek saheler</p>
                            </div>
                        </div>

                        {/* Field List */}
                        <div className="space-y-2">
                            {settings.customFields.map((field) => {
                                const isExpanded = expandedFieldId === field.id;
                                return (
                                    <div key={field.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                                        {/* Field Row */}
                                        <div className="flex items-center gap-3 px-4 py-3">
                                            <GripVertical className="w-4 h-4 text-slate-600 cursor-grab shrink-0" />

                                            {/* Label input */}
                                            <input
                                                value={field.label}
                                                onChange={e => updateField(field.id, { label: e.target.value })}
                                                className="flex-1 bg-transparent text-white text-sm font-medium focus:outline-none border-b border-transparent focus:border-slate-600 pb-0.5 min-w-0"
                                            />

                                            {/* Type badge */}
                                            <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-slate-800 px-2 py-1 rounded shrink-0">
                                                {TYPE_LABELS[field.type].icon}
                                                <span className="hidden sm:inline">{TYPE_LABELS[field.type].label}</span>
                                            </div>

                                            {/* Expand (for select fields) */}
                                            {field.type === 'select' && (
                                                <button
                                                    onClick={() => setExpandedFieldId(isExpanded ? null : field.id)}
                                                    className="p-1 text-slate-500 hover:text-slate-300 transition-colors shrink-0"
                                                >
                                                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                </button>
                                            )}

                                            {/* Delete */}
                                            <button
                                                onClick={() => removeField(field.id)}
                                                className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>

                                        {/* Dropdown Options (select fields only) */}
                                        {field.type === 'select' && isExpanded && (
                                            <div className="border-t border-slate-800 bg-slate-950/40 px-4 py-3 space-y-2">
                                                <p className="text-[10px] font-semibold text-slate-500 uppercase mb-2">Seçim Variantları</p>

                                                {(field.options || []).length === 0 && (
                                                    <p className="text-xs text-slate-600 italic">Hələ seçim yoxdur. Aşağıdan əlavə edin.</p>
                                                )}

                                                {(field.options || []).map((opt, idx) => (
                                                    <div key={idx} className="flex items-center gap-2">
                                                        <div className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-300">
                                                            {opt}
                                                        </div>
                                                        <button
                                                            onClick={() => removeOption(field.id, idx)}
                                                            className="p-1 text-slate-600 hover:text-red-400 transition-colors shrink-0"
                                                        >
                                                            <X className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                ))}

                                                {/* Add new option */}
                                                <div className="flex gap-2 mt-2">
                                                    <input
                                                        value={newOptionText[field.id] || ''}
                                                        onChange={e => setNewOptionText(prev => ({ ...prev, [field.id]: e.target.value }))}
                                                        onKeyDown={e => e.key === 'Enter' && addOption(field.id)}
                                                        placeholder="Yeni variant yazın..."
                                                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                    />
                                                    <button
                                                        onClick={() => addOption(field.id)}
                                                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition-colors shrink-0"
                                                    >
                                                        <Plus className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Add Field Buttons */}
                        <div className="mt-3 flex flex-wrap gap-2">
                            {(Object.keys(TYPE_LABELS) as FieldType[]).map(type => (
                                <button
                                    key={type}
                                    onClick={() => addField(type)}
                                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-xs font-medium transition-colors"
                                >
                                    <Plus className="w-3 h-3" />
                                    {TYPE_LABELS[type].icon}
                                    {TYPE_LABELS[type].label} əlavə et
                                </button>
                            ))}
                        </div>
                    </section>

                    {/* Section: Preview Info */}
                    <section className="bg-blue-950/20 border border-blue-900/30 rounded-xl p-4">
                        <p className="text-xs text-blue-400 font-semibold mb-1">📌 Məlumat</p>
                        <p className="text-xs text-slate-400 leading-relaxed">
                            Əlavə etdiyiniz sahələr hər lead-in "Detallar" panelinin sol tərəfindəgörünər.
                            "Seçim" tipli sahələr üçün variantlar siyahısını burada idarə edirsiniz.
                            Dəyişiklikləri yadda saxlamağı unutmayın.
                        </p>
                    </section>
                </div>

                {/* Footer Save */}
                <div className="p-4 border-t border-white/5 bg-[#111827]/60 shrink-0">
                    <button
                        onClick={handleSave}
                        className={cn(
                            'w-full py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                            saved ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'
                        )}
                    >
                        {saved ? <><Check className="w-4 h-4" /> Saxlandı!</> : <><Save className="w-4 h-4" /> Ayarları Saxla</>}
                    </button>
                </div>
            </div>

            <style>{`
        @keyframes slideInRight {
          from { transform: translateX(40px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
        </div>
    );
}
