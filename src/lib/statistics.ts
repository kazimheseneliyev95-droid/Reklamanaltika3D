/**
 * Calculates the Wilson Score Interval for a proportion.
 * This is much more accurate than the Normal Approximation (Wald) for small sample sizes
 * (e.g., ad clicks/conversions) and extreme probabilities (near 0% or 100%).
 * 
 * 🆕 IMPROVED: Better edge case handling and division by zero protection
 * 
 * @param count Number of successes (e.g., Messages)
 * @param total Number of trials (e.g., Clicks)
 * @param z Z-score (1.0 = 68%, 1.44 = 85%, 1.96 = 95%). Default 1.0 for "Expected Range"
 * @returns [low, high] percentages (0-100)
 */
export function calculateConfidenceInterval(count: number, total: number, z = 1.0): [number, number] {
  // 🆕 Guard clauses for edge cases
  if (total === 0 || isNaN(total)) {
    return [0, 0];
  }
  
  if (count < 0 || isNaN(count)) {
    return [0, 0];
  }

  if (count === 0) {
    return [0, 0]; // No successes means 0% confidence
  }

  if (count === total) {
    return [100, 100]; // All successes means 100% confidence
  }

  const p = count / total;
  const n = total;
  
  // 🆕 Validate z-score
  if (isNaN(z) || z <= 0) {
    z = 1.0;
  }

  try {
    // Wilson Score Interval Formula
    const factor1 = 1 / (1 + (z * z) / n);
    const factor2 = p + (z * z) / (2 * n);
    const factor3 = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));

    const low = factor1 * (factor2 - factor3);
    const high = factor1 * (factor2 + factor3);

    // Clamp between 0 and 100 with epsilon for floating point errors
    const epsilon = 0.0001;
    return [
      Math.max(0, Math.min(100, low * 100 + epsilon)), 
      Math.max(0, Math.min(100, high * 100 - epsilon))
    ];
  } catch (error) {
    console.error('Error calculating Wilson Score Interval:', error);
    // Fallback to simple normal approximation if Wilson fails
    return simpleConfidenceInterval(count, total, z);
  }
}

/**
 * Fallback simple confidence interval using normal approximation
 */
function simpleConfidenceInterval(count: number, total: number, z: number): [number, number] {
  if (total === 0 || count === 0) return [0, 0];
  if (count === total) return [100, 100];

  const p = count / total;
  const margin = z * Math.sqrt((p * (1 - p)) / total);

  const low = Math.max(0, p - margin) * 100;
  const high = Math.min(100, p + margin) * 100;

  return [low, high];
}

/**
 * Calculates the percentage contribution of each metric to the change in Sales.
 * Uses a simplified attribution model.
 * 
 * 🆕 IMPROVED: Better error handling and edge case management
 */
export function calculateDecomposition(
  current: { spend: number; cpc: number; msgRate: number; closeRate: number },
  benchmark: { spend: number; cpc: number; msgRate: number; closeRate: number }
): { spend: number; cpc: number; msgRate: number; closeRate: number } | null {
  // 🆕 Guard clauses
  if (!current || !benchmark) {
    return null;
  }

  // Check for zero or invalid values
  if (
    benchmark.spend <= 0 ||
    benchmark.cpc <= 0 ||
    benchmark.msgRate < 0 ||
    benchmark.closeRate < 0
  ) {
    console.warn('Decomposition: Invalid benchmark values');
    return null;
  }

  try {
    // Calculate raw % changes
    const spendDiff = benchmark.spend > 0 ? ((current.spend - benchmark.spend) / benchmark.spend) : 0;
    
    // CPC inverse: Higher CPC = Lower Sales
    // If CPC goes 1.0 -> 1.2 (+20%), Impact is roughly -16% (1/1.2 - 1)
    const cpcImpact = benchmark.cpc > 0 && current.cpc > 0 
      ? (benchmark.cpc / current.cpc) - 1 
      : 0;
    
    const msgRateDiff = benchmark.msgRate > 0 
      ? ((current.msgRate - benchmark.msgRate) / benchmark.msgRate) 
      : 0;

    const closeRateDiff = benchmark.closeRate > 0 
      ? ((current.closeRate - benchmark.closeRate) / benchmark.closeRate) 
      : 0;

    // Validate that we don't have Infinity or NaN
    const results = {
      spend: isFinite(spendDiff) ? spendDiff * 100 : 0,
      cpc: isFinite(cpcImpact) ? cpcImpact * 100 : 0,
      msgRate: isFinite(msgRateDiff) ? msgRateDiff * 100 : 0,
      closeRate: isFinite(closeRateDiff) ? closeRateDiff * 100 : 0
    };

    return results;
  } catch (error) {
    console.error('Error calculating decomposition:', error);
    return null;
  }
}

/**
 * 🆕 NEW: Calculates sample size required for desired confidence level
 */
export function calculateSampleSize(
  proportion: number,
  marginOfError: number,
  confidenceLevel: number = 0.95
): number {
  const z = confidenceLevel === 0.95 ? 1.96 : confidenceLevel === 0.99 ? 2.58 : 1.0;
  
  if (proportion <= 0 || proportion >= 1) {
    return 0;
  }

  try {
    const n = (z * z * proportion * (1 - proportion)) / (marginOfError * marginOfError);
    return Math.ceil(n);
  } catch (error) {
    console.error('Error calculating sample size:', error);
    return 0;
  }
}

/**
 * 🆕 NEW: Calculates statistical significance between two proportions
 */
export function calculateSignificance(
  count1: number,
  total1: number,
  count2: number,
  total2: number
): { zScore: number; pValue: number; isSignificant: boolean; significanceLevel: number } | null {
  if (total1 === 0 || total2 === 0) {
    return null;
  }

  const p1 = count1 / total1;
  const p2 = count2 / total2;
  const pooledP = (count1 + count2) / (total1 + total2);
  
  try {
    const se = Math.sqrt(pooledP * (1 - pooledP) * (1/total1 + 1/total2));
    
    if (se === 0) {
      return null;
    }

    const zScore = (p1 - p2) / se;
    const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));
    const isSignificant = pValue < 0.05;
    
    return {
      zScore,
      pValue,
      isSignificant,
      significanceLevel: isSignificant ? 0.95 : 0
    };
  } catch (error) {
    console.error('Error calculating significance:', error);
    return null;
  }
}

/**
 * Normal Cumulative Distribution Function
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Thresholds for data quality and health checks
 */
export const THRESHOLDS = {
  LOW_DATA_CLICKS: 100,
  LOW_DATA_MESSAGES: 10,
  WARNING_VARIANCE: -15, // % drop to trigger yellow
  CRITICAL_VARIANCE: -25, // % drop to trigger red
  
  // 🆕 NEW: Confidence level thresholds
  HIGH_CONFIDENCE: 95,
  MEDIUM_CONFIDENCE: 85,
  LOW_CONFIDENCE: 68,

  // 🆕 NEW: Statistical significance thresholds
  SIGNIFICANCE_ALPHA: 0.05,
  HIGH_SIGNIFICANCE_ALPHA: 0.01
} as const;

/**
 * 🆕 NEW: Assess data quality based on sample size
 */
export function assessDataQuality(clicks: number, messages: number): {
  level: 'high' | 'medium' | 'low';
  confidence: string;
  recommendation: string;
} {
  if (clicks >= THRESHOLDS.LOW_DATA_CLICKS && messages >= THRESHOLDS.LOW_DATA_MESSAGES) {
    return {
      level: 'high',
      confidence: '95% confidence level',
      recommendation: 'Data quality is good. Statistical analysis is reliable.'
    };
  } else if (clicks >= THRESHOLDS.LOW_DATA_CLICKS / 2) {
    return {
      level: 'medium',
      confidence: '85% confidence level',
      recommendation: 'Data quality is acceptable. Results have some uncertainty.'
    };
  } else {
    return {
      level: 'low',
      confidence: '68% confidence level',
      recommendation: 'Insufficient data. Collect more data for reliable analysis.'
    };
  }
}

/**
 * 🆕 NEW: Calculate minimum sample size for reliable analysis
 */
export function calculateMinSampleSize(confidenceLevel: number = 0.95, marginOfError: number = 0.05): number {
  const z = confidenceLevel === 0.95 ? 1.96 : confidenceLevel === 0.99 ? 2.58 : 1.0;
  const n = Math.ceil((z * z * 0.25) / (marginOfError * marginOfError));
  return n;
}
