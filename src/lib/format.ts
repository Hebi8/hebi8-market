import type { ColumnFormat } from "./columns";
import type { QuoteSession } from "./sources/types";
import { pricePrecision } from "./stats";

export function fmtPrice(value: number, precision = pricePrecision(value)): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = value * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(digits)}%`;
}

/** Format a custom overview formula column's latest value (`pct` expects percentage points, e.g. `roc()`). */
export function fmtColumnValue(value: number | null | undefined, format: ColumnFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (format === "pct") {
    const rounded = Math.round(value * 10) / 10;
    const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
    return `${sign}${Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }
  if (format === "ratio") {
    const digits = abs >= 100 ? 1 : 2;
    const factor = 10 ** digits;
    const rounded = Math.round(value * factor) / factor;
    const sign = rounded < 0 ? "−" : "";
    return `${sign}${Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}x`;
  }
  const digits = abs >= 10000 ? 0 : abs >= 1000 ? 1 : abs === 0 || abs >= 0.01 ? 2 : 4;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const sign = rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** 「3 分钟前同步」; `what` is what happened then (empty for just 「3 分钟前」). */
export function fmtAgo(ms: number | null, what = "同步"): string {
  if (!ms) return `从未${what}`;
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return `刚刚${what}`;
  if (minutes < 60) return `${minutes} 分钟前${what}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前${what}`;
  return `${Math.round(hours / 24)} 天前${what}`;
}

/** A quote's session, in the chart's status strip and next to the overview's price */
export const SESSION_LABELS: Record<QuoteSession, string> = { open: "盘中", pre: "盘前", post: "盘后", closed: "休市", always: "24h" };

/** Tailwind text color for a signed change. */
export function changeColor(value: number | null | undefined): string {
  if (value == null || value === 0) return "text-muted";
  return value > 0 ? "text-up" : "text-down";
}
