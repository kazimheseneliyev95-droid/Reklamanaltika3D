import React, { useMemo, useState } from 'react';
import { Calendar, ChevronDown, ChevronUp, Plus, Trash2, Type, Hash, List, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { CRMSettings, CustomField, FieldType, generateFieldId } from '../../../lib/crmSettings';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

const TYPE_LABELS: Record<FieldType, { label: string; icon: React.ReactNode }> = {
  text: { label: 'Mətn', icon: <Type className="w-3.5 h-3.5" /> },
  number: { label: 'Rəqəm', icon: <Hash className="w-3.5 h-3.5" /> },
  select: { label: 'Seçim', icon: <List className="w-3.5 h-3.5" /> },
  datetime: { label: 'Tarix/Saat', icon: <Calendar className="w-3.5 h-3.5" /> },
};

export function CustomFieldsTab({
  settings,
  setSettings,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newOptionText, setNewOptionText] = useState<Record<string, string>>({});

  const addField = (type: FieldType) => {
    const newField: CustomField = {
      id: generateFieldId(),
      label:
        type === 'text'
          ? 'Yeni Mətn Sahəsi'
          : type === 'number'
            ? 'Yeni Rəqəm Sahəsi'
            : type === 'datetime'
              ? 'Yeni Tarix/Saat Sahəsi'
              : 'Yeni Seçim Sahəsi',
      type,
      options: type === 'select' ? [] : undefined,
    };
    setSettings((prev) => ({ ...prev, customFields: [...prev.customFields, newField] }));
    setExpandedId(type === 'select' ? newField.id : null);
  };

  const updateField = (id: string, updates: Partial<CustomField>) => {
    setSettings((prev) => ({
      ...prev,
      customFields: prev.customFields.map((f) => (f.id === id ? { ...f, ...updates } : f)),
    }));
  };

  const removeField = (id: string) => {
    setSettings((prev) => ({ ...prev, customFields: prev.customFields.filter((f) => f.id !== id) }));
    setExpandedId((cur) => (cur === id ? null : cur));
  };

  const addOption = (fieldId: string) => {
    const text = (newOptionText[fieldId] || '').trim();
    if (!text) return;
    const field = settings.customFields.find((f) => f.id === fieldId);
    updateField(fieldId, { options: [...(field?.options || []), text] });
    setNewOptionText((prev) => ({ ...prev, [fieldId]: '' }));
  };

  const removeOption = (fieldId: string, optIdx: number) => {
    const field = settings.customFields.find((f) => f.id === fieldId);
    if (!field?.options) return;
    updateField(fieldId, { options: field.options.filter((_, i) => i !== optIdx) });
  };

  const selectCount = useMemo(() => settings.customFields.filter((f) => f.type === 'select').length, [settings.customFields]);

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Xüsusi Sahələr"
          description="Lead panelində görünəcək əlavə məlumatlar (mətn, rəqəm, seçim)."
        />

        <div className="space-y-2">
          {settings.customFields.map((field) => {
            const expanded = expandedId === field.id;
            const typeMeta = TYPE_LABELS[field.type];
            return (
              <Card key={field.id} className="border-slate-800 bg-slate-950/30 overflow-hidden">
                <CardHeader className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-300 bg-slate-900 border border-slate-800 px-2 py-1 rounded shrink-0">
                      {typeMeta.icon}
                      <span className="hidden sm:inline">{typeMeta.label}</span>
                    </div>
                    <input
                      value={field.label}
                      onChange={(e) => updateField(field.id, { label: e.target.value })}
                      className="flex-1 bg-transparent text-white text-sm font-semibold focus:outline-none border-b border-transparent focus:border-slate-700 pb-1 min-w-0"
                    />

                    {field.type === 'select' ? (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : field.id)}
                        className="p-1 text-slate-500 hover:text-slate-300"
                        title={expanded ? 'Yığ' : 'Variantlar'}
                      >
                        {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => removeField(field.id)}
                      className="p-1 text-slate-600 hover:text-red-400"
                      title="Sil"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500 truncate">ID: {field.id}</p>
                </CardHeader>

                {field.type === 'select' && expanded ? (
                  <CardContent className="p-4 pt-0 border-t border-slate-800 bg-slate-950/20 space-y-2">
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Seçim variantları</p>

                    {(field.options || []).length === 0 ? (
                      <p className="text-xs text-slate-500 italic">Hələ seçim yoxdur. Aşağıdan əlavə edin.</p>
                    ) : null}

                    {(field.options || []).map((opt, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <div className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200">
                          {opt}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeOption(field.id, idx)}
                          className="p-1 text-slate-600 hover:text-red-400"
                          title="Sil"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}

                    <div className="flex gap-2 pt-1">
                      <input
                        value={newOptionText[field.id] || ''}
                        onChange={(e) => setNewOptionText((prev) => ({ ...prev, [field.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && addOption(field.id)}
                        placeholder="Yeni variant yazın..."
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() => addOption(field.id)}
                        className="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition-colors shrink-0 inline-flex items-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        Əlavə et
                      </button>
                    </div>
                  </CardContent>
                ) : null}
              </Card>
            );
          })}
        </div>

        <Card className="border-slate-800 bg-slate-950/20">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200">Yeni sahə əlavə et</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 flex flex-wrap gap-2">
            {(Object.keys(TYPE_LABELS) as FieldType[]).map((type) => (
              <button
                key={type}
                onClick={() => addField(type)}
                className="flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 border-dashed text-slate-200 rounded-lg text-xs font-semibold transition-colors"
              >
                <Plus className="w-4 h-4" />
                {TYPE_LABELS[type].icon}
                {TYPE_LABELS[type].label}
              </button>
            ))}
          </CardContent>
        </Card>
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="Nə üçün lazımdır?">
          <p>Xüsusi sahələr lead formunda və filtrlərdə görünür.</p>
          <p>Routing qaydaları ən çox <strong>select</strong> sahələr ilə işləyir.</p>
        </HelpCallout>

        <HelpCallout title="Kiçik qayda">
          <p>Çox sahə yaratmayın: 5-8 sahə adətən kifayətdir.</p>
          <p>Select sahələr üçün variantları qısa və standart saxlayın.</p>
          <p className="text-slate-500">Hazırda select sahə sayı: <span className="text-slate-200 font-semibold">{selectCount}</span></p>
        </HelpCallout>
      </SettingsAside>
    </SettingsGrid>
  );
}
