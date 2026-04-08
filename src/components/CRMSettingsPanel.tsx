import React, { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, Bell, LayoutGrid, List, Route, Save, Settings, Smartphone, Type, Users, Zap } from 'lucide-react';
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
import { NotificationsTab } from './settings/crm/NotificationsTab';
import { DashboardTab } from './settings/crm/DashboardTab';

// ─── Factory Reset Button (now creates a super-admin approval request) ─────
function FormatButton({ serverUrl }: { serverUrl: string; onClose: () => void }) {
  const { currentUser } = useAppStore();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  if (currentUser?.permissions?.factory_reset === false && currentUser?.role !== 'superadmin') {
    return null;
  }

  const handleSubmitRequest = async () => {
    setBusy(true);
    setError('');
    try {
      if (!serverUrl) throw new Error('Server URL yoxdur');
      const res = await fetch(`${serverUrl}/api/danger-actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...CrmService['getAuthHeaders']() },
        body: JSON.stringify({ actionType: 'factory_reset', reason: reason.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Sorğu göndərilmədi');
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || 'Sorğu uğursuz oldu');
    } finally {
      setBusy(false);
    }
  };

  if (submitted) {
    return (
      <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/15 p-4 space-y-2">
        <p className="text-xs text-emerald-200 font-bold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Sorğunuz super-admin təsdiqini gözləyir
        </p>
        <p className="text-[11px] text-emerald-300/70 leading-relaxed">
          Super-admin sorğunu təsdiqləyəndə bütün leadlər və mesajlar
          <strong className="text-emerald-200"> 30 gün arxivə </strong> daşınacaq.
          Bu müddət ərzində super-admin istənilən an bərpa edə bilər.
          30 gündən sonra məlumatlar avtomatik silinir.
        </p>
        <button
          onClick={() => {
            setSubmitted(false);
            setConfirm(false);
            setReason('');
          }}
          className="w-full mt-2 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-xs font-bold rounded-lg"
        >
          Bağla
        </button>
      </div>
    );
  }

  if (confirm) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/15 p-4 space-y-3">
        <p className="text-xs text-red-300 font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Bu əməliyyat dərhal icra OLUNMUR
        </p>
        <p className="text-[11px] text-red-300/80 leading-relaxed">
          Sorğunuz <strong className="text-red-200">super-admin təsdiqinə</strong> göndəriləcək.
          Təsdiqdən sonra məlumatlar 30 günlük arxivə daşınacaq və super-admin
          tərəfindən bərpa edilə bilər. Heç bir məlumat dərhal silinməz.
        </p>

        <div>
          <label className="block text-[10px] uppercase font-bold text-red-300/70 mb-1">
            Səbəb (super-admin görəcək)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Niyə bu əməliyyat lazımdır?"
            rows={3}
            className="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-red-500 placeholder:text-slate-500 resize-none"
          />
          {error ? <p className="text-[10px] text-red-300 mt-1">{error}</p> : null}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleSubmitRequest}
            disabled={busy}
            className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-lg transition-colors disabled:opacity-50"
          >
            {busy ? 'Göndərilir...' : 'Sorğu göndər'}
          </button>
          <button
            onClick={() => {
              setConfirm(false);
              setReason('');
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
      Formatla (super-admin təsdiqi tələb edir)
    </button>
  );
}

interface CRMSettingsPanelProps {
  onClose?: () => void;
  variant?: 'modal' | 'page';
}

type Tab = 'connection' | 'rules' | 'routing' | 'stages' | 'cards' | 'fields' | 'dashboard' | 'notifications' | 'users' | 'audit';

const TABS: { id: Tab; label: string; icon: React.ReactNode; reqRole?: string[] }[] = [
  { id: 'connection', label: 'Bağlantı', icon: <Smartphone className="w-4 h-4" /> },
  { id: 'rules', label: 'Avtomatik Qaydalar', icon: <Zap className="w-4 h-4" /> },
  { id: 'routing', label: 'Mənbə (Routing)', icon: <Route className="w-4 h-4" /> },
  { id: 'stages', label: 'Kanban Sütunları', icon: <List className="w-4 h-4" /> },
  { id: 'cards', label: 'Lead Kartları', icon: <LayoutGrid className="w-4 h-4" /> },
  { id: 'fields', label: 'Xüsusi Sahələr', icon: <Type className="w-4 h-4" /> },
  { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 className="w-4 h-4" /> },
  { id: 'notifications', label: 'Bildirişlər & SLA', icon: <Bell className="w-4 h-4" /> },
  { id: 'users', label: 'İstifadəçilər', icon: <Users className="w-4 h-4" />, reqRole: ['admin'] },
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
  const canFactoryReset = currentUser?.role === 'superadmin';

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
      {activeTab === 'dashboard' ? <DashboardTab settings={settings} setSettings={setSettings} serverUrl={serverUrl} /> : null}
      {activeTab === 'notifications' ? <NotificationsTab settings={settings} setSettings={setSettings} /> : null}
      {activeTab === 'users' ? <UsersSettings /> : null}
      {activeTab === 'audit' ? <AuditLogs /> : null}
    </SettingsShell>
  );
}
