/**
 * A tiny expression language for user-defined indicators and conditions, evaluated over whole series.
 *
 *   fast = ema(close, 10); slow = ema(close, 40)      # two lines, the second may reuse the first
 *   (close / sma(close, 40) - 1) * 100                 # one unnamed line
 *   close > sma(close, 40) and close(QQQ) > ref(close(QQQ), 1)   # booleans are 0/1 series
 *
 * Statements are separated by `;` or newlines, `#` starts a comment. Each statement becomes a
 * plotted line; `name = expr` names it so later statements can refer to it. `close(X)` reads another
 * symbol (an alias or a quoted key) aligned to this symbol's bars; `bench` is the configured benchmark.
 */

import { isSynthetic, isValidKey } from "@/lib/symbols";
import { parseSynth } from "@/lib/synth";

export type Series = number[];
type Value = Series | number;

export interface OhlcvBar {
  /** Bar timestamp in UTC milliseconds (matching KLineChart's KLineData.timestamp) */
  timestamp?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  [key: string]: unknown;
}

/** Another symbol's bars aligned to the evaluated bars (null before it starts), column by column. */
export interface RefSeries {
  c: (number | null)[];
  o?: (number | null)[];
  h?: (number | null)[];
  l?: (number | null)[];
  v?: (number | null)[];
}

export interface EvalInput {
  bars: OhlcvBar[];
  refs?: Record<string, RefSeries>;
  /** First daily bar's open per UTC calendar year, so 3D and weekly series align with daily/monthly/yearly `yearopen`. */
  yearOpens?: Record<number, number>;
}

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly pos?: number,
  ) {
    super(message);
  }
}

type ArithOp = "+" | "-" | "*" | "/" | "^";
type CmpOp = ">" | "<" | ">=" | "<=" | "==" | "!=";
type Keyword = "and" | "or" | "not";

type Token =
  | { type: "num"; value: number; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "str"; value: string; pos: number }
  | { type: "kw"; value: Keyword; pos: number }
  | { type: "op"; value: ArithOp; pos: number }
  | { type: "cmp"; value: CmpOp; pos: number }
  | { type: "(" | ")" | "," | "=" | "sep"; pos: number };

const FIELDS = ["open", "high", "low", "close", "volume"] as const;
type Field = (typeof FIELDS)[number];

type Node =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string; pos: number }
  | { kind: "ref"; field: Field; target: string; quoted: boolean; key: string; pos: number }
  | { kind: "call"; name: string; args: Node[]; pos: number }
  | { kind: "neg"; arg: Node }
  | { kind: "not"; arg: Node }
  | { kind: "bin"; op: ArithOp; left: Node; right: Node }
  | { kind: "cmp"; op: CmpOp; left: Node; right: Node }
  | { kind: "logic"; op: "and" | "or"; left: Node; right: Node };

interface Statement {
  name: string | null;
  expr: Node;
}

export interface Program {
  statements: Statement[];
  /** Legend title for each plotted line */
  outputs: string[];
  /** Keys of the other symbols the formula reads, aliases resolved */
  refs: string[];
  benchKey: string | null;
}

export interface CompileOptions {
  aliases?: Record<string, string>;
  /** The symbol's benchmark key; null means "none configured" and makes `bench` an error */
  bench?: string | null;
}

// ---------------------------------------------------------------------------- built-ins

export const SERIES_VARS: Record<string, string> = {
  open: "开盘价",
  high: "最高价",
  low: "最低价",
  close: "收盘价",
  volume: "成交量",
  bench: "基准收盘价，同 close(bench)",
  hl2: "(high + low) / 2",
  hlc3: "(high + low + close) / 3",
  tr: "真实波幅",
  year: "当前 K 线的 UTC 年份（如 2026）",
  month: "当前 K 线的 UTC 月份（1–12）",
  yearopen: "该公历年首个交易日的开盘价",
};

const isSeries = (v: Value): v is Series => Array.isArray(v);

function rolling(x: Series, n: number, fn: (window: Series) => number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    const window = x.slice(i - n + 1, i + 1);
    if (window.every(Number.isFinite)) out[i] = fn(window);
  }
  return out;
}

const mean = (w: Series) => w.reduce((a, b) => a + b, 0) / w.length;

function ema(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  const alpha = 2 / (n + 1);
  let prev = NaN;
  let seen: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(prev)) {
      // seed with the simple average of the first n values
      seen.push(v);
      if (seen.length === n) {
        prev = mean(seen);
        out[i] = prev;
        seen = [];
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing, seeded with a simple average like ema(). */
function rma(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  let prev = NaN;
  let seen: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(prev)) {
      seen.push(v);
      if (seen.length === n) {
        prev = mean(seen);
        out[i] = prev;
        seen = [];
      }
      continue;
    }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

function rsi(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  let count = 0;
  for (let i = 1; i < x.length; i++) {
    const diff = x[i] - x[i - 1];
    if (!Number.isFinite(diff)) {
      // gaps before warm-up (e.g. leading NaN of an inner sma) restart the average
      if (count < n) gain = loss = count = 0;
      continue;
    }
    const up = Math.max(diff, 0);
    const down = Math.max(-diff, 0);
    count++;
    if (count <= n) {
      gain += up / n;
      loss += down / n;
    } else {
      // Wilder smoothing
      gain = (gain * (n - 1) + up) / n;
      loss = (loss * (n - 1) + down) / n;
    }
    if (count >= n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function shift(x: Series, n: number): Series {
  return x.map((_, i) => (i - n >= 0 ? x[i - n] : NaN));
}

function running(x: Series, pick: (a: number, b: number) => number): Series {
  let acc = NaN;
  return x.map((v) => {
    if (Number.isFinite(v)) acc = Number.isNaN(acc) ? v : pick(acc, v);
    return acc;
  });
}

function correlation(a: Series, b: Series, n: number): Series {
  const out: Series = new Array(a.length).fill(NaN);
  for (let i = n - 1; i < a.length; i++) {
    const wa = a.slice(i - n + 1, i + 1);
    const wb = b.slice(i - n + 1, i + 1);
    if (!wa.every(Number.isFinite) || !wb.every(Number.isFinite)) continue;
    const ma = mean(wa);
    const mb = mean(wb);
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let j = 0; j < n; j++) {
      cov += (wa[j] - ma) * (wb[j] - mb);
      va += (wa[j] - ma) ** 2;
      vb += (wb[j] - mb) ** 2;
    }
    out[i] = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
  }
  return out;
}

/** Percent of the previous n values that are <= the current one. */
function pctrank(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) {
    const window = x.slice(i - n, i);
    if (!Number.isFinite(x[i]) || !window.every(Number.isFinite)) continue;
    out[i] = (window.filter((v) => v <= x[i]).length / n) * 100;
  }
  return out;
}

function trueRange(bars: OhlcvBar[]): Series {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prev = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
}

function macdLine(x: Series, fast: number, slow: number): Series {
  const f = ema(x, fast);
  const s = ema(x, slow);
  return f.map((v, i) => v - s[i]);
}

function yearOpenSeries(bars: OhlcvBar[], yearOpens?: Record<number, number>): Series {
  if (yearOpens !== undefined) {
    return bars.map((d) => {
      if (!Number.isFinite(d.timestamp)) return NaN;
      const v = yearOpens[new Date(d.timestamp!).getUTCFullYear()];
      return Number.isFinite(v) ? v : NaN;
    });
  }
  const first = new Map<number, number>();
  return bars.map((d) => {
    if (!Number.isFinite(d.timestamp)) return NaN;
    const y = new Date(d.timestamp!).getUTCFullYear();
    if (!first.has(y)) first.set(y, d.open);
    return first.get(y)!;
  });
}

interface Ctx {
  len: number;
  bars: OhlcvBar[];
}

interface FnSpec {
  /** argument count, or [min, max] */
  arity: number | [number, number];
  /** indexes of arguments that must be positive integer window lengths */
  windows?: number[];
  hint: string;
  run: (args: Value[], ctx: Ctx) => Value;
}

const toSeries = (v: Value, len: number): Series => (isSeries(v) ? v : new Array(len).fill(v));
const elementwise =
  (fn: (a: number) => number) =>
  ([x]: Value[]) =>
    isSeries(x) ? x.map(fn) : fn(x);
const pairwise =
  (fn: (a: number, b: number) => number) =>
  ([a, b]: Value[], len: number): Value => {
    if (!isSeries(a) && !isSeries(b)) return fn(a, b);
    const left = toSeries(a, len);
    const right = toSeries(b, len);
    return left.map((v, i) => fn(v, right[i]));
  };
const truthy = (v: number) => (Number.isNaN(v) ? NaN : v !== 0 ? 1 : 0);

export const FUNCTIONS: Record<string, FnSpec> = {
  sma: { arity: 2, windows: [1], hint: "sma(x, n) 简单均线", run: ([x, n], { len }) => rolling(toSeries(x, len), n as number, mean) },
  ema: { arity: 2, windows: [1], hint: "ema(x, n) 指数均线", run: ([x, n], { len }) => ema(toSeries(x, len), n as number) },
  std: {
    arity: 2,
    windows: [1],
    hint: "std(x, n) 滚动标准差",
    run: ([x, n], { len }) =>
      rolling(toSeries(x, len), n as number, (w) => {
        const m = mean(w);
        return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
      }),
  },
  sum: {
    arity: 2,
    windows: [1],
    hint: "sum(x, n) 滚动求和",
    run: ([x, n], { len }) => rolling(toSeries(x, len), n as number, (w) => w.reduce((a, b) => a + b, 0)),
  },
  highest: {
    arity: 2,
    windows: [1],
    hint: "highest(x, n) n 根内最高",
    run: ([x, n], { len }) => rolling(toSeries(x, len), n as number, (w) => Math.max(...w)),
  },
  lowest: {
    arity: 2,
    windows: [1],
    hint: "lowest(x, n) n 根内最低",
    run: ([x, n], { len }) => rolling(toSeries(x, len), n as number, (w) => Math.min(...w)),
  },
  ref: { arity: 2, windows: [1], hint: "ref(x, n) n 根之前的值", run: ([x, n], { len }) => shift(toSeries(x, len), n as number) },
  change: {
    arity: [1, 2],
    windows: [1],
    hint: "change(x, n=1) 与 n 根前的差",
    run: ([x, n = 1], { len }) => {
      const s = toSeries(x, len);
      const prev = shift(s, n as number);
      return s.map((v, i) => v - prev[i]);
    },
  },
  roc: {
    arity: [1, 2],
    windows: [1],
    hint: "roc(x, n=1) 与 n 根前相比的涨跌 %",
    run: ([x, n = 1], { len }) => {
      const s = toSeries(x, len);
      const prev = shift(s, n as number);
      return s.map((v, i) => (v / prev[i] - 1) * 100);
    },
  },
  rsi: { arity: 2, windows: [1], hint: "rsi(x, n) 相对强弱指数", run: ([x, n], { len }) => rsi(toSeries(x, len), n as number) },
  macd: {
    arity: [1, 3],
    windows: [1, 2],
    hint: "macd(x, fast=12, slow=26) MACD 线（快慢 EMA 之差）",
    run: ([x, fast = 12, slow = 26], { len }) => macdLine(toSeries(x, len), fast as number, slow as number),
  },
  macdsignal: {
    arity: [1, 4],
    windows: [1, 2, 3],
    hint: "macdsignal(x, fast=12, slow=26, signal=9) MACD 信号线",
    run: ([x, fast = 12, slow = 26, signal = 9], { len }) => ema(macdLine(toSeries(x, len), fast as number, slow as number), signal as number),
  },
  macdhist: {
    arity: [1, 4],
    windows: [1, 2, 3],
    hint: "macdhist(x, fast=12, slow=26, signal=9) MACD 柱（MACD 线减信号线）",
    run: ([x, fast = 12, slow = 26, signal = 9], { len }) => {
      const line = macdLine(toSeries(x, len), fast as number, slow as number);
      const sig = ema(line, signal as number);
      return line.map((v, i) => v - sig[i]);
    },
  },
  atr: { arity: 1, windows: [0], hint: "atr(n) 平均真实波幅", run: ([n], { bars }) => rma(trueRange(bars), n as number) },
  corr: {
    arity: 3,
    windows: [2],
    hint: "corr(a, b, n) 滚动相关系数",
    run: ([a, b, n], { len }) => correlation(toSeries(a, len), toSeries(b, len), n as number),
  },
  pctrank: { arity: 2, windows: [1], hint: "pctrank(x, n) 在近 n 根中的百分位", run: ([x, n], { len }) => pctrank(toSeries(x, len), n as number) },
  cummax: { arity: 1, hint: "cummax(x) 历史最高", run: ([x], { len }) => running(toSeries(x, len), Math.max) },
  cummin: { arity: 1, hint: "cummin(x) 历史最低", run: ([x], { len }) => running(toSeries(x, len), Math.min) },
  max: { arity: 2, hint: "max(a, b) 逐根取大", run: (args, { len }) => pairwise(Math.max)(args, len) },
  min: { arity: 2, hint: "min(a, b) 逐根取小", run: (args, { len }) => pairwise(Math.min)(args, len) },
  abs: { arity: 1, hint: "abs(x)", run: elementwise(Math.abs) },
  sqrt: { arity: 1, hint: "sqrt(x)", run: elementwise(Math.sqrt) },
  log: { arity: 1, hint: "log(x) 自然对数", run: elementwise(Math.log) },
  exp: { arity: 1, hint: "exp(x)", run: elementwise(Math.exp) },
  iff: {
    arity: 3,
    hint: "iff(cond, a, b) 条件成立取 a 否则 b",
    run: ([cond, a, b], { len }) => {
      const c = toSeries(cond, len);
      const x = toSeries(a, len);
      const y = toSeries(b, len);
      return c.map((v, i) => (Number.isNaN(v) ? NaN : v !== 0 ? x[i] : y[i]));
    },
  },
  cross: {
    arity: 2,
    hint: "cross(a, b) a 上穿 b 的那根为 1",
    run: ([a, b], { len }) => {
      const x = toSeries(a, len);
      const y = toSeries(b, len);
      return x.map((v, i) => {
        if (i === 0 || [v, y[i], x[i - 1], y[i - 1]].some(Number.isNaN)) return NaN;
        return v > y[i] && x[i - 1] <= y[i - 1] ? 1 : 0;
      });
    },
  },
  barssince: {
    arity: 1,
    hint: "barssince(cond) 距上次条件成立的根数",
    run: ([cond], { len }) => {
      let since = NaN;
      return toSeries(cond, len).map((v) => {
        if (Number.isFinite(v) && v !== 0) since = 0;
        else if (Number.isFinite(since)) since++;
        return since;
      });
    },
  },
};

// ---------------------------------------------------------------------------- parsing

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (ch === "\n" || ch === ";") {
      tokens.push({ type: "sep", pos: i++ });
    } else if (/\s/.test(ch)) {
      i++;
    } else if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError("无法识别的数字", i);
      tokens.push({ type: "num", value: Number(m[0]), pos: i });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))![0];
      if (name === "and" || name === "or" || name === "not") tokens.push({ type: "kw", value: name, pos: i });
      else tokens.push({ type: "ident", value: name, pos: i });
      i += name.length;
    } else if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new FormulaError("引号没有闭合", i);
      tokens.push({ type: "str", value: src.slice(i + 1, end), pos: i });
      i = end + 1;
    } else if (two === ">=" || two === "<=" || two === "==" || two === "!=") {
      tokens.push({ type: "cmp", value: two, pos: i });
      i += 2;
    } else if (ch === ">" || ch === "<") {
      tokens.push({ type: "cmp", value: ch, pos: i++ });
    } else if ("+-*/^".includes(ch)) {
      tokens.push({ type: "op", value: ch as ArithOp, pos: i++ });
    } else if ("(),=".includes(ch)) {
      tokens.push({ type: ch as "(", pos: i++ });
    } else {
      throw new FormulaError(`无法识别的字符「${ch}」`, i);
    }
  }
  return tokens;
}

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly end: number,
  ) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t?.type === "op" && ops.includes(t.value);
  }

  private isKw(kw: Keyword): boolean {
    const t = this.peek();
    return t?.type === "kw" && t.value === kw;
  }

  private expect(type: ")"): void {
    const t = this.peek();
    if (t?.type !== type) throw new FormulaError(`缺少「${type}」`, t?.pos ?? this.end);
    this.i++;
  }

  program(): Statement[] {
    const statements: Statement[] = [];
    while (this.peek()) {
      if (this.peek()!.type === "sep") {
        this.i++;
        continue;
      }
      statements.push(this.statement());
      const t = this.peek();
      if (t && t.type !== "sep") throw new FormulaError("这里多了内容，语句之间用分号或换行分隔", t.pos);
    }
    return statements;
  }

  private statement(): Statement {
    const t = this.peek();
    if (t?.type === "ident" && this.peek(1)?.type === "=") {
      this.i += 2;
      return { name: t.value, expr: this.expr() };
    }
    return { name: null, expr: this.expr() };
  }

  private expr(): Node {
    let left = this.andExpr();
    while (this.isKw("or")) {
      this.i++;
      left = { kind: "logic", op: "or", left, right: this.andExpr() };
    }
    return left;
  }

  private andExpr(): Node {
    let left = this.notExpr();
    while (this.isKw("and")) {
      this.i++;
      left = { kind: "logic", op: "and", left, right: this.notExpr() };
    }
    return left;
  }

  private notExpr(): Node {
    if (this.isKw("not")) {
      this.i++;
      return { kind: "not", arg: this.notExpr() };
    }
    return this.cmpExpr();
  }

  private cmpExpr(): Node {
    const left = this.addExpr();
    const t = this.peek();
    if (t?.type === "cmp") {
      this.i++;
      return { kind: "cmp", op: t.value, left, right: this.addExpr() };
    }
    return left;
  }

  private addExpr(): Node {
    let left = this.term();
    while (this.isOp("+", "-")) {
      const op = (this.tokens[this.i++] as { value: "+" | "-" }).value;
      left = { kind: "bin", op, left, right: this.term() };
    }
    return left;
  }

  private term(): Node {
    let left = this.unary();
    while (this.isOp("*", "/")) {
      const op = (this.tokens[this.i++] as { value: "*" | "/" }).value;
      left = { kind: "bin", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp("-")) {
      this.i++;
      return { kind: "neg", arg: this.unary() };
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.isOp("^")) {
      this.i++;
      return { kind: "bin", op: "^", left: base, right: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const t = this.tokens[this.i++];
    if (!t || t.type === "sep") throw new FormulaError("公式不完整", t?.pos ?? this.end);
    if (t.type === "num") return { kind: "num", value: t.value };
    if (t.type === "str") throw new FormulaError("字符串只能用在 close(\"…\") 这样的标的引用里", t.pos);
    if (t.type === "(") {
      const inner = this.expr();
      this.expect(")");
      return inner;
    }
    if (t.type === "ident") {
      if (this.peek()?.type !== "(") return { kind: "var", name: t.value, pos: t.pos };
      this.i++;
      const name = t.value.toLowerCase();
      if ((FIELDS as readonly string[]).includes(name)) return this.ref(name as Field, t.pos);
      const args: Node[] = [];
      if (this.peek()?.type !== ")") {
        args.push(this.expr());
        while (this.peek()?.type === ",") {
          this.i++;
          args.push(this.expr());
        }
      }
      this.expect(")");
      return { kind: "call", name, args, pos: t.pos };
    }
    const shown = t.type === "op" || t.type === "cmp" || t.type === "kw" ? t.value : t.type;
    throw new FormulaError(`这里不应出现「${shown}」`, t.pos);
  }

  /** `close(QQQ)`, `close("yahoo:QQQ")`, `close(bench)`; the opening paren is consumed. */
  private ref(field: Field, pos: number): Node {
    const t = this.tokens[this.i];
    if ((t?.type !== "ident" && t?.type !== "str") || this.peek(1)?.type !== ")") {
      throw new FormulaError(`${field}(…) 里应是别名、带引号的 key 或 bench`, t?.pos ?? this.end);
    }
    this.i += 2;
    return { kind: "ref", field, target: t.value, quoted: t.type === "str", key: "", pos };
  }
}

const BINARY: Record<ArithOp, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "^": (a, b) => a ** b,
};

const COMPARE: Record<CmpOp, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

const SCALAR_FNS = new Set(["abs", "sqrt", "log", "exp", "max", "min"]);

/** Constant scalar value of an AST node when it cannot depend on any series; null if series-valued. */
function evalConst(node: Node): number | null {
  switch (node.kind) {
    case "num":
      return node.value;
    case "neg": {
      const v = evalConst(node.arg);
      return v === null ? null : -v;
    }
    case "not": {
      const v = evalConst(node.arg);
      return v === null ? null : Number.isNaN(v) ? NaN : v !== 0 ? 0 : 1;
    }
    case "bin": {
      const l = evalConst(node.left);
      const r = evalConst(node.right);
      return l === null || r === null ? null : BINARY[node.op](l, r);
    }
    case "cmp": {
      const l = evalConst(node.left);
      const r = evalConst(node.right);
      return l === null || r === null ? null : Number.isNaN(l) || Number.isNaN(r) ? NaN : COMPARE[node.op](l, r) ? 1 : 0;
    }
    case "logic": {
      const l = evalConst(node.left);
      const r = evalConst(node.right);
      if (l === null || r === null) return null;
      if (Number.isNaN(l) || Number.isNaN(r)) return NaN;
      return (node.op === "and" ? truthy(l) && truthy(r) : truthy(l) || truthy(r)) ? 1 : 0;
    }
    case "call": {
      if (!SCALAR_FNS.has(node.name)) return null;
      const args = node.args.map(evalConst);
      if (args.some((a) => a === null)) return null;
      const out = FUNCTIONS[node.name].run(args as number[], { len: 0, bars: [] });
      return typeof out === "number" ? out : null;
    }
    case "var":
    case "ref":
      return null;
  }
}

function checkRefKey(key: string, aliases: Record<string, string> | undefined, pos: number): void {
  if (!isValidKey(key)) throw new FormulaError(`无效的标的 key「${key}」`, pos);
  if (isSynthetic(key)) {
    try {
      parseSynth(key.slice(1), aliases ?? {});
    } catch (err) {
      throw new FormulaError(err instanceof Error ? err.message : String(err), pos);
    }
  }
}

function check(node: Node, known: Set<string>, opts: CompileOptions, refs: Set<string>): string | null {
  let benchKey: string | null = null;
  const resolveBench = (pos: number): string => {
    if (opts.bench === null) throw new FormulaError("未设置基准", pos);
    if (opts.bench) {
      refs.add(opts.bench);
      benchKey = opts.bench;
    }
    return opts.bench ?? "bench";
  };
  const visit = (n: Node): void => {
    switch (n.kind) {
      case "num":
        return;
      case "var":
        if (n.name === "bench") {
          resolveBench(n.pos);
          return;
        }
        if (!(n.name in SERIES_VARS) && !known.has(n.name)) throw new FormulaError(`未知变量「${n.name}」`, n.pos);
        return;
      case "ref": {
        if (!n.quoted && n.target === "bench") {
          n.key = resolveBench(n.pos);
        } else if (n.quoted) {
          checkRefKey(n.target, opts.aliases, n.pos);
          n.key = n.target;
          refs.add(n.key);
        } else {
          const key = opts.aliases && Object.hasOwn(opts.aliases, n.target) ? opts.aliases[n.target] : undefined;
          if (!key) throw new FormulaError(`未知别名「${n.target}」`, n.pos);
          checkRefKey(key, opts.aliases, n.pos);
          n.key = key;
          refs.add(key);
        }
        return;
      }
      case "neg":
      case "not":
        return visit(n.arg);
      case "bin":
      case "cmp":
      case "logic":
        visit(n.left);
        return visit(n.right);
      case "call": {
        const fn = FUNCTIONS[n.name];
        if (!fn) throw new FormulaError(`未知函数「${n.name}」`, n.pos);
        const [min, max] = typeof fn.arity === "number" ? [fn.arity, fn.arity] : fn.arity;
        if (n.args.length < min || n.args.length > max) throw new FormulaError(`${fn.hint}：参数个数不对`, n.pos);
        n.args.forEach(visit);
        for (const w of fn.windows ?? []) {
          if (w >= n.args.length) continue;
          const v = evalConst(n.args[w]);
          if (v === null || !Number.isInteger(v) || v < 1) {
            throw new FormulaError(`${fn.hint}：n 必须是正整数`, n.pos);
          }
        }
      }
    }
  };
  visit(node);
  return benchKey;
}

/** Parse and validate; throws FormulaError with a position on bad input. */
export function compile(source: string, opts: CompileOptions = {}): Program {
  const statements = new Parser(tokenize(source), source.length).program();
  if (statements.length === 0) throw new FormulaError("公式为空");
  const known = new Set<string>();
  const refs = new Set<string>();
  let benchKey: string | null = null;
  statements.forEach((s) => {
    benchKey = check(s.expr, known, opts, refs) ?? benchKey;
    if (s.name) known.add(s.name);
  });
  return {
    statements,
    outputs: statements.map((s, i) => s.name ?? (statements.length === 1 ? "值" : `L${i + 1}`)),
    refs: [...refs],
    benchKey,
  };
}

// ---------------------------------------------------------------------------- evaluation

const FIELD_COLUMN: Record<Field, keyof RefSeries> = { open: "o", high: "h", low: "l", close: "c", volume: "v" };

function refSeries(refs: Record<string, RefSeries>, key: string, field: Field, len: number): Series {
  const column = refs[key]?.[FIELD_COLUMN[field]];
  return column ? column.map((v) => (v === null ? NaN : v)) : new Array(len).fill(NaN);
}

/** Evaluate every statement; returns one series per plotted line (NaN where undefined). */
export function evaluate(program: Program, input: EvalInput): Series[] {
  const { bars, refs = {}, yearOpens } = input;
  const len = bars.length;
  const env = new Map<string, Value>();
  const cache = new Map<string, Series>();

  const base = (name: string): Series => {
    switch (name) {
      case "hl2":
        return bars.map((d) => (d.high + d.low) / 2);
      case "hlc3":
        return bars.map((d) => (d.high + d.low + d.close) / 3);
      case "volume":
        return bars.map((d) => d.volume ?? NaN);
      case "tr":
        return trueRange(bars);
      case "year":
        return bars.map((d) => (Number.isFinite(d.timestamp) ? new Date(d.timestamp!).getUTCFullYear() : NaN));
      case "month":
        return bars.map((d) => (Number.isFinite(d.timestamp) ? new Date(d.timestamp!).getUTCMonth() + 1 : NaN));
      case "yearopen":
        return yearOpenSeries(bars, yearOpens);
      case "bench":
        return program.benchKey ? refSeries(refs, program.benchKey, "close", len) : new Array(len).fill(NaN);
      default:
        return bars.map((d) => d[name as "close"]);
    }
  };

  const run = (node: Node): Value => {
    switch (node.kind) {
      case "num":
        return node.value;
      case "var": {
        const named = env.get(node.name);
        if (named !== undefined) return named;
        if (!cache.has(node.name)) cache.set(node.name, base(node.name));
        return cache.get(node.name)!;
      }
      case "ref":
        return refSeries(refs, node.key, node.field, len);
      case "neg": {
        const v = run(node.arg);
        return isSeries(v) ? v.map((x) => -x) : -v;
      }
      case "not": {
        const v = run(node.arg);
        const flip = (x: number) => (Number.isNaN(x) ? NaN : x !== 0 ? 0 : 1);
        return isSeries(v) ? v.map(flip) : flip(v);
      }
      case "bin":
        return pairwise(BINARY[node.op])([run(node.left), run(node.right)], len);
      case "cmp": {
        const cmp = COMPARE[node.op];
        return pairwise((a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : cmp(a, b) ? 1 : 0))(
          [run(node.left), run(node.right)],
          len,
        );
      }
      case "logic": {
        const combine =
          node.op === "and"
            ? (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : truthy(a) && truthy(b) ? 1 : 0)
            : (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : truthy(a) || truthy(b) ? 1 : 0);
        return pairwise(combine)([run(node.left), run(node.right)], len);
      }
      case "call": {
        const fn = FUNCTIONS[node.name];
        const args = node.args.map(run);
        for (const w of fn.windows ?? []) {
          if (w >= args.length) continue;
          const n = args[w];
          if (isSeries(n) || !Number.isInteger(n) || n < 1) {
            throw new FormulaError(`${fn.hint}：n 必须是正整数`, node.pos);
          }
        }
        return fn.run(args, { len, bars });
      }
    }
  };

  return program.statements.map((s) => {
    const series = toSeries(run(s.expr), len);
    if (s.name) env.set(s.name, series);
    return series;
  });
}
