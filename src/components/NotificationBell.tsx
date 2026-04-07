import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { cn } from '../lib/utils';
import { CrmService } from '../services/CrmService';

type NotifRow = {
  id: string;
  type: string;
  title?: string | null;
  body?: string | null;
  payload?: any;
  lead_id?: string | null;
  followup_id?: string | null;
  created_at?: string;
  read_at?: string | null;
  lead_phone?: string | null;
  lead_name?: string | null;
};

export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotifRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [toast, setToast] = useState<NotifRow | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 360 });

  // Tracks notification IDs marked read optimistically. We merge these into
  // refresh() results so a stale poll between an optimistic update and the
  // server's confirmation can't bring the badge back. Cleared after 60s.
  const recentlyReadRef = useRef<Map<string, number>>(new Map());
  const recentlyReadAllAtRef = useRef<number>(0);

  const cleanupRecentlyRead = () => {
    const now = Date.now();
    for (const [id, ts] of recentlyReadRef.current.entries()) {
      if (now - ts > 60_000) recentlyReadRef.current.delete(id);
    }
  };

  const refresh = async (opts?: { unreadOnly?: boolean }) => {
    const res = await CrmService.fetchNotifications({ unreadOnly: Boolean(opts?.unreadOnly), limit: 80 });
    cleanupRecentlyRead();
    const recentlyRead = recentlyReadRef.current;
    const allReadAt = recentlyReadAllAtRef.current;
    const allReadStillFresh = allReadAt > 0 && (Date.now() - allReadAt) < 60_000;

    const incoming = Array.isArray(res.notifications) ? (res.notifications as NotifRow[]) : [];
    const merged = incoming.map((row) => {
      if (!row || row.read_at) return row;
      const localTs = recentlyRead.get(String(row.id));
      if (localTs) return { ...row, read_at: new Date(localTs).toISOString() };
      if (allReadStillFresh) return { ...row, read_at: new Date(allReadAt).toISOString() };
      return row;
    });

    // If we have pending optimistic reads, recompute the unread count from the
    // merged list rather than trusting the server's number — otherwise the
    // badge would briefly bounce back up.
    let finalUnread = Number.isFinite(Number(res.unread_count)) ? Number(res.unread_count) : 0;
    if (recentlyRead.size > 0 || allReadStillFresh) {
      finalUnread = merged.reduce((sum, row) => sum + (row?.read_at ? 0 : 1), 0);
    }

    setItems(merged);
    setUnreadCount(finalUnread);
  };

  useEffect(() => {
    refresh().catch(() => { });
    const cleanupNew = CrmService.onNotificationNew((n: any) => {
      try {
        const row = n as NotifRow;
        setToast(row);
        setUnreadCount((c) => (Number.isFinite(c) ? c + 1 : 1));
        setItems((prev) => [row, ...prev].slice(0, 120));
      } catch {
        // ignore
      }
    });
    const cleanupReconnect = CrmService.onReconnect(() => {
      refresh().catch(() => { });
    });
    const cleanupMeta = CrmService.onNotificationsMeta((meta: any) => {
      try {
        let handledLocally = false;
        if (meta?.action === 'notification_read') {
          handledLocally = true;
          const id = String(meta?.id || '').trim();
          const readAt = meta?.read_at ? String(meta.read_at) : new Date().toISOString();
          if (id) {
            setItems((prev) => {
              const nextItems = prev.map((x) => String(x?.id || '') === id && !x.read_at ? { ...x, read_at: readAt } : x);
              if (meta?.unread_count === undefined || meta?.unread_count === null) {
                setUnreadCount(nextItems.reduce((sum, item) => sum + (item?.read_at ? 0 : 1), 0));
              }
              return nextItems;
            });
          }
        }
        if (meta?.action === 'notifications_read_all') {
          handledLocally = true;
          const readAt = meta?.read_at ? String(meta.read_at) : new Date().toISOString();
          setItems((prev) => {
            const nextItems = prev.map((x) => ({ ...x, read_at: x.read_at || readAt }));
            if (meta?.unread_count === undefined || meta?.unread_count === null) {
              setUnreadCount(0);
            }
            return nextItems;
          });
        }
        if (meta?.action === 'lead_notifications_read') {
          handledLocally = true;
          const leadId = String(meta?.lead_id || '').trim();
          const readAt = meta?.read_at ? String(meta.read_at) : new Date().toISOString();
          if (leadId) {
            setItems((prev) => {
              const nextItems = prev.map((x) => {
                if (!x?.lead_id) return x;
                return String(x.lead_id) === leadId && !x.read_at ? { ...x, read_at: readAt } : x;
              });
              if (meta?.unread_count === undefined || meta?.unread_count === null) {
                setUnreadCount(nextItems.reduce((sum, item) => sum + (item?.read_at ? 0 : 1), 0));
              }
              return nextItems;
            });
          }
        }
        if (meta?.unread_count !== undefined && meta?.unread_count !== null) {
          const next = Number(meta.unread_count);
          if (Number.isFinite(next)) setUnreadCount(Math.max(0, next));
        }
        if (!handledLocally) refresh().catch(() => { });
      } catch {
        // ignore
      }
    });
    return () => {
      cleanupNew();
      cleanupReconnect();
      cleanupMeta();
    };
  }, []);

  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === 'hidden') return;
      refresh().catch(() => { });
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };

    const intervalId = window.setInterval(sync, 15000);
    window.addEventListener('focus', sync);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', sync);
      window.removeEventListener('online', sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    // Auto-dismiss toast after 3s — used to be 6.5s which felt sluggish.
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: any) => {
      const target = e?.target as HTMLElement;
      if (!target) return;
      if (rootRef.current && rootRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const w = Math.min(360, Math.max(280, Math.floor(window.innerWidth * 0.92)));
      const rect = btnRef.current?.getBoundingClientRect();
      const top = rect ? Math.min(window.innerHeight - 80, rect.bottom + 8) : 56;
      const left = rect
        ? Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w))
        : Math.max(8, window.innerWidth - w - 8);
      setPanelPos({ top, left, width: w });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  const visible = useMemo(() => {
    return (items || []).slice(0, 30);
  }, [items]);

  const markRead = (id: string) => {
    // Optimistic: clear UI immediately, server confirmation runs in the background.
    const target = items.find((x) => x.id === id);
    if (!target || target.read_at) return;
    recentlyReadRef.current.set(String(id), Date.now());
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, read_at: new Date().toISOString() } : x)));
    setUnreadCount((c) => Math.max(0, Number(c || 0) - 1));
    CrmService.markNotificationRead(id).catch(() => {
      // Revert on failure
      recentlyReadRef.current.delete(String(id));
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, read_at: null } : x)));
      setUnreadCount((c) => Number(c || 0) + 1);
    });
  };

  const markAllRead = () => {
    // Optimistic: clear all unread badges immediately.
    const prevItems = items;
    const prevUnread = unreadCount;
    if (prevUnread === 0) return;
    recentlyReadAllAtRef.current = Date.now();
    setUnreadCount(0);
    setItems((prev) => prev.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
    CrmService.markAllNotificationsRead().catch(() => {
      recentlyReadAllAtRef.current = 0;
      setItems(prevItems);
      setUnreadCount(prevUnread);
    });
  };

  const toastLeadName = toast?.payload?.lead?.name || toast?.lead_name || toast?.payload?.lead?.phone || toast?.lead_phone || null;
  const toastPhone = toast?.payload?.lead?.phone || toast?.lead_phone || null;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {toast ? (
        <div className="fixed top-4 right-4 z-[80] w-[360px] max-w-[92vw] rounded-2xl border border-slate-800 bg-slate-950/80 backdrop-blur px-4 py-3 shadow-2xl">
          <div className="text-[10px] uppercase tracking-wide font-extrabold text-slate-300">{toast.title || 'Bildiris'}</div>
          <div className="mt-1 text-sm font-bold text-white truncate">
            {toastLeadName ? String(toastLeadName) : 'Lead'}
          </div>
          {toast.body ? (
            <div className="mt-1 text-[12px] text-slate-200 whitespace-pre-line line-clamp-3">{String(toast.body)}</div>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-2">
            {toastPhone ? (
              <a
                href={`tel:${String(toastPhone).replace(/\s+/g, '')}`}
                className="text-[11px] font-bold text-emerald-300 hover:text-emerald-200"
              >
                Zeng et
              </a>
            ) : <span />}
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-[11px] font-bold text-slate-300 hover:text-white"
            >
              Bagla
            </button>
          </div>
        </div>
      ) : null}

      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          // Open instantly with cached items; background-refresh in parallel.
          // We never await refresh here because that adds 100-300ms before the
          // panel becomes visible.
          const next = !open;
          setOpen(next);
          if (next) {
            void refresh({ unreadOnly: false });
          }
        }}
        className="relative p-2 rounded-lg hover:bg-slate-800/60 transition-colors"
        title="Bildirisler"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-rose-600 text-white text-[10px] font-extrabold flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed rounded-2xl border border-slate-800 bg-slate-950/95 backdrop-blur shadow-2xl overflow-hidden z-[70] flex flex-col"
          style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width, maxHeight: `calc(100vh - ${Math.round(panelPos.top + 8)}px)` }}
        >
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <div className="text-xs font-extrabold text-slate-200">Bildirisler</div>
            <button
              type="button"
              onClick={markAllRead}
              className="text-[10px] font-bold text-slate-400 hover:text-slate-200"
            >
              Hamisini oxunmus et
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="p-6 text-xs text-slate-500">Bildiris yoxdur</div>
            ) : (
              visible.map((n) => {
                const leadLabel = n?.payload?.lead?.name || n?.lead_name || n?.payload?.lead?.phone || n?.lead_phone || '';
                const phone = n?.payload?.lead?.phone || n?.lead_phone || '';
                const unread = !n.read_at;
                return (
                  <div key={n.id} className={cn('px-4 py-3 border-b border-slate-900/60', unread && 'bg-rose-950/10')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className={cn('text-[11px] font-extrabold truncate', unread ? 'text-white' : 'text-slate-300')} title={String(n.title || '')}>
                          {n.title || 'Bildiris'}
                        </div>
                        {leadLabel ? (
                          <div className="mt-0.5 text-[11px] font-bold text-slate-200 truncate">{String(leadLabel)}</div>
                        ) : null}
                        {n.body ? (
                          <div className="mt-1 text-[11px] text-slate-400 whitespace-pre-line line-clamp-3">{String(n.body)}</div>
                        ) : null}
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        {phone ? (
                          <a
                            href={`tel:${String(phone).replace(/\s+/g, '')}`}
                            className="text-[10px] font-bold text-emerald-300 hover:text-emerald-200"
                            title="Zeng et"
                          >
                            Zeng
                          </a>
                        ) : null}
                        {unread ? (
                          <button
                            type="button"
                            onClick={() => markRead(n.id)}
                            className="text-[10px] font-bold text-slate-300 hover:text-white"
                          >
                            Oxudum
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
