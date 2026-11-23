import { compile, evaluate, type OhlcvBar, type Program } from "@/indicators/formula";
import { describeError } from "@/indicators/formula-indicators";
import { closedReader, loadDaily, loadRefs, tradesWeekends, trimClosed, type DailyReader } from "./bars";
import { findItem, type Config } from "./config";
import { aggregate, yearOpens as computeYearOpens, type Bar } from "./series";
import type { ConditionResult } from "./stats";
import { readDaily } from "./store";
import type { Timeframe } from "./symbols";

export const toOhlcv = (bars: Bar[]): OhlcvBar[] =>
  bars.map((b) => ({ timestamp: b.t * 1000, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? undefined }));

/**
 * What a formula's value on a bar counts as: nothing where it has none (NaN: not enough bars, a
 * symbol without data), else true unless it is 0. An infinite value (a division by zero) is a
 * value, and true. Alerts, `scan` and `test_formula` all go by this one.
 */
export const holds = (v: number | undefined): boolean | null => (v === undefined || Number.isNaN(v) ? null : v !== 0);

/** Options for `runFormula` / `evalRule`. With `closed`, unfinished bars of `tf` as of `now` are dropped and refs read closed daily bars. */
export interface FormulaOptions {
  closed?: boolean;
  now?: number;
}

/** Loaded series for one key on one timeframe, shared by every rule on that key and check mode. */
export interface CachedSeries {
  daily: Bar[];
  bars: Bar[];
  weekends: boolean;
  yearOpens: Record<number, number>;
}

/** Series per timeframe for one key, loaded once and shared by every rule on that key. */
export type SeriesCache = Map<Timeframe, CachedSeries>;

/** A formula compiled for `key` (`bench` is its own benchmark); a formula that does not compile throws its message as the person reads it. */
export function compileFor(formula: string, cfg: Config, bench?: string | null): Program {
  try {
    return compile(formula, { aliases: cfg.aliases, bench });
  } catch (err) {
    throw new Error(describeError(err));
  }
}

/**
 * A formula over all of `key`'s bars on `tf`, the last line of it: the one evaluation alerts,
 * `scan` and `test_formula` share, so a formula sees the same bars and the same aligned
 * references wherever it runs. A multi-statement formula counts by its last statement.
 */
export function runFormula(
  key: string,
  formula: string,
  tf: Timeframe,
  cfg: Config,
  read: DailyReader = readDaily,
  cache: SeriesCache = new Map(),
  opts: FormulaOptions = {},
): { bars: Bar[]; daily: Bar[]; weekends: boolean; line: number[] } {
  const program = compileFor(formula, cfg, findItem(cfg, key)?.bench ?? null);
  const now = opts.now ?? Date.now();
  const effectiveRead = opts.closed ? closedReader(now, read) : read;
  let entry = cache.get(tf);
  if (!entry) {
    const daily = loadDaily(key, cfg.prices, cfg, effectiveRead);
    const weekends = tradesWeekends(key, cfg, effectiveRead);
    const series = aggregate(daily, tf, weekends);
    const bars = opts.closed ? trimClosed(key, series, tf, cfg, effectiveRead, weekends, now) : series;
    entry = { daily, bars, weekends, yearOpens: computeYearOpens(daily) };
    cache.set(tf, entry);
  }
  const refs = loadRefs(entry.bars, entry.weekends, program.refs, tf, cfg.prices, cfg, effectiveRead);
  return {
    bars: entry.bars,
    daily: entry.daily,
    weekends: entry.weekends,
    line: evaluate(program, { bars: toOhlcv(entry.bars), refs, yearOpens: entry.yearOpens }).at(-1)!,
  };
}

/** One boolean formula on the last two bars of `tf`, as an alert judges it; `t` is the time of the last bar. */
export function evalRule(
  key: string,
  formula: string,
  tf: Timeframe,
  cfg: Config,
  cache: SeriesCache = new Map(),
  read: DailyReader = readDaily,
  opts: FormulaOptions = {},
): ConditionResult {
  try {
    const { bars, line } = runFormula(key, formula, tf, cfg, read, cache, opts);
    const t = bars.at(-1)?.t;
    return { now: holds(line.at(-1)), prev: holds(line.at(-2)), ...(t !== undefined ? { t } : {}) };
  } catch (err) {
    return { now: null, prev: null, error: describeError(err) };
  }
}
