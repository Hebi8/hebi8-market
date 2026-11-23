/**
 * Synthetic symbols: `=BTC/GOLD`, `=binance:BTCUSDT/tv:TVC:GOLD`, `=2*(yahoo:SPY-yahoo:QQQ)`.
 * Operands are aliases or full keys, quoted when the ticker has characters an expression uses
 * (`="yahoo:BRK-B"/yahoo:SPY`, `="data:gpu/4090-xianyu"/USDCNH`); each OHLC field is computed
 * separately, like a TradingView spread. Trading days follow the first operand, the rest are
 * forward-filled.
 */
import { align, type Bar } from "./series";
import { isSynthetic, isValidKey, parseKey } from "./symbols";

type Op = "+" | "-" | "*" | "/" | "^";
type Node =
  | { kind: "num"; value: number }
  | { kind: "sym"; key: string }
  | { kind: "neg"; arg: Node }
  | { kind: "bin"; op: Op; left: Node; right: Node };

export interface Synth {
  /** Referenced keys in order of appearance; the first one sets the trading days */
  keys: string[];
  node: Node;
}

/** `ref` is an operand as written: an alias, a key, or a bare ticker typed into the search box. */
export type SynthToken =
  | { type: "num"; text: string; start: number; end: number }
  | { type: "op"; text: string; start: number; end: number }
  | { type: "ref"; text: string; quoted: boolean; start: number; end: number }
  | { type: "bad"; text: string; message: string; start: number; end: number };
type RefToken = Extract<SynthToken, { type: "ref" }>;

/** Letters (any script), digits, `_ . ! =`, and `:` with an optional `^` after it (`yahoo:^GSPC`). */
const WORD = /^(?:[\p{L}\p{N}_.!=]|:\^?)+/u;
const NUMBER = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i;

/**
 * Never throws, so the search box can lex what is being typed. A digit starts a number unless a
 * word character follows it (`0700.HK`); `^` starts an operand where one is expected (`^GSPC/^DJI`)
 * and is a power after one (`SPY^2`); `-` is always an operator, so `yahoo:BRK-B` needs quotes.
 */
export function lexSynth(src: string): SynthToken[] {
  const tokens: SynthToken[] = [];
  const operandNext = () => {
    const last = tokens.at(-1);
    return !last || (last.type === "op" && last.text !== ")");
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) {
        tokens.push({ type: "bad", text: src.slice(i), message: "引号没有闭合", start: i, end: src.length });
        break;
      }
      tokens.push({ type: "ref", text: src.slice(i + 1, end), quoted: true, start: i, end: end + 1 });
      i = end + 1;
      continue;
    }
    const num = NUMBER.exec(src.slice(i));
    if (num && !WORD.test(src.slice(i + num[0].length))) {
      tokens.push({ type: "num", text: num[0], start: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const caret = ch === "^" && operandNext() ? 1 : 0;
    const word = WORD.exec(src.slice(i + caret));
    if (word) {
      const end = i + caret + word[0].length;
      tokens.push({ type: "ref", text: src.slice(i, end), quoted: false, start: i, end });
      i = end;
    } else if ("+-*/^()".includes(ch)) {
      tokens.push({ type: "op", text: ch, start: i, end: i + 1 });
      i++;
    } else {
      tokens.push({ type: "bad", text: ch, message: `无法识别的字符「${ch}」`, start: i, end: i + 1 });
      i++;
    }
  }
  return tokens;
}

/** An alias, else a full key (`source:` prefix or quoted). Synthetic keys cannot nest. */
function refKey(t: RefToken, aliases: Record<string, string>): string {
  const hasAlias = !t.quoted && Object.hasOwn(aliases, t.text);
  if (!hasAlias && !t.quoted && !t.text.includes(":")) throw new Error(`未知别名「${t.text}」`);
  const key = hasAlias ? aliases[t.text] : t.text;
  if (isSynthetic(key)) throw new Error(`合成表达式不能嵌套合成标的「${t.text}」`);
  if (!isValidKey(key)) throw new Error(`无效的标的 key「${key}」`);
  return key;
}

type Token = { type: "num"; value: number } | { type: "sym"; key: string } | { type: "op"; value: string };

function tokenize(tokens: SynthToken[], keyOf: (t: RefToken) => string): Token[] {
  return tokens.map((t): Token => {
    if (t.type === "bad") throw new Error(t.message);
    if (t.type === "num") return { type: "num", value: Number(t.text) };
    if (t.type === "op") return { type: "op", value: t.text };
    return { type: "sym", key: keyOf(t) };
  });
}

/**
 * A key as an operand: bare when it reads back as one word, quoted otherwise, and also when an
 * alias has the key's name (a bare name is an alias first).
 */
export const synthOperand = (key: string, aliases: Record<string, string>) => (WORD.exec(key)?.[0] === key && !aliases[key] ? key : `"${key}"`);

/**
 * Lexed tokens written back as a synthetic key, every operand the key `keyOf` gives it and no
 * spaces. They are parsed as they are first, so `1 2` is an error rather than `12`; throws like
 * `parseSynth`.
 */
export function writeSynth(tokens: SynthToken[], keyOf: (t: RefToken) => string, aliases: Record<string, string>): string {
  parseTokens(tokens, keyOf);
  return `=${tokens.map((t) => (t.type === "ref" ? synthOperand(keyOf(t), aliases) : t.text)).join("")}`;
}

/**
 * A synthetic key in the form the search box writes, every operand a full key and no spaces:
 * `=BTC / GOLD` → `=binance:BTCUSDT/tv:TVC:GOLD`. A key that does not parse is returned as is.
 */
export function canonicalSynth(key: string, aliases: Record<string, string>): string {
  try {
    return writeSynth(lexSynth(key.slice(1)), (t) => refKey(t, aliases), aliases);
  } catch {
    return key;
  }
}

/** What a chart calls a key: `AAPL/MSFT` for `=yahoo:AAPL/yahoo:MSFT`, `GOLD` for `tv:TVC:GOLD`. */
function shortTicker(key: string): string {
  const { source, ticker } = parseKey(key);
  return source === "tv" || source === "data" ? ticker.slice(ticker.search(/[:/]/) + 1) : ticker;
}

/** A synthetic key the way TradingView shows a spread: operands by ticker, no spaces. */
export function synthName(key: string): string {
  const parts: string[] = [];
  for (const t of lexSynth(key.slice(1))) {
    if (t.type === "bad") return key.slice(1);
    const full = t.type === "ref" && (t.quoted || t.text.includes(":")) && isValidKey(t.text) && !isSynthetic(t.text);
    parts.push(full ? shortTicker(t.text) : t.text);
  }
  return parts.join("");
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private op(...values: string[]): string | null {
    const t = this.tokens[this.i];
    return t?.type === "op" && values.includes(t.value) ? t.value : null;
  }

  parse(): Node {
    const node = this.expr();
    if (this.i < this.tokens.length) throw new Error("表达式多了内容");
    return node;
  }

  private expr(): Node {
    let left = this.term();
    for (let op = this.op("+", "-"); op; op = this.op("+", "-")) {
      this.i++;
      left = { kind: "bin", op: op as Op, left, right: this.term() };
    }
    return left;
  }

  private term(): Node {
    let left = this.unary();
    for (let op = this.op("*", "/"); op; op = this.op("*", "/")) {
      this.i++;
      left = { kind: "bin", op: op as Op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.op("-")) {
      this.i++;
      return { kind: "neg", arg: this.unary() };
    }
    const base = this.primary();
    if (this.op("^")) {
      this.i++;
      return { kind: "bin", op: "^", left: base, right: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const t = this.tokens[this.i++];
    if (!t) throw new Error("表达式不完整");
    if (t.type === "num") return { kind: "num", value: t.value };
    if (t.type === "sym") return { kind: "sym", key: t.key };
    if (t.value === "(") {
      const inner = this.expr();
      if (!this.op(")")) throw new Error("缺少「)」");
      this.i++;
      return inner;
    }
    throw new Error(`这里不应出现「${t.value}」`);
  }
}

/** Parse the part after `=`; throws on unknown aliases or bad syntax. */
export function parseSynth(expr: string, aliases: Record<string, string>): Synth {
  return parseTokens(lexSynth(expr), (t) => refKey(t, aliases));
}

function parseTokens(lexed: SynthToken[], keyOf: (t: RefToken) => string): Synth {
  const tokens = tokenize(lexed, keyOf);
  const keys = [...new Set(tokens.flatMap((t) => (t.type === "sym" ? [t.key] : [])))];
  if (keys.length === 0) throw new Error("合成表达式至少要引用一个标的");
  return { keys, node: new Parser(tokens).parse() };
}

const BIN: Record<Op, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "^": (a, b) => a ** b,
};

function run(node: Node, env: Record<string, Bar>, field: "o" | "h" | "l" | "c"): number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "sym":
      return env[node.key][field];
    case "neg":
      return -run(node.arg, env, field);
    case "bin":
      return BIN[node.op](run(node.left, env, field), run(node.right, env, field));
  }
}

/** The real keys a key's bars come from: a synthetic key's operands, else the key itself. */
export const operands = (key: string, aliases: Record<string, string>): string[] => (isSynthetic(key) ? parseSynth(key.slice(1), aliases).keys : [key]);

/** Field-by-field evaluation; days before every operand has data are dropped. */
export function evalSynth(synth: Synth, series: Record<string, Bar[]>): Bar[] {
  const base = series[synth.keys[0]] ?? [];
  const aligned = synth.keys.map((k, i) => (i === 0 ? base : align(base, series[k] ?? [])));
  const out: Bar[] = [];
  for (let i = 0; i < base.length; i++) {
    const row = aligned.map((a) => a[i]);
    if (row.some((b) => b === null)) continue;
    const env = Object.fromEntries(synth.keys.map((k, j) => [k, row[j]!]));
    const o = run(synth.node, env, "o");
    const h = run(synth.node, env, "h");
    const l = run(synth.node, env, "l");
    const c = run(synth.node, env, "c");
    if (![o, h, l, c].every(Number.isFinite)) continue;
    // a ratio of highs is not the high of the ratio; keep the candle well-formed
    out.push({ t: base[i].t, o, h: Math.max(h, l, o, c), l: Math.min(l, h, o, c), c, v: null, adj: 1 });
  }
  return out;
}
