import type { Timeframe } from "./symbols";
import { DAY } from "./time";

export interface Bar {
  /** Unix seconds at UTC midnight of the trading day (or of the 3D/week/month/quarter start) */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  /** Dividend adjustment factor; o/h/l/c are split-adjusted only, total return = price × adj */
  adj: number;
}

export type Prices = "split" | "total";

/** Sort by time and keep the last bar for each timestamp. */
export function dedupeBars(bars: Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.t, bar);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Days from 1970-01-01 to Monday 1970-01-05, where 3D bars start counting. */
const EPOCH_MONDAY = 4;

/** Whether any of the bars is on a Saturday or Sunday: how 3D counts a series nothing else is known of (`tradesWeekends` in bars.ts). */
export function hasWeekendBars(bars: Bar[]): boolean {
  return bars.some(({ t }) => {
    const day = new Date(t * 1000).getUTCDay();
    return day === 0 || day === 6;
  });
}

/**
 * The first day of the 3D bar a day is in: days counted in threes from Monday 1970-01-05, weekdays
 * only (a weekend day goes with the Friday before) unless the series trades on weekends. Fixed
 * days, so a new day never moves an earlier bar and every symbol counted alike has the same bars;
 * a holiday leaves its bar a day short.
 */
function threeDayStart(t: number, weekends: boolean): number {
  const days = Math.floor(t / DAY) - EPOCH_MONDAY;
  if (weekends) return (Math.floor(days / 3) * 3 + EPOCH_MONDAY) * DAY;
  const weeks = Math.floor(days / 7);
  // the bar's first weekday, counted from 1970-01-05, back to a date
  const first = Math.floor((weeks * 5 + Math.min(days - weeks * 7, 4)) / 3) * 3;
  const firstWeeks = Math.floor(first / 5);
  return (firstWeeks * 7 + first - firstWeeks * 5 + EPOCH_MONDAY) * DAY;
}

export function bucketStart(t: number, tf: Timeframe, weekends = false): number {
  if (tf === "D") return t;
  if (tf === "3D") return threeDayStart(t, weekends);
  const date = new Date(t * 1000);
  if (tf === "W") {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    return t - daysSinceMonday * DAY;
  }
  const month = date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), tf === "Q" ? Math.floor(month / 3) * 3 : month, 1) / 1000;
}

/**
 * Aggregate ascending daily bars into 3D, weekly (Monday-start), monthly or quarterly bars. `weekends`
 * says how 3D counts days: the symbol's own way, or for another symbol compared on a chart the chart's.
 */
export function aggregate(daily: Bar[], tf: Timeframe, weekends = hasWeekendBars(daily)): Bar[] {
  if (tf === "D") return daily;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const bar of daily) {
    const t = bucketStart(bar.t, tf, weekends);
    if (!cur || cur.t !== t) {
      cur = { ...bar, t };
      out.push(cur);
      continue;
    }
    cur.h = Math.max(cur.h, bar.h);
    cur.l = Math.min(cur.l, bar.l);
    cur.c = bar.c;
    cur.adj = bar.adj;
    cur.v = cur.v === null && bar.v === null ? null : (cur.v ?? 0) + (bar.v ?? 0);
  }
  return out;
}

/** `total` folds dividends into the prices; `split` returns the bars untouched. */
export function applyPrices(bars: Bar[], prices: Prices): Bar[] {
  if (prices !== "total") return bars;
  return bars.map((b) =>
    b.adj === 1 ? b : { ...b, o: b.o * b.adj, h: b.h * b.adj, l: b.l * b.adj, c: b.c * b.adj, adj: 1 },
  );
}

/**
 * For each target bar, the other series' bar on the same day or the latest one before it
 * (forward fill: crypto trades on days stocks do not). Null before the other series starts.
 */
export function align(target: Bar[], other: Bar[]): (Bar | null)[] {
  const out: (Bar | null)[] = [];
  let j = 0;
  let last: Bar | null = null;
  for (const bar of target) {
    while (j < other.length && other[j].t <= bar.t) last = other[j++];
    out.push(last);
  }
  return out;
}

/** Close of the latest bar at or before `t`, via binary search over ascending bars. */
export function closeAtOrBefore(bars: Bar[], t: number): number | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  let found: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) {
      found = bars[mid].c;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
