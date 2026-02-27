import React, { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { RefreshCcw, Smartphone, Wifi, WifiOff, Link2 } from 'lucide-react';
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

export function ConnectionTab() {
  const { isWhatsAppConnected } = useAppStore();
  const [health, setHealth] = useState<any | null>(null);
  const [qr, setQr] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const [metaPages, setMetaPages] = useState<MetaPage[]>([]);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState('');

  const [pageId, setPageId] = useState('');
  const [pageName, setPageName] = useState('');
  const [pageAccessToken, setPageAccessToken] = useState('');
  const [igBusinessId, setIgBusinessId] = useState('');

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

  const saveMeta = async () => {
    setMetaBusy(true);
    setMetaError('');
    try {
      const url = CrmService.getServerUrl();
      const token = localStorage.getItem('crm_auth_token');
      if (!url || !token) return;

      const res = await fetch(`${url}/api/meta/pages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          pageId,
          pageName,
          pageAccessToken,
          igBusinessId
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Meta save failed');

      setPageAccessToken('');
      await refreshMeta();
    } catch (e: any) {
      setMetaError(e?.message || 'Meta bağlantısı saxlanmadı');
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
    refreshMeta();

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
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">Page ID</label>
                <input
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder="1234567890"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">Page Name</label>
                <input
                  value={pageName}
                  onChange={(e) => setPageName(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder="My Business"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">Page Access Token</label>
                <input
                  type="password"
                  value={pageAccessToken}
                  onChange={(e) => setPageAccessToken(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder="EAAG..."
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 block">IG Business ID (optional)</label>
                <input
                  value={igBusinessId}
                  onChange={(e) => setIgBusinessId(e.target.value)}
                  className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                  placeholder="1784..."
                />
              </div>
            </div>

            <button
              onClick={saveMeta}
              disabled={metaBusy || !pageId.trim() || !pageAccessToken.trim()}
              className="w-full py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors disabled:opacity-50"
            >
              {metaBusy ? 'Saxlanır...' : 'Meta qoş (Token ilə)'}
            </button>
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
