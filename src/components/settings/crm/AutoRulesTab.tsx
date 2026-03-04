import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Save, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { AutoRule, CRMSettings, generateFieldId, type CloseMovesToStageSettings, type ReopenOnInboundSettings } from '../../../lib/crmSettings';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

export function AutoRulesTab({
  settings,
  setSettings,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const stages = settings.pipelineStages || [];

  const reopenCfg: ReopenOnInboundSettings = settings.automation?.reopenOnInbound || {};
  const closeCfg: CloseMovesToStageSettings = settings.automation?.closeMovesToStage || {};

  const updateReopenCfg = (updates: Partial<ReopenOnInboundSettings>) => {
    setSettings((prev) => ({
      ...prev,
      automation: {
        ...(prev.automation || {}),
        reopenOnInbound: { ...(prev.automation?.reopenOnInbound || {}), ...updates },
      },
    }));
  };

  const updateCloseCfg = (updates: Partial<CloseMovesToStageSettings>) => {
    setSettings((prev) => ({
      ...prev,
      automation: {
        ...(prev.automation || {}),
        closeMovesToStage: { ...(prev.automation?.closeMovesToStage || {}), ...updates },
      },
    }));
  };

  const addRule = () => {
    const newRule: AutoRule = {
      id: generateFieldId(),
      enabled: true,
      keyword: '',
      targetStage: stages[0]?.id || 'new',
      extractValue: false,
      note: '',
    };
    setSettings((prev) => ({ ...prev, autoRules: [...prev.autoRules, newRule] }));
    setExpandedId(newRule.id);
  };

  const updateRule = (id: string, updates: Partial<AutoRule>) => {
    setSettings((prev) => ({
      ...prev,
      autoRules: prev.autoRules.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    }));
  };

  const removeRule = (id: string) => {
    setSettings((prev) => ({ ...prev, autoRules: prev.autoRules.filter((r) => r.id !== id) }));
    setExpandedId((cur) => (cur === id ? null : cur));
  };

  const examples = useMemo(
    () => [
      { msg: 'Qiymet nece? 50 azn olar?', hit: 'qiymet', effect: 'mərhələ dəyişir + dəyər yazıla bilər' },
      { msg: 'Sifaris vermek isteyirem', hit: 'sifaris', effect: 'mərhələ Satışa keçir' },
    ],
    []
  );

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Avtomatik Keçid Qaydaları"
          description="Mesajın içində açar söz tapılsa, lead avtomatik seçilmiş mərhələyə keçir."
          actions={
            <button
              onClick={addRule}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Yeni Qayda
            </button>
          }
        />

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200">Gələn mesaja görə geri dönmə</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateReopenCfg({ enabled: !(reopenCfg.enabled === true) })}
                className={cn('shrink-0 transition-colors', reopenCfg.enabled === true ? 'text-emerald-300' : 'text-slate-600')}
                title={reopenCfg.enabled === true ? 'Söndür' : 'Yandır'}
              >
                {reopenCfg.enabled === true ? <ToggleRight className="w-7 h-7" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
              <div className="min-w-0">
                <p className="text-xs text-slate-200 font-semibold">Close edilmiş sohbetə müştəri yenidən mesaj yazarsa, lead avtomatik “Yeni” (və ya seçdiyiniz) sütuna qayıdar</p>
                <p className="text-[11px] text-slate-500">Məqsəd: yeni mesajı qaçırmamaq üçün lead yenidən önə çıxsın.</p>
              </div>
            </div>

            <div className={cn(reopenCfg.enabled === true ? '' : 'opacity-50 pointer-events-none')}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Hədəf sütun</label>
                  <select
                    value={reopenCfg.targetStage || stages[0]?.id || 'new'}
                    onChange={(e) => updateReopenCfg({ targetStage: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-emerald-500 appearance-none"
                  >
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>

                  <label className="mt-2 flex items-center gap-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={reopenCfg.onlyWhenClosed !== false}
                      onChange={(e) => updateReopenCfg({ onlyWhenClosed: e.target.checked })}
                    />
                    <span>Sadece Close edilmiş sohbetlerde çalışsın</span>
                  </label>
                </div>

                <div>
                  <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">İstisna sütunlar (qayıtmasın)</label>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-2 max-h-36 overflow-auto">
                    {stages.map((s) => {
                      const selected = (reopenCfg.excludeStages || []).includes(s.id);
                      return (
                        <label key={s.id} className="flex items-center gap-2 py-1 text-xs text-slate-200">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(e) => {
                              const cur = Array.isArray(reopenCfg.excludeStages) ? reopenCfg.excludeStages.slice() : [];
                              const next = e.target.checked
                                ? Array.from(new Set([...cur, s.id]))
                                : cur.filter((x) => x !== s.id);
                              updateReopenCfg({ excludeStages: next });
                            }}
                          />
                          <span className="truncate" title={s.id}>{s.label}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">Adətən burada “Satış” sütununu işarələyirlər ki, satılmış müştəri yenidən “Yeni”yə düşməsin.</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200">Conversation “Close” davranışı</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateCloseCfg({ enabled: !(closeCfg.enabled === true) })}
                className={cn('shrink-0 transition-colors', closeCfg.enabled === true ? 'text-blue-300' : 'text-slate-600')}
                title={closeCfg.enabled === true ? 'Söndür' : 'Yandır'}
              >
                {closeCfg.enabled === true ? <ToggleRight className="w-7 h-7" /> : <ToggleLeft className="w-7 h-7" />}
              </button>
              <div className="min-w-0">
                <p className="text-xs text-slate-200 font-semibold">Close ediləndə lead-i xüsusi “Kapatıldı” sütununa at</p>
                <p className="text-[11px] text-slate-500">Sonra müştəridən yeni mesaj gələrsə, yuxarıdakı qayda ilə geri qaytara bilərsiniz.</p>
              </div>
            </div>

            <div className={cn(closeCfg.enabled === true ? '' : 'opacity-50 pointer-events-none')}>
              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Close sütunu</label>
              <select
                value={closeCfg.targetStage || ''}
                onChange={(e) => updateCloseCfg({ targetStage: e.target.value })}
                className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
              >
                <option value="">(seçilməyib)</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {settings.autoRules.map((rule, index) => {
            const expanded = expandedId === rule.id;
            const enabled = rule.enabled;
            const stageLabel = stages.find((s) => s.id === rule.targetStage)?.label || rule.targetStage;
            const meta: string[] = [];
            if (rule.extractValue) meta.push(`Mətndən qiymət${rule.currencyTag ? ` (${rule.currencyTag})` : ''}`);
            if (typeof rule.fixedValue === 'number') meta.push(`Sabit: ${rule.fixedValue}`);
            if (rule.note) meta.push('Qeyd var');

            return (
              <Card
                key={rule.id}
                className={cn(
                  'border-slate-800 overflow-hidden',
                  enabled ? 'bg-slate-950/30' : 'bg-slate-950/10 opacity-70'
                )}
              >
                <CardHeader className="p-4">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}
                      className={cn('shrink-0 transition-colors', rule.enabled ? 'text-blue-300' : 'text-slate-600')}
                      title={rule.enabled ? 'Söndür' : 'Yandır'}
                    >
                      {rule.enabled ? <ToggleRight className="w-7 h-7" /> : <ToggleLeft className="w-7 h-7" />}
                    </button>

                    <span className="text-slate-500 text-xs font-bold shrink-0">#{index + 1}</span>

                    <div className="flex-1 min-w-0">
                      <input
                        value={rule.keyword}
                        onChange={(e) => updateRule(rule.id, { keyword: e.target.value })}
                        placeholder="Açar söz (məs: qiymət)"
                        className="w-full bg-transparent text-white text-sm font-semibold focus:outline-none border-b border-transparent focus:border-slate-700 pb-1"
                      />
                      <div className="mt-1 flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-slate-500">Mərhələ:</span>
                        <span className="text-[10px] font-bold text-slate-300 truncate">{stageLabel}</span>
                        {meta.length ? (
                          <span className="text-[10px] text-slate-500 truncate">· {meta.join(' · ')}</span>
                        ) : null}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : rule.id)}
                      className="p-1 text-slate-500 hover:text-slate-300"
                      title={expanded ? 'Yığ' : 'Detallar'}
                    >
                      {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => removeRule(rule.id)}
                      className="p-1 text-slate-600 hover:text-red-400"
                      title="Sil"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </CardHeader>

                {expanded ? (
                  <CardContent className="p-4 pt-0">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                          Keçəcəyi Mərhələ
                        </label>
                        <select
                          value={rule.targetStage}
                          onChange={(e) => updateRule(rule.id, { targetStage: e.target.value })}
                          className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                        >
                          {stages.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                          Sabit Qiymət (₼)
                        </label>
                        <input
                          type="number"
                          value={rule.fixedValue ?? ''}
                          onChange={(e) =>
                            updateRule(rule.id, { fixedValue: e.target.value ? parseFloat(e.target.value) : undefined })
                          }
                          placeholder="Məs: 50"
                          className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                          Mətndən Qiymət
                        </label>
                        <button
                          type="button"
                          onClick={() => updateRule(rule.id, { extractValue: !rule.extractValue })}
                          className={cn(
                            'w-full px-3 py-2 rounded-lg border text-xs font-semibold transition-colors inline-flex items-center gap-2 justify-center',
                            rule.extractValue
                              ? 'bg-emerald-950/20 border-emerald-800/40 text-emerald-200'
                              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                          )}
                        >
                          {rule.extractValue ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                          {rule.extractValue ? 'Açıqdır' : 'Bağlıdır'}
                        </button>
                        <p className="mt-1 text-[10px] text-slate-500">Açar söz tapıldıqda mesajdan ilk rəqəmi götürür.</p>
                      </div>

                      <div className={cn(!rule.extractValue && 'opacity-40 pointer-events-none')}>
                        <label
                          className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1"
                          title="Yalnız bu sözlə (məs: azn) yazılmış rəqəmi tapır"
                        >
                          Format (məs: azn)
                        </label>
                        <input
                          type="text"
                          value={rule.currencyTag || ''}
                          onChange={(e) => updateRule(rule.id, { currencyTag: e.target.value })}
                          placeholder="Məs: azn"
                          className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <p className="mt-1 text-[10px] text-slate-500">Bu boşdursa, istənilən rəqəmi götürür.</p>
                      </div>
                    </div>

                    <div className="mt-3">
                      <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Qeyd</label>
                      <input
                        value={rule.note || ''}
                        onChange={(e) => updateRule(rule.id, { note: e.target.value })}
                        placeholder="Qeyd (isteğe bağlı, məs: 'Qiymət soruşur')"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-500"
                      />
                    </div>
                  </CardContent>
                ) : null}
              </Card>
            );
          })}
        </div>

        {settings.autoRules.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4 text-xs text-slate-500">
            Heç bir qayda yoxdur. <span className="text-slate-300 font-semibold">Yeni Qayda</span> ilə başlayın.
          </div>
        ) : null}
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="Necə işləyir?">
          <p>Yeni mesaj gələndə (gələn və gedən), mesaj mətni hər qaydanın açar sözü ilə yoxlanılır.</p>
          <p>Açar söz tapılsa, lead seçilən mərhələyə keçirilir.</p>
          <p>
            <strong>Mətndən Qiymət</strong> açıqdırsa, mesajdakı ilk rəqəm (və ya formatla birlikdə olan) büdcəyə yazılır.
          </p>
        </HelpCallout>

        <HelpCallout title="Nümunələr">
          {examples.map((ex, i) => (
            <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
              <p className="text-[10px] text-slate-500">Mesaj</p>
              <p className="text-xs text-slate-200 mt-0.5">{ex.msg}</p>
              <p className="text-[10px] text-slate-500 mt-2">Açar söz</p>
              <p className="text-xs text-emerald-300 font-semibold">{ex.hit}</p>
              <p className="text-[10px] text-slate-500 mt-2">Nəticə</p>
              <p className="text-xs text-slate-300">{ex.effect}</p>
            </div>
          ))}
        </HelpCallout>

        <div className="rounded-xl border border-slate-800 bg-slate-950/20 p-4 text-[11px] text-slate-500">
          Qeyd: Qaydaları dəyişdikdən sonra <Save className="inline w-3.5 h-3.5 mx-1" /> <span className="text-slate-300 font-semibold">Ayarları Saxla</span> edin.
        </div>
      </SettingsAside>
    </SettingsGrid>
  );
}
