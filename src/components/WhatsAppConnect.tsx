import { useState, useEffect } from 'react';
import QRCode from 'react-qr-code';
import { Smartphone, X, Server, Wifi, WifiOff, RefreshCw, PlayCircle } from 'lucide-react';
import { Card, CardContent } from './ui/Card';
import { Input } from './ui/Input';
import { cn } from '../lib/utils';
import { CrmService } from '../services/CrmService';

interface WhatsAppConnectProps {
  isConnected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function WhatsAppConnect({ isConnected, onConnect, onDisconnect }: WhatsAppConnectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState(import.meta.env.PROD ? window.location.origin : 'http://localhost:4000');
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline' | 'demo'>('offline');
  const [qrCode, setQrCode] = useState<string>('');

  // Auto-connect in production
  useEffect(() => {
    if (import.meta.env.PROD && !isConnected) {
      checkServer(window.location.origin);
    }
  }, []);

  // Check Server Status
  const checkServer = async (url: string = serverUrl) => {
    setServerStatus('checking');
    setQrCode(''); // Reset QR code

    try {
      console.log('🔌 Attempting to connect to:', url);
      const isOnline = await CrmService.connectToServer(url);
      setServerStatus(url === 'demo' ? 'demo' : (isOnline ? 'online' : 'offline'));

      if (isOnline) {
        console.log('✅ Server connection successful!');
        // Start listening for QR
        CrmService.onQrCode((qr) => {
          console.log('📱 QR Code received!');
          setQrCode(qr);
        });
        CrmService.onAuthenticated(() => {
          console.log('✅ WhatsApp authenticated!');
          onConnect();
          setIsOpen(false);
          setQrCode('');
        });
      } else {
        console.error('❌ Server connection failed');
      }
    } catch (e) {
      console.error('❌ Connection error:', e);
      setServerStatus('offline');
    }
  };

  const handleDisconnect = () => {
    console.log('🔌 Disconnecting from WhatsApp...');
    CrmService.disconnect();
    onDisconnect();
    setServerStatus('offline');
    setQrCode('');
  };

  useEffect(() => {
    if (isOpen && !isConnected) {
      // Don't auto-check on open if we are just looking
    }
  }, [isOpen]);

  if (isConnected) {
    return (
      <div className={cn("flex items-center gap-2 sm:gap-3 border px-3 sm:px-4 py-2 rounded-lg animate-in fade-in",
        serverStatus === 'demo' ? "bg-blue-950/30 border-blue-900/50" : "bg-green-950/30 border-green-900/50")}>
        <div className="relative">
          <Smartphone className={cn("w-4 h-4 sm:w-5 sm:h-5", serverStatus === 'demo' ? "text-blue-400" : "text-green-400")} />
          <div className={cn("absolute -top-1 -right-1 w-2 h-2 rounded-full animate-pulse", serverStatus === 'demo' ? "bg-blue-500" : "bg-green-500")} />
        </div>
        <div className="flex flex-col">
          <span className={cn("text-[10px] sm:text-xs font-bold", serverStatus === 'demo' ? "text-blue-400" : "text-green-400")}>
            {serverStatus === 'demo' ? "Demo Mode" : "WhatsApp Active"}
          </span>
          <span className={cn("text-[8px] sm:text-[10px] hidden sm:block", serverStatus === 'demo' ? "text-blue-500/70" : "text-green-500/70")}>
            {serverStatus === 'demo' ? "Simulating..." : "Receiving messages"}
          </span>
        </div>
        <button
          onClick={handleDisconnect}
          className="ml-1 sm:ml-2 text-[10px] text-slate-500 hover:text-red-400 underline decoration-dotted"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="relative group">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all shadow-sm",
          isOpen ? "bg-slate-900 text-slate-400" : "bg-slate-800 hover:bg-slate-700 text-white"
        )}
      >
        <Server className="w-4 h-4" />
        <span className="hidden sm:inline">{isOpen ? 'Close Setup' : 'Connect Server'}</span>
        <span className="sm:hidden">{isOpen ? 'Close' : 'Setup'}</span>
      </button>

      {/* Connection Popup — fullscreen on mobile, absolute on desktop */}
      {isOpen && (
        <>
          {/* Mobile: full-screen overlay */}
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm sm:hidden" onClick={() => setIsOpen(false)} />
          <div className={cn(
            "z-50 animate-in fade-in zoom-in-95 duration-200",
            // Mobile: fixed position, full-width with padding
            // Desktop: fixed position to viewport top-right to prevent horizontal page overflow
            "fixed inset-x-3 top-16 sm:top-20 sm:right-6 sm:left-auto sm:w-96 sm:w-[400px]"
          )}>
            <Card className="bg-white text-slate-900 border-slate-200 shadow-2xl overflow-hidden max-h-[calc(100vh-100px)] overflow-y-auto">
              <div className="p-3 border-b border-slate-100 flex justify-between items-center bg-slate-50 sticky top-0 z-10">
                <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-slate-600" />
                  Connect Backend
                </h3>
                <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-slate-600 p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <CardContent className="p-4 sm:p-6 flex flex-col space-y-4 sm:space-y-6">

                {/* Demo Mode Option */}
                <div className="bg-blue-50 p-3 rounded-lg border border-blue-100">
                  <h4 className="text-xs font-bold text-blue-800 mb-1 flex items-center gap-2">
                    <PlayCircle className="w-3 h-3" /> No Server? Try Demo Mode
                  </h4>
                  <p className="text-[10px] text-blue-600 mb-3">
                    Simulate a connection to see how the CRM works. We'll generate fake incoming messages for you.
                  </p>
                  <button
                    onClick={() => checkServer('demo')}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded transition-colors"
                  >
                    Start Demo Simulation
                  </button>
                </div>

                <div className="relative flex items-center justify-center">
                  <div className="border-t border-slate-200 w-full absolute"></div>
                  <span className="bg-white px-2 text-[10px] text-slate-400 relative uppercase font-medium">OR Connect Real Server</span>
                </div>

                {/* Real Server URL Input */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-[10px] font-bold uppercase text-slate-500">Server URL</label>
                    <span className={cn("text-[10px] flex items-center gap-1",
                      serverStatus === 'online' ? "text-green-600" :
                        serverStatus === 'checking' ? "text-yellow-600" : "text-red-600")}>
                      {serverStatus === 'online' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                      {serverStatus === 'online' ? "ONLINE" : serverStatus === 'checking' ? "CHECKING" : "OFFLINE"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      className="h-10 text-xs bg-slate-100 border-slate-200 text-slate-900 flex-1 min-w-0"
                      placeholder="http://localhost:4000"
                    />
                    <button onClick={() => checkServer(serverUrl)} className="px-3 bg-slate-200 rounded hover:bg-slate-300 text-slate-600 shrink-0">
                      <RefreshCw className={cn("w-4 h-4", serverStatus === 'checking' && "animate-spin")} />
                    </button>
                  </div>
                </div>

                {/* QR Code Area */}
                <div className="flex flex-col items-center justify-center p-4 bg-slate-100 rounded-lg min-h-[180px]">
                  {serverStatus === 'online' || serverStatus === 'demo' ? (
                    qrCode ? (
                      <div className="bg-white p-3 rounded shadow-sm">
                        <QRCode value={qrCode} size={180} />
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-slate-500">
                        <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
                        <span className="text-xs">Generating QR Code...</span>
                        <span className="text-[10px] text-slate-400">This may take up to 30s on free hosting</span>
                      </div>
                    )
                  ) : (
                    <div className="text-center space-y-2">
                      <p className="text-xs text-slate-500 font-medium">Server Not Detected</p>
                      <div className="text-[10px] text-slate-400 leading-tight text-left bg-slate-50 p-3 rounded border border-slate-200">
                        <p className="font-bold mb-1">Connection Tip:</p>
                        <p>Press the <span className="font-mono bg-slate-200 px-1 rounded">↻</span> button to connect.</p>
                      </div>
                    </div>
                  )}
                </div>

                {(serverStatus === 'online' || serverStatus === 'demo') && (
                  <p className="text-[10px] text-center text-green-600 font-medium">
                    {serverStatus === 'demo' ? "Demo Mode: Waiting for fake authentication..." : "Scan this QR with WhatsApp (Linked Devices)"}
                  </p>
                )}

              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
