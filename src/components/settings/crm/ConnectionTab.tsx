import React, { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { RefreshCcw, Smartphone, Wifi, WifiOff, Link2, CheckSquare, Square, Trash2, BellRing, Send } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAppStore } from '../../../context/Store';
import { CrmService } from '../../../services/CrmService';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

type MetaPage = {
  page_id: string;
  page_name?: string | null;
  ig_business_id?: string | null;
  connected_at?: string;
  updated_at?: string;
};

type DiscoveredPage = {
  pageId: string;
  pageName: string | null;
  pageAccessToken: string | null;
  igBusinessId: string | null;
  igUsername: string | null;
};

export function ConnectionTab() {
  const { isWhatsAppConnected } = useAppStore();
  const [health, setHealth] = useState<any | null>(null);
  const [qr, setQr] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const [tgConfig, setTgConfig] = useState<any | null>(null);
  const [tgEnabled, setTgEnabled] = useState(true);
  const [tgChatId, setTgChatId] = useState('');
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgClearToken, setTgClearToken] = useState(false);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgError, setTgError] = useState('');
  const [tgSavedOk, setTgSavedOk] = useState(false);

  const [metaPages, setMetaPages] = useState<MetaPage[]>([]);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState('');

  const [userToken, setUserToken] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredPage[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);

  const [webhookStats, setWebhookStats] = useState<any | null>(null);
  const [lastConnectReport, setLastConnectReport] = useState<any | null>(null);
  const [metaConfig, setMetaConfig] = useState<any | null>(null);

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
      const res = await fetch(`${url}/api/telegram/test`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
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

  const webhookHelp = (err: any) => {
    const e = String(err || '').toLowerCase();
    if (!e) return '';
    if (e.includes('meta_app_secret missing')) return 'Server env-də META_APP_SECRET yoxdur (Render → Environment).';
    if (e.includes('signature_mismatch')) return 'META_APP_SECRET yanlışdır (Meta App Secret ilə eyni olmalıdır).';
    if (e.includes('handler_error')) return 'Server webhook payload-ı parse edə bilmədi (logs-a baxın).';
    return '';
  };

  const discoverPages = async () => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;
      const res = await fetch(`${url}/api/meta/discover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ token: userToken })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Discover failed');

      const pages: DiscoveredPage[] = Array.isArray(data?.pages) ? data.pages : [];
      setDiscovered(pages);

      const connected = new Set((metaPages || []).map(p => String(p.page_id)));
      const defaults = pages
        .map(p => p.pageId)
        .filter(pid => pid && !connected.has(pid));
      setSelectedPageIds(defaults);
    } catch (e: any) {
      setMetaError(e?.message || 'Səhifələr alınmadı');
    } finally {
      setMetaBusy(false);
    }
  };

  const connectSelected = async () => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;

      const res = await fetch(`${url}/api/meta/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ token: userToken, pageIds: selectedPageIds })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Connect failed');

      setLastConnectReport(data?.subscribe || null);

      setUserToken('');
      setDiscovered([]);
      setSelectedPageIds([]);
      await refreshMeta();
      await refreshWebhookStats();
      await refreshMetaConfig();
    } catch (e: any) {
      setMetaError(e?.message || 'Qoşulma alınmadı');
    } finally {
      setMetaBusy(false);
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
    setMetaBusy(true);
    setMetaError('');
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
      await refreshMeta();
    } catch (e: any) {
      setMetaError(e?.message || 'Webhook subscribe alınmadı');
    } finally {
      setMetaBusy(false);
    }
  };

  useEffect(() => {
    const cleanupHealth = CrmService.onHealthCheck((h: any) => setHealth(h));
    const cleanupQr = CrmService.onQrCode((q: string) => setQr(q));
    const cleanupAuth = CrmService.onAuthenticated(() => {
      setQr('');
      refreshHealth();
    });
    refreshHealth();
    refreshTelegram();
    refreshMeta();
    refreshWebhookStats();
    refreshMetaConfig();

    return () => {
      cleanupHealth();
      cleanupQr();
      cleanupAuth();
    };
  }, []);

  const handleQrRefresh = async () => {
    setBusy(true);
    setQr('');
    try {
      await CrmService.startWhatsApp();
      await refreshHealth();
    } finally {
      setBusy(false);
    }
  };

  const handleReconnect = async () => {
    setBusy(true);
    setQr('');
    try {
      await CrmService.reconnect();
      await CrmService.startWhatsApp();
      await refreshHealth();
    } finally {
      setBusy(false);
    }
  };

  const info = CrmService.getConnectionInfo();
  const waStatus = health?.whatsapp || (isWhatsAppConnected ? 'CONNECTED' : 'OFFLINE');
  const waOk = waStatus === 'CONNECTED';

  const callbackPath = metaConfig?.callbackPath || '/api/webhooks/meta';
  const callbackUrl = info?.serverUrl ? `${String(info.serverUrl).replace(/\/$/, '')}${callbackPath}` : callbackPath;

  return (
    <SettingsGrid>
      <SettingsMain>
        <SettingsSectionHeader
          title="WhatsApp Bağlantısı"
          description="QR, Socket və sistem statusunu buradan idarə edin."
          actions={
            <>
              <button
                onClick={handleQrRefresh}
                disabled={busy}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors disabled:opacity-50 inline-flex items-center gap-2"
              >
                <RefreshCcw className={cn('w-4 h-4', busy && 'animate-spin')} />
                QR Yenilə
              </button>
              <button
                onClick={handleReconnect}
                disabled={busy}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 border border-blue-500/30 text-white transition-colors disabled:opacity-50 inline-flex items-center gap-2"
              >
                <RefreshCcw className={cn('w-4 h-4', busy && 'animate-spin')} />
                Socket Yenilə
              </button>
            </>
          }
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card className={cn('border-slate-800', waOk ? 'bg-emerald-950/10' : 'bg-slate-950/40')}>
            <CardHeader className="p-4">
              <CardTitle className="text-xs text-slate-200 flex items-center gap-2">
                <Smartphone className={cn('w-4 h-4', waOk ? 'text-emerald-400' : 'text-slate-400')} />
                WhatsApp
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="flex items-center gap-2">
                <span className={cn('w-2 h-2 rounded-full', waOk ? 'bg-emerald-500' : waStatus === 'SYNCING' ? 'bg-yellow-500' : 'bg-rose-500')} />
                <p className={cn('text-xs font-bold', waOk ? 'text-emerald-300' : waStatus === 'SYNCING' ? 'text-yellow-300' : 'text-rose-300')}>
                  {waStatus}
                </p>
              </div>
              {health?.connectedNumber ? (
                <p className="mt-2 text-[11px] text-slate-400 truncate">{health.connectedNumber}</p>
              ) : null}
              {health?.timestamp ? (
                <p className="mt-1 text-[10px] text-slate-500 truncate">Son yoxlama: {new Date(health.timestamp).toLocaleString()}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-slate-800 bg-slate-950/40">
            <CardHeader className="p-4">
              <CardTitle className="text-xs text-slate-200 flex items-center gap-2">
                {info.socketConnected ? <Wifi className="w-4 h-4 text-blue-400" /> : <WifiOff className="w-4 h-4 text-slate-500" />}
                Socket
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
        </div>

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

            <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2">
              <div className="text-[11px] text-slate-400">
                Status: <span className={cn('font-semibold', tgEnabled ? 'text-emerald-300' : 'text-slate-500')}>{tgEnabled ? 'ENABLED' : 'DISABLED'}</span>
                {tgConfig?.has_bot_token ? <span className="text-slate-600"> · token: ok</span> : <span className="text-slate-600"> · token: yok</span>}
                {tgConfig?.last_error ? <span className="text-red-300"> · err: {String(tgConfig.last_error)}</span> : null}
              </div>
              <button
                onClick={() => setTgEnabled(v => !v)}
                disabled={tgBusy}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-colors disabled:opacity-50',
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

        {!waOk ? (
          <Card className="border-slate-800 bg-slate-950/30">
            <CardHeader className="p-4">
              <CardTitle className="text-xs text-slate-200 flex items-center justify-between">
                <span>QR Kod</span>
                <span className="text-[10px] text-slate-500">WhatsApp - Linked devices</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="mt-1 flex items-center justify-center min-h-[240px] rounded-lg bg-slate-900/40 border border-slate-800">
                {qr ? (
                  <div className="bg-white rounded-lg p-3 shadow-sm">
                    <QRCode value={qr} size={190} />
                  </div>
                ) : (
                  <div className="text-center text-slate-500">
                    <div className={cn('mx-auto w-6 h-6 border-2 border-slate-600 border-t-transparent rounded-full', busy && 'animate-spin')} />
                    <p className="mt-2 text-xs">QR gozlenilir...</p>
                    <p className="mt-1 text-[10px]">QR Yenile duymesini basin</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ) : null}

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
              <button
                onClick={refreshWebhookStats}
                disabled={metaBusy}
                className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-900 disabled:opacity-50"
              >
                {metaBusy ? '...' : 'Yoxla'}
              </button>
            </div>

            {webhookStats?.last_error ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400">
                <span className="text-slate-200 font-semibold">Diaqnoz:</span>{' '}
                {webhookHelp(webhookStats.last_error) || 'Meta Developer → Webhooks → Delivery log-a baxın (status code görsənəcək).'}
              </div>
            ) : null}

            {metaConfig && (!metaConfig.hasAppSecret || !metaConfig.hasVerifyToken || !metaConfig.hasAppId) ? (
              <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-[11px] text-amber-300">
                Meta env eksik: {!metaConfig.hasAppSecret ? 'META_APP_SECRET ' : ''}{!metaConfig.hasVerifyToken ? 'META_VERIFY_TOKEN ' : ''}{!metaConfig.hasAppId ? 'META_APP_ID' : ''}
              </div>
            ) : null}

            <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400">
              <div className="text-slate-200 font-semibold">Sıfırdan quraşdırma (qısa)</div>
              <div className="mt-1">
                1) Render → Environment: <span className="text-slate-200 font-semibold">META_APP_SECRET</span>, <span className="text-slate-200 font-semibold">META_VERIFY_TOKEN</span>, (opsional) <span className="text-slate-200 font-semibold">META_APP_ID</span> əlavə et → deploy/restart.
              </div>
              <div className="mt-1">
                2) Meta Developers → Webhooks: Callback URL = <span className="text-slate-200 font-semibold break-all">{callbackUrl}</span> → Verify Token = META_VERIFY_TOKEN → “Verify and Save”.
              </div>
              <div className="mt-1">
                3) Burada token yaz → “Səhifələri gətir” → seç → “Qoş” → “zil” (subscribe) bas.
              </div>
              <div className="mt-1 text-slate-500">
                Qayda: Webhook <span className="text-slate-200 font-semibold">ok</span> artmadan trigger işləməyəcək.
              </div>
            </div>

            {metaPages.some(p => !p.ig_business_id) ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 px-3 py-2 text-[11px] text-slate-400">
                IG ucu n: Saved Pages setrinde <span className="text-slate-200 font-semibold">ig:</span> gormursense, Instagram hesab Facebook Page-e bagli deyil.
              </div>
            ) : null}

            {metaPages.length > 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">Saved Pages</div>
                <div className="space-y-2">
                  {metaPages.slice(0, 5).map((p) => (
                    <div key={p.page_id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] text-slate-200 font-semibold truncate">{p.page_name || p.page_id}</div>
                        <div className="text-[10px] text-slate-600 truncate">page_id: {p.page_id}{p.ig_business_id ? ` · ig: ${p.ig_business_id}` : ''}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => subscribePage(p.page_id)}
                          disabled={metaBusy}
                          className="p-2 rounded-lg text-slate-500 hover:text-blue-300 hover:bg-slate-900 border border-slate-800 disabled:opacity-50"
                          title="Webhook subscribe"
                        >
                          <BellRing className="w-4 h-4" />
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
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">User Access Token</label>
              <input
                type="password"
                value={userToken}
                onChange={(e) => setUserToken(e.target.value)}
                className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                placeholder="EAAG..."
              />
              <div className="mt-1 text-[10px] text-slate-600">
                Token yaz → hesaba aid Page/IG siyahisi gelecek → secib qos.
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={discoverPages}
                disabled={metaBusy || !userToken.trim()}
                className="flex-1 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors disabled:opacity-50"
              >
                {metaBusy ? '...' : 'Səhifələri gətir'}
              </button>
              <button
                onClick={() => {
                  setDiscovered([]);
                  setSelectedPageIds([]);
                }}
                disabled={metaBusy || discovered.length === 0}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-transparent hover:bg-slate-900 border border-slate-800 text-slate-300 transition-colors disabled:opacity-50"
              >
                Təmizlə
              </button>
            </div>

            {discovered.length > 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Tapılan səhifələr</div>
                  <button
                    onClick={() => {
                      const all = discovered.map(d => d.pageId).filter(Boolean);
                      const allSelected = selectedPageIds.length === all.length;
                      setSelectedPageIds(allSelected ? [] : all);
                    }}
                    className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-900"
                  >
                    hamısı
                  </button>
                </div>

                <div className="space-y-2 max-h-48 overflow-auto pr-1 custom-scrollbar">
                  {discovered.map((p) => {
                    const checked = selectedPageIds.includes(p.pageId);
                    const already = (metaPages || []).some(mp => String(mp.page_id) === String(p.pageId));
                    return (
                      <button
                        key={p.pageId}
                        onClick={() => {
                          if (checked) setSelectedPageIds(prev => prev.filter(x => x !== p.pageId));
                          else setSelectedPageIds(prev => [...prev, p.pageId]);
                        }}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-800 hover:bg-slate-900/40 text-left"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          {checked ? <CheckSquare className="w-4 h-4 text-blue-400" /> : <Square className="w-4 h-4 text-slate-600" />}
                          <span className="min-w-0">
                            <span className="block text-[12px] font-semibold text-slate-200 truncate">
                              {p.pageName || p.pageId}
                            </span>
                            <span className="block text-[10px] text-slate-600 truncate">
                              page: {p.pageId}{p.igBusinessId ? ` · ig: ${p.igBusinessId}${p.igUsername ? ` (@${p.igUsername})` : ''}` : ''}
                            </span>
                          </span>
                        </span>
                        <span className={already ? 'text-[10px] font-bold text-green-300' : 'text-[10px] font-bold text-slate-500'}>
                          {already ? 'connected' : 'new'}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={connectSelected}
                  disabled={metaBusy || !userToken.trim() || selectedPageIds.length === 0}
                  className="mt-3 w-full py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                >
                  {metaBusy ? 'Qoşulur...' : `Seçilənləri qoş (${selectedPageIds.length})`}
                </button>
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
