import React, { useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { CRMSettings, PipelineStage, generateFieldId } from '../../../lib/crmSettings';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

export function StagesTab({
  settings,
  setSettings,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
}) {
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const addStage = () => {
    const newStage: PipelineStage = { id: generateFieldId(), label: 'Yeni Sütun', color: 'slate' };
    setSettings((prev) => ({ ...prev, pipelineStages: [...prev.pipelineStages, newStage] }));
  };

  const updateStage = (id: string, updates: Partial<PipelineStage>) => {
    setSettings((prev) => ({
      ...prev,
      pipelineStages: prev.pipelineStages.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    }));
  };

  const removeStage = (id: string) => {
    if (settings.pipelineStages.length <= 1) {
      alert('Ən azı 1 sütun olmalıdır!');
      return;
    }
    setSettings((prev) => ({ ...prev, pipelineStages: prev.pipelineStages.filter((s) => s.id !== id) }));
  };

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDraggedIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === idx) return;
    const next = [...settings.pipelineStages];
    const draggedItem = next[draggedIdx];
    next.splice(draggedIdx, 1);
    next.splice(idx, 0, draggedItem);
    setDraggedIdx(idx);
    setSettings((prev) => ({ ...prev, pipelineStages: next }));
  };

  const handleDragEnd = () => setDraggedIdx(null);

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Kanban Sütunları"
          description="CRM lövhəsindəki satış mərhələləri. Sıra: soldan sağa."
          actions={
            <button
              onClick={addStage}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Yeni Sütun
            </button>
          }
        />

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200">Sütunlar</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-2">
            {settings.pipelineStages.map((stage, idx) => (
              <div
                key={stage.id}
                draggable
                onDragStart={(e) => handleDragStart(e, idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={cn(
                  'flex flex-col sm:flex-row sm:items-center gap-3 border rounded-xl px-4 py-3 transition-colors',
                  draggedIdx === idx ? 'bg-slate-900 border-slate-700 opacity-60' : 'bg-slate-950/40 border-slate-800'
                )}
              >
                <div className="flex items-center gap-3 w-full min-w-0">
                  <GripVertical className="w-4 h-4 text-slate-600 cursor-grab shrink-0" />
                  <input
                    value={stage.label}
                    onChange={(e) => updateStage(stage.id, { label: e.target.value })}
                    className="flex-1 bg-transparent text-white text-sm font-semibold focus:outline-none border-b border-transparent focus:border-slate-700 pb-1 min-w-0"
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto sm:justify-end">
                  <select
                    value={stage.color}
                    onChange={(e) => updateStage(stage.id, { color: e.target.value })}
                    className="flex-1 sm:flex-none bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none appearance-none cursor-pointer"
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
                  <button
                    onClick={() => removeStage(stage.id)}
                    className="p-2 text-slate-600 hover:text-red-400 transition-colors shrink-0"
                    title="Sil"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="İpucu">
          <p>Mərhələ ID-ləri database-də saxlanılır; dəyişsəniz köhnə leadlərdə qarışıqlıq yarana bilər.</p>
          <p>Adı dəyişmək təhlükəsizdir, amma ID-ni yalnız ehtiyac varsa dəyişin.</p>
        </HelpCallout>
      </SettingsAside>
    </SettingsGrid>
  );
}
