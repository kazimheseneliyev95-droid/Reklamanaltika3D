import React, { useEffect, useMemo, useState } from 'react';
import { Timer, Users, Activity, AlarmClock } from 'lucide-react';
import { cn } from '../lib/utils';
import { CrmService } from '../services/CrmService';

type Stats = {
  range: { start: string; end: string };
  filters: { channels: string[]; sla_minutes: number };
  frt: {
    count: number;
    avg_minutes: number | null;
    min_minutes: number | null;
    max_minutes: number | null;
    p50_minutes: number | null;
    p90_minutes: number | null;
  };
  cgt: {
    count: number;
    avg_minutes: number | null;
    min_minutes: number | null;
    max_minutes: number | null;
    p50_minutes: number | null;
    p90_minutes: number | null;
  };
  art: { avg_minutes: number | null; count: number };
  sla: {
    sla_minutes: number;
    within_count: number;
    outside_count: number;
    within_pct: number | null;
    outside_pct: number | null;
  };
  by_operator: Array<{
    user_id: string | null;
    name: string;
    frt_count: number;
    frt_avg_minutes: number | null;
    art_avg_minutes: number | null;
    cgt_count: number;
    cgt_max_minutes: number | null;
  }>;
};

function fmtMinutes(mins: number | null): string {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return '-';
  if (mins < 1) return `${Math.round(mins * 60)}s`;
  if (mins < 60) return `${mins.toFixed(1)} dk`;
  const h = mins / 60;
  if (h < 24) return `${h.toFixed(1)} saat`;
  const d = h / 24;
  return `${d.toFixed(1)} gun`;
}

function MetricCard({
  title,
  value,
  sub,
  icon,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/25 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">{title}</div>
          <div className="mt-1 text-2xl font-extrabold text-slate-100 tabular-nums">{value}</div>
          {sub ? <div className="mt-1 text-[11px] text-slate-500">{sub}</div> : null}
        </div>
        <div className="w-10 h-10 rounded-2xl border border-slate-800 bg-slate-950/40 flex items-center justify-center text-slate-300">
          {icon}
        </div>
      </div>
    </div>
  );
}

export default function ResponseTimesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [preset, setPreset] = useState<'today' | '7d' | '30d'>('7d');
  const [channels, setChannels] = useState<string[]>(['whatsapp', 'instagram', 'facebook', 'telegram']);
  const channelKey = useMemo(() => channels.join(','), [channels]);

  const toggleChannel = (ch: string) => {
    setChannels((prev) => {
      const has = prev.includes(ch);
      const next = has ? prev.filter(x => x !== ch) : [...prev, ch];
      return next.length ? next : prev;
    });
  };

  const range = useMemo(() => {
    const now = new Date();
    const end = new Date(now);
    let start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (preset === 'today') {
      start = new Date(end);
      start.setHours(0, 0, 0, 0);
    } else if (preset === '30d') {
      start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    return { start, end };
  }, [preset]);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError('');
      try {
        const url = CrmService.getServerUrl();
        const token = localStorage.getItem('crm_auth_token');
        if (!url || !token) throw new Error('Not authenticated');

        const qs = new URLSearchParams({
          start: range.start.toISOString(),
          end: range.end.toISOString(),
          channels: channelKey,
        });
        const res = await fetch(`${url}/api/analytics/response-times?${qs.toString()}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Load failed');
        setStats(data as any);
      } catch (e: any) {
        setError(String(e?.message || 'Load failed'));
        setStats(null);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [channelKey, channels, range.end, range.start, refreshKey]);

  const slaPct = stats?.sla?.within_pct === null || stats?.sla?.within_pct === undefined
    ? null
    : Math.round(stats.sla.within_pct * 100);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-2xl border border-slate-800 bg-slate-950/40 flex items-center justify-center">
              <Timer className="w-5 h-5 text-slate-300" />
            </div>
            <div>
              <div className="text-2xl font-extrabold text-slate-100">Cavab Sureleri</div>
              <div className="mt-0.5 text-[12px] text-slate-500">
                FRT (ilk cavab) + CGT (gap) + ART (gap ortalamasi).
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setRefreshKey((v) => v + 1)}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors"
        >
          Yenile
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-slate-800 bg-slate-950/25 p-1">
          {([
            { key: 'today', label: 'Bugun' },
            { key: '7d', label: 'Son 7 gun' },
            { key: '30d', label: 'Son 30 gun' },
          ] as const).map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setPreset(b.key)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-[11px] font-extrabold transition-colors',
                preset === b.key ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-900'
              )}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {['whatsapp', 'instagram', 'facebook', 'telegram'].map((ch) => {
            const on = channels.includes(ch);
            return (
              <button
                key={ch}
                type="button"
                onClick={() => toggleChannel(ch)}
                className={cn(
                  'px-3 py-1.5 rounded-full border text-[11px] font-extrabold transition-colors',
                  on
                    ? 'border-slate-700 bg-slate-950/40 text-slate-100'
                    : 'border-slate-800 bg-slate-950/10 text-slate-500 hover:text-slate-200'
                )}
              >
                {ch.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border border-red-900/50 bg-red-950/15 px-4 py-3 text-sm text-red-300">{error}</div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard
          title="Ortalama FRT"
          value={loading ? '...' : fmtMinutes(stats?.frt?.avg_minutes ?? null)}
          sub={loading ? '' : `min: ${fmtMinutes(stats?.frt?.min_minutes ?? null)} · max: ${fmtMinutes(stats?.frt?.max_minutes ?? null)}`}
          icon={<Activity className="w-5 h-5" />}
        />
        <MetricCard
          title="Ortalama ART"
          value={loading ? '...' : fmtMinutes(stats?.art?.avg_minutes ?? null)}
          sub={loading ? '' : `CGT say: ${stats?.cgt?.count ?? 0}`}
          icon={<Users className="w-5 h-5" />}
        />
        <MetricCard
          title="CGT (Gap)"
          value={loading ? '...' : (stats?.cgt?.p50_minutes !== null && stats?.cgt?.p50_minutes !== undefined ? fmtMinutes(stats?.cgt?.p50_minutes) : '-')}
          sub={loading ? '' : `min: ${fmtMinutes(stats?.cgt?.min_minutes ?? null)} · max: ${fmtMinutes(stats?.cgt?.max_minutes ?? null)}`}
          icon={<Timer className="w-5 h-5" />}
        />
        <MetricCard
          title={`SLA (<= ${stats?.sla?.sla_minutes ?? 10} dk)`}
          value={loading ? '...' : (slaPct === null ? '-' : `${slaPct}%`)}
          sub={loading ? '' : `icinde: ${stats?.sla?.within_count ?? 0} · disi: ${stats?.sla?.outside_count ?? 0}`}
          icon={<AlarmClock className="w-5 h-5" />}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4">
          <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500">Operatorlara gore</div>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-slate-500">
                  <th className="py-2 pr-3">Operator</th>
                  <th className="py-2 pr-3">FRT say</th>
                  <th className="py-2 pr-3">Ort FRT</th>
                  <th className="py-2 pr-3">Ort ART</th>
                  <th className="py-2">Max CGT</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {(stats?.by_operator || []).slice(0, 25).map((r) => (
                  <tr key={r.user_id || r.name} className="border-t border-slate-800/70">
                    <td className="py-2 pr-3 font-semibold text-slate-100">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-300">{r.frt_count}</td>
                    <td className="py-2 pr-3 tabular-nums">{fmtMinutes(r.frt_avg_minutes)}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-300">{fmtMinutes(r.art_avg_minutes)}</td>
                    <td className="py-2 tabular-nums text-slate-400">{fmtMinutes(r.cgt_max_minutes)}</td>
                  </tr>
                ))}
                {!loading && (stats?.by_operator || []).length === 0 ? (
                  <tr><td className="py-4 text-slate-500" colSpan={5}>Data yoxdur.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/20 p-4">
          <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500">Tanim</div>
          <div className="mt-3 space-y-2 text-[12px] text-slate-300">
            <div className="rounded-xl border border-slate-800 bg-slate-950/25 px-3 py-2">
              <div className="font-extrabold text-slate-100">FRT</div>
              <div className="text-slate-400">Musterinin ilk mesaji → ilk agent cavabi.</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/25 px-3 py-2">
              <div className="font-extrabold text-slate-100">CGT</div>
              <div className="text-slate-400">Musteri mesaj bloku (son mesaj) → agentin ilk cavabi.</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/25 px-3 py-2">
              <div className="font-extrabold text-slate-100">ART</div>
              <div className="text-slate-400">Butun CGT dongulerinin ortalamasi.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
