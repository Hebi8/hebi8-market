/** Read path: bars for any key, synthetic ones included. Never touches the network. */
import type { RefSeries } from "@/indicators/formula";
import type { BarsTail, ChartBar } from "./api-types";
import { findItem, type Config } from "./config";
import { aggregate, align, applyPrices, hasWeekendBars, type Bar, type Prices } from "./series";
import { dayCloseAt, weekendTrading } from "./session";
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

/** Daily bars that are done: the last one is left out while its trading day is still going (`dayClosed`). */
export function closedReader(now = Date.now()): DailyReader {
  return (key) => {
    const bars = readDaily(key);
    const last = bars.at(-1);
    return last && !dayClosed(key, last.t, now) ? bars.slice(0, -1) : bars;
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

export function loadDaily(key: string, prices: Prices, cfg: Config, read: DailyReader = readDaily): Bar[] {
  if (!isSynthetic(key)) return applyPrices(read(key), prices);
  const synth = parseSynth(key.slice(1), cfg.aliases);
  const series = Object.fromEntries(synth.keys.map((k) => [k, applyPrices(read(k), prices)]));
  return evalSynth(synth, series);
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
  return { daily, weekends, bars, refs };
}

/** The last bar of a chart and the other symbols at it, for updating an open chart after a quote round. */
export function chartTail({ daily, weekends, bars, refs }: ChartData): BarsTail | null {
  const i = bars.length - 1;
  if (i < 0) return null;
  return {
    bar: bars[i],
    prev: bars[i - 1]?.timestamp ?? null,
    refs: Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, { o: r.o?.[i] ?? null, h: r.h?.[i] ?? null, l: r.l?.[i] ?? null, c: r.c[i], v: r.v?.[i] ?? null }])),
    lastDay: daily[daily.length - 1].t * 1000,
    weekends,
  };
}
