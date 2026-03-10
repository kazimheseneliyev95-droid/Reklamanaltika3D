import { Badge } from './ui/Badge';
import { Activity, AlertTriangle, CheckCircle, TrendingDown, Lightbulb } from 'lucide-react';
import { cn, formatNumber, formatPercent } from '../lib/utils';
import { THRESHOLDS } from '../lib/statistics';

interface MetricHealth {
  label: string;
  current: number;
  benchmark: number;
  format?: 'number' | 'percent' | 'currency';
  inverse?: boolean; // True if lower is better (e.g., CPC, CPA)
}

interface HealthPanelProps {
  metrics: {
    cpc: MetricHealth;
    msgRate: MetricHealth;
    closeRate: MetricHealth;
    roas: MetricHealth;
  };
  dataQuality: {
    clicks: number;
    messages: number;
  };
}

export function HealthPanel({ metrics, dataQuality }: HealthPanelProps) {
  
  const getStatus = (current: number, benchmark: number, inverse = false) => {
    if (benchmark === 0) return 'neutral';
    const diff = ((current - benchmark) / benchmark) * 100;
    const val = inverse ? -diff : diff; // If inverse (CPC), positive diff is bad (negative val)

    if (val <= THRESHOLDS.CRITICAL_VARIANCE) return 'critical';
    if (val <= THRESHOLDS.WARNING_VARIANCE) return 'warning';
    return 'healthy';
  };

  const renderStatusIcon = (status: string) => {
    switch(status) {
      case 'critical': return <TrendingDown className="w-4 h-4 text-red-500" />;
      case 'warning': return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      case 'healthy': return <CheckCircle className="w-4 h-4 text-green-500" />;
      default: return <Activity className="w-4 h-4 text-slate-500" />;
    }
  };

  const getRecommendation = (metricKey: string, status: string) => {
    if (status === 'healthy' || status === 'neutral') return null;
    
    switch(metricKey) {
      case 'cpc':
        return "CTR dropped or CPM spiked. Refresh creative or broaden audience.";
      case 'msgRate':
        return "Weak intent. Improve creative hook, CTA, or offer alignment.";
      case 'closeRate':
        return "Sales friction. Check pricing, checkout flow, or sales script.";
      case 'roas':
        return "Efficiency drop. Pause high-CPA ads or reduce spend on broad targeting.";
      default:
        return null;
    }
  };

  const items = Object.entries(metrics).map(([key, data]) => {
    const status = getStatus(data.current, data.benchmark, data.inverse);
    const rec = getRecommendation(key, status);
    
    return { key, ...data, status, rec };
  });

  const lowDataWarnings = [];
  if (dataQuality.clicks < THRESHOLDS.LOW_DATA_CLICKS) lowDataWarnings.push("Low Clicks (<100): Rates may be volatile.");
  if (dataQuality.messages < THRESHOLDS.LOW_DATA_MESSAGES) lowDataWarnings.push("Low Messages (<10): Close Rate unreliable.");

  return (
    <div className="space-y-4">
      {/* Data Quality Flags */}
      {lowDataWarnings.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {lowDataWarnings.map((w, i) => (
            <Badge key={i} variant="warning" className="text-[10px] py-1">
              <AlertTriangle className="w-3 h-3 mr-1" /> {w}
            </Badge>
          ))}
        </div>
      )}

      {/* Health Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.key} className={cn(
            "p-3 rounded-lg border flex flex-col gap-2",
            item.status === 'critical' ? "bg-red-950/10 border-red-900/30" :
            item.status === 'warning' ? "bg-yellow-950/10 border-yellow-900/30" :
            "bg-slate-900/50 border-slate-800"
          )}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-400 uppercase">{item.label}</span>
              {renderStatusIcon(item.status)}
            </div>
            
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-slate-200">
                {item.format === 'percent' ? formatPercent(item.current, 1) : 
                 item.format === 'currency' ? `$${formatNumber(item.current, 2)}` : 
                 formatNumber(item.current)}
              </span>
              {item.benchmark > 0 && (
                <span className={cn("text-xs", 
                  item.status === 'critical' ? "text-red-400" : 
                  item.status === 'warning' ? "text-yellow-400" : 
                  "text-green-400"
                )}>
                  vs {item.format === 'percent' ? formatPercent(item.benchmark, 1) : item.benchmark}
                </span>
              )}
            </div>

            {item.rec && (
              <div className="mt-1 pt-2 border-t border-slate-700/50 flex gap-2 items-start">
                <Lightbulb className="w-3 h-3 text-yellow-500 mt-0.5 shrink-0" />
                <p className="text-[10px] text-slate-400 leading-tight">{item.rec}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
