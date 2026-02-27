import React, { useMemo } from 'react';
import { LayoutGrid } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { CRMSettings, LeadCardUISettings } from '../../../lib/crmSettings';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/30">
      <div className="min-w-0">
        <p className="text-xs text-slate-200 font-semibold truncate">{label}</p>
        {description ? <p className="text-[10px] text-slate-500 mt-0.5">{description}</p> : null}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-blue-500 mt-0.5"
      />
    </label>
  );
}

export function LeadCardsTab({
  settings,
  setSettings,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
}) {
  const ui = settings.ui?.leadCard || {};

  const updateLeadCardUi = (updates: Partial<LeadCardUISettings>) => {
    setSettings((prev) => ({
      ...prev,
      ui: {
        ...(prev.ui || {}),
        leadCard: {
          ...((prev.ui && prev.ui.leadCard) || {}),
          ...updates,
        },
      },
    }));
  };

  const selectFieldsAll = settings.customFields.filter((f) => f.type === 'select');
  const enabledIds = Array.isArray(ui.customFieldIds) ? ui.customFieldIds : [];
  const useAll = (ui.showCustomFieldBadges !== false) && enabledIds.length === 0;

  const preview = useMemo(
    () => ({
      name: 'Aysel',
      assignee: 'Operator 1',
      source: 'Instagram',
      product: 'Masterclass',
      value: 50,
      message: 'Salam, qiymet nece olacaq?',
      extraBadges: ['Mahmud Dizayn', 'VIP'],
    }),
    []
  );

  const show = {
    name: ui.showNameBadge !== false,
    assignee: ui.showAssignee !== false,
    source: ui.showSource !== false,
    product: ui.showProductBadge !== false,
    value: ui.showValue !== false,
    msg: ui.showLastMessagePreview !== false,
    custom: ui.showCustomFieldBadges !== false,
  };

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Lead Kartları"
          description="Kanban kartlarının üstündə hansı məlumatlar görünsün."
        />

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200 flex items-center gap-2">
              <LayoutGrid className="w-4 h-4 text-slate-400" />
              Görünəcək məlumatlar
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <ToggleRow label="Ad" checked={show.name} onChange={(v) => updateLeadCardUi({ showNameBadge: v })} />
            <ToggleRow label="Operator" checked={show.assignee} onChange={(v) => updateLeadCardUi({ showAssignee: v })} />
            <ToggleRow label="Mənbə" checked={show.source} onChange={(v) => updateLeadCardUi({ showSource: v })} />
            <ToggleRow label="Məhsul" checked={show.product} onChange={(v) => updateLeadCardUi({ showProductBadge: v })} />
            <ToggleRow label="Büdcə" checked={show.value} onChange={(v) => updateLeadCardUi({ showValue: v })} />
            <ToggleRow label="Mesaj preview" checked={show.msg} onChange={(v) => updateLeadCardUi({ showLastMessagePreview: v })} />
            <ToggleRow
              label="Xüsusi sahə badge-ləri"
              description="Select sahələrdən dəyəri olanlar"
              checked={show.custom}
              onChange={(v) => updateLeadCardUi({ showCustomFieldBadges: v })}
            />
          </CardContent>
        </Card>

        <Card className={cn('border-slate-800 bg-slate-950/30', !show.custom && 'opacity-60')}>
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200">Xüsusi sahə badge-ləri</CardTitle>
          </CardHeader>
          <CardContent className={cn('p-4 pt-0 space-y-3', !show.custom && 'pointer-events-none')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateLeadCardUi({ customFieldBadgeMode: 'value' })}
                className={cn(
                  'px-3 py-2 rounded-lg border text-xs font-semibold transition-colors',
                  (ui.customFieldBadgeMode || 'value') === 'value'
                    ? 'border-blue-700/40 bg-blue-950/20 text-blue-200'
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
                    ? 'border-blue-700/40 bg-blue-950/20 text-blue-200'
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
                className="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {selectFieldsAll.length === 0 ? (
              <p className="text-xs text-slate-500 italic">Heç bir select tipli xüsusi sahə yoxdur.</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-slate-500">Hansı sahələr kartda görünsün</p>
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
                  {selectFieldsAll.map((f) => {
                    const checked = useAll ? true : enabledIds.includes(f.id);
                    return (
                      <label
                        key={f.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/30"
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-slate-200 font-semibold truncate">{f.label}</p>
                          <p className="text-[10px] text-slate-500 truncate">{f.id}</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            if (enabledIds.length === 0) {
                              if (!e.target.checked) {
                                const explicit = selectFieldsAll.map((sf) => sf.id).filter((id) => id !== f.id);
                                updateLeadCardUi({ customFieldIds: explicit });
                              }
                              return;
                            }

                            const next = new Set(enabledIds);
                            if (e.target.checked) next.add(f.id);
                            else next.delete(f.id);
                            updateLeadCardUi({ customFieldIds: Array.from(next) });
                          }}
                          className="h-4 w-4 accent-blue-500"
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-500">Siyahı boşdursa kartda bütün select sahələr (dəyəri olanlar) görünəcək.</p>
              </>
            )}
          </CardContent>
        </Card>
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="Preview">
          <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
            {show.name ? <p className="text-xs font-bold text-white">{preview.name}</p> : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {show.product ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-800 bg-slate-950/60 text-slate-200">
                  {preview.product}
                </span>
              ) : null}
              {show.source ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-800 bg-slate-950/60 text-slate-200">
                  {preview.source}
                </span>
              ) : null}
              {show.value ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-800 bg-slate-950/60 text-slate-200">
                  {preview.value} ₼
                </span>
              ) : null}
            </div>

            {show.custom ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {preview.extraBadges.slice(0, Math.max(0, Number(ui.maxCustomFieldBadges ?? 2) || 2)).map((b) => (
                  <span
                    key={b}
                    className="px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-900/40 bg-emerald-950/20 text-emerald-200"
                  >
                    {b}
                  </span>
                ))}
              </div>
            ) : null}

            {show.assignee ? <p className="mt-2 text-[10px] text-slate-500">Operator: {preview.assignee}</p> : null}
            {show.msg ? <p className="mt-2 text-xs text-slate-300 line-clamp-2">{preview.message}</p> : null}
          </div>
        </HelpCallout>

        <HelpCallout title="İpucu">
          <p>Kartı sadə saxlayın: ən vacib 3-4 məlumat kifayətdir.</p>
          <p>Çox badge göstərmək kartları uzadır və oxunmanı zəiflədir.</p>
        </HelpCallout>
      </SettingsAside>
    </SettingsGrid>
  );
}
