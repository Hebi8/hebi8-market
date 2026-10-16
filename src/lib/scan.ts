/**
 * A formula tried out on cached bars before it becomes an alert or an indicator: across symbols
 * (`scan`) or back through one symbol's history (`testFormula`). Like every read, nothing is
 * fetched: a symbol without cached bars is reported, not synced. A formula with several
 * statements counts by its last one, as an alert's `when` does.
 */
import { compile, evaluate, type Program } from "@/indicators/formula";
import { describeError } from "@/indicators/formula-indicators";
import type { AlertCheck } from "./alert-conds";
import { closedReader, loadRefs, loadSeries, type DailyReader } from "./bars";
import { holds, toOhlcv } from "./conditions";
import { findItem, type Config } from "./config";
import { fmtDate } from "./format";
import { nameOf } from "./names";
import { liveReader } from "./quotes";
import type { Bar } from "./series";
import { getSymbol } from "./store";
import { isSynthetic, type Timeframe } from "./symbols";

/** The bars an alert with this `check` is judged on: with today's unfinished bar, or closed daily bars only. */
export const readerFor = (check: AlertCheck): DailyReader => (check === "close" ? closedReader() : liveReader());

/**
 * A formula's value as a reply can carry it. JSON has no infinity, so an infinite value (a
 * division by zero) is the string `"Infinity"` or `"-Infinity"`: it is a value, and true like any
 * other that is not 0 (`holds`). null is no value at all: not enough bars, a symbol without data.
 */
export type ScanValue = number | "Infinity" | "-Infinity" | null;

const shown = (v: number | undefined): ScanValue => (v === undefined || Number.isNaN(v) ? null : v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : Number(v.toPrecision(10)));

function checked(formula: string, cfg: Config, bench?: string | null): Program {
  try {
    return compile(formula, { aliases: cfg.aliases, bench });
  } catch (err) {
    throw new Error(describeError(err));
  }
}

/** The formula's last line over all of `key`'s bars on `tf`. */
function run(key: string, formula: string, tf: Timeframe, cfg: Config, read: DailyReader): { bars: Bar[]; line: number[] } {
  const program = checked(formula, cfg, findItem(cfg, key)?.bench ?? null);
  const bars = loadSeries(key, tf, cfg.prices, cfg, read);
  if (bars.length === 0) throw new Error(isSynthetic(key) ? "合成不出数据：操作数没有缓存的日线或日期不重叠" : "没有缓存的日线");
  const refs = loadRefs(bars, program.refs, tf, cfg.prices, cfg, read);
  return { bars, line: evaluate(program, { bars: toOhlcv(bars), refs }).at(-1)! };
}

export interface ScanRow {
  key: string;
  name: string;
  /** On the last bar and the one before it */
  value: ScanValue;
  prev: ScanValue;
  /** Whether it is true on the last bar and was on the one before, as an alert judges it (`holds`); null without a value */
  holds: boolean | null;
  held: boolean | null;
  /** The last bar's date (the start of its 3D bar, week, month or quarter) */
  date: string | null;
  error?: string;
}

export interface ScanResult {
  rows: ScanRow[];
  /** Symbols the formula reads (`close(X)`) that have no cached bars, so what depends on them has no value */
  uncached: string[];
}

/** One formula on each of `keys` (resolved keys); a formula that does not compile at all throws. */
export function scan(cfg: Config, keys: string[], formula: string, tf: Timeframe, read: DailyReader): ScanResult {
  // `bench` is each symbol's own, so it is only checked per symbol
  const program = checked(formula, cfg);
  const rows = keys.map((key): ScanRow => {
    const name = nameOf(cfg, key, getSymbol(key)?.name);
    try {
      const { bars, line } = run(key, formula, tf, cfg, read);
      return { key, name, value: shown(line.at(-1)), prev: shown(line.at(-2)), holds: holds(line.at(-1)), held: holds(line.at(-2)), date: fmtDate(bars.at(-1)!.t) };
    } catch (err) {
      return { key, name, value: null, prev: null, holds: null, held: null, date: null, error: describeError(err) };
    }
  });
  return { rows, uncached: program.refs.filter((k) => !isSynthetic(k) && read(k).length === 0) };
}

/** As many of the newest entries as a reply should carry */
const MAX_LISTED = 60;

export interface FormulaTest {
  key: string;
  name: string;
  /** The window looked at: its bar count and first and last dates */
  bars: number;
  from: string;
  to: string;
  value: ScanValue;
  prev: ScanValue;
  /** Bars in the window where the formula is true (`holds`), and where it has no value */
  trueBars: number;
  unknownBars: number;
  /** Bars where it turned true after being false: when a `when` alert would have fired */
  turnedTrue: { count: number; dates: string[] };
  /** Runs of true bars, newest last */
  trueRanges: { count: number; ranges: { from: string; to: string; bars: number }[] };
  /** The last few values, oldest first */
  recent: { date: string; value: ScanValue }[];
}

/**
 * How a formula behaved over the last `window` bars of one symbol. 由假变真 follows the alert
 * rule (`decide`): the last known value was false and this bar is true; a bar without a value
 * changes nothing, and the first value ever seen only records.
 */
export function testFormula(cfg: Config, key: string, formula: string, tf: Timeframe, window: number, read: DailyReader): FormulaTest {
  const { bars, line } = run(key, formula, tf, cfg, read);
  const start = Math.max(0, bars.length - window);
  const date = (i: number) => fmtDate(bars[i].t);
  let known: boolean | null = null;
  let trueBars = 0;
  let unknownBars = 0;
  const turned: string[] = [];
  const ranges: { from: string; to: string; bars: number }[] = [];
  let open: { from: number; to: number } | null = null;
  const close = () => {
    if (open) ranges.push({ from: date(open.from), to: date(open.to), bars: open.to - open.from + 1 });
    open = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const now = holds(line[i]);
    if (i >= start) {
      if (now === null) unknownBars++;
      if (now) {
        trueBars++;
        if (known === false) turned.push(date(i));
        if (open) open.to = i;
        else open = { from: i, to: i };
      } else close();
    }
    if (now !== null) known = now;
  }
  close();
  return {
    key,
    name: nameOf(cfg, key, getSymbol(key)?.name),
    bars: bars.length - start,
    from: date(start),
    to: date(bars.length - 1),
    value: shown(line.at(-1)),
    prev: shown(line.at(-2)),
    trueBars,
    unknownBars,
    turnedTrue: { count: turned.length, dates: turned.slice(-MAX_LISTED) },
    trueRanges: { count: ranges.length, ranges: ranges.slice(-MAX_LISTED) },
    recent: bars.slice(-10).map((b, i, last) => ({ date: fmtDate(b.t), value: shown(line[bars.length - last.length + i]) })),
  };
}
