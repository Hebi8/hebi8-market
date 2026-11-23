/** Read path: bars for any key, synthetic ones included. Never touches the network. */
import type { RefSeries } from "@/indicators/formula";
import type { BarsTail, ChartBar } from "./api-types";
import { findItem, type Config } from "./config";
import { aggregate, align, applyPrices, bucketStart, hasWeekendBars, nextBucketStart, yearOpens as computeYearOpens, type Bar, type Prices } from "./series";
import { dayCloseAt, latestCloseInRange, periodClose, weekendTrading } from "./session";
import { calendarOfRow, getSymbol, readDaily } from "./store";
import { isSynthetic, parseKey, type Timeframe } from "./symbols";
import { evalSynth, parseSynth } from "./synth";
import { DAY } from "./time";

/** Where daily bars come from: the cache, or for price alerts the cache plus today's bar from the latest quote. */
export type DailyReader = (key: string) => Bar[];

/**
 * Whether a real key's daily bar of trading day `t` is done on the clock: its exchange has closed
 * that day (at the earlier time on a half day, or the merged session close across a holiday), or
 * the UTC day is over for crypto. A dataset's rows are published values, done as they are.
 */
export function dayClosed(key: string, t: number, now = Date.now()): boolean {
  return parseKey(key).source === "data" || dayCloseAt(t, calendarOfRow(getSymbol(key))) <= now;
}

/** Whether a real key's daily bar of trading day `t` is closed AND not a stale pre-close intraday sync. */
function realDayFinal(key: string, t: number, now: number): boolean {
  if (parseKey(key).source === "data") return true;
  const row = getSymbol(key);
  const closeAt = dayCloseAt(t, calendarOfRow(row));
  if (closeAt > now) return false;
  if (row?.syncedAt != null && row.syncedAt < closeAt) return false;
  return true;
}

/** Daily bars that are done and synced: trailing bars whose trading day is still going or stale are left out. */
export function closedReader(now = Date.now(), base: DailyReader = readDaily): DailyReader {
  return (key) => {
    const bars = base(key);
    let end = bars.length;
    while (end > 0 && !realDayFinal(key, bars[end - 1].t, now)) end--;
    return end === bars.length ? bars : bars.slice(0, end);
  };
}

/**
 * Whether the daily bar of day `t` of any key is done on the clock (used by `get_bars`
 * `last_daily_bar.closed`). A synthetic bar is made of its operands' bars on or before that day
 * (the first operand's own, the others forward filled) as `read` gives them, and is done when
 * each of those is.
 */
export function barClosed(key: string, t: number, cfg: Config, read: DailyReader = readDaily, now = Date.now()): boolean {
  if (!isSynthetic(key)) return dayClosed(key, t, now);
  return parseSynth(key.slice(1), cfg.aliases).keys.every((k) => {
    const used = read(k).findLast((b) => b.t <= t);
    return !used || dayClosed(k, used.t, now);
  });
}

/**
 * Whether a real (non-synthetic) symbol's bars covering `[start, endExclusive)` are closed and
 * synced as of `now`. Returns `null` when the symbol has no scheduled trading in that range.
 *
 * When a symbol has a recorded `syncedAt` earlier than `close.closeAt`, the cache may still hold
 * an intraday partial bar (e.g. a post-close sync failed), so this returns `false` even when
 * `lastDaily.t >= close.day`.
 */
function realRangeClosed(
  key: string,
  start: number,
  endExclusive: number,
  isDaily: boolean,
  read: DailyReader,
  calendarWeekends: boolean,
  now: number,
  naturalEnd: number,
): boolean | null {
  if (parseKey(key).source === "data") return isDaily ? true : naturalEnd * 1000 <= now;
  const row = getSymbol(key);
  const calendar = calendarOfRow(row);
  const close = latestCloseInRange(start, endExclusive, calendar, calendarWeekends);
  if (!close) return null;
  if (close.closeAt > now) return false;
  if (row?.syncedAt != null && row.syncedAt < close.closeAt) return false;
  const lastDaily = read(key).at(-1);
  if (!lastDaily || lastDaily.t >= close.day) return true;
  // Cached daily bars stop before the period's expected closing trading day:
  // do not close on a 24x7 market missing its final day, on a sync error, or while the natural period is still running.
  if (calendar.hours === "24x7" || row?.syncError) return false;
  return naturalEnd * 1000 <= now;
}

/**
 * Whether a real symbol (secondary synthetic operand or formula ref) is final through
 * `[start, endExclusive)` as of `now`. When it has no trading scheduled in that range
 * (weekend / holiday), its most recent scheduled trading day before `endExclusive` must
 * be closed and synced so a failed pre-weekend sync cannot silently forward-fill an older bar.
 */
function operandClosedUntil(
  key: string,
  start: number,
  endExclusive: number,
  isDaily: boolean,
  naturalEnd: number,
  cfg: Config,
  read: DailyReader,
  now: number,
): boolean {
  const calWeekends = tradesWeekends(key, cfg, read);
  const res = realRangeClosed(key, start, endExclusive, isDaily, read, calWeekends, now, naturalEnd);
  if (res !== null) return res;
  const prior = realRangeClosed(key, start - 14 * DAY, endExclusive, false, read, calWeekends, now, naturalEnd);
  if (prior !== null) return prior;
  const used = read(key).findLast((b) => b.t < endExclusive);
  return !used || realDayFinal(key, used.t, now);
}

/**
 * Whether the bar of `tf` covering `[startDay, nextStartDay)` has finished trading and been synced
 * as of `now`.
 *
 * For a synthetic symbol `=A/B`, `A` defines the bucket's trading dates, so `A` must close the
 * bucket and each secondary operand `B` only needs to be final through `A`'s last trading day in
 * that bucket (e.g. `=SPY/BTC` on W closes once both SPY and BTC finish Friday, without waiting
 * for Sunday; `=BTC/SPY` waits for BTC's Sunday; `=JP/SPY` on D waits for SPY's same-day close).
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
  const start = bucketStart(startDay, tf, weekends);
  const next = nextBucketStart(start, tf, weekends);
  const isDaily = tf === "D";
  if (!isSynthetic(key)) {
    const calWeekends = tradesWeekends(key, cfg, read);
    const res = realRangeClosed(key, start, next, isDaily, read, calWeekends, now, next);
    if (res !== null) return res;
    // A daily bar that actually exists on a day the calendar considers off (e.g. an unrecorded trading day) did trade.
    return isDaily && read(key).some((b) => b.t === start) ? realDayFinal(key, start, now) : false;
  }
  const [first, ...rest] = parseSynth(key.slice(1), cfg.aliases).keys;
  if (!periodClosed(first, start, tf, cfg, read, weekends, now)) return false;
  let cutoff = next - DAY;
  if (isDaily) {
    cutoff = start;
  } else if (parseKey(first).source !== "data") {
    const firstClose = periodClose(start, tf, calendarOfRow(getSymbol(first)), weekends, tradesWeekends(first, cfg, read));
    const firstLast = read(first).findLast((b) => b.t >= start && b.t < next)?.t;
    cutoff = firstClose ? Math.min(firstClose.day, firstLast ?? firstClose.day) : (firstLast ?? start);
  }
  return rest.every((k) => operandClosedUntil(k, start, cutoff + DAY, isDaily, next, cfg, read, now));
}

/**
 * Whether a referenced symbol `refKey` (a formula's `program.refs`) is final for a main bar on
 * `[startDay, nextStartDay)` of `(tf, weekends)`. Uncached refs (no cached bars at all) return
 * true so they evaluate to NaN rather than hiding the main symbol's closed history.
 */
export function refPeriodClosed(
  refKey: string,
  startDay: number,
  tf: Timeframe,
  cfg: Config,
  read: DailyReader = readDaily,
  weekends = false,
  now = Date.now(),
): boolean {
  const start = bucketStart(startDay, tf, weekends);
  const next = nextBucketStart(start, tf, weekends);
  const isDaily = tf === "D";
  if (isSynthetic(refKey)) {
    try {
      if (loadDaily(refKey, "split", cfg, read).length === 0) return true;
    } catch {
      return true;
    }
    const [first, ...rest] = parseSynth(refKey.slice(1), cfg.aliases).keys;
    const firstRes = realRangeClosed(first, start, next, isDaily, read, tradesWeekends(first, cfg, read), now, next);
    if (firstRes === null) {
      const used = read(first).findLast((b) => b.t < next);
      if (!used) return true;
      return realDayFinal(first, used.t, now) && rest.every((k) => operandClosedUntil(k, used.t, used.t + DAY, true, used.t + DAY, cfg, read, now));
    }
    if (!firstRes) return false;
    return periodClosed(refKey, start, tf, cfg, read, weekends, now);
  }
  if (read(refKey).length === 0) return true;
  return operandClosedUntil(refKey, start, next, isDaily, next, cfg, read, now);
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

/**
 * Bars of `key` on `tf` whose period has closed as of `now` (unfinished trailing bar dropped).
 * Builds from the untrimmed `read` series before trimming so synthetic operands are never silently
 * forward-filled from yesterday while today's session is still open.
 */
export function closedSeries(
  key: string,
  tf: Timeframe,
  prices: Prices,
  cfg: Config,
  read: DailyReader = readDaily,
  weekends = tradesWeekends(key, cfg, read),
  now = Date.now(),
): Bar[] {
  return trimClosed(key, loadSeries(key, tf, prices, cfg, read, weekends), tf, cfg, read, weekends, now);
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

export interface ChartData {
  daily: Bar[];
  /** How its 3D bars count days (`tradesWeekends`) */
  weekends: boolean;
  bars: ChartBar[];
  refs: Record<string, RefSeries>;
  /** First daily bar's open per UTC calendar year, full precision to match server formula `yearopen` */
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
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v ?? undefined,
    bench: benchCloses?.[i] ?? undefined,
  }));
  const yearOpens = computeYearOpens(daily);
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
