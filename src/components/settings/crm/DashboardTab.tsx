import React, { useEffect, useMemo, useState } from 'react';
import { Check, Filter, Link2, Loader2, Search, Target, Unlink2 } from 'lucide-react';
import { CRMSettings } from '../../../lib/crmSettings';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';
import { cn } from '../../../lib/utils';

type Campaign = {
  id: string;
  name: string;
  account_name?: string | null;
  objective?: string | null;
};

type FacebookConfig = {
  selectedCampaigns?: Campaign[];
  campaignCache?: Campaign[];
};

function normalizeMappings(settings: CRMSettings, fieldId: string) {
  const field = settings.customFields.find((item) => item.id === fieldId && item.type === 'select');
  const allowed = new Set((field?.options || []).map((item) => String(item || '').trim()).filter(Boolean));
  const current = Array.isArray(settings.dashboard?.mappings) ? settings.dashboard?.mappings || [] : [];
  const byValue = new Map(current.map((row) => [String(row.value || '').trim(), row]));

  return Array.from(allowed).map((value) => ({
    value,
    campaignIds: Array.isArray(byValue.get(value)?.campaignIds)
      ? byValue.get(value)!.campaignIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
  }));
}

export function DashboardTab({
  settings,
  setSettings,
  serverUrl,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
  serverUrl: string;
}) {
  const [config, setConfig] = useState<FacebookConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeValue, setActiveValue] = useState('');
  const [valueQuery, setValueQuery] = useState('');
  const [campaignQuery, setCampaignQuery] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!serverUrl) {
        if (!cancelled) {
          setConfig(null);
          setLoading(false);
          setError('Server URL tapılmadı');
        }
        return;
      }

      setLoading(true);
      setError('');
      try {
        const token = localStorage.getItem('crm_auth_token') || '';
        const res = await fetch(`${serverUrl}/api/facebook-import/config`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Facebook kampaniyaları yüklənmədi');
        if (!cancelled) setConfig(data);
      } catch (e: any) {
        if (!cancelled) {
          setConfig(null);
          setError(e?.message || 'Facebook kampaniyaları yüklənmədi');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [serverUrl]);

  const selectFields = useMemo(
    () => settings.customFields.filter((field) => field.type === 'select'),
    [settings.customFields]
  );

  const selectedFieldId = settings.dashboard?.fieldId || '';
  const selectedField = useMemo(
    () => selectFields.find((field) => field.id === selectedFieldId) || null,
    [selectFields, selectedFieldId]
  );

  const campaigns = useMemo(() => {
    const rows = Array.isArray(config?.selectedCampaigns) && config!.selectedCampaigns!.length > 0
      ? config!.selectedCampaigns!
      : Array.isArray(config?.campaignCache) ? config!.campaignCache! : [];
    const unique = new Map<string, Campaign>();
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!id) continue;
      unique.set(id, {
        id,
        name: String(row?.name || 'Campaign'),
        account_name: row?.account_name ? String(row.account_name) : null,
        objective: row?.objective ? String(row.objective) : null,
      });
    }
    return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [config]);

  const mappings = useMemo(
    () => selectedField ? normalizeMappings(settings, selectedField.id) : [],
    [selectedField, settings]
  );

  useEffect(() => {
    if (!mappings.length) {
      setActiveValue('');
      return;
    }
    if (!mappings.some((row) => row.value === activeValue)) {
      const firstConnected = mappings.find((row) => row.campaignIds.length > 0);
      setActiveValue(firstConnected?.value || mappings[0].value);
    }
  }, [activeValue, mappings]);

  const filteredMappings = useMemo(() => {
    const query = valueQuery.trim().toLowerCase();
    return mappings.filter((row) => {
      if (showUnmappedOnly && row.campaignIds.length > 0) return false;
      if (!query) return true;
      return row.value.toLowerCase().includes(query);
    });
  }, [mappings, showUnmappedOnly, valueQuery]);

  useEffect(() => {
    if (!filteredMappings.length) return;
    if (!filteredMappings.some((row) => row.value === activeValue)) {
      setActiveValue(filteredMappings[0].value);
    }
  }, [activeValue, filteredMappings]);

  const activeMapping = useMemo(
    () => mappings.find((row) => row.value === activeValue) || null,
    [activeValue, mappings]
  );

  const selectedCampaigns = useMemo(() => {
    if (!activeMapping) return [];
    const selected = new Set(activeMapping.campaignIds);
    return campaigns.filter((campaign) => selected.has(campaign.id));
  }, [activeMapping, campaigns]);

  const filteredCampaigns = useMemo(() => {
    const query = campaignQuery.trim().toLowerCase();
    const selected = new Set(activeMapping?.campaignIds || []);
    return campaigns.filter((campaign) => {
      if (showSelectedOnly && !selected.has(campaign.id)) return false;
      if (!query) return true;
      return [campaign.name, campaign.account_name, campaign.objective]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [activeMapping?.campaignIds, campaignQuery, campaigns, showSelectedOnly]);

  const updateFieldId = (fieldId: string) => {
    setSettings((prev) => ({
      ...prev,
      dashboard: {
        fieldId,
        mappings: fieldId ? normalizeMappings(prev, fieldId) : [],
      }
    }));
  };

  const setCampaignIds = (fieldValue: string, nextIds: string[]) => {
    setSettings((prev) => {
      const fieldId = prev.dashboard?.fieldId || '';
      const rows = fieldId ? normalizeMappings(prev, fieldId) : [];
      return {
        ...prev,
        dashboard: {
          fieldId,
          mappings: rows.map((row) => row.value === fieldValue ? { ...row, campaignIds: nextIds } : row),
        }
      };
    });
  };

  const toggleCampaign = (fieldValue: string, campaignId: string) => {
    const current = mappings.find((row) => row.value === fieldValue);
    const exists = current?.campaignIds.includes(campaignId);
    const nextIds = exists
      ? (current?.campaignIds || []).filter((id) => id !== campaignId)
      : [...(current?.campaignIds || []), campaignId];
    setCampaignIds(fieldValue, nextIds);
  };

  const clearActiveValue = () => {
    if (!activeMapping) return;
    setCampaignIds(activeMapping.value, []);
  };

  const connectedCount = mappings.filter((row) => row.campaignIds.length > 0).length;
  const unmappedCount = Math.max(0, mappings.length - connectedCount);
  const activeSelectedCount = activeMapping?.campaignIds.length || 0;

  return (
    <SettingsGrid>
      <SettingsMain className="lg:col-span-12">
        <SettingsSectionHeader
          title="Dashboard"
          description="Əvvəl CRM dəyərini seçin, sonra həmin dəyərə kampaniyaları bağlayın. Ekran yalnız bu iş axını üçün sadələşdirildi."
        />

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4 pb-3">
            <CardTitle className="text-sm text-slate-100 flex items-center gap-2">
              <Target className="w-4 h-4 text-blue-400" />
              Birləşdirmə bazası
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-4">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,360px)_1fr] gap-4 items-end">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-2">CRM select sahəsi</label>
                <select
                  value={selectedFieldId}
                  onChange={(e) => updateFieldId(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Sahə seçin...</option>
                  {selectFields.map((field) => (
                    <option key={field.id} value={field.id}>{field.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span className="rounded-full border border-slate-800 bg-slate-950/30 px-3 py-1.5">
                  Sahə: <span className="font-semibold text-slate-100">{selectedField?.label || 'Seçilməyib'}</span>
                </span>
                <span className="rounded-full border border-slate-800 bg-slate-950/30 px-3 py-1.5">
                  {connectedCount} dəyər bağlanıb
                </span>
                <span className="rounded-full border border-slate-800 bg-slate-950/30 px-3 py-1.5">
                  {unmappedCount} dəyər boşdur
                </span>
                <span className="rounded-full border border-slate-800 bg-slate-950/30 px-3 py-1.5">
                  {campaigns.length} kampaniya hovuzu
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4 border-b border-slate-800/80">
            <CardTitle className="text-sm text-slate-100 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-emerald-400" />
              Map idarəsi
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="px-5 py-8 text-sm text-slate-400 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Facebook kampaniyaları yüklənir...
              </div>
            ) : error ? (
              <div className="px-5 py-4 text-sm text-red-300 bg-red-950/20 border-l-2 border-red-500/40">{error}</div>
            ) : campaigns.length === 0 ? (
              <div className="px-5 py-4 text-sm text-amber-300 bg-amber-950/10 border-l-2 border-amber-500/40">
                Əvvəlcə <strong>Facebook</strong> bölməsində kampaniyaları seçib saxlayın. Sonra burada map yarada biləcəksiniz.
              </div>
            ) : !selectedField ? (
              <div className="px-5 py-6 text-sm text-slate-400">
                Əvvəlcə kampaniyalarla eşləşdiriləcək <strong className="text-slate-200">select</strong> sahəni seçin.
              </div>
            ) : mappings.length === 0 ? (
              <div className="px-5 py-6 text-sm text-slate-400">
                Bu sahənin seçim variantı yoxdur. Əvvəlcə həmin sahəyə variant əlavə edin.
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] min-h-[640px]">
                <div className="border-b xl:border-b-0 xl:border-r border-slate-800/80 bg-slate-950/35">
                  <div className="px-4 py-4 border-b border-slate-800/70 space-y-3">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">CRM dəyərləri</div>
                      <div className="mt-1 text-xs text-slate-400">Soldan dəyəri seçin, sağda kampaniyaları bağlayın.</div>
                    </div>

                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input
                        value={valueQuery}
                        onChange={(e) => setValueQuery(e.target.value)}
                        placeholder="Dəyər axtar..."
                        className="w-full rounded-xl border border-slate-800 bg-slate-900 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowUnmappedOnly((prev) => !prev)}
                      className={cn(
                        'w-full rounded-xl border px-3 py-2 text-xs font-bold transition-colors',
                        showUnmappedOnly
                          ? 'border-blue-500/40 bg-blue-500/10 text-blue-100'
                          : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                      )}
                    >
                      <Filter className="w-3.5 h-3.5 inline mr-1.5" /> Yalnız eşləşməmişlər
                    </button>
                  </div>

                  <div className="max-h-[640px] overflow-auto p-2 space-y-2">
                    {filteredMappings.map((row) => {
                      const active = row.value === activeValue;
                      return (
                        <button
                          key={row.value}
                          type="button"
                          onClick={() => setActiveValue(row.value)}
                          className={cn(
                            'w-full rounded-2xl border px-3 py-3 text-left transition-colors',
                            active
                              ? 'border-blue-500/40 bg-blue-500/10'
                              : 'border-slate-800 bg-slate-950/20 hover:border-slate-700 hover:bg-slate-950/35'
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-bold text-slate-100 break-words">{row.value}</div>
                              <div className="mt-1 text-[11px] text-slate-500">
                                {row.campaignIds.length > 0 ? `${row.campaignIds.length} kampaniya bağlıdır` : 'Hələ kampaniya bağlanmayıb'}
                              </div>
                            </div>
                            <span className={cn(
                              'inline-flex min-w-8 justify-center rounded-full px-2 py-1 text-[11px] font-bold',
                              row.campaignIds.length > 0 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-800 text-slate-500'
                            )}>
                              {row.campaignIds.length}
                            </span>
                          </div>
                        </button>
                      );
                    })}

                    {filteredMappings.length === 0 ? (
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/20 px-4 py-5 text-sm text-slate-500">
                        Filterə uyğun CRM dəyəri tapılmadı.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="min-w-0">
                  {activeMapping ? (
                    <>
                      <div className="px-4 py-4 border-b border-slate-800/70 bg-slate-950/15 space-y-3">
                        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-lg font-bold text-slate-100 break-words">{activeMapping.value}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                              <span className="rounded-full border border-slate-800 bg-slate-900/70 px-2.5 py-1">{activeSelectedCount} kampaniya bağlıdır</span>
                              <span className="rounded-full border border-slate-800 bg-slate-900/70 px-2.5 py-1">Kampaniya adları tam görünür</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setShowSelectedOnly((prev) => !prev)}
                              className={cn(
                                'rounded-xl border px-3 py-2 text-xs font-bold transition-colors',
                                showSelectedOnly
                                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-100'
                                  : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                              )}
                            >
                              <Filter className="w-3.5 h-3.5 inline mr-1.5" /> Yalnız seçilənlər
                            </button>
                            <button
                              type="button"
                              onClick={clearActiveValue}
                              disabled={activeMapping.campaignIds.length === 0}
                              className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-300 hover:text-white disabled:opacity-40"
                            >
                              <Unlink2 className="w-3.5 h-3.5 inline mr-1.5" /> Təmizlə
                            </button>
                          </div>
                        </div>

                        <div className="relative">
                          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                          <input
                            value={campaignQuery}
                            onChange={(e) => setCampaignQuery(e.target.value)}
                            placeholder="Kampaniya axtar..."
                            className="w-full rounded-xl border border-slate-800 bg-slate-900 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>

                        {selectedCampaigns.length > 0 ? (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-3">
                            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">Seçilmiş kampaniyalar</div>
                            <div className="flex flex-wrap gap-2">
                              {selectedCampaigns.map((campaign) => (
                                <button
                                  key={campaign.id}
                                  type="button"
                                  onClick={() => toggleCampaign(activeMapping.value, campaign.id)}
                                  className="inline-flex max-w-full items-start gap-2 rounded-2xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-left text-[11px] font-semibold text-blue-100"
                                >
                                  <Check className="w-3 h-3 mt-0.5 shrink-0" />
                                  <span className="whitespace-normal break-words">{campaign.name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="text-[12px] text-slate-500">Hələ heç bir kampaniya seçilməyib.</div>
                        )}
                      </div>

                      <div className="p-4">
                        <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-3">Bütün kampaniyalar</div>
                        <div className="grid grid-cols-1 gap-2 max-h-[520px] overflow-auto pr-1">
                          {filteredCampaigns.map((campaign) => {
                            const active = activeMapping.campaignIds.includes(campaign.id);
                            return (
                              <button
                                key={campaign.id}
                                type="button"
                                onClick={() => toggleCampaign(activeMapping.value, campaign.id)}
                                className={cn(
                                  'group rounded-2xl border px-4 py-3 text-left transition-all',
                                  active
                                    ? 'border-blue-500/40 bg-blue-500/10 text-slate-100'
                                    : 'border-slate-800 bg-slate-950/20 text-slate-300 hover:border-slate-700 hover:bg-slate-950/35'
                                )}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold whitespace-normal break-words">{campaign.name}</div>
                                    <div className="mt-1 text-[11px] text-slate-500 whitespace-normal break-words">
                                      {campaign.account_name || 'Facebook Campaign'}{campaign.objective ? ` · ${campaign.objective}` : ''}
                                    </div>
                                  </div>
                                  <span className={cn(
                                    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
                                    active
                                      ? 'border-blue-500 bg-blue-500 text-white'
                                      : 'border-slate-700 text-slate-500 group-hover:border-slate-600'
                                  )}>
                                    {active ? <Check className="w-3.5 h-3.5" /> : null}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        {filteredCampaigns.length === 0 ? (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/20 px-4 py-5 text-sm text-slate-500 mt-3">
                            Filterə uyğun kampaniya tapılmadı.
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="px-5 py-6 text-sm text-slate-500">Sol tərəfdən bir CRM dəyəri seçin.</div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </SettingsMain>
    </SettingsGrid>
  );
}
