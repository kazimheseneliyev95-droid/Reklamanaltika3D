import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, currency: 'USD' | 'AZN' = 'USD') {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value).replace('AZN', '₼');
}

export function toNumberSafe(input: any, fallback = 0): number {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : fallback;
  }

  const raw = String(input ?? '').trim();
  if (!raw) return fallback;

  // Keep digits, separators, and sign; drop currency symbols and other text.
  let s = raw.replace(/[^0-9,.-]/g, '');

  // If both separators exist, treat the last one as decimal and remove the other.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('');
    if (dec === ',') s = s.replace(',', '.');
  } else if (lastComma !== -1 && lastDot === -1) {
    // Single comma: assume it's decimal separator
    s = s.replace(',', '.');
  } else {
    // Single dot or none: ok
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

export function formatNumber(value: number, decimals = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, decimals = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}
