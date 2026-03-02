import React from 'react';
import { Bell, Timer } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { CRMSettings } from '../../../lib/crmSettings';

export function NotificationsTab({
  settings,
  setSettings,
}: {
  settings: CRMSettings;
  setSettings: React.Dispatch<React.SetStateAction<CRMSettings>>;
}) {
  const notif = settings.notifications || {};
  const delayDots = settings.ui?.delayDots || {};

  const setNotif = (patch: Partial<NonNullable<CRMSettings['notifications']>>) => {
    setSettings((prev) => ({
      ...prev,
      notifications: { ...(prev.notifications || {}), ...patch }
    }));
  };

  const setDelay = (patch: Partial<NonNullable<NonNullable<CRMSettings['ui']>['delayDots']>>) => {
    setSettings((prev) => ({
      ...prev,
      ui: {
        ...(prev.ui || {}),
        delayDots: { ...((prev.ui || {}).delayDots || {}), ...patch }
      }
    }));
  };

  const replySlaMinutes = Number(notif.replySlaMinutes ?? 5);
  const followupOverdueMinutes = Number(notif.followupOverdueMinutes ?? 15);
  const greenMaxMinutes = Number(delayDots.greenMaxMinutes ?? 10);
  const yellowMaxMinutes = Number(delayDots.yellowMaxMinutes ?? 30);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
        <div className="flex items-center gap-2">
          <Timer className="w-4 h-4 text-amber-300" />
          <p className="text-sm font-extrabold text-slate-100">SLA / Cavab gecikməsi</p>
        </div>
        <p className="mt-1 text-xs text-slate-500">Son inbound mesaja cavab gecikəndə operator + adminlərə bildiriş düşür.</p>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-bold text-slate-400">SLA (dəqiqə)</label>
            <input
              type="number"
              min={1}
              max={240}
              value={Number.isFinite(replySlaMinutes) ? replySlaMinutes : 5}
              onChange={(e) => setNotif({ replySlaMinutes: Math.max(1, Math.min(240, Number(e.target.value || 5))) })}
              className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-400">Kimə bildiriş</label>
            <div className="mt-1 space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={notif.notifyAssignee !== false}
                  onChange={(e) => setNotif({ notifyAssignee: e.target.checked })}
                />
                Lead operatoruna (assignee)
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={notif.notifyAdmins !== false}
                  onChange={(e) => setNotif({ notifyAdmins: e.target.checked })}
                />
                Admin/Manager roluna
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-violet-300" />
          <p className="text-sm font-extrabold text-slate-100">Follow-up bildirişləri</p>
        </div>
        <p className="mt-1 text-xs text-slate-500">Due olanda və gecikəndə bildiriş düşür.</p>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-bold text-slate-400">Overdue (dəqiqə)</label>
            <input
              type="number"
              min={0}
              max={10080}
              value={Number.isFinite(followupOverdueMinutes) ? followupOverdueMinutes : 15}
              onChange={(e) => setNotif({ followupOverdueMinutes: Math.max(0, Math.min(10080, Number(e.target.value || 15))) })}
              className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-slate-500">0 olsa, due olan kimi overdue kimi sayilacaq.</p>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-400">Kimə bildiriş</label>
            <div className="mt-1 space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={notif.notifyCreator !== false}
                  onChange={(e) => setNotif({ notifyCreator: e.target.checked })}
                />
                Follow-up yaradan
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={notif.notifyAssignee !== false}
                  onChange={(e) => setNotif({ notifyAssignee: e.target.checked })}
                />
                Follow-up operatoru
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={notif.notifyAdmins !== false}
                  onChange={(e) => setNotif({ notifyAdmins: e.target.checked })}
                />
                Admin/Manager roluna
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/35 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-extrabold text-slate-100">Kanban gecikmə rəngləri</p>
          <span className={cn('text-[10px] font-bold uppercase tracking-wide', 'text-slate-500')}>dot thresholds</span>
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-bold text-slate-400">Yaşıl max (dəqiqə)</label>
            <input
              type="number"
              min={1}
              max={240}
              value={Number.isFinite(greenMaxMinutes) ? greenMaxMinutes : 10}
              onChange={(e) => setDelay({ greenMaxMinutes: Math.max(1, Math.min(240, Number(e.target.value || 10))) })}
              className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-400">Sarı max (dəqiqə)</label>
            <input
              type="number"
              min={2}
              max={1440}
              value={Number.isFinite(yellowMaxMinutes) ? yellowMaxMinutes : 30}
              onChange={(e) => {
                const n = Math.max(2, Math.min(1440, Number(e.target.value || 30)));
                setDelay({ yellowMaxMinutes: n });
              }}
              className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">Qırmızı: sarı max-dan yuxarı.</p>
      </div>
    </div>
  );
}
