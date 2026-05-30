import { useEffect, useState } from 'react';
import { RefreshCcw, Wifi, WifiOff, Link2, Trash2, BellRing, Send, Bot, ShieldCheck, ScanSearch, AlertCircle, Info, ClipboardCopy, CheckCircle2, Facebook, XCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { CrmService } from '../../../services/CrmService';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';
import { WhatsAppAccountsCard } from './WhatsAppAccountsCard';

type MetaPage = {
  page_id: string;
  page_name?: string | null;
  ig_business_id?: string | null;
  connected_at?: string;
  updated_at?: string;
};


function CopyChip({ value, onCopy }: { value: string; onCopy: (v: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(value)}
      className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 align-middle"
      title="Kopyala"
    >
      <ClipboardCopy className="w-3 h-3" />
    </button>
  );
}

export function ConnectionTab() {
  const [health, setHealth] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const [tgConfig, setTgConfig] = useState<any | null>(null);
  const [tgEnabled, setTgEnabled] = useState(true);
  const [tgChatId, setTgChatId] = useState('');
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgClearToken, setTgClearToken] = useState(false);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgError, setTgError] = useState('');
  const [tgSavedOk, setTgSavedOk] = useState(false);

  const [tgDiag, setTgDiag] = useState<any | null>(null);
  const [tgDiagBusy, setTgDiagBusy] = useState(false);
  const [tgDiagError, setTgDiagError] = useState('');

  const [metaPages, setMetaPages] = useState<MetaPage[]>([]);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState('');

  const [oauthBusy, setOauthBusy] = useState(false);
  const [pendingActive, setPendingActive] = useState(false);
  const [pendingPages, setPendingPages] = useState<{ pageId: string; pageName: string | null; igBusinessId: string | null; igUsername: string | null; hasToken: boolean }[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [oauthNotice, setOauthNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [webhookStats, setWebhookStats] = useState<any | null>(null);
  const [lastConnectReport, setLastConnectReport] = useState<any | null>(null);
  const [metaConfig, setMetaConfig] = useState<any | null>(null);
  const [webhookCheck, setWebhookCheck] = useState<any[] | null>(null);
  const [webhookAppSub, setWebhookAppSub] = useState<any | null>(null);
  const [webhookCheckBusy, setWebhookCheckBusy] = useState(false);
  const [webhookSetupBusy, setWebhookSetupBusy] = useState(false);
  const [webhookSetupResult, setWebhookSetupResult] = useState<any | null>(null);
  const [pageSubResult, setPageSubResult] = useState<{ pageId: string; ok: boolean; msg: string } | null>(null);
  const [subscribingId, setSubscribingId] = useState('');

  // Per-tenant Facebook app credentials (each business uses its own app)
  const [appConfig, setAppConfig] = useState<any | null>(null);
  const [appIdInput, setAppIdInput] = useState('');
  const [appSecretInput, setAppSecretInput] = useState('');
  const [appVerifyInput, setAppVerifyInput] = useState('');
  const [appCfgBusy, setAppCfgBusy] = useState(false);
  const [appCfgSavedOk, setAppCfgSavedOk] = useState(false);
  const [appCfgError, setAppCfgError] = useState('');

  const refreshHealth = async () => {
    const h = await CrmService.fetchHealth();
    if (h) setHealth(h);
  };

  const refreshMeta = async () => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/pages`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Meta pages fetch failed (${res.status})`);
      }
      const data = await res.json();
      setMetaPages(Array.isArray(data?.pages) ? data.pages : []);
    } catch (e: any) {
      setMetaError(e?.message || 'Meta bağlantısı oxuna bilmədi');
    } finally {
      setMetaBusy(false);
    }
  };

  const refreshTelegram = async () => {
    setTgBusy(true);
    setTgError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/telegram/config`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Telegram config oxunmadi');

      setTgConfig(data || null);
      setTgEnabled(data?.enabled !== false);
      setTgChatId(String(data?.chat_id || ''));
    } catch (e: any) {
      setTgError(e?.message || 'Telegram config oxunmadi');
    } finally {
      setTgBusy(false);
    }
  };

  const diagnoseTelegram = async (): Promise<any | null> => {
    setTgDiagBusy(true);
    setTgDiagError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return null;
      const res = await fetch(`${url}/api/telegram/diagnose`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Telegram diaqnoz alinmadi');
      setTgDiag(data || null);
      return data || null;
    } catch (e: any) {
      setTgDiagError(e?.message || 'Telegram diaqnoz alinmadi');
      setTgDiag(null);
      return null;
    } finally {
      setTgDiagBusy(false);
    }
  };

  const detectChatId = async () => {
    const data = await diagnoseTelegram();
    const first = Array.isArray(data?.chat_candidates) ? data.chat_candidates[0] : null;
    if (first && first.chat_id) {
      setTgChatId(String(first.chat_id));
      return;
    }
    setTgDiagError('Chat id tapilmadi. Bot-a 1 mesaj gonderin (məs: /start), sonra tekrar yoxlayin.');
  };

  const copyText = async (text: string) => {
    const t = String(text || '');
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      // ignore
    }
  };

  const saveTelegram = async () => {
    setTgBusy(true);
    setTgError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;

      const payload: any = {
        enabled: tgEnabled,
        chat_id: tgChatId
      };
      if (tgClearToken) payload.clear_token = true;
      if (tgBotToken.trim()) payload.bot_token = tgBotToken.trim();

      const res = await fetch(`${url}/api/telegram/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Telegram save failed');

      setTgBotToken('');
      setTgClearToken(false);
      setTgSavedOk(true);
      setTimeout(() => setTgSavedOk(false), 1500);
      await refreshTelegram();
    } catch (e: any) {
      setTgError(e?.message || 'Telegram save failed');
    } finally {
      setTgBusy(false);
    }
  };

  const testTelegram = async () => {
    setTgBusy(true);
    setTgError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;

      const payload: any = {
        chat_id: String(tgChatId || '').trim(),
      };
      if (String(tgBotToken || '').trim()) payload.bot_token = String(tgBotToken || '').trim();
      payload.text = `Telegram test ok\nTenant: ${localStorage.getItem('crm_tenant_id') || ''}\nTime: ${new Date().toISOString()}`;

      const res = await fetch(`${url}/api/telegram/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Telegram test failed');
      await refreshTelegram();
    } catch (e: any) {
      setTgError(e?.message || 'Telegram test failed');
    } finally {
      setTgBusy(false);
    }
  };

  const refreshWebhookStats = async () => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/webhook/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Status failed');
      setWebhookStats(data?.stats || null);
    } catch (e: any) {
      setMetaError(e?.message || 'Webhook status oxunmadi');
    } finally {
      setMetaBusy(false);
    }
  };

  const refreshMetaConfig = async () => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/config`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Config failed');
      setMetaConfig(data || null);
    } catch (e: any) {
      setMetaError(e?.message || 'Meta config oxunmadi');
    } finally {
      setMetaBusy(false);
    }
  };

  const refreshAppConfig = async () => {
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/app-config`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setAppConfig(data || null);
        setAppIdInput(String(data?.appId || ''));
      }
    } catch {
      // ignore
    }
  };

  const saveAppConfig = async () => {
    setAppCfgBusy(true);
    setMetaError('');
    setAppCfgError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const payload: Record<string, string> = {};
      if (appIdInput.trim()) payload.app_id = appIdInput.trim();
      if (appSecretInput.trim()) payload.app_secret = appSecretInput.trim();
      if (appVerifyInput.trim()) payload.verify_token = appVerifyInput.trim();
      const res = await fetch(`${url}/api/meta/app-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Tətbiq məlumatları saxlanmadı');
      setAppConfig(data || null);
      setAppIdInput(String(data?.appId || ''));
      setAppSecretInput('');
      setAppVerifyInput('');
      setAppCfgSavedOk(true);
      setTimeout(() => setAppCfgSavedOk(false), 1500);
      await refreshMetaConfig();
    } catch (e: any) {
      setAppCfgError(e?.message || 'Tətbiq məlumatları saxlanmadı');
    } finally {
      setAppCfgBusy(false);
    }
  };

  const checkWebhook = async () => {
    setWebhookCheckBusy(true);
    setWebhookCheck(null);
    setWebhookAppSub(null);
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/webhook/check`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Check failed');
      setWebhookCheck(Array.isArray(data?.results) ? data.results : []);
      setWebhookAppSub(data?.app || null);
    } catch (e: any) {
      setMetaError(e?.message || 'Webhook check failed');
    } finally {
      setWebhookCheckBusy(false);
    }
  };

  const webhookHelp = (err: any) => {
    const e = String(err || '').toLowerCase();
    if (!e) return '';
    if (e.includes('meta_app_secret missing')) return 'Server env-də META_APP_SECRET yoxdur (Render → Environment).';
    if (e.includes('signature_mismatch')) return 'META_APP_SECRET yanlışdır (Meta App Secret ilə eyni olmalıdır).';
    if (e.includes('handler_error')) return 'Server webhook payload-ı parse edə bilmədi (logs-a baxın).';
    return '';
  };

  // Step 1: ask backend for the Facebook dialog URL, then redirect the browser to Meta.
  const startOAuth = async () => {
    setOauthBusy(true);
    setMetaError('');
    setOauthNotice(null);
    try {
      const url = CrmService.getServerUrl();
      const authToken = localStorage.getItem('crm_auth_token');
      if (!url || !authToken) return;
      const res = await fetch(`${url}/api/meta/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) throw new Error(data?.error || 'OAuth başlatıla bilmədi');
      window.location.href = data.url;
    } catch (e: any) {
      setMetaError(e?.message || 'OAuth başlatıla bilmədi');
      setOauthBusy(false);
    }
  };

  // Step 3: load the pages reachable by the stored user token (metadata only, no tokens).
  const loadPending = async (silent = false) => {
    if (!silent) setMetaBusy(true);
    try {
      const url = CrmService.getServerUrl();
      const authToken = localStorage.getItem('crm_auth_token');
      if (!url || !authToken) return;
      const res = await fetch(`${url}/api/meta/oauth/pending`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Pending sessiya oxunmadı');
      const active = Boolean(data?.pending);
      setPendingActive(active);
      const pages = Array.isArray(data?.pages) ? data.pages : [];
      setPendingPages(pages);
      if (data?.error) setOauthNotice({ kind: 'error', text: String(data.error) });
      // Default-select pages that are not yet connected.
      const connected = new Set((metaPages || []).map(p => String(p.page_id)));
      setSelectedPageIds(pages.filter((p: any) => p.hasToken && !connected.has(p.pageId)).map((p: any) => p.pageId));
    } catch (e: any) {
      if (!silent) setMetaError(e?.message || 'Pending sessiya oxunmadı');
    } finally {
      if (!silent) setMetaBusy(false);
    }
  };

  // Step 4: confirm which pages to keep → backend saves page tokens + subscribes webhooks.
  const selectPages = async () => {
    if (selectedPageIds.length === 0) return;
    setMetaBusy(true);
    setMetaError('');
    setLastConnectReport(null);
    try {
      const url = CrmService.getServerUrl();
      const authToken = localStorage.getItem('crm_auth_token');
      if (!url || !authToken) return;
      const res = await fetch(`${url}/api/meta/oauth/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ pageIds: selectedPageIds })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Səhifələr qoşulmadı');
      setLastConnectReport(data?.subscribe || null);
      setOauthNotice({ kind: 'success', text: `${data?.savedCount ?? selectedPageIds.length} səhifə qoşuldu.` });
      await refreshMeta();
      await refreshWebhookStats();
      await refreshMetaConfig();
      await loadPending(true);
    } catch (e: any) {
      setMetaError(e?.message || 'Səhifələr qoşulmadı');
    } finally {
      setMetaBusy(false);
    }
  };

  // Discard the pending OAuth session (stored user token) without touching connected pages.
  const cancelOAuth = async () => {
    setOauthBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const authToken = localStorage.getItem('crm_auth_token');
      if (!url || !authToken) return;
      await fetch(`${url}/api/meta/oauth/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      }).catch(() => {});
      setPendingActive(false);
      setPendingPages([]);
      setSelectedPageIds([]);
      setOauthNotice(null);
    } finally {
      setOauthBusy(false);
    }
  };

  const disconnectPage = async (pageId: string) => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;

      const res = await fetch(`${url}/api/meta/pages/${encodeURIComponent(pageId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Disconnect failed');
      await refreshMeta();
    } catch (e: any) {
      setMetaError(e?.message || 'Ayrilma alınmadı');
    } finally {
      setMetaBusy(false);
    }
  };

  const subscribePage = async (pageId: string) => {
    setSubscribingId(pageId);
    setMetaError('');
    setPageSubResult(null);
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;

      const res = await fetch(`${url}/api/meta/pages/${encodeURIComponent(pageId)}/subscribe`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Subscribe failed');
      const r = data?.result || {};
      const pageOk = r?.page?.ok !== false;
      const igInfo = r?.instagram ? (r.instagram.ok ? ' · ig: ok' : ` · ig: ${r.instagram.error || 'xəta'}`) : '';
      setPageSubResult({ pageId, ok: pageOk, msg: pageOk ? `Abunə olundu (page: ok${igInfo})` : `Page abunəlik xətası: ${r?.page?.error || 'naməlum'}` });
      await refreshMeta();
    } catch (e: any) {
      setPageSubResult({ pageId, ok: false, msg: e?.message || 'Webhook subscribe alınmadı' });
    } finally {
      setSubscribingId('');
    }
  };

  // One-click: subscribe the APP to the webhook fields (messages/feed/comments) via the server.
  const setupAppWebhook = async () => {
    setWebhookSetupBusy(true);
    setWebhookSetupResult(null);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/webhook/setup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Webhook setup alınmadı');
      setWebhookSetupResult(data || null);
      await checkWebhook();
    } catch (e: any) {
      setWebhookSetupResult({ error: e?.message || 'Webhook setup alınmadı' });
    } finally {
      setWebhookSetupBusy(false);
    }
  };

  useEffect(() => {
    const cleanupHealth = CrmService.onHealthCheck((h: any) => setHealth(h));
    const cleanupAuth = CrmService.onAuthenticated(() => {
      refreshHealth();
    });
    refreshHealth();
    refreshTelegram();
    refreshMeta();
    refreshWebhookStats();
    refreshMetaConfig();
    refreshAppConfig();

    // Handle the OAuth redirect status set by the backend callback (?meta_oauth=...).
    let oauthSucceeded = false;
    try {
      const params = new URLSearchParams(window.location.search);
      const status = params.get('meta_oauth');
      if (status) {
        const messages: Record<string, { kind: 'success' | 'error' | 'info'; text: string }> = {
          success: { kind: 'success', text: 'Facebook icazəsi verildi. Aşağıdan səhifələri seçib qoşun.' },
          denied: { kind: 'error', text: 'İcazə ləğv edildi. Yenidən cəhd edin.' },
          badstate: { kind: 'error', text: 'Təhlükəsizlik yoxlaması uğursuz oldu (state). Yenidən cəhd edin.' },
          nocode: { kind: 'error', text: 'Meta-dan kod gəlmədi. Yenidən cəhd edin.' },
          exchangefail: { kind: 'error', text: 'Token mübadiləsi alınmadı. Yenidən cəhd edin.' },
          error: { kind: 'error', text: 'OAuth zamanı xəta baş verdi. Yenidən cəhd edin.' }
        };
        setOauthNotice(messages[status] || { kind: 'info', text: `OAuth: ${status}` });
        oauthSucceeded = status === 'success';
        // Clean the query param so a refresh does not re-trigger the notice.
        params.delete('meta_oauth');
        const clean = window.location.pathname + (params.toString() ? `?${params}` : '') + window.location.hash;
        window.history.replaceState({}, '', clean);
      }
    } catch {
      // ignore URL parsing issues
    }
    // Always probe for a stored pending session (resilient across refresh); force-show after success.
    loadPending(!oauthSucceeded);

    return () => {
      cleanupHealth();
      cleanupAuth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReconnect = async () => {
    setBusy(true);
    try {
      await CrmService.reconnect();
      await refreshHealth();
    } finally {
      setBusy(false);
    }
  };

  const info = CrmService.getConnectionInfo();

  const callbackPath = metaConfig?.callbackPath || '/api/webhooks/meta';
  const callbackUrl = info?.serverUrl ? `${String(info.serverUrl).replace(/\/$/, '')}${callbackPath}` : callbackPath;
  const oauthRedirectUri = metaConfig?.oauthRedirectUri
    || (info?.serverUrl ? `${String(info.serverUrl).replace(/\/$/, '')}/api/meta/oauth/callback` : '/api/meta/oauth/callback');
  const appDomain = (() => { try { return new URL(oauthRedirectUri).host; } catch { return ''; } })();

  const tgServerEnabled = tgConfig ? (tgConfig.enabled !== false) : false;
  const tgServerChat = String(tgConfig?.chat_id || '').trim();
  const tgServerHasToken = Boolean(tgConfig?.has_bot_token);
  const tgGlobalEnabled = tgConfig?.enabled_global !== false;
  const tgDirty = tgConfig != null
    ? (tgEnabled !== tgServerEnabled || String(tgChatId || '').trim() !== tgServerChat || tgClearToken || String(tgBotToken || '').trim() !== '')
    : (Boolean(String(tgChatId || '').trim()) || Boolean(String(tgBotToken || '').trim()));
  const tgReady = tgGlobalEnabled && tgServerEnabled && tgServerHasToken && Boolean(tgServerChat);
  const tgDraftReady = tgGlobalEnabled && Boolean(tgEnabled) && Boolean(String(tgChatId || '').trim()) && (tgServerHasToken || Boolean(String(tgBotToken || '').trim()));

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="Bağlantılar"
          description="WhatsApp hesablarını və digər bildirim kanallarını buradan idarə edin."
          actions={
            <button
              onClick={handleReconnect}
              disabled={busy}
              className="px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 border border-blue-500/30 text-white transition-colors disabled:opacity-50 inline-flex items-center gap-2"
            >
              <RefreshCcw className={cn('w-4 h-4', busy && 'animate-spin')} />
              Socket Yenilə
            </button>
          }
        />

        {/* Multi-WhatsApp Accounts (replaces the old single WhatsApp card) */}
        <WhatsAppAccountsCard />

        <Card className="border-slate-800 bg-slate-950/40">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200 flex items-center gap-2">
              {info.socketConnected ? <Wifi className="w-4 h-4 text-blue-400" /> : <WifiOff className="w-4 h-4 text-slate-500" />}
              Real-time Socket
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className={cn('text-xs font-bold', info.socketConnected ? 'text-blue-300' : 'text-slate-400')}>
              {info.socketConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </p>
            <p className="mt-2 text-[10px] text-slate-500 truncate">{info.serverUrl}</p>
            {typeof health?.socket_clients === 'number' ? (
              <p className="mt-1 text-[10px] text-slate-600">UI client sayi: {health.socket_clients}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Send className="w-4 h-4 text-slate-400" />
                Telegram Bildirimleri
              </span>
              <button
                onClick={refreshTelegram}
                disabled={tgBusy}
                className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {tgBusy ? '...' : 'Yenilə'}
              </button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            {tgError ? (
              <div className="rounded-lg border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] text-red-300">
                {tgError}
              </div>
            ) : null}

            {tgConfig?.enabled_global === false ? (
              <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-[11px] text-amber-300">
                Server env: TELEGRAM_NOTIFICATIONS_ENABLED=false oldugu ucun gonderis bloklanir.
              </div>
            ) : null}

            <div className="rounded-xl border border-slate-800 bg-slate-950/25 px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-9 h-9 rounded-xl border flex items-center justify-center',
                      tgReady ? 'border-emerald-900/40 bg-emerald-950/15' : 'border-slate-800 bg-slate-950/30'
                    )}>
                      {tgReady ? <CheckCircle2 className="w-5 h-5 text-emerald-300" /> : <AlertCircle className="w-5 h-5 text-slate-400" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[12px] font-extrabold text-slate-100">
                        {tgReady ? 'Hazirdir (server config)' : 'Setup lazimdir'}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500">
                        Bildirimler server-de saxlanan config ile gonderilir. Formdakı deyisiklikler <span className="text-slate-300 font-semibold">Yadda Saxla</span> edenden sonra aktiv olur.
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-extrabold', tgGlobalEnabled ? 'border-slate-800 bg-slate-950/40 text-slate-300' : 'border-amber-900/40 bg-amber-950/10 text-amber-300')}>
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Global: {tgGlobalEnabled ? 'ON' : 'OFF'}
                    </span>
                    <span className={cn('inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-extrabold', tgServerEnabled ? 'border-emerald-900/30 bg-emerald-950/10 text-emerald-200' : 'border-slate-800 bg-slate-950/40 text-slate-500')}>
                      Tenant: {tgServerEnabled ? 'ENABLED' : 'DISABLED'}
                    </span>
                    <span className={cn('inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-extrabold', tgServerHasToken ? 'border-slate-800 bg-slate-950/40 text-slate-300' : 'border-slate-800 bg-slate-950/40 text-slate-500')}>
                      <Bot className="w-3.5 h-3.5" /> Token: {tgServerHasToken ? 'ok' : 'yox'}
                    </span>
                    <span className={cn('inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-extrabold', tgServerChat ? 'border-slate-800 bg-slate-950/40 text-slate-300' : 'border-slate-800 bg-slate-950/40 text-slate-500')}>
                      Chat: {tgServerChat ? 'set' : 'yox'}
                    </span>
                    {tgDirty ? (
                      <span className="inline-flex items-center gap-2 rounded-full border border-blue-900/30 bg-blue-950/15 text-blue-200 px-2 py-1 text-[10px] font-extrabold">
                        Draft: {tgDraftReady ? 'ready' : 'incomplete'}
                      </span>
                    ) : null}
                  </div>

                  {tgConfig?.last_error ? (
                    <div className="mt-3 rounded-lg border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] text-red-300">
                      Son xeta: {String(tgConfig.last_error)}
                    </div>
                  ) : null}

                  <div className="mt-2 text-[10px] text-slate-600">
                    {tgConfig?.last_sent_at ? <span>Son gonderis: {new Date(tgConfig.last_sent_at).toLocaleString()} </span> : <span>Son gonderis: - </span>}
                    <span className="text-slate-700">·</span>
                    {tgConfig?.last_test_at ? <span> Test: {new Date(tgConfig.last_test_at).toLocaleString()}</span> : <span> Test: -</span>}
                    {tgConfig?.updated_at ? <span className="text-slate-700"> ·</span> : null}
                    {tgConfig?.updated_at ? <span> Yenilendi: {new Date(tgConfig.updated_at).toLocaleString()}</span> : null}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <button
                    onClick={diagnoseTelegram}
                    disabled={tgDiagBusy || tgBusy}
                    className="px-2 py-1.5 rounded-lg text-[10px] font-extrabold border border-slate-800 text-slate-300 hover:bg-slate-900 disabled:opacity-50 inline-flex items-center gap-2"
                    title="Bot token yoxla + chat id tap"
                  >
                    <ScanSearch className={cn('w-3.5 h-3.5', tgDiagBusy && 'animate-spin')} />
                    Diaqnoz
                  </button>
                </div>
              </div>

              {tgDiagError ? (
                <div className="mt-3 rounded-lg border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] text-red-300">
                  {tgDiagError}
                </div>
              ) : null}

              {tgDiag?.bot ? (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/25 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-300 font-semibold flex items-center gap-2">
                      <Bot className="w-4 h-4 text-slate-400" />
                      Bot: <span className="text-slate-100">{tgDiag.bot.username ? `@${tgDiag.bot.username}` : (tgDiag.bot.first_name || 'Telegram Bot')}</span>
                    </div>
                    {tgDiag?.stored?.bot_token_masked ? (
                      <div className="text-[10px] text-slate-500">token: {String(tgDiag.stored.bot_token_masked)}</div>
                    ) : null}
                  </div>

                  {Array.isArray(tgDiag?.chat_candidates) && tgDiag.chat_candidates.length > 0 ? (
                    <div className="mt-2">
                      <div className="text-[10px] uppercase font-extrabold text-slate-500">Chat id namizedleri (getUpdates)</div>
                      <div className="mt-2 grid grid-cols-1 gap-2">
                        {tgDiag.chat_candidates.map((c: any) => {
                          const label = c?.title || (c?.username ? `@${c.username}` : c?.chat_id);
                          const meta = [c?.type ? String(c.type) : null, c?.last_at ? new Date(c.last_at).toLocaleString() : null].filter(Boolean).join(' · ');
                          return (
                            <div key={String(c.chat_id)} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
                              <div className="min-w-0">
                                <div className="text-[11px] font-semibold text-slate-200 truncate" title={String(label)}>{String(label)}</div>
                                <div className="text-[10px] text-slate-600">{meta}</div>
                              </div>
                              <div className="shrink-0 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => { setTgChatId(String(c.chat_id || '')); }}
                                  className="px-2 py-1 rounded-lg text-[10px] font-extrabold border border-blue-900/30 bg-blue-950/20 text-blue-200 hover:bg-blue-950/35"
                                >
                                  Istifade et
                                </button>
                                <button
                                  type="button"
                                  onClick={() => copyText(String(c.chat_id || ''))}
                                  className="p-1.5 rounded-lg border border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900"
                                  title="Copy chat id"
                                >
                                  <ClipboardCopy className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-2 text-[10px] text-slate-600 flex items-start gap-2">
                        <Info className="w-3.5 h-3.5 mt-0.5 text-slate-500" />
                        Chat id namizedleri gorunmesi ucun bot-a 1 mesaj gonderin (məs: /start), sonra tekrar Diaqnoz edin.
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-[10px] text-slate-600 flex items-start gap-2">
                      <Info className="w-3.5 h-3.5 mt-0.5 text-slate-500" />
                      Chat id tapilmadi. Bot-a 1 mesaj gonderin (məs: /start), sonra tekrar Diaqnoz edin.
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/20 px-3 py-2">
              <div className="text-[11px] text-slate-400">
                Tenant bildirimleri:{' '}
                <span className={cn('font-extrabold', tgEnabled ? 'text-emerald-300' : 'text-slate-500')}>
                  {tgEnabled ? 'ENABLED' : 'DISABLED'}
                </span>
                {tgDirty ? <span className="text-blue-300"> · (draft)</span> : <span className="text-slate-600"> · (saved)</span>}
              </div>
              <button
                type="button"
                onClick={() => setTgEnabled(v => !v)}
                disabled={tgBusy}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-[10px] font-extrabold border transition-colors disabled:opacity-50',
                  tgEnabled
                    ? 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300 hover:bg-emerald-950/25'
                    : 'border-slate-800 bg-slate-950/20 text-slate-300 hover:bg-slate-900'
                )}
              >
                {tgEnabled ? 'Sondur' : 'Aktiv et'}
              </button>
            </div>

            <div>
              <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">Bot Token</label>
              <input
                type="password"
                value={tgBotToken}
                onChange={(e) => setTgBotToken(e.target.value)}
                className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                placeholder={tgConfig?.has_bot_token ? (tgConfig?.bot_token_masked ? `Saved (${tgConfig.bot_token_masked})` : 'Saved') : '123456:AA...'}
              />
              <div className="mt-1 text-[10px] text-slate-600">
                Tokeni yalniz 1 defe yazmaq kifayetdir (sonra DB-de qalir).
              </div>
              <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-400 select-none">
                <input
                  type="checkbox"
                  checked={tgClearToken}
                  onChange={(e) => setTgClearToken(e.target.checked)}
                  className="accent-blue-600"
                />
                Tokeni sil (clear)
              </label>
            </div>

            <div>
              <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">Chat ID</label>
              <input
                type="text"
                value={tgChatId}
                onChange={(e) => setTgChatId(e.target.value)}
                className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                placeholder="-1001234567890 veya @kanal"
              />
              <div className="mt-1 text-[10px] text-slate-600">
                Chat ID ucun: bot-a 1 mesaj yazin, sonra chat id-ni alin (mes: @userinfobot).
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={detectChatId}
                  disabled={tgBusy || tgDiagBusy}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-extrabold border border-slate-800 text-slate-300 hover:bg-slate-900 disabled:opacity-50 inline-flex items-center gap-2"
                  title="Bot token ile chat id tap"
                >
                  <ScanSearch className={cn('w-3.5 h-3.5', tgDiagBusy && 'animate-spin')} />
                  Chat ID tap
                </button>
                {tgChatId ? (
                  <button
                    type="button"
                    onClick={() => copyText(String(tgChatId))}
                    className="p-1.5 rounded-lg border border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900"
                    title="Copy"
                  >
                    <ClipboardCopy className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={saveTelegram}
                disabled={tgBusy}
                className={cn(
                  'flex-1 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50',
                  tgSavedOk ? 'bg-emerald-600 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'
                )}
              >
                {tgBusy ? '...' : (tgSavedOk ? 'Saxlandi' : 'Yadda Saxla')}
              </button>
              <button
                onClick={testTelegram}
                disabled={tgBusy}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors disabled:opacity-50"
              >
                Test
              </button>
            </div>
          </CardContent>
        </Card>

        {/* QR display moved into WhatsAppAccountsCard (per-account modal) */}

        <Card className="border-slate-800 bg-slate-950/30">
          <CardHeader className="p-4">
            <CardTitle className="text-xs text-slate-200 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-slate-400" />
                Facebook / Instagram
              </span>
              <button
                onClick={refreshMeta}
                disabled={metaBusy}
                className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {metaBusy ? '...' : 'Yenilə'}
              </button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            {metaError ? (
              <div className="rounded-lg border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] text-red-300">
                {metaError}
              </div>
            ) : null}

            <div className="text-[11px] text-slate-400">
              Qoşulu səhifə: <span className="text-slate-200 font-semibold">{metaPages.length}</span>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2">
              <div className="text-[11px] text-slate-400">
                Webhook: <span className="text-slate-200 font-semibold">{webhookStats?.accepted ?? 0}</span>
                <span className="text-slate-600"> ok</span>
                <span className="text-slate-600"> · </span>
                <span className="text-slate-200 font-semibold">{webhookStats?.rejected ?? 0}</span>
                <span className="text-slate-600"> rej</span>
                {typeof webhookStats?.backlog === 'number' ? (
                  <>
                    <span className="text-slate-600"> · </span>
                    <span className="text-slate-200 font-semibold">{webhookStats.backlog}</span>
                    <span className="text-slate-600"> queue</span>
                  </>
                ) : null}
                {typeof webhookStats?.outbox_pending === 'number' ? (
                  <>
                    <span className="text-slate-600"> · </span>
                    <span className="text-slate-200 font-semibold">{webhookStats.outbox_pending}</span>
                    <span className="text-slate-600"> outbox</span>
                  </>
                ) : null}
                {webhookStats?.last_at ? <span className="text-slate-600"> · last: {new Date(webhookStats.last_at).toLocaleString()}</span> : null}
                {webhookStats?.last_error ? <span className="text-red-300"> · err: {String(webhookStats.last_error)}</span> : null}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={refreshWebhookStats}
                  disabled={metaBusy}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-900 disabled:opacity-50"
                >
                  {metaBusy ? '...' : 'Yoxla'}
                </button>
                <button
                  onClick={checkWebhook}
                  disabled={webhookCheckBusy || metaBusy}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-blue-900/40 bg-blue-950/10 text-blue-300 hover:bg-blue-950/20 disabled:opacity-50"
                  title="Hər səhifənin webhook abunəliyini Meta-dan yoxla"
                >
                  {webhookCheckBusy ? '...' : 'Test'}
                </button>
                <button
                  onClick={setupAppWebhook}
                  disabled={webhookSetupBusy || metaBusy}
                  className="px-2 py-1 rounded-md text-[10px] font-bold border border-emerald-900/40 bg-emerald-950/10 text-emerald-300 hover:bg-emerald-950/20 disabled:opacity-50"
                  title="Tətbiqi messages/feed webhook-larına abunə et (mesajların gəlməsi üçün)"
                >
                  {webhookSetupBusy ? '...' : 'Webhook qur'}
                </button>
              </div>
            </div>

            {webhookSetupResult ? (
              <div className={cn(
                'rounded-lg border px-3 py-2 text-[11px]',
                webhookSetupResult.error ? 'border-red-900/40 bg-red-950/15 text-red-300'
                  : (webhookSetupResult.page?.ok ? 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300' : 'border-amber-900/40 bg-amber-950/10 text-amber-300')
              )}>
                {webhookSetupResult.error ? (
                  <span>Webhook qurulmadı: {webhookSetupResult.error}</span>
                ) : (
                  <span>
                    Webhook qurma: page {webhookSetupResult.page?.ok ? '✓ (messages,feed)' : `✗ ${webhookSetupResult.page?.error || ''}`}
                    {' · '}instagram {webhookSetupResult.instagram?.ok ? '✓' : `✗ ${webhookSetupResult.instagram?.error || 'advanced access lazımdır'}`}
                  </span>
                )}
              </div>
            ) : null}

            {webhookStats?.last_error ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400">
                <span className="text-slate-200 font-semibold">Diaqnoz:</span>{' '}
                {webhookHelp(webhookStats.last_error) || 'Meta Developer → Webhooks → Delivery log-a baxın (status code görsənəcək).'}
              </div>
            ) : null}

            {Array.isArray(webhookCheck) ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400">
                <div className="text-slate-200 font-semibold mb-2">Webhook abunəlik nəticəsi</div>

                {webhookAppSub ? (() => {
                  const hasMsg = (webhookAppSub.objects || []).some((o: any) => o.object === 'page' && (o.fields || []).includes('messages'));
                  const ready = Boolean(webhookAppSub.configured && webhookAppSub.matches && hasMsg);
                  const partial = Boolean(webhookAppSub.configured && (!webhookAppSub.matches || !hasMsg));
                  return (
                  <div className={cn(
                    'mb-2 rounded-lg border px-2 py-2',
                    ready ? 'border-emerald-900/40 bg-emerald-950/15' : partial ? 'border-amber-900/40 bg-amber-950/10' : 'border-red-900/40 bg-red-950/15'
                  )}>
                    <div className="flex items-center gap-2">
                      <span className={ready ? 'text-green-400' : partial ? 'text-amber-400' : 'text-red-400'}>
                        {ready ? '✓' : partial ? '!' : '✗'}
                      </span>
                      <span className="font-semibold text-slate-200">
                        App webhook: {ready ? 'hazır (messages abunəliyi var)' : !webhookAppSub.configured ? 'callback QURULMAYIB' : !webhookAppSub.matches ? 'callback URL fərqlidir' : 'messages alanı abunə DEYİL'}
                      </span>
                    </div>
                    {!webhookAppSub.configured ? (
                      <div className="mt-1 text-[10px] text-red-300">
                        Tətbiqdə Webhooks callback yoxdur. <span className="text-emerald-300 font-semibold">"Webhook qur"</span> düyməsini sıxın (avtomatik qurar).
                      </div>
                    ) : !webhookAppSub.matches ? (
                      <div className="mt-1 text-[10px] text-amber-300 break-all">
                        Tətbiqdəki: {webhookAppSub.callbackUrl} · Olmalı: {webhookAppSub.expectedUrl} — <span className="text-emerald-300 font-semibold">"Webhook qur"</span> sıxın.
                      </div>
                    ) : !hasMsg ? (
                      <div className="mt-1 text-[10px] text-amber-300">
                        Callback var amma <b>messages</b> alanı abunə deyil → mesaj gəlmir. <span className="text-emerald-300 font-semibold">"Webhook qur"</span> düyməsini sıxın.
                      </div>
                    ) : (
                      <div className="mt-1 text-[10px] text-slate-500">
                        {(webhookAppSub.objects || []).map((o: any) => `${o.object}: ${(o.fields || []).join(',') || '-'}`).join(' · ') || '—'}
                      </div>
                    )}
                    {webhookAppSub.error ? <div className="mt-1 text-[10px] text-red-300">err: {String(webhookAppSub.error)}</div> : null}
                  </div>
                  );
                })() : null}

                {webhookCheck.length === 0 ? (
                  <div className="text-slate-500">Həç bir səhifə tapilmadi.</div>
                ) : (
                  <div className="space-y-1">
                    {webhookCheck.map((r: any) => (
                      <div key={String(r.pageId)} className="flex items-start gap-2">
                        <span className={r.subscribed ? 'text-green-400' : 'text-red-400'}>{r.subscribed ? '✓' : '✗'}</span>
                        <div className="min-w-0">
                          <span className="font-semibold text-slate-200">{r.pageName || r.pageId}</span>
                          {r.subscribed ? (
                            <span className="ml-2 text-slate-500">fields: {(r.fields || []).join(', ') || '-'}</span>
                          ) : (
                            <span className="ml-2 text-red-400">{r.error || 'abunəlik yoxdur'}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[10px] text-slate-600">
                  {'✓ = webhook abunəliyi var (messages gəlir); ✗ = yoxdur (BellRing düyməsini sıx).'}
                </div>
              </div>
            ) : null}

            {metaConfig && (!metaConfig.hasAppSecret || !metaConfig.hasVerifyToken || !metaConfig.hasAppId) ? (
              <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-[11px] text-amber-300">
                Tətbiq məlumatları natamam: {!metaConfig.hasAppId ? 'App ID ' : ''}{!metaConfig.hasAppSecret ? 'App Secret ' : ''}{!metaConfig.hasVerifyToken ? 'Verify Token' : ''} (aşağıdakı formada doldurun)
              </div>
            ) : null}

            <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400 space-y-2">
              <div className="text-slate-200 font-semibold">Tam quraşdırma (addım-addım)</div>

              {/* A. Tətbiq yarat */}
              <div>
                <div className="text-[10px] uppercase font-bold text-blue-300/80">A · Tətbiq yarat</div>
                <div className="mt-0.5">1) <span className="text-slate-200">developers.facebook.com</span> → My Apps → <span className="text-slate-200 font-semibold">Create App</span>.</div>
                <div>2) Use case: <span className="text-slate-200 font-semibold">Other</span> seçin (ən altda, "going away soon" yazsa da işləyir) → Next. <span className="text-slate-500">(Yoxdursa: "Authenticate and request data... Facebook Login")</span></div>
                <div>3) App type: <span className="text-slate-200 font-semibold">Business</span> → Next.</div>
                <div>4) Tətbiq adı + email → <span className="text-slate-200 font-semibold">Create app</span>.</div>
              </div>

              {/* B. App ID / Secret / Domain */}
              <div>
                <div className="text-[10px] uppercase font-bold text-blue-300/80">B · App ID / Secret / Domain</div>
                <div className="mt-0.5">5) Sol menyu: <span className="text-slate-200 font-semibold">App settings → Basic</span>.</div>
                <div>6) <span className="text-slate-200 font-semibold">App ID</span> və <span className="text-slate-200 font-semibold">App Secret</span> (Show) → aşağıdakı formaya köçürün.</div>
                <div className="break-all">7) <span className="text-slate-200 font-semibold">App domains</span> sahəsinə: <span className="text-slate-200 font-semibold">{appDomain}</span>
                  <CopyChip value={appDomain} onCopy={copyText} /> → <span className="text-slate-200 font-semibold">Save changes</span>.
                </div>
              </div>

              {/* C. Facebook Login */}
              <div>
                <div className="text-[10px] uppercase font-bold text-blue-300/80">C · Facebook Login</div>
                <div className="mt-0.5">8) <span className="text-slate-200 font-semibold">Products → + Add product → Facebook Login → Set up</span> (Web).</div>
                <div className="break-all">9) <span className="text-slate-200 font-semibold">Facebook Login → Settings → Valid OAuth Redirect URIs</span>: <span className="text-slate-200 font-semibold">{oauthRedirectUri}</span>
                  <CopyChip value={oauthRedirectUri} onCopy={copyText} /> → Save.
                </div>
              </div>

              {/* D. Messenger + Instagram webhooks */}
              <div>
                <div className="text-[10px] uppercase font-bold text-blue-300/80">D · Webhooks (Messenger + Instagram)</div>
                <div className="mt-0.5">10) <span className="text-slate-200 font-semibold">Products → + Add product → Messenger</span> (və varsa <span className="text-slate-200 font-semibold">Instagram</span>).</div>
                <div className="break-all">11) Webhooks → Callback URL: <span className="text-slate-200 font-semibold">{callbackUrl}</span>
                  <CopyChip value={callbackUrl} onCopy={copyText} />, Verify Token: <span className="text-slate-200 font-semibold">(formada yazdığınız)</span> → Verify and Save.
                </div>
                <div>12) Subscribe fields — Page: <span className="text-slate-200 font-semibold">messages, messaging_postbacks, feed</span>; Instagram: <span className="text-slate-200 font-semibold">messages, comments</span>. <span className="text-slate-500">(feed/comments = yorumlar)</span></div>
              </div>

              {/* E. İcazələr */}
              <div>
                <div className="text-[10px] uppercase font-bold text-blue-300/80">E · İcazələr (Permissions)</div>
                <div className="mt-0.5 break-words">13) App Review → Permissions: <span className="text-slate-200">pages_show_list, pages_messaging, pages_read_engagement, pages_manage_metadata, pages_read_user_content, instagram_basic, instagram_manage_messages, instagram_manage_comments, business_management</span>.</div>
              </div>

              {/* F. CRM-də bağla */}
              <div>
                <div className="text-[10px] uppercase font-bold text-blue-300/80">F · CRM-də bağla</div>
                <div className="mt-0.5">14) Aşağıdakı formada <span className="text-slate-200 font-semibold">App ID + App Secret + Verify Token</span> yadda saxlayın.</div>
                <div>15) <span className="text-slate-200 font-semibold">Facebook ilə Bağlan</span> → icazə ver → səhifələri seç → <span className="text-slate-200 font-semibold">Seçilənləri Qoş</span>.</div>
              </div>

              <div className="text-slate-500 pt-1 border-t border-slate-800/60">
                Qeyd: <span className="text-slate-300">Development</span> modda yalnız tətbiqin admin/tester istifadəçiləri girə bilər. Başqaları üçün tətbiqi <span className="text-slate-300">Live</span> edib App Review-dan keçirin.
                {' '}Qayda: Webhook <span className="text-slate-200 font-semibold">ok</span> artmadan trigger işləməyəcək.
              </div>
            </div>

            {metaPages.some(p => !p.ig_business_id) ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400">
                IG üçün: Saved Pages sətrində <span className="text-slate-200 font-semibold">ig:</span> görmürsənsə, Instagram hesabı Facebook səhifəsinə bağlı deyil.
              </div>
            ) : null}

            {metaPages.length > 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">Saved Pages ({metaPages.length})</div>
                <div className="space-y-2 max-h-64 overflow-auto pr-1">
                  {metaPages.map((p) => (
                    <div key={p.page_id} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] text-slate-200 font-semibold truncate">{p.page_name || p.page_id}</div>
                          <div className="text-[10px] text-slate-600 truncate">page_id: {p.page_id}{p.ig_business_id ? ` · ig: ${p.ig_business_id}` : ''}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => subscribePage(p.page_id)}
                            disabled={subscribingId === p.page_id || metaBusy}
                            className="p-2 rounded-lg text-slate-500 hover:text-blue-300 hover:bg-slate-900 border border-slate-800 disabled:opacity-50"
                            title="Səhifəni webhook-a abunə et"
                          >
                            <BellRing className={cn('w-4 h-4', subscribingId === p.page_id && 'animate-pulse text-blue-300')} />
                          </button>
                          <button
                            onClick={() => disconnectPage(p.page_id)}
                            disabled={metaBusy}
                            className="p-2 rounded-lg text-slate-500 hover:text-red-300 hover:bg-slate-900 border border-slate-800 disabled:opacity-50"
                            title="Disconnect"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {pageSubResult && pageSubResult.pageId === p.page_id ? (
                        <div className={cn('text-[10px] px-1', pageSubResult.ok ? 'text-emerald-300' : 'text-red-300')}>
                          {pageSubResult.ok ? '✓ ' : '✗ '}{pageSubResult.msg}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Per-tenant Facebook app credentials — each business uses its own app. */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase font-bold text-slate-500">Facebook Tətbiq Məlumatları (öz tətbiqiniz)</div>
                <span className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold',
                  appConfig?.configured ? 'bg-emerald-950/30 text-emerald-300 border border-emerald-900/40' : 'bg-amber-950/20 text-amber-300 border border-amber-900/40'
                )}>
                  {appConfig?.configured ? <><CheckCircle2 className="w-3 h-3" /> Hazır</> : <><AlertCircle className="w-3 h-3" /> Tələb olunur</>}
                </span>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">App ID</label>
                <input
                  type="text"
                  value={appIdInput}
                  onChange={(e) => setAppIdInput(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder="məs: 268536394142..."
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">App Secret</label>
                <input
                  type="password"
                  value={appSecretInput}
                  onChange={(e) => setAppSecretInput(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder={appConfig?.hasAppSecret ? 'Saxlanılıb — dəyişmək üçün yenisini yazın' : 'App Secret'}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">Verify Token</label>
                <input
                  type="text"
                  value={appVerifyInput}
                  onChange={(e) => setAppVerifyInput(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder={appConfig?.hasVerifyToken ? 'Saxlanılıb — dəyişmək üçün yenisini yazın' : 'özünüz təyin etdiyiniz gizli söz'}
                />
                <div className="mt-1 text-[10px] text-slate-600">
                  Webhook qurğusunda Meta panelində eyni Verify Token-i yazacaqsınız.
                </div>
              </div>
              <button
                onClick={saveAppConfig}
                disabled={appCfgBusy || (!appIdInput.trim() && !appSecretInput.trim() && !appVerifyInput.trim())}
                className={cn(
                  'w-full py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50',
                  appCfgSavedOk ? 'bg-emerald-600 text-white' : 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200'
                )}
              >
                {appCfgBusy ? '...' : (appCfgSavedOk ? 'Saxlandı' : 'Tətbiq məlumatlarını yadda saxla')}
              </button>
              {appCfgError ? (
                <div className="rounded-lg border border-red-900/40 bg-red-950/15 px-3 py-2 text-[11px] text-red-300">
                  {appCfgError}
                </div>
              ) : null}
              {appCfgSavedOk ? (
                <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/15 px-3 py-2 text-[11px] text-emerald-300">
                  Tətbiq məlumatları yadda saxlanıldı.
                </div>
              ) : null}
            </div>

            {oauthNotice ? (
              <div className={cn(
                'rounded-lg border px-3 py-2 text-[11px] flex items-start gap-2',
                oauthNotice.kind === 'success' ? 'border-emerald-900/40 bg-emerald-950/15 text-emerald-300'
                  : oauthNotice.kind === 'error' ? 'border-red-900/40 bg-red-950/15 text-red-300'
                  : 'border-blue-900/40 bg-blue-950/15 text-blue-300'
              )}>
                {oauthNotice.kind === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  : oauthNotice.kind === 'error' ? <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  : <Info className="w-4 h-4 mt-0.5 shrink-0" />}
                <span>{oauthNotice.text}</span>
              </div>
            ) : null}

            <div>
              <button
                onClick={startOAuth}
                disabled={oauthBusy || metaBusy || (metaConfig != null && metaConfig.oauthConfigured === false)}
                className="w-full h-10 rounded-lg text-sm font-semibold bg-[#1877F2] hover:bg-[#1465d8] text-white transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                <Facebook className="w-4 h-4" />
                {oauthBusy ? 'Yönləndirilir...' : 'Facebook ilə Bağlan'}
              </button>
              {metaConfig && metaConfig.oauthConfigured === false ? (
                <div className="mt-1 text-[10px] text-amber-400">
                  Əvvəlcə yuxarıda App ID + App Secret yadda saxlayın.
                </div>
              ) : (
                <div className="mt-1 text-[10px] text-slate-600">
                  {'Facebook icazə pəncərəsinə yönlənəcəksiniz. Qayıdışda səhifələri seçib qoşacaqsınız.'}
                </div>
              )}
            </div>

            {pendingActive ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Səhifə seçimi ({pendingPages.length})</div>
                  <div className="flex items-center gap-1">
                    {pendingPages.length > 0 ? (
                      <button
                        onClick={() => {
                          const all = pendingPages.filter(p => p.hasToken).map(d => d.pageId);
                          setSelectedPageIds(selectedPageIds.length === all.length ? [] : all);
                        }}
                        className="px-2 py-1 rounded text-[10px] font-bold border border-slate-700 text-slate-400 hover:bg-slate-800"
                      >
                        {selectedPageIds.length === pendingPages.filter(p => p.hasToken).length ? 'Heçbirini seçmə' : 'Hamısını seç'}
                      </button>
                    ) : null}
                    <button
                      onClick={cancelOAuth}
                      disabled={oauthBusy}
                      className="px-2 py-1 rounded text-[10px] font-bold border border-red-900/40 bg-red-950/10 text-red-300 hover:bg-red-950/20 disabled:opacity-50"
                      title="Pending OAuth sessiyasını ləğv et (qoşulu səhifələrə toxunmur)"
                    >
                      Ləğv et
                    </button>
                  </div>
                </div>
                {pendingPages.length === 0 ? (
                  <div className="text-[11px] text-slate-500">
                    Səhifə tapılmadı. Facebook hesabınızda idarə etdiyiniz Page olmalıdır, yoxsa token vaxtı keçib — yenidən bağlanın.
                  </div>
                ) : (
                  <div className="space-y-1 max-h-60 overflow-auto pr-1">
                    {pendingPages.map((p) => {
                      const checked = selectedPageIds.includes(p.pageId);
                      const alreadyConnected = metaPages.some(mp => String(mp.page_id) === String(p.pageId));
                      const disabled = !p.hasToken;
                      return (
                        <button
                          key={p.pageId}
                          disabled={disabled}
                          onClick={() => setSelectedPageIds(prev => checked ? prev.filter(x => x !== p.pageId) : [...prev, p.pageId])}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors',
                            checked ? 'border-blue-700/50 bg-blue-950/20' : 'border-slate-800 hover:bg-slate-900/40',
                            disabled && 'opacity-50 cursor-not-allowed'
                          )}
                        >
                          <div className={cn('w-4 h-4 rounded border flex items-center justify-center shrink-0', checked ? 'border-blue-500 bg-blue-600' : 'border-slate-600')}>
                            {checked ? <span className="text-white text-[10px] font-bold">✓</span> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-semibold text-slate-200 truncate">{p.pageName || p.pageId}</div>
                            <div className="text-[10px] text-slate-600 truncate">
                              {p.pageId}{p.igBusinessId ? ` · ig: ${p.igUsername ? `@${p.igUsername}` : p.igBusinessId}` : ''}
                            </div>
                          </div>
                          {!p.hasToken ? <span className="text-[10px] text-amber-400 font-bold shrink-0">token yox</span>
                            : alreadyConnected ? <span className="text-[10px] text-green-400 font-bold shrink-0">bağlı</span> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
                {pendingPages.length > 0 ? (
                  <button
                    onClick={selectPages}
                    disabled={metaBusy || selectedPageIds.length === 0}
                    className="mt-3 w-full py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                  >
                    {metaBusy ? 'Qoşulur...' : `Seçilənləri Qoş (${selectedPageIds.length})`}
                  </button>
                ) : null}
              </div>
            ) : null}

            {Array.isArray(lastConnectReport) && lastConnectReport.length > 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">Subscribe nəticəsi</div>
                <div className="space-y-2">
                  {lastConnectReport.slice(0, 8).map((r: any) => (
                    <div key={String(r?.pageId)} className="text-[11px] text-slate-300">
                      <span className="font-semibold">{String(r?.pageId)}</span>
                      <span className="text-slate-500"> · page: </span>
                      <span className={r?.result?.page?.ok ? 'text-green-300' : 'text-red-300'}>
                        {r?.result?.page?.ok ? 'ok' : (r?.result?.page?.error || 'fail')}
                      </span>
                      {r?.igBusinessId ? (
                        <>
                          <span className="text-slate-500"> · ig: </span>
                          <span className={r?.result?.instagram?.ok ? 'text-green-300' : 'text-red-300'}>
                            {r?.result?.instagram?.ok ? 'ok' : (r?.result?.instagram?.error || 'fail')}
                          </span>
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </SettingsMain>

      <SettingsAside>
        <HelpCallout title="Sürətli kömək">
          <p>Bağlantı yoxdursa: əvvəlcə <strong>QR</strong> ilə cihazı bağlayın.</p>
          <p>Socket tez-tez qırılırsa: <strong>Socket Yenilə</strong> edin və səhifəni refresh edin.</p>
          <p>Online görünür, amma mesaj gəlmirsə: 1 dəfə <strong>QR Yenilə</strong> edin.</p>
        </HelpCallout>
      </SettingsAside>
    </SettingsGrid>
  );
}
