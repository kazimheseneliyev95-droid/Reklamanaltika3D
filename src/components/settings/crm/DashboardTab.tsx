import React, { useEffect, useMemo, useState } from 'react';
import { Check, Link2, Loader2, Target } from 'lucide-react';
import { CRMSettings } from '../../../lib/crmSettings';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

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

  const updateFieldId = (fieldId: string) => {
    setSettings((prev) => ({
      ...prev,
      dashboard: {
        fieldId,
        mappings: fieldId ? normalizeMappings(prev, fieldId) : [],
      }
    }));
  };

  const toggleCampaign = (fieldValue: string, campaignId: string) => {
    setSettings((prev) => {
      const fieldId = prev.dashboard?.fieldId || '';
      const rows = fieldId ? normalizeMappings(prev, fieldId) : [];
      const nextRows = rows.map((row) => {
        if (row.value !== fieldValue) return row;
        const exists = row.campaignIds.includes(campaignId);
        return {
          ...row,
          campaignIds: exists
            ? row.campaignIds.filter((id) => id !== campaignId)
            : [...row.campaignIds, campaignId]
        };
      });
      return {
        ...prev,
        dashboard: {
          fieldId,
          mappings: nextRows,
        }
      };
    });
  };

  const connectedCount = mappings.filter((row) => row.campaignIds.length > 0).length;

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Dashboard"
          description="CRM-dəki seçim sahəsini Facebook kampaniyaları ilə birləşdirin. Dashboard bu map-ə görə xərcləri və CRM nəticələrini bir yerdə göstərəcək."
        />

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-sm text-slate-100 flex items-center gap-2">
              <Target className="w-4 h-4 text-blue-400" />
              Birləşdirmə bazası
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-4">
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

            {!selectedField ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-4 py-3 text-sm text-slate-400">
                Əvvəlcə kampaniyalarla eşləşdiriləcək <strong className="text-slate-200">select</strong> sahəni seçin.
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-sm text-slate-100 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-emerald-400" />
              Dəyər → kampaniya map-i
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            {loading ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-4 py-6 text-sm text-slate-400 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Facebook kampaniyaları yüklənir...
              </div>
            ) : error ? (
              <div className="rounded-xl border border-red-900/40 bg-red-950/20 px-4 py-3 text-sm text-red-300">{error}</div>
            ) : campaigns.length === 0 ? (
              <div className="rounded-xl border border-amber-900/40 bg-amber-950/10 px-4 py-3 text-sm text-amber-300">
                Əvvəlcə <strong>Facebook</strong> bölməsində kampaniyaları seçib saxlayın. Sonra burada map yarada biləcəksiniz.
              </div>
            ) : selectedField && mappings.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/20 px-4 py-3 text-sm text-slate-400">
                Bu sahənin seçim variantı yoxdur. Əvvəlcə sahəyə variant əlavə edin.
              </div>
            ) : (
              mappings.map((row) => (
                <div key={row.value} className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <div className="text-sm font-bold text-slate-100">{row.value}</div>
                      <div className="text-[11px] text-slate-500">Bu kurs/dəyər üçün 1 və ya bir neçə kampaniya seçin</div>
                    </div>
                    <div className="text-[11px] font-semibold text-slate-400">
                      {row.campaignIds.length} kampaniya bağlıdır
                    </div>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                    {campaigns.map((campaign) => {
                      const active = row.campaignIds.includes(campaign.id);
                      return (
                        <button
                          key={campaign.id}
                          type="button"
                          onClick={() => toggleCampaign(row.value, campaign.id)}
                          className={active
                            ? 'flex items-start justify-between gap-3 rounded-xl border border-blue-500/40 bg-blue-500/10 px-3 py-3 text-left text-slate-100 transition-colors'
                            : 'flex items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-left text-slate-300 hover:border-slate-700 transition-colors'}
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-semibold truncate">{campaign.name}</div>
                            <div className="mt-1 text-[11px] text-slate-500 truncate">
                              {campaign.account_name || 'Facebook Campaign'}{campaign.objective ? ` · ${campaign.objective}` : ''}
                            </div>
                          </div>
                          <span className={active
                            ? 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white'
                            : 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-500'}
                          >
                            {active ? <Check className="w-3.5 h-3.5" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="Necə işləyir?">
          <p>Məsələn <strong>Maraqlandığı kurs</strong> sahəsindəki <strong>3D printer</strong> dəyərini 2-3 Facebook kampaniyası ilə bağlayırsınız.</p>
          <p>Dashboard həmin kurs üçün CRM nəticələrini və Facebook xərclərini bir yerdə göstərir.</p>
        </HelpCallout>

        <HelpCallout title="Hazırkı vəziyyət">
          <p>Seçilən sahə: <strong>{selectedField?.label || 'yoxdur'}</strong></p>
          <p>Map olunan dəyər sayı: <strong>{connectedCount}</strong></p>
          <p>Kampaniya mənbəyi: <strong>{campaigns.length}</strong> kampaniya</p>
        </HelpCallout>

        <HelpCallout title="Tövsiyə">
          <p>Bir CRM dəyərini yalnız həqiqətən eyni kursa aid kampaniyalarla bağlayın.</p>
          <p>Əgər bir kurs bir neçə kampaniyada gedirsə, hamısını eyni sətirdə seçin.</p>
        </HelpCallout>
      </SettingsAside>
    </SettingsGrid>
  );
}
