import { CHANGE_PERIODS, type ChangePeriod } from "./periods";
import { aggregate, closeAtOrBefore, type Bar } from "./series";
import { DAY } from "./time";

/** A boolean formula on one symbol (an alert's `when`). */
export interface ConditionResult {
  /** Last bar of the formula's timeframe (the unfinished one) and the one before it; null when undefined */
  now: boolean | null;
  prev: boolean | null;
  /** Time of the last bar the result is about; absent when the formula failed */
  t?: number;
  error?: string;
}

export interface Stats {
  last: number;
  lastTime: number;
  currency: string | null;
  /** Change versus the close at the start of each period; null when history is too short */
  changes: Record<ChangePeriod, number | null>;
  /** Distance from the all-time high close, <= 0 */
  ddAth: number;
  /** Position of the last close inside the trailing 52-week low/high range, 0..1 */
  pos52: number | null;
  /** Weekly closes for the last two years */
  spark: number[];
  /** Latest values of configured overview formula columns (`hebi8.yaml` `columns`), by column id */
  columns?: Record<string, number | null>;
}

function change(last: number, prev: number | undefined): number | null {
  return prev ? last / prev - 1 : null;
}

export function computeStats(daily: Bar[], extra: { currency?: string | null } = {}): Stats | null {
  const lastBar = daily.at(-1);
  if (!lastBar) return null;
  const { c: last, t } = lastBar;
  const yearStart = Date.UTC(new Date(t * 1000).getUTCFullYear(), 0, 1) / 1000;

  let ath = -Infinity;
  for (const bar of daily) ath = Math.max(ath, bar.c);

  let hi = -Infinity;
  let lo = Infinity;
  for (let i = daily.length - 1; i >= 0 && daily[i].t > t - 365 * DAY; i--) {
    hi = Math.max(hi, daily[i].h);
    lo = Math.min(lo, daily[i].l);
  }

  // closeAtOrBefore is undefined before the first bar, so short histories yield null
  const changes = Object.fromEntries(
    CHANGE_PERIODS.map(({ key, days }) => [
      key,
      change(last, closeAtOrBefore(daily, days === null ? yearStart - 1 : t - days * DAY)),
    ]),
  ) as Record<ChangePeriod, number | null>;

  return {
    last,
    lastTime: t,
    currency: extra.currency ?? null,
    changes,
    ddAth: last / ath - 1,
    pos52: hi > lo ? (last - lo) / (hi - lo) : null,
    spark: aggregate(daily.slice(-800), "W").slice(-104).map((bar) => bar.c),
  };
}

/** Decimal places that keep ~5 significant digits for typical prices. */
export function pricePrecision(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 10) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.01) return 5;
  return 8;
}
