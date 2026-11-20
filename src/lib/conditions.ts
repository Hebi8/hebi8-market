import { compile, evaluate, type OhlcvBar, type Program } from "@/indicators/formula";
import { describeError } from "@/indicators/formula-indicators";
import { loadRefs, loadSeries, tradesWeekends, type DailyReader } from "./bars";
import { findItem, type Config } from "./config";
import type { Bar } from "./series";
import type { ConditionResult } from "./stats";
import { readDaily } from "./store";
import type { Timeframe } from "./symbols";

export const toOhlcv = (bars: Bar[]): OhlcvBar[] =>
  bars.map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? undefined }));

/**
 * What a formula's value on a bar counts as: nothing where it has none (NaN: not enough bars, a
 * symbol without data), else true unless it is 0. An infinite value (a division by zero) is a
 * value, and true. Alerts, `scan` and `test_formula` all go by this one.
 */
export const holds = (v: number | undefined): boolean | null => (v === undefined || Number.isNaN(v) ? null : v !== 0);

/** Series per timeframe for one key, loaded once and shared by every rule on that key. */
export type SeriesCache = Map<Timeframe, Bar[]>;

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
export function runFormula(key: string, formula: string, tf: Timeframe, cfg: Config, read: DailyReader = readDaily, cache: SeriesCache = new Map()): { bars: Bar[]; line: number[] } {
  const program = compileFor(formula, cfg, findItem(cfg, key)?.bench ?? null);
  let bars = cache.get(tf);
  if (!bars) {
    bars = loadSeries(key, tf, cfg.prices, cfg, read);
    cache.set(tf, bars);
  }
  const refs = loadRefs(bars, tradesWeekends(key, cfg, read), program.refs, tf, cfg.prices, cfg, read);
  return { bars, line: evaluate(program, { bars: toOhlcv(bars), refs }).at(-1)! };
}

/** One boolean formula on the last two bars of `tf`, as an alert judges it; `t` is the time of the last bar. */
export function evalRule(key: string, formula: string, tf: Timeframe, cfg: Config, cache: SeriesCache = new Map(), read: DailyReader = readDaily): ConditionResult {
  try {
    const { bars, line } = runFormula(key, formula, tf, cfg, read, cache);
    const t = bars.at(-1)?.t;
    return { now: holds(line.at(-1)), prev: holds(line.at(-2)), ...(t !== undefined ? { t } : {}) };
  } catch (err) {
    return { now: null, prev: null, error: describeError(err) };
  }
}
