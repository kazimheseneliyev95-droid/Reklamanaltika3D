import { useEffect, useMemo, useState } from 'react';
import QRCode from 'react-qr-code';
import {
  Smartphone,
  Plus,
  RefreshCcw,
  Trash2,
  Star,
  StarOff,
  LogOut,
  AlertCircle,
  CheckCircle2,
  X,
  Loader2,
  Pencil,
  Check,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { CrmService } from '../../../services/CrmService';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/Card';
import { WhatsAppAccount } from '../../../types/crm';

type StatusKey =
  | 'pending'
  | 'qr'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'error';

const STATUS_THEME: Record<
  StatusKey,
  { dot: string; text: string; label: string; bg: string; border: string }
> = {
  pending: {
    dot: 'bg-slate-500',
    text: 'text-slate-300',
    label: 'Hazır deyil',
    bg: 'bg-slate-950/40',
    border: 'border-slate-800',
  },
  qr: {
    dot: 'bg-amber-500 animate-pulse',
    text: 'text-amber-300',
    label: 'QR gözlənilir',
    bg: 'bg-amber-950/15',
    border: 'border-amber-900/40',
  },
  connecting: {
    dot: 'bg-blue-500 animate-pulse',
    text: 'text-blue-300',
    label: 'Bağlanır',
    bg: 'bg-blue-950/15',
    border: 'border-blue-900/40',
  },
  connected: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-300',
    label: 'Bağlıdır',
    bg: 'bg-emerald-950/15',
    border: 'border-emerald-900/40',
  },
  disconnected: {
    dot: 'bg-rose-500',
    text: 'text-rose-300',
    label: 'Kəsildi',
    bg: 'bg-rose-950/15',
    border: 'border-rose-900/40',
  },
  logged_out: {
    dot: 'bg-slate-500',
    text: 'text-slate-400',
    label: 'Çıxış edildi',
    bg: 'bg-slate-950/40',
    border: 'border-slate-800',
  },
  error: {
    dot: 'bg-rose-600',
    text: 'text-rose-300',
    label: 'Xəta',
    bg: 'bg-rose-950/20',
    border: 'border-rose-900/50',
  },
};

function effectiveStatus(account: WhatsAppAccount): StatusKey {
  // Live worker state takes priority over the DB-stored status.
  if (account.live?.isReady) return 'connected';
  if (account.live?.qr) return 'qr';
  const s = String(account.status || 'pending') as StatusKey;
  return STATUS_THEME[s] ? s : 'pending';
}

function formatPhone(phone?: string | null): string {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.length <= 4) return '+' + digits;
  if (digits.length <= 7) return '+' + digits.slice(0, digits.length - 4) + ' ' + digits.slice(-4);
  return '+' + digits.slice(0, digits.length - 7) + ' ' + digits.slice(-7, -4) + ' ' + digits.slice(-4);
}

function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 5) return 'indi';
  if (diff < 60) return diff + 's əvvəl';
  if (diff < 3600) return Math.floor(diff / 60) + ' dəq əvvəl';
  if (diff < 86400) return Math.floor(diff / 3600) + ' saat əvvəl';
  return Math.floor(diff / 86400) + ' gün əvvəl';
}

export function WhatsAppAccountsCard() {
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [limit, setLimit] = useState<number>(1);
  const [used, setUsed] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Per-account QR cache (multi-account aware: account_id → qr string)
  const [qrByAccount, setQrByAccount] = useState<Record<string, string>>({});
  // Account currently showing the QR modal
  const [qrModalAccountId, setQrModalAccountId] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const startRename = (accountId: string, currentLabel: string) => {
    setRenamingId(accountId);
    setRenameDraft(currentLabel || '');
    setError('');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };

  const saveRename = async (accountId: string) => {
    const label = renameDraft.trim();
    if (!label) return;
    setRenameBusy(true);
    setError('');
    try {
      const result = await CrmService.renameWhatsAppAccount(accountId, label);
      if (!result.ok) {
        setError(result.error || 'Ad dəyişdirilə bilmədi');
        return;
      }
      cancelRename();
      await refresh();
    } finally {
      setRenameBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await CrmService.listWhatsAppAccounts();
      setAccounts(data.accounts);
      setLimit(data.limit);
      setUsed(data.used);
    } catch (e: any) {
      setError(e?.message || 'Hesablar oxunmadı');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
    const cleanupQr = CrmService.onQrCode((qr: string, accountId?: string | null) => {
      if (accountId) {
        setQrByAccount((prev) => ({ ...prev, [accountId]: qr }));
        // Auto-open modal when a QR appears for a brand-new account waiting on a scan.
        setQrModalAccountId((prev) => prev || accountId);
      }
    });
    const cleanupStatus = CrmService.onAccountStatus(({ accountId, status }) => {
      if (status === 'connected' && accountId) {
        // Successfully connected — remove the QR and close any open modal.
        setQrByAccount((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        setQrModalAccountId((prev) => (prev === accountId ? null : prev));
      }
      // Refresh the list to pull updated phone_number / status from backend.
      refresh();
    });
    // Periodic poll as a safety net (every 25s)
    const t = setInterval(refresh, 25000);
    return () => {
      cleanupQr();
      cleanupStatus();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setCreating(true);
    setError('');
    try {
      const result = await CrmService.createWhatsAppAccount(label);
      if (!result.account) {
        if (result.error === 'limit_exceeded') {
          setError(`WhatsApp hesab limiti doldu (${result.limit ?? limit}). Yeni hesap əlavə etmək üçün super-admin ilə əlaqə saxlayın.`);
        } else {
          setError(result.error || 'Yaradıla bilmədi');
        }
        return;
      }
      setShowAddModal(false);
      setNewLabel('');
      // The QR will arrive via socket; refresh list immediately so the new card shows up.
      await refresh();
      setQrModalAccountId(result.account.id);
    } finally {
      setCreating(false);
    }
  };

  const handleStart = async (accountId: string) => {
    setBusy(true);
    try {
      await CrmService.startWhatsAppAccount(accountId);
      setQrModalAccountId(accountId);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRestart = async (accountId: string) => {
    setBusy(true);
    try {
      await CrmService.restartWhatsAppAccount(accountId);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async (accountId: string) => {
    setBusy(true);
    try {
      await CrmService.logoutWhatsAppAccount(accountId);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSetDefault = async (accountId: string) => {
    setBusy(true);
    try {
      await CrmService.setDefaultWhatsAppAccount(accountId);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (accountId: string) => {
    setBusy(true);
    setConfirmDelete(null);
    try {
      await CrmService.deleteWhatsAppAccount(accountId);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const limitReached = used >= limit;
  const qrModalAccount = useMemo(
    () => accounts.find((a) => a.id === qrModalAccountId) || null,
    [accounts, qrModalAccountId]
  );
  const qrModalQr = qrModalAccount ? qrByAccount[qrModalAccount.id] || '' : '';

  return (
    <Card className="border-slate-800 bg-slate-950/30">
      <CardHeader className="p-4">
        <CardTitle className="text-xs text-slate-200 flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-emerald-400" />
            WhatsApp Hesabları
          </span>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-extrabold',
                limitReached
                  ? 'border-rose-900/40 bg-rose-950/15 text-rose-300'
                  : 'border-slate-800 bg-slate-950/40 text-slate-300'
              )}
              title="Bu kiracıya icazə verilən maksimum WhatsApp sayı"
            >
              {used} / {limit} hesap
            </span>
            <button
              onClick={refresh}
              disabled={busy}
              className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
            >
              <RefreshCcw className={cn('w-3 h-3', busy && 'animate-spin')} />
              Yenilə
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              disabled={busy || limitReached}
              className="px-3 py-1 rounded-md text-[10px] font-bold bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1 disabled:opacity-40"
              title={limitReached ? 'Limit doldu — super-admin artırmalıdır' : 'Yeni WhatsApp hesabı əlavə et'}
            >
              <Plus className="w-3 h-3" />
              Yeni Hesap
            </button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-3">
        {error ? (
          <div className="rounded-lg border border-rose-900/40 bg-rose-950/15 px-3 py-2 text-[11px] text-rose-300 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {accounts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/20 p-8 text-center">
            <Smartphone className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <p className="text-xs text-slate-400">Hələ bir WhatsApp hesabı əlavə edilməyib.</p>
            <p className="text-[10px] text-slate-600 mt-1">
              "Yeni Hesap" düyməsinə basın və QR ilə bağlayın.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {accounts.map((account) => {
              const status = effectiveStatus(account);
              const theme = STATUS_THEME[status];
              const qr = qrByAccount[account.id];
              const isQrPending = status === 'qr' || (!!qr && status !== 'connected');
              return (
                <div
                  key={account.id}
                  className={cn('rounded-xl border p-3', theme.bg, theme.border)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', theme.dot)} />
                        {renamingId === account.id ? (
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <input
                              type="text"
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveRename(account.id);
                                if (e.key === 'Escape') cancelRename();
                              }}
                              autoFocus
                              maxLength={120}
                              className="flex-1 min-w-0 h-6 rounded-md bg-slate-950 border border-blue-700/50 px-2 text-[12px] font-bold text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              placeholder="Hesab adı..."
                            />
                            <button
                              onClick={() => saveRename(account.id)}
                              disabled={renameBusy || !renameDraft.trim()}
                              className="shrink-0 p-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                              title="Saxla"
                            >
                              {renameBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            </button>
                            <button
                              onClick={cancelRename}
                              disabled={renameBusy}
                              className="shrink-0 p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40"
                              title="İmtina"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="text-[12px] font-extrabold text-slate-100 truncate">
                              {account.label}
                            </div>
                            <button
                              onClick={() => startRename(account.id, account.label)}
                              className="shrink-0 p-0.5 rounded text-slate-500 hover:text-blue-300 hover:bg-slate-800/50"
                              title="Adı dəyişdir"
                            >
                              <Pencil className="w-2.5 h-2.5" />
                            </button>
                            {account.is_default ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-amber-900/40 bg-amber-950/20 text-amber-300 px-1.5 py-0.5 text-[9px] font-extrabold shrink-0"
                                title="Bu hesap varsayılan olaraq giden mesajlar üçün istifadə olunur"
                              >
                                <Star className="w-2.5 h-2.5" />
                                DEFAULT
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                      <p className={cn('mt-1 text-[10px] font-bold', theme.text)}>
                        {theme.label}
                        {account.live?.number ? ` · ${account.live.number}` : ''}
                      </p>
                      <p className="mt-1 text-[10px] text-slate-500 truncate">
                        {formatPhone(account.phone_number || account.live?.number)}
                      </p>
                      {account.last_connected_at ? (
                        <p className="mt-0.5 text-[9px] text-slate-600">
                          Son bağlantı: {timeAgo(account.last_connected_at)}
                        </p>
                      ) : null}
                      {account.last_error ? (
                        <p className="mt-1 text-[10px] text-rose-300 line-clamp-2">{account.last_error}</p>
                      ) : null}
                    </div>
                  </div>

                  {/* Action row */}
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    <button
                      onClick={() => handleStart(account.id)}
                      disabled={busy}
                      className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 bg-slate-900/40 text-slate-200 hover:bg-slate-800 disabled:opacity-40 inline-flex items-center gap-1"
                      title="QR göstər / başlat"
                    >
                      <Smartphone className="w-3 h-3" />
                      QR
                    </button>
                    <button
                      onClick={() => handleRestart(account.id)}
                      disabled={busy}
                      className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 bg-slate-900/40 text-slate-200 hover:bg-slate-800 disabled:opacity-40 inline-flex items-center gap-1"
                      title="Yenidən bağlan"
                    >
                      <RefreshCcw className={cn('w-3 h-3', busy && 'animate-spin')} />
                    </button>
                    {!account.is_default ? (
                      <button
                        onClick={() => handleSetDefault(account.id)}
                        disabled={busy}
                        className="px-2 py-1 rounded-md text-[10px] font-bold border border-amber-900/30 bg-amber-950/15 text-amber-200 hover:bg-amber-950/25 disabled:opacity-40 inline-flex items-center gap-1"
                        title="Varsayılan et"
                      >
                        <StarOff className="w-3 h-3" />
                      </button>
                    ) : null}
                    <button
                      onClick={() => handleLogout(account.id)}
                      disabled={busy}
                      className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-800 bg-slate-900/40 text-slate-300 hover:bg-slate-800 disabled:opacity-40 inline-flex items-center gap-1"
                      title="Çıxış et (auth state-i təmizlə)"
                    >
                      <LogOut className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(account.id)}
                      disabled={busy}
                      className="ml-auto px-2 py-1 rounded-md text-[10px] font-bold border border-rose-900/40 bg-rose-950/15 text-rose-300 hover:bg-rose-950/25 disabled:opacity-40 inline-flex items-center gap-1"
                      title="Hesabı sil (leadlər saxlanır, eyni nömrə yenidən bağlananda bərpa olunur)"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {isQrPending ? (
                    <button
                      onClick={() => setQrModalAccountId(account.id)}
                      className="mt-3 w-full rounded-lg border border-amber-900/40 bg-amber-950/10 px-3 py-2 text-[11px] font-bold text-amber-200 hover:bg-amber-950/20"
                    >
                      📷 QR-i göstər
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* Add account modal */}
        {showAddModal ? (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#0d1117] p-5 shadow-2xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-extrabold text-slate-100">Yeni WhatsApp Hesabı</h3>
                <button
                  onClick={() => {
                    setShowAddModal(false);
                    setNewLabel('');
                  }}
                  className="p-1 rounded-md text-slate-500 hover:text-slate-300"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">
                Hesap adı
              </label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Məs: Satış Hattı"
                className="w-full h-10 rounded-lg bg-slate-950 border border-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/50"
                maxLength={120}
                autoFocus
              />
              <p className="mt-2 text-[10px] text-slate-500">
                Hesab yaradıldıqdan sonra QR kod yaranacaq və telefonunuzla oxutmalısınız.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => {
                    setShowAddModal(false);
                    setNewLabel('');
                  }}
                  disabled={creating}
                  className="flex-1 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 disabled:opacity-50"
                >
                  İmtina
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newLabel.trim()}
                  className="flex-1 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Yarat
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* QR display modal */}
        {qrModalAccount ? (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#0d1117] p-5 shadow-2xl">
              <div className="flex items-center justify-between mb-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-slate-100 truncate">{qrModalAccount.label}</h3>
                  <p className="text-[10px] text-slate-500">WhatsApp → Linked Devices → QR oxudun</p>
                </div>
                <button
                  onClick={() => setQrModalAccountId(null)}
                  className="p-1 rounded-md text-slate-500 hover:text-slate-300"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center justify-center min-h-[240px] rounded-lg bg-slate-900/40 border border-slate-800">
                {qrModalQr ? (
                  <div className="bg-white rounded-lg p-3 shadow-sm">
                    <QRCode value={qrModalQr} size={200} />
                  </div>
                ) : (
                  <div className="text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                    <p className="mt-2 text-xs">QR yaranır...</p>
                  </div>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => handleStart(qrModalAccount.id)}
                  className="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 inline-flex items-center justify-center gap-2"
                >
                  <RefreshCcw className="w-3.5 h-3.5" />
                  QR Yenilə
                </button>
                <button
                  onClick={() => setQrModalAccountId(null)}
                  className="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-slate-800 text-slate-300"
                >
                  Bağla
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Delete confirmation */}
        {confirmDelete ? (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-2xl border border-rose-900/40 bg-[#0d1117] p-5 shadow-2xl">
              <h3 className="text-sm font-extrabold text-rose-300 mb-2">Hesabı sil?</h3>
              <p className="text-[11px] text-slate-400">
                Hesab silinəcək, amma <span className="font-bold text-slate-200">leadlər və mesajlar olduğu kimi qalacaq</span>.
                Eyni nömrə yenidən QR ilə bağlananda hesab avtomatik bərpa olunur.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="flex-1 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200"
                >
                  İmtina
                </button>
                <button
                  onClick={() => handleDelete(confirmDelete)}
                  className="flex-1 py-2 rounded-lg text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white inline-flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Sil
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
