import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  CRMSettings,
  RoutingRule,
  applyRoutingRules,
  generateFieldId,
} from '../../../lib/crmSettings';
import { CrmService } from '../../../services/CrmService';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { KeywordChipsInput } from '../KeywordChipsInput';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

export function RoutingTab({
  settings,
  setSettings,
  canSaveToDb,
  serverUrl,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
  canSaveToDb: boolean;
  serverUrl: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [routingTestText, setRoutingTestText] = useState('');
  const [routingStats, setRoutingStats] = useState<Record<string, { count: number; last_at?: string }>>({});

  const selectFields = useMemo(() => settings.customFields.filter((f) => f.type === 'select'), [settings.customFields]);

  // Load stats (admin only)
  useEffect(() => {
    if (!canSaveToDb) return;
    if (!serverUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/api/routing-rules/stats?days=7`, {
          headers: CrmService['getAuthHeaders'](),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return;
        if (cancelled) return;
        setRoutingStats(data?.stats || {});
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canSaveToDb, serverUrl]);

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
      targetStage: '',
    };
    setSettings((prev) => ({ ...prev, routingRules: [...(prev.routingRules || []), newRule] }));
    setExpandedId(newRule.id);
  };

  const updateRoutingRule = (id: string, updates: Partial<RoutingRule>) => {
    setSettings((prev) => ({
      ...prev,
      routingRules: (prev.routingRules || []).map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
  };

  const removeRoutingRule = (id: string) => {
    setSettings((prev) => ({ ...prev, routingRules: (prev.routingRules || []).filter((r) => r.id !== id) }));
    setExpandedId((cur) => (cur === id ? null : cur));
  };

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDraggedIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === idx) return;
    const next = [...(settings.routingRules || [])];
    const draggedItem = next[draggedIdx];
    next.splice(draggedIdx, 1);
    next.splice(idx, 0, draggedItem);
    setDraggedIdx(idx);
    setSettings((prev) => ({ ...prev, routingRules: next }));
  };

  const handleDragEnd = () => setDraggedIdx(null);

  const testResult = useMemo(() => {
    if (routingTestText.trim() === '') return null;
    return applyRoutingRules(routingTestText, settings.routingRules || []);
  }, [routingTestText, settings.routingRules]);

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Mətnə Görə Mənbə (Routing)"
          description="Mesajın içində açar söz tapılsa seçilmiş select sahəyə dəyər yazılır."
          actions={
            <button
              onClick={addRoutingRule}
              disabled={selectFields.length === 0}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors inline-flex items-center gap-2 disabled:opacity-50"
              title={selectFields.length === 0 ? 'Əvvəlcə select field yaradın' : 'Yeni qayda'}
            >
              <Plus className="w-4 h-4" />
              Yeni Qayda
            </button>
          }
        />

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-xs text-slate-200">Test Mesaj</CardTitle>
              <button
                type="button"
                onClick={() => setRoutingTestText('')}
                className="text-[10px] text-slate-500 hover:text-slate-300"
              >
                Təmizlə
              </button>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <textarea
              value={routingTestText}
              onChange={(e) => setRoutingTestText(e.target.value)}
              placeholder="Mesaj yazın... (uyğun qaydanı burada görəcəksiniz)"
              rows={3}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 placeholder:text-slate-500"
            />
            {routingTestText.trim() !== '' ? (
              <div className="mt-2 text-[11px] text-slate-400">
                {!testResult ? (
                  <span className="text-slate-500">Heç bir qayda uyğun gəlmədi.</span>
                ) : (
                  (() => {
                    const fieldId = Object.keys(testResult.extra || {})[0] || '';
                    const field = settings.customFields.find((f) => f.id === fieldId);
                    const val = (testResult.extra as any)?.[fieldId] || '';
                    return (
                      <span>
                        Uyğun qayda: <span className="text-emerald-300 font-semibold">{testResult.ruleId}</span>{' -> '}
                        <span className="text-slate-200 font-semibold">{field?.label || fieldId}</span>={' '}
                        <span className="text-slate-200 font-semibold">{val}</span>
                        {testResult.targetStage ? (
                          <span className="text-slate-500"> (mərhələ: {testResult.targetStage})</span>
                        ) : null}
                      </span>
                    );
                  })()
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {selectFields.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4 text-xs text-slate-500">
            Select tipli xüsusi sahə yoxdur. Əvvəlcə <strong className="text-slate-200">Xüsusi Sahələr</strong> bölməsində select field yaradın.
          </div>
        ) : (
          <div className="space-y-3">
            {(settings.routingRules || []).map((r, idx) => {
              const expanded = expandedId === r.id;
              const field = settings.customFields.find((f) => f.id === r.fieldId);
              const options = field && field.type === 'select' ? field.options || [] : [];
              const stat = routingStats[r.id];
              const keywordCount = (r.keywords || []).length;

              return (
                <Card
                  key={r.id}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                  className={cn(
                    'border-slate-800 overflow-hidden',
                    r.enabled ? 'bg-slate-950/30' : 'bg-slate-950/10 opacity-70'
                  )}
                >
                  <CardHeader className="p-4">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        draggable
                        onDragStart={(e) => handleDragStart(e, idx)}
                        className="p-1 text-slate-600 hover:text-slate-300 cursor-grab active:cursor-grabbing shrink-0"
                        title="Sırala"
                      >
                        <GripVertical className="w-4 h-4" />
                      </button>

                      <button
                        onClick={() => updateRoutingRule(r.id, { enabled: !r.enabled })}
                        className={cn('shrink-0 transition-colors', r.enabled ? 'text-emerald-300' : 'text-slate-600')}
                        title={r.enabled ? 'Söndür' : 'Yandır'}
                      >
                        {r.enabled ? <ToggleRight className="w-7 h-7" /> : <ToggleLeft className="w-7 h-7" />}
                      </button>

                      <span className="text-slate-500 text-xs font-bold shrink-0">#{idx + 1}</span>

                      {typeof stat?.count === 'number' ? (
                        <span
                          className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-800 bg-slate-950/40 text-slate-300 shrink-0"
                          title="Son 7 gün"
                        >
                          7g: {stat.count}
                        </span>
                      ) : null}

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <select
                            value={r.fieldId}
                            onChange={(e) => {
                              const nextFieldId = e.target.value;
                              const nextField = settings.customFields.find((f) => f.id === nextFieldId);
                              const nextDefault =
                                (nextField && nextField.type === 'select' ? (nextField.options || [])[0] : '') || '';
                              updateRoutingRule(r.id, { fieldId: nextFieldId, setValue: nextDefault });
                            }}
                            className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                          >
                            {selectFields.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="mt-1 flex items-center gap-2 min-w-0">
                          <span className="text-[10px] text-slate-500">Dəyər:</span>
                          <span className="text-[10px] text-slate-300 font-bold truncate">{r.setValue || '--'}</span>
                          <span className="text-[10px] text-slate-500 truncate">· {keywordCount} açar söz</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : r.id)}
                        className="p-1 text-slate-500 hover:text-slate-300"
                        title={expanded ? 'Yığ' : 'Detallar'}
                      >
                        {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                      </button>

                      <button
                        onClick={() => removeRoutingRule(r.id)}
                        className="p-1 text-slate-600 hover:text-red-400"
                        title="Sil"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </CardHeader>

                  {expanded ? (
                    <CardContent className="p-4 pt-0 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Seçiləcək Dəyər</label>
                          <select
                            value={r.setValue}
                            onChange={(e) => updateRoutingRule(r.id, { setValue: e.target.value })}
                            className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                          >
                            <option value="">-- Seçin --</option>
                            {options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">(İstəyə bağlı) Mərhələ</label>
                          <select
                            value={r.targetStage || ''}
                            onChange={(e) => updateRoutingRule(r.id, { targetStage: e.target.value })}
                            className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                          >
                            <option value="">-- Dəyişmə --</option>
                            {settings.pipelineStages.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Açar Sözlər</label>
                        <KeywordChipsInput
                          value={r.keywords || []}
                          onChange={(next) => updateRoutingRule(r.id, { keywords: next })}
                          placeholder={r.matchType === 'regex' ? 'məs: \\b(dizayn|interyer)\\b (Enter)' : 'məs: mahmud, dizayn (Enter)'}
                        />
                        <p className="mt-1 text-[10px] text-slate-500">Mesaj bu sözləri ehtiva edərsə dəyər yazılır.</p>
                      </div>

                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">İstisna Sözlər (olarsa işləməsin)</label>
                        <KeywordChipsInput
                          value={r.excludeKeywords || []}
                          onChange={(next) => updateRoutingRule(r.id, { excludeKeywords: next })}
                          placeholder="məs: spam, test (Enter)"
                        />
                        <p className="mt-1 text-[10px] text-slate-500">Bu sözlərdən biri varsa qayda işə düşməyəcək.</p>
                      </div>

                      <details className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                        <summary className="cursor-pointer text-xs font-bold text-slate-200 select-none">
                          Qabaqcıl uyğunluq (Advanced)
                        </summary>
                        <div className="mt-3 space-y-3">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Uyğunluq Rejimi</label>
                              <select
                                value={r.matchMode || 'any'}
                                onChange={(e) => updateRoutingRule(r.id, { matchMode: e.target.value as any })}
                                className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                              >
                                <option value="any">Hər hansı (OR)</option>
                                <option value="all">Hamısı (AND)</option>
                              </select>
                              <p className="mt-1 text-[10px] text-slate-500">OR: 1 söz bəs edir. AND: hamısı olmalıdır.</p>
                            </div>

                            <div>
                              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Uyğunluq Növü</label>
                              <select
                                value={r.matchType || 'contains'}
                                onChange={(e) => updateRoutingRule(r.id, { matchType: e.target.value as any })}
                                className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                              >
                                <option value="contains">Mətnin içində keçir</option>
                                <option value="startsWith">Mətn bununla başlayır</option>
                                <option value="exact">Tam eynidir</option>
                                <option value="regex">Regex (qayda)</option>
                              </select>
                              <p className="mt-1 text-[10px] text-slate-500">Regex: çətin axtarış üçün.</p>
                            </div>
                          </div>

                          <div>
                            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Davranış</label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => updateRoutingRule(r.id, { caseSensitive: !r.caseSensitive })}
                                className={cn(
                                  'flex-1 px-2 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors',
                                  r.caseSensitive
                                    ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                    : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                )}
                                title="Böyük/kiçik hərf fərqi"
                              >
                                Aa
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  updateRoutingRule(r.id, { lockFieldAfterMatch: r.lockFieldAfterMatch === false ? true : false })
                                }
                                className={cn(
                                  'flex-[1.4] px-2 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-wide transition-colors',
                                  r.lockFieldAfterMatch !== false
                                    ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-200'
                                    : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:text-slate-200'
                                )}
                                title="Bir dəfə tətbiq et (sahə doludursa toxunma)"
                              >
                                1x Lock
                              </button>
                            </div>
                            <p className="mt-1 text-[10px] text-slate-500">1x Lock açıqdırsa, sahə doludursa bu qayda bir daha tətbiq olunmur.</p>
                          </div>
                        </div>
                      </details>
                    </CardContent>
                  ) : null}
                </Card>
              );
            })}

            {(settings.routingRules || []).length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4 text-xs text-slate-500">
                Heç bir routing qaydası yoxdur. <span className="text-slate-300 font-semibold">Yeni Qayda</span> ilə başlayın.
              </div>
            ) : null}
          </div>
        )}
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="Sıralama vacibdir">
          <p>Qaydalar yuxarıdan aşağı yoxlanılır. Daha spesifik qaydaları yuxarıda saxlayın.</p>
          <p><strong>İstisna sözlər</strong> spam/test kimi mesajları kənarlaşdırmaq üçün idealdır.</p>
        </HelpCallout>

        <HelpCallout title="Hazır şablon">
          <p className="text-slate-300 font-semibold">Maraqlandığı kurs{' -> '}Mahmud Dizayn</p>
          <p>Keywords: <span className="text-emerald-300 font-semibold">dizayn, interyer</span></p>
          <p>Match: contains + OR</p>
        </HelpCallout>

        {!canSaveToDb ? (
          <div className="rounded-xl border border-amber-900/40 bg-amber-950/10 p-4 text-[11px] text-amber-300">
            Qeyd: Statistikalar yalnız Admin üçün görünür.
          </div>
        ) : null}
      </SettingsAside>
    </SettingsGrid>
  );
}
