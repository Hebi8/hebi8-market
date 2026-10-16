import { compile, evaluate, type OhlcvBar } from "@/indicators/formula";
import { describeError } from "@/indicators/formula-indicators";
import { loadRefs, loadSeries, tradesWeekends, type DailyReader } from "./bars";
import { findItem, type Config } from "./config";
import type { Bar } from "./series";
import type { ConditionResult } from "./stats";
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

/** One boolean formula on the last two bars of `tf`; `t` is the time of the last bar. */
export function evalRule(key: string, formula: string, tf: Timeframe, cfg: Config, cache: SeriesCache = new Map(), read?: DailyReader): ConditionResult {
  try {
    const program = compile(formula, { aliases: cfg.aliases, bench: findItem(cfg, key)?.bench ?? null });
    let bars = cache.get(tf);
    if (!bars) {
      bars = loadSeries(key, tf, cfg.prices, cfg, read);
      cache.set(tf, bars);
    }
    const refs = loadRefs(bars, tradesWeekends(key, cfg, read), program.refs, tf, cfg.prices, cfg, read);
    const line = evaluate(program, { bars: toOhlcv(bars), refs }).at(-1)!;
    const t = bars.at(-1)?.t;
    return { now: holds(line.at(-1)), prev: holds(line.at(-2)), ...(t !== undefined ? { t } : {}) };
  } catch (err) {
    return { now: null, prev: null, error: describeError(err) };
  }
}
