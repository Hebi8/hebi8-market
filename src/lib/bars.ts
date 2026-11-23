/** Read path: bars for any key, synthetic ones included. Never touches the network. */
import type { RefSeries } from "@/indicators/formula";
import type { BarsTail, ChartBar } from "./api-types";
import { findItem, type Config } from "./config";
import { aggregate, align, applyPrices, hasWeekendBars, nextBucketStart, yearOpens as computeYearOpens, type Bar, type Prices } from "./series";
import { dayCloseAt, periodClose, weekendTrading } from "./session";
import { calendarOfRow, getSymbol, readDaily } from "./store";
import { isSynthetic, parseKey, type Timeframe } from "./symbols";
import { evalSynth, parseSynth } from "./synth";

/** Where daily bars come from: the cache, or for price alerts the cache plus today's bar from the latest quote. */
export type DailyReader = (key: string) => Bar[];

/**
 * Whether a real key's daily bar of trading day `t` is done: its exchange has closed that day (at
 * the earlier time on a half day), or the UTC day is over for crypto. A dataset's rows are
 * published values, done as they are.
 */
export function dayClosed(key: string, t: number, now = Date.now()): boolean {
  return parseKey(key).source === "data" || dayCloseAt(t, calendarOfRow(getSymbol(key))) <= now;
}

/** Daily bars that are done: trailing bars whose trading day is still going are left out (`dayClosed`). */
export function closedReader(now = Date.now(), base: DailyReader = readDaily): DailyReader {
  return (key) => {
    const bars = base(key);
    let end = bars.length;
    while (end > 0 && !dayClosed(key, bars[end - 1].t, now)) end--;
    return end === bars.length ? bars : bars.slice(0, end);
  };
}

/**
 * Whether the daily bar of day `t` of any key is done. A synthetic bar is made of its operands'
 * bars on or before that day (the first operand's own, the others forward filled) as `read` gives
 * them, and is done when each of those is.
 */
export function barClosed(key: string, t: number, cfg: Config, read: DailyReader = readDaily, now = Date.now()): boolean {
  if (!isSynthetic(key)) return dayClosed(key, t, now);
  return parseSynth(key.slice(1), cfg.aliases).keys.every((k) => {
    const used = read(k).findLast((b) => b.t <= t);
    return !used || dayClosed(k, used.t, now);
  });
}

function realPeriodClosed(key: string, startDay: number, tf: Timeframe, read: DailyReader, weekends: boolean, now: number): boolean {
  if (tf === "D") return dayClosed(key, startDay, now);
  if (parseKey(key).source === "data") return nextBucketStart(startDay, tf, weekends) * 1000 <= now;
  const row = getSymbol(key);
  const calendar = calendarOfRow(row);
  const close = periodClose(startDay, tf, calendar, weekends);
  if (!close || close.closeAt > now) return false;
  const lastDaily = read(key).at(-1);
  if (!lastDaily || lastDaily.t >= close.day) return true;
  // Cached daily bars stop before the period's expected closing trading day:
  // do not close on a failed/stale sync, on a 24x7 market missing its final day,
  // or while the natural period is still running (upstream lag).
  if (calendar.hours === "24x7" || row?.syncError || (row?.syncedAt != null && row.syncedAt < close.closeAt)) return false;
  return nextBucketStart(startDay, tf, weekends) * 1000 <= now;
}

/**
 * Whether the bar of `tf` covering `[startDay, nextStartDay)` has finished trading as of `now`.
 * Daily bars follow `barClosed`; higher timeframes wait for the last trading day in the bucket
 * to close (every operand for a synthetic symbol; `nextStartDay` UTC for a `data:` dataset).
 */
export function periodClosed(
  key: string,
  startDay: number,
  tf: Timeframe,
  cfg: Config,
  read: DailyReader = readDaily,
  weekends = tradesWeekends(key, cfg, read),
  now = Date.now(),
): boolean {
  if (tf === "D") return barClosed(key, startDay, cfg, read, now);
  if (!isSynthetic(key)) return realPeriodClosed(key, startDay, tf, read, weekends, now);
  const next = nextBucketStart(startDay, tf, weekends);
  let anyScheduled = false;
  for (const k of parseSynth(key.slice(1), cfg.aliases).keys) {
    if (parseKey(k).source === "data") {
      anyScheduled = true;
      if (next * 1000 > now) return false;
      continue;
    }
    const close = periodClose(startDay, tf, calendarOfRow(getSymbol(k)), weekends);
    if (!close) {
      // Operand has no trading days in this bucket (e.g. a holiday week): its last used bar before `next` must be closed.
      const used = read(k).findLast((b) => b.t < next);
      if (used && !dayClosed(k, used.t, now)) return false;
      continue;
    }
    anyScheduled = true;
    if (!realPeriodClosed(k, startDay, tf, read, weekends, now)) return false;
  }
  return anyScheduled;
}

/** Drop trailing bars whose period has not closed yet as of `now`. */
export function trimClosed(
  key: string,
  bars: Bar[],
  tf: Timeframe,
  cfg: Config,
  read: DailyReader = readDaily,
  weekends = tradesWeekends(key, cfg, read),
  now = Date.now(),
): Bar[] {
  let end = bars.length;
  while (end > 0 && !periodClosed(key, bars[end - 1].t, tf, cfg, read, weekends, now)) end--;
  return end === bars.length ? bars : bars.slice(0, end);
}

/** Bars of `key` on `tf` whose period has closed as of `now` (unfinished trailing bar dropped). */
export function closedSeries(
  key: string,
  tf: Timeframe,
  prices: Prices,
  cfg: Config,
  read?: DailyReader,
  weekends?: boolean,
  now = Date.now(),
): Bar[] {
  const effectiveRead = closedReader(now, read);
  const w = weekends ?? tradesWeekends(key, cfg, effectiveRead);
  return trimClosed(key, loadSeries(key, tf, prices, cfg, effectiveRead, w), tf, cfg, effectiveRead, w, now);
}

export function loadDaily(key: string, prices: Prices, cfg: Config, read: DailyReader = readDaily): Bar[] {
  if (!isSynthetic(key)) return applyPrices(read(key), prices);
  const synth = parseSynth(key.slice(1), cfg.aliases);
  const series = Object.fromEntries(synth.keys.map((k) => [k, applyPrices(read(k), prices)]));
  return evalSynth(synth, series);
}

/** An input of a key's last daily bar: the symbol (a real key itself, else an operand) and the day of the bar of it used. */
export type BarInput = { key: string; t: number };

/**
 * What the last of a key's daily bars is made of: a real key's own bar; a synthetic key's bar is
 * on its first operand's day, with each other operand's bar of that day or the last one before
 * (forward-filled, `evalSynth`). Empty without bars.
 */
export function lastInputs(key: string, bars: Bar[], aliases: Record<string, string>, read: DailyReader = readDaily): BarInput[] {
  const last = bars.at(-1);
  if (!last) return [];
  if (!isSynthetic(key)) return [{ key, t: last.t }];
  return parseSynth(key.slice(1), aliases).keys.map((k) => ({ key: k, t: read(k).findLast((b) => b.t <= last.t)!.t }));
}

/** Why a synthetic key has no bars: each operand without any, with its sync error. */
export function synthNoData(key: string, cfg: Config, syncError: (key: string) => string | null, read: DailyReader = readDaily): string {
  const missing = parseSynth(key.slice(1), cfg.aliases).keys.filter((k) => read(k).length === 0);
  if (missing.length === 0) return "各操作数的日期没有重叠";
  return missing.map((k) => `${k}：${syncError(k) ?? "暂无数据，等待同步"}`).join("；");
}

/**
 * Whether a key's 3D bars count calendar days rather than weekdays (§3.2), from what the symbol is,
 * not from its latest bars: crypto and a market with weekend sessions do; with no hours known (a
 * dataset, a symbol not synced yet), a series with any weekend bar does. A synthetic key counts the
 * way its first operand does, whose days it has.
 */
export function tradesWeekends(key: string, cfg: Config, read: DailyReader = readDaily): boolean {
  if (isSynthetic(key)) return tradesWeekends(parseSynth(key.slice(1), cfg.aliases).keys[0], cfg, read);
  const row = getSymbol(key);
  if (row?.kind === "crypto" || row?.kind === "cryptocurrency") return true;
  return weekendTrading(calendarOfRow(row)) ?? hasWeekendBars(read(key));
}

/** A key's bars on `tf`; on 3D counted its own way, or as given (another symbol on a chart counts the chart's way). */
export function loadSeries(key: string, tf: Timeframe, prices: Prices, cfg: Config, read: DailyReader = readDaily, weekends = tradesWeekends(key, cfg, read)): Bar[] {
  return aggregate(loadDaily(key, prices, cfg, read), tf, weekends);
}

/**
 * Other symbols aligned to `bars`, as the columns the formula engine and the chart consume. On 3D
 * they count days the way the chart's symbol does (`weekends`), so their bars start on the same days.
 */
export function loadRefs(bars: Bar[], weekends: boolean, keys: string[], tf: Timeframe, prices: Prices, cfg: Config, read: DailyReader = readDaily): Record<string, RefSeries> {
  const refs: Record<string, RefSeries> = {};
  for (const key of new Set(keys)) {
    let other: Bar[];
    try {
      other = loadSeries(key, tf, prices, cfg, read, weekends);
    } catch {
      continue;
    }
    const aligned = align(bars, other);
    refs[key] = {
      o: aligned.map((b) => b?.o ?? null),
      h: aligned.map((b) => b?.h ?? null),
      l: aligned.map((b) => b?.l ?? null),
      c: aligned.map((b) => b?.c ?? null),
      v: aligned.map((b) => b?.v ?? null),
    };
  }
  return refs;
}

/** Trim float noise from adjusted prices to keep the payload small. */
const round = (x: number) => Number(x.toPrecision(8));

export interface ChartData {
  daily: Bar[];
  /** How its 3D bars count days (`tradesWeekends`) */
  weekends: boolean;
  bars: ChartBar[];
  refs: Record<string, RefSeries>;
  /** First daily bar's open per UTC calendar year, rounded like `bars`, for formula `yearopen` */
  yearOpens: Record<number, number>;
}

/** What the chart draws for a key: its bars on a timeframe with the benchmark's close, and the other symbols aligned to them. */
export function loadChart(key: string, tf: Timeframe, prices: Prices, withKeys: string[], cfg: Config, read: DailyReader = readDaily): ChartData {
  const daily = loadDaily(key, prices, cfg, read);
  const bench = findItem(cfg, key)?.bench ?? null;
  const weekends = tradesWeekends(key, cfg, read);
  const series = aggregate(daily, tf, weekends);
  const refs = loadRefs(series, weekends, [...withKeys, ...(bench && bench !== key ? [bench] : [])], tf, prices, cfg, read);
  const benchCloses = bench ? refs[bench]?.c : undefined;
  const bars = series.map((b, i) => ({
    timestamp: b.t * 1000,
    open: round(b.o),
    high: round(b.h),
    low: round(b.l),
    close: round(b.c),
    volume: b.v ?? undefined,
    bench: benchCloses?.[i] != null ? round(benchCloses[i]!) : undefined,
  }));
  const yearOpens = Object.fromEntries(Object.entries(computeYearOpens(daily)).map(([y, o]) => [y, round(o)]));
  return { daily, weekends, bars, refs, yearOpens };
}

/** The last bar of a chart and the other symbols at it, for updating an open chart after a quote round. */
export function chartTail({ daily, weekends, bars, refs, yearOpens }: ChartData): BarsTail | null {
  const i = bars.length - 1;
  if (i < 0) return null;
  const yearOpen = yearOpens[new Date(bars[i].timestamp).getUTCFullYear()];
  return {
    bar: bars[i],
    prev: bars[i - 1]?.timestamp ?? null,
    refs: Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, { o: r.o?.[i] ?? null, h: r.h?.[i] ?? null, l: r.l?.[i] ?? null, c: r.c[i], v: r.v?.[i] ?? null }])),
    lastDay: daily[daily.length - 1].t * 1000,
    weekends,
    ...(yearOpen !== undefined ? { yearOpen } : {}),
  };
}
