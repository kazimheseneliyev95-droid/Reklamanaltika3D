import React, { useEffect, useMemo, useState } from 'react';
import { Timer, Users, TrendingUp, Activity } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAppStore } from '../context/Store';
import { CrmService } from '../services/CrmService';

type Stats = {
  range: { start: string; end: string };
  overall: {
    count: number;
    avg_minutes: number | null;
    min_minutes: number | null;
    max_minutes: number | null;
    p50_minutes: number | null;
    p90_minutes: number | null;
  };
  categories: {
    new: any;
    conversation: any;
  };
  by_operator: Array<{
    user_id: string | null;
    name: string;
    count: number;
    avg_minutes: number | null;
    min_minutes: number | null;
    max_minutes: number | null;
    p50_minutes: number | null;
    p90_minutes: number | null;
  }>;
  conversion: {
    stage_id: string | null;
    stage_rule: string;
    buckets: Array<{
      bucket: string;
      leads: number;
      converted: number;
      conversion_rate: number | null;
      avg_first_response_minutes: number | null;
    }>;
  };
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
  const { dateRange } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const range = useMemo(() => {
    const end = dateRange?.end ? new Date(`${dateRange.end}T23:59:59.999Z`) : new Date();
    const start = dateRange?.start
      ? new Date(`${dateRange.start}T00:00:00.000Z`)
      : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  }, [dateRange?.start, dateRange?.end]);

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
  }, [range.start, range.end, refreshKey]);

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
                Musteri mesajindan sonra ilk cavaba qeder olan vaxt (dk).
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

      {error ? (
        <div className="mt-4 rounded-xl border border-red-900/50 bg-red-950/15 px-4 py-3 text-sm text-red-300">{error}</div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard
          title="Ortalama"
          value={loading ? '...' : fmtMinutes(stats?.overall?.avg_minutes ?? null)}
          sub={loading ? '' : `p50: ${fmtMinutes(stats?.overall?.p50_minutes ?? null)} · p90: ${fmtMinutes(stats?.overall?.p90_minutes ?? null)}`}
          icon={<Activity className="w-5 h-5" />}
        />
        <MetricCard
          title="En Qisa"
          value={loading ? '...' : fmtMinutes(stats?.overall?.min_minutes ?? null)}
          sub={loading ? '' : 'Bu araliqda'}
          icon={<TrendingUp className="w-5 h-5" />}
        />
        <MetricCard
          title="En Uzun"
          value={loading ? '...' : fmtMinutes(stats?.overall?.max_minutes ?? null)}
          sub={loading ? '' : 'Bu araliqda'}
          icon={<Timer className="w-5 h-5" />}
        />
        <MetricCard
          title="Cavab Say"
          value={loading ? '...' : String(stats?.overall?.count ?? 0)}
          sub={loading ? '' : `Yeni: ${stats?.categories?.new?.count ?? 0} · Davam: ${stats?.categories?.conversation?.count ?? 0}`}
          icon={<Users className="w-5 h-5" />}
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
                  <th className="py-2 pr-3">Say</th>
                  <th className="py-2 pr-3">Ort</th>
                  <th className="py-2 pr-3">Min</th>
                  <th className="py-2">Max</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {(stats?.by_operator || []).slice(0, 20).map((r) => (
                  <tr key={r.user_id || r.name} className="border-t border-slate-800/70">
                    <td className="py-2 pr-3 font-semibold text-slate-100">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-300">{r.count}</td>
                    <td className="py-2 pr-3 tabular-nums">{fmtMinutes(r.avg_minutes)}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-400">{fmtMinutes(r.min_minutes)}</td>
                    <td className="py-2 tabular-nums text-slate-400">{fmtMinutes(r.max_minutes)}</td>
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
          <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500">Ilk cavab sureleri vs konversiya</div>
          <div className="mt-2 text-[11px] text-slate-500">
            Rule: <span className="text-slate-200 font-semibold">{stats?.conversion?.stage_rule || '-'}</span>
            {stats?.conversion?.stage_id ? <span className="text-slate-600"> · stage: {stats.conversion.stage_id}</span> : null}
          </div>

          <div className="mt-3 space-y-2">
            {(stats?.conversion?.buckets || []).map((b) => {
              const pct = b.conversion_rate === null ? 0 : Math.round(b.conversion_rate * 100);
              return (
                <div key={b.bucket} className="rounded-xl border border-slate-800 bg-slate-950/25 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-bold text-slate-100">{b.bucket} dk</div>
                    <div className="text-[11px] text-slate-400 tabular-nums">
                      {b.converted}/{b.leads} · <span className="text-slate-200 font-semibold">{b.conversion_rate === null ? '-' : `${pct}%`}</span>
                    </div>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                    <div className="h-full bg-emerald-500/60" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] text-slate-600">Ortalama ilk cavab: {fmtMinutes(b.avg_first_response_minutes)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
