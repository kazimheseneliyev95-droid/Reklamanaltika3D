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
  const stages = settings.pipelineStages || [];

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
  const slaIgnoreStages = Array.isArray((notif as any).slaIgnoreStages) ? (notif as any).slaIgnoreStages as string[] : [];
  const bh = ((notif as any).businessHours && typeof (notif as any).businessHours === 'object') ? (notif as any).businessHours : {};
  const bhEnabled = bh.enabled === true;
  const bhTimezone = String(bh.timezone || 'Asia/Baku');
  const bhStart = String(bh.start || '09:00');
  const bhEnd = String(bh.end || '18:00');
  const bhDays = Array.isArray(bh.days) ? (bh.days as number[]).filter((x) => Number.isFinite(Number(x))) : [1, 2, 3, 4, 5];

  const setBusinessHours = (patch: any) => {
    const next = { ...(bh || {}), ...(patch || {}) };
    setNotif({ businessHours: next } as any);
  };

  const dayOptions: Array<{ id: number; label: string }> = [
    { id: 1, label: 'Mon' },
    { id: 2, label: 'Tue' },
    { id: 3, label: 'Wed' },
    { id: 4, label: 'Thu' },
    { id: 5, label: 'Fri' },
    { id: 6, label: 'Sat' },
    { id: 0, label: 'Sun' },
  ];

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

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-extrabold text-slate-200">İş saatları (Business hours)</p>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={bhEnabled}
                onChange={(e) => setBusinessHours({ enabled: e.target.checked })}
              />
              Aktiv
            </label>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Aktiv olanda SLA gecikməsi yalnız seçilmiş günlər/saatlarda hesablanır (digər vaxtlarda 0 sayılır).</p>

          <div className={cn('mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3', !bhEnabled && 'opacity-50 pointer-events-none')}>
            <div>
              <label className="text-[11px] font-bold text-slate-400">Timezone</label>
              <input
                list="tz-list"
                value={bhTimezone}
                onChange={(e) => setBusinessHours({ timezone: e.target.value })}
                className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Asia/Baku"
              />
              <datalist id="tz-list">
                <option value="Asia/Baku" />
                <option value="Europe/Istanbul" />
                <option value="Europe/Moscow" />
                <option value="Europe/London" />
                <option value="Europe/Berlin" />
                <option value="UTC" />
              </datalist>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-bold text-slate-400">Start</label>
                <input
                  type="time"
                  value={bhStart}
                  onChange={(e) => setBusinessHours({ start: e.target.value })}
                  className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-400">End</label>
                <input
                  type="time"
                  value={bhEnd}
                  onChange={(e) => setBusinessHours({ end: e.target.value })}
                  className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          <div className={cn('mt-3 flex flex-wrap gap-2', !bhEnabled && 'opacity-50 pointer-events-none')}>
            {dayOptions.map((d) => {
              const checked = bhDays.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    const cur = bhDays.slice();
                    const next = checked ? cur.filter((x) => x !== d.id) : Array.from(new Set([...cur, d.id]));
                    setBusinessHours({ days: next });
                  }}
                  className={cn(
                    'px-2 py-1 rounded-lg border text-[11px] font-extrabold transition-colors',
                    checked
                      ? 'border-blue-500/30 bg-blue-600/15 text-blue-200'
                      : 'border-slate-800 bg-slate-950/30 text-slate-300 hover:bg-slate-900/50'
                  )}
                  title={checked ? 'Seçilib' : 'Seç'}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-extrabold text-slate-200">Gecikmə istisnaları (SLA + dot)</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setNotif({ slaIgnoreStages: [] })}
                className="text-[10px] font-extrabold text-slate-300 hover:text-white px-2 py-1 rounded-lg border border-slate-800 bg-slate-950/40 hover:bg-slate-900"
                title="Hamısını sıfırla"
              >
                Sıfırla
              </button>
              <button
                type="button"
                onClick={() => setNotif({ slaIgnoreStages: ['won'] })}
                className="text-[10px] font-extrabold text-emerald-200 hover:text-emerald-100 px-2 py-1 rounded-lg border border-emerald-900/30 bg-emerald-950/15 hover:bg-emerald-950/25"
                title="Tipik: Satış (Won)"
              >
                Default
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Seçilmiş sütunlarda olan lead-lər üçün cavab gecikməsi sayılmır və kanbanda gecikmə dot-u çıxmır.</p>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-auto pr-1">
            {stages.map((s) => {
              const checked = slaIgnoreStages.includes(s.id);
              return (
                <label key={s.id} className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const cur = Array.isArray(slaIgnoreStages) ? slaIgnoreStages.slice() : [];
                      const next = e.target.checked
                        ? Array.from(new Set([...cur, s.id]))
                        : cur.filter((x) => x !== s.id);
                      setNotif({ slaIgnoreStages: next });
                    }}
                  />
                  <span className="truncate" title={s.label}>{s.label}</span>
                </label>
              );
            })}
            {stages.length === 0 ? (
              <p className="text-[11px] text-slate-500">Əvvəl Kanban sütunlarını yaradın.</p>
            ) : null}
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
