import React, { useEffect, useState } from 'react';
import QRCode from 'react-qr-code';
import { RefreshCcw, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAppStore } from '../../../context/Store';
import { CrmService } from '../../../services/CrmService';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { HelpCallout } from '../HelpCallout';
import { SettingsAside, SettingsGrid, SettingsMain } from '../SettingsLayout';
import { SettingsSectionHeader } from '../SettingsSectionHeader';

export function ConnectionTab() {
  const { isWhatsAppConnected } = useAppStore();
  const [health, setHealth] = useState<any | null>(null);
  const [qr, setQr] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const refreshHealth = async () => {
    const h = await CrmService.fetchHealth();
    if (h) setHealth(h);
  };

  useEffect(() => {
    const cleanupHealth = CrmService.onHealthCheck((h: any) => setHealth(h));
    const cleanupQr = CrmService.onQrCode((q: string) => setQr(q));
    const cleanupAuth = CrmService.onAuthenticated(() => {
      setQr('');
      refreshHealth();
    });
    refreshHealth();

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
