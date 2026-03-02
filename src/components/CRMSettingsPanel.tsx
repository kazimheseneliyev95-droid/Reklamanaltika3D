import React, { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, LayoutGrid, List, Route, Save, Settings, Smartphone, Type, Users, Zap } from 'lucide-react';
import { cn } from '../lib/utils';
import { CRMSettings, loadCRMSettings, saveCRMSettings } from '../lib/crmSettings';
import { CrmService } from '../services/CrmService';
import { UsersSettings } from './UsersSettings';
import { AuditLogs } from './AuditLogs';
import { useAppStore } from '../context/Store';
import { SettingsShell, type SettingsShellTab } from './settings/SettingsShell';
import { ConnectionTab } from './settings/crm/ConnectionTab';
import { AutoRulesTab } from './settings/crm/AutoRulesTab';
import { RoutingTab } from './settings/crm/RoutingTab';
import { StagesTab } from './settings/crm/StagesTab';
import { LeadCardsTab } from './settings/crm/LeadCardsTab';
import { CustomFieldsTab } from './settings/crm/CustomFieldsTab';

// ─── Factory Reset Button ─────────────────────────────────────────────────────
function FormatButton({ serverUrl, onClose }: { serverUrl: string; onClose: () => void }) {
  const { currentUser } = useAppStore();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (currentUser?.permissions?.factory_reset === false && currentUser?.role !== 'superadmin') {
    return null;
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
            ...CrmService['getAuthHeaders'](),
          },
          body: JSON.stringify({ password }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Silinmə zamanı xəta baş verdi');
      }

      Object.keys(localStorage).forEach((k) => {
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

  if (confirm) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/15 p-4 space-y-3">
        <p className="text-xs text-red-300 font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Bütün leadlar və yazışmalar silinəcək. Geri qaytarıla bilməz.
        </p>

        <div>
          <input
            type="password"
            placeholder="Təsdiq üçün şifrənizi yazın"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-red-500 placeholder:text-slate-500"
          />
          {error ? <p className="text-[10px] text-red-300 mt-1">{error}</p> : null}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleReset}
            disabled={busy || !password}
            className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? 'Silinir...' : 'Bəli, sil!'}
          </button>
          <button
            onClick={() => {
              setConfirm(false);
              setPassword('');
              setError('');
            }}
            className="flex-1 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-xs font-bold rounded-lg transition-colors"
          >
            Ləğv et
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirm(true)}
      className="w-full py-2 rounded-lg text-xs font-semibold text-red-300 hover:text-red-200 border border-red-900/30 hover:border-red-800/60 bg-transparent hover:bg-red-950/20 flex items-center justify-center gap-2 transition-colors"
    >
      <AlertTriangle className="w-4 h-4" />
      Formatla (Bütün Datanı Sil)
    </button>
  );
}

interface CRMSettingsPanelProps {
  onClose?: () => void;
  variant?: 'modal' | 'page';
}

type Tab = 'connection' | 'rules' | 'routing' | 'stages' | 'cards' | 'fields' | 'users' | 'audit';

const TABS: { id: Tab; label: string; icon: React.ReactNode; reqRole?: string[] }[] = [
  { id: 'connection', label: 'Bağlantı', icon: <Smartphone className="w-4 h-4" /> },
  { id: 'rules', label: 'Avtomatik Qaydalar', icon: <Zap className="w-4 h-4" /> },
  { id: 'routing', label: 'Mənbə (Routing)', icon: <Route className="w-4 h-4" /> },
  { id: 'stages', label: 'Kanban Sütunları', icon: <List className="w-4 h-4" /> },
  { id: 'cards', label: 'Lead Kartları', icon: <LayoutGrid className="w-4 h-4" /> },
  { id: 'fields', label: 'Xüsusi Sahələr', icon: <Type className="w-4 h-4" /> },
  { id: 'users', label: 'İstifadəçilər', icon: <Users className="w-4 h-4" />, reqRole: ['admin', 'manager'] },
  { id: 'audit', label: 'Audit Log', icon: <Activity className="w-4 h-4" />, reqRole: ['admin'] },
];

export function CRMSettingsPanel({ onClose, variant = 'modal' }: CRMSettingsPanelProps) {
  const safeOnClose = onClose || (() => {});
  const { currentUser, isWhatsAppConnected, bumpCrmSettingsRev } = useAppStore();

  const [settings, setSettings] = useState<CRMSettings>(loadCRMSettings());
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>(() => (isWhatsAppConnected ? 'rules' : 'connection'));
  const serverUrl = CrmService.getServerUrl();

  const canSaveToDb = currentUser?.role === 'admin' || currentUser?.role === 'superadmin';
  const canFactoryReset = (currentUser?.role === 'superadmin') || (currentUser?.permissions?.factory_reset !== false);

  const visibleTabs: SettingsShellTab[] = useMemo(() => {
    return TABS.map((t) => {
      const allowed = !t.reqRole || t.reqRole.includes(currentUser?.role || '') || currentUser?.role === 'superadmin';
      return { id: t.id, label: t.label, icon: t.icon, hidden: !allowed };
    });
  }, [currentUser?.role]);

  useEffect(() => {
    if (variant !== 'modal') return;
    if (!onClose) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose, variant]);

  useEffect(() => {
    // If current tab becomes hidden (role change), fallback to the first visible tab.
    const isHidden = visibleTabs.find((t) => t.id === activeTab)?.hidden;
    if (!isHidden) return;
    const first = visibleTabs.find((t) => !t.hidden);
    if (first) setActiveTab(first.id as Tab);
  }, [activeTab, visibleTabs]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      if (!canSaveToDb) throw new Error('Ayarları yadda saxlamaq üçün Admin icazəsi lazımdır');
      await saveCRMSettings(settings);
      setSaved(true);
      // Do NOT hard-reload the app: it can look like a redirect to Connection tab.
      // Just bump settings revision so pages re-read from localStorage.
      bumpCrmSettingsRev();
      setTimeout(() => setSaved(false), 900);
    } catch (e: any) {
      setSaveError(e?.message || 'Saxlama zamanı xəta baş verdi');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsShell
      variant={variant}
      title="CRM Ayarları"
      titleIcon={<Settings className="w-5 h-5 text-blue-400" />}
      onClose={onClose}
      tabs={visibleTabs}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as Tab)}
      footer={
        <>
          {saveError ? (
            <div className="rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-2 text-[11px] text-red-300">{saveError}</div>
          ) : null}

          {!canSaveToDb ? (
            <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-[11px] text-amber-300">
              Qeyd: Bu ayarları database-ə yazmaq üçün Admin rol lazımdır.
            </div>
          ) : null}

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
            {saving ? (
              <>
                <span className="animate-spin">↻</span> Saxlanır...
              </>
            ) : saved ? (
              <>
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/10">✓</span>
                Saxlandı!
              </>
            ) : (
              <>
                <Save className="w-4 h-4" /> Ayarları Saxla
              </>
            )}
          </button>

          {canFactoryReset ? (
            <details className="rounded-xl border border-slate-800 bg-slate-950/20 p-3">
              <summary className="cursor-pointer text-xs font-bold text-slate-200 select-none">Təhlükəli əməliyyatlar</summary>
              <div className="mt-3">
                <FormatButton serverUrl={serverUrl} onClose={safeOnClose} />
              </div>
            </details>
          ) : null}
        </>
      }
    >
      {activeTab === 'connection' ? <ConnectionTab /> : null}
      {activeTab === 'rules' ? <AutoRulesTab settings={settings} setSettings={setSettings} /> : null}
      {activeTab === 'routing' ? (
        <RoutingTab settings={settings} setSettings={setSettings} canSaveToDb={canSaveToDb} serverUrl={serverUrl} />
      ) : null}
      {activeTab === 'stages' ? <StagesTab settings={settings} setSettings={setSettings} /> : null}
      {activeTab === 'cards' ? <LeadCardsTab settings={settings} setSettings={setSettings} /> : null}
      {activeTab === 'fields' ? <CustomFieldsTab settings={settings} setSettings={setSettings} /> : null}
      {activeTab === 'users' ? <UsersSettings /> : null}
      {activeTab === 'audit' ? <AuditLogs /> : null}
    </SettingsShell>
  );
}
