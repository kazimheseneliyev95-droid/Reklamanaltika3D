import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { formatCurrency, formatNumber, cn } from '../lib/utils';
import { Calculator, TrendingDown, TrendingUp, Minus, DollarSign, Wallet, AlertCircle } from 'lucide-react';

interface MonthlyProjectionProps {
  inputs: {
    cpc: number;
    msgRate: number;
    closeRate: number;
    potentialRate: number;
    aov: number;
    hasPotential: boolean;
    exchangeRate: number; // 1 USD = X AZN
  };
  uncertainty: {
    msgRate: number; // percentage variance (e.g. 0.2 for 20%)
    closeRate: number;
  };
}

export function MonthlyProjection({ inputs, uncertainty }: MonthlyProjectionProps) {
  const [targetSales, setTargetSales] = useState<number>(90);

  // --- CALCULATIONS ---

  // Helper to calculate scenario
  const calculateScenario = (mode: 'avg' | 'pessimistic' | 'optimistic') => {
    let msgRateMod = 1;
    let closeRateMod = 1;

    // Pessimistic: Lower conversion rates = Higher Cost, Lower Profit
    if (mode === 'pessimistic') {
      msgRateMod = 1 - uncertainty.msgRate;
      closeRateMod = 1 - uncertainty.closeRate;
    }
    // Optimistic: Higher conversion rates = Lower Cost, Higher Profit
    if (mode === 'optimistic') {
      msgRateMod = 1 + uncertainty.msgRate;
      closeRateMod = 1 + uncertainty.closeRate;
    }

    const effectiveMsgRate = Math.max(0, inputs.msgRate * msgRateMod);
    const effectiveCloseRate = Math.max(0, inputs.closeRate * closeRateMod);
    const effectivePotentialRate = Math.max(0, inputs.potentialRate); 

    // Safety check: If rates are 0, we can't calculate reverse funnel
    if (effectiveCloseRate <= 0 || effectiveMsgRate <= 0 || (inputs.hasPotential && effectivePotentialRate <= 0)) {
       return {
        budgetUSD: 0,
        revenueAZN: 0,
        profitAZN: 0,
        roas: 0,
        clicks: 0,
        messages: 0,
        possible: false
      };
    }

    // Reverse Funnel Logic
    // Sales -> (Potential) -> Messages -> Clicks -> Budget
    
    let reqPotential = 0;
    let reqMessages = 0;

    if (inputs.hasPotential) {
      // Sales = Potential * CloseRate
      // Potential = Sales / CloseRate
      reqPotential = targetSales / (effectiveCloseRate / 100);
      
      // Potential = Messages * PotentialRate
      // Messages = Potential / PotentialRate
      reqMessages = reqPotential / (effectivePotentialRate / 100);
    } else {
      // Sales = Messages * CloseRate
      reqMessages = targetSales / (effectiveCloseRate / 100);
    }

    // Messages = Clicks * MsgRate
    // Clicks = Messages / MsgRate
    const reqClicks = reqMessages / (effectiveMsgRate / 100);
    
    // Budget is in USD (Cost per Click is USD)
    const reqBudgetUSD = reqClicks * inputs.cpc;
    
    // Revenue is in AZN (AOV is AZN)
    const revenueAZN = targetSales * inputs.aov;
    
    // Profit Calculation (Need to convert Budget USD to AZN to subtract from Revenue AZN)
    const costInAZN = reqBudgetUSD * inputs.exchangeRate;
    const profitAZN = revenueAZN - costInAZN;
    
    // ROAS (Revenue USD / Spend USD)
    const revenueUSD = revenueAZN / (inputs.exchangeRate || 1);
    const roas = reqBudgetUSD > 0 ? revenueUSD / reqBudgetUSD : 0;

    return {
      budgetUSD: reqBudgetUSD,
      revenueAZN,
      profitAZN,
      roas,
      clicks: reqClicks,
      messages: reqMessages,
      possible: true
    };
  };

  const avg = useMemo(() => calculateScenario('avg'), [inputs, uncertainty, targetSales]);
  const worst = useMemo(() => calculateScenario('pessimistic'), [inputs, uncertainty, targetSales]);
  const best = useMemo(() => calculateScenario('optimistic'), [inputs, uncertainty, targetSales]);

  const isImpossible = !avg.possible;

  return (
    <Card className="border-l-4 border-l-purple-500 bg-slate-950/50 mt-8">
      <CardHeader className="pb-4 border-b border-slate-800/50">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Calculator className="w-5 h-5 text-purple-500" />
              Monthly Projection Simulator
            </CardTitle>
            <p className="text-sm text-slate-400 mt-1">
              Forecast budget & profit for a specific sales target based on your simulation settings.
            </p>
          </div>
          
          <div className="flex items-center gap-3 bg-slate-900 p-2 rounded-lg border border-slate-800">
            <Label className="whitespace-nowrap">Target Sales / Month:</Label>
            <Input 
              type="number" 
              value={targetSales} 
              onChange={(e) => setTargetSales(parseFloat(e.target.value) || 0)} 
              className="w-24 h-8 text-center font-bold text-purple-400 border-purple-500/30 focus:border-purple-500"
            />
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="pt-6">
        {isImpossible ? (
           <div className="flex flex-col items-center justify-center p-8 border border-dashed border-slate-700 rounded-xl bg-slate-900/30 text-slate-400">
             <AlertCircle className="w-8 h-8 mb-2 text-yellow-500" />
             <h3 className="font-semibold text-slate-200">Projection Unavailable</h3>
             <p className="text-sm text-center max-w-md mt-1">
               Your simulation has a <strong>0% Conversion Rate</strong> (Close Rate or Message Rate). 
               Please increase the rates in the "Pro Simulation" panel to see projected costs.
             </p>
           </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* WORST CASE */}
              <ScenarioCard 
                title="Pessimistic" 
                icon={<TrendingDown className="w-4 h-4" />}
                data={worst} 
                color="red"
                description="High Cost / Low Conv."
              />

              {/* AVERAGE CASE */}
              <ScenarioCard 
                title="Expected Average" 
                icon={<Minus className="w-4 h-4" />}
                data={avg} 
                color="blue"
                isMain
                description="Based on current sim"
              />

              {/* BEST CASE */}
              <ScenarioCard 
                title="Optimistic" 
                icon={<TrendingUp className="w-4 h-4" />}
                data={best} 
                color="green"
                description="Low Cost / High Conv."
              />
            </div>

            {/* Summary Text */}
            <div className="mt-6 p-4 bg-slate-900 rounded-lg border border-slate-800 text-sm text-slate-300 flex flex-col md:flex-row gap-4 justify-between items-center">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-slate-500" />
                <span>
                  To get <strong>{targetSales} sales</strong>, you likely need a budget between 
                  <span className="text-white font-mono font-bold mx-1">{formatCurrency(best.budgetUSD)}</span> 
                  and 
                  <span className="text-white font-mono font-bold mx-1">{formatCurrency(worst.budgetUSD)}</span>.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-green-500" />
                <span>
                  Est. Profit: 
                  <span className="text-green-400 font-mono font-bold mx-1">{formatCurrency(worst.profitAZN, 'AZN')}</span> 
                  - 
                  <span className="text-green-400 font-mono font-bold mx-1">{formatCurrency(best.profitAZN, 'AZN')}</span>
                </span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScenarioCard({ title, icon, data, color, isMain, description }: any) {
  const textColors = {
    red: "text-red-400",
    blue: "text-blue-400",
    green: "text-green-400"
  };

  const borderColor = isMain ? "border-blue-500" : "border-slate-800";

  // Handle impossible scenarios gracefully in card display
  if (!data.possible) {
    return (
      <div className={cn("rounded-xl border p-4 space-y-4 relative overflow-hidden bg-slate-950/50 opacity-60", borderColor)}>
         <div className="flex items-center justify-between">
          <div>
            <h3 className={cn("font-bold flex items-center gap-2", textColors[color as keyof typeof textColors])}>
              {icon} {title}
            </h3>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{description}</p>
          </div>
        </div>
        <div className="h-24 flex items-center justify-center text-xs text-slate-600">
          Not possible (0% rate)
        </div>
      </div>
    )
  }

  return (
    <div className={cn("rounded-xl border p-4 space-y-4 relative overflow-hidden", borderColor, isMain ? "bg-slate-900/80 shadow-lg shadow-blue-900/10" : "bg-slate-950")}>
      {isMain && <div className="absolute top-0 left-0 w-full h-1 bg-blue-500" />}
      
      <div className="flex items-center justify-between">
        <div>
          <h3 className={cn("font-bold flex items-center gap-2", textColors[color as keyof typeof textColors])}>
            {icon} {title}
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{description}</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex flex-col border-b border-slate-800/50 pb-2">
          <span className="text-xs text-slate-400">Required Budget ($)</span>
          {/* Increased Font Size */}
          <span className="text-2xl font-mono font-bold text-slate-200">{formatCurrency(data.budgetUSD)}</span>
        </div>

        <div className="flex flex-col border-b border-slate-800/50 pb-2">
          <span className="text-xs text-slate-400">Est. Revenue (₼)</span>
          {/* Increased Font Size */}
          <span className="text-xl font-mono text-slate-300">{formatCurrency(data.revenueAZN, 'AZN')}</span>
        </div>

        <div className="flex flex-col">
          <span className="text-xs text-slate-400 font-bold uppercase">Net Profit (₼)</span>
          {/* Increased Font Size */}
          <span className={cn("text-3xl font-mono font-bold", data.profitAZN > 0 ? "text-green-400" : "text-red-400")}>
            {formatCurrency(data.profitAZN, 'AZN')}
          </span>
        </div>
        
        <div className="pt-2 flex justify-between text-[10px] text-slate-500 font-mono">
          <span>ROAS: {formatNumber(data.roas, 2)}x</span>
          <span>Clicks: {formatNumber(data.clicks)}</span>
        </div>
      </div>
    </div>
  );
}
