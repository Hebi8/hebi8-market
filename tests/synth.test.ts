import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/series";
import { synthNoData } from "@/lib/bars";
import { normalizeConfig } from "@/lib/config";
import { canonicalSynth, evalSynth, lexSynth, parseSynth, synthName, synthOperand } from "@/lib/synth";

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
const bar = (iso: string, o: number, h: number, l: number, c: number): Bar => ({ t: day(iso), o, h, l, c, v: 1, adj: 1 });

const aliases = { BTC: "binance:BTCUSDT", GOLD: "tv:TVC:GOLD" };

const lexed = (src: string) => lexSynth(src).map((t) => (t.type === "bad" ? `!${t.message}` : t.type === "ref" ? `[${t.text}]` : t.text));

describe("lexSynth", () => {
  it("reads keys, tickers and numbers as operands where they cannot be operators", () => {
    expect(lexed("yahoo:AAPL/tv:TVC:GOLD")).toEqual(["[yahoo:AAPL]", "/", "[tv:TVC:GOLD]"]);
    // `^` opens an index ticker where an operand is expected and is a power after one
    expect(lexed("^GSPC/yahoo:^DJI^2")).toEqual(["[^GSPC]", "/", "[yahoo:^DJI]", "^", "2"]);
    expect(lexed("-(^VIX)")).toEqual(["-", "(", "[^VIX]", ")"]);
    // a digit followed by a word character is a ticker, a bare number a constant
    expect(lexed("0700.HK*2.5e1+600519")).toEqual(["[0700.HK]", "*", "2.5e1", "+", "600519"]);
    // `-` is always an operator; `=` and `!` belong to tickers
    expect(lexed("BRK-B+yahoo:GC=F+ES1!")).toEqual(["[BRK]", "-", "[B]", "+", "[yahoo:GC=F]", "+", "[ES1!]"]);
    expect(lexed('"yahoo:BRK-B"/腾讯')).toEqual(["[yahoo:BRK-B]", "/", "[腾讯]"]);
  });

  it("marks what it cannot read instead of throwing", () => {
    expect(lexed("A % B")).toEqual(["[A]", "!无法识别的字符「%」", "[B]"]);
    expect(lexed('A/"yahoo:B')).toEqual(["[A]", "/", "!引号没有闭合"]);
  });

  it("gives positions in the source", () => {
    expect(lexSynth(' A / "b:c"').map((t) => [t.start, t.end])).toEqual([
      [1, 2],
      [3, 4],
      [5, 10],
    ]);
  });
});

describe("synthOperand / synthName", () => {
  it("leaves a key bare only when it reads back as one operand", () => {
    expect(synthOperand("yahoo:AAPL", {})).toBe("yahoo:AAPL");
    expect(synthOperand("yahoo:^GSPC", {})).toBe("yahoo:^GSPC");
    expect(synthOperand("tv:TVC:GOLD", {})).toBe("tv:TVC:GOLD");
    expect(synthOperand("yahoo:EURUSD=X", {})).toBe("yahoo:EURUSD=X");
    expect(synthOperand("yahoo:BRK-B", {})).toBe('"yahoo:BRK-B"');
    expect(synthOperand("data:gpu/4090-xianyu", {})).toBe('"data:gpu/4090-xianyu"');
    // a bare name is an alias first, so a key that is also an alias name keeps its quotes
    expect(synthOperand("yahoo:SPY", { "yahoo:SPY": "yahoo:QQQ" })).toBe('"yahoo:SPY"');
  });

  it("shows operands by ticker, like a TradingView spread", () => {
    expect(synthName("=yahoo:AAPL/yahoo:MSFT")).toBe("AAPL/MSFT");
    expect(synthName("=2*(yahoo:SPY-yahoo:QQQ)")).toBe("2*(SPY-QQQ)");
    expect(synthName('=binance:BTCUSDT/tv:TVC:GOLD+"data:gpu/4090-xianyu"')).toBe("BTCUSDT/GOLD+4090-xianyu");
    expect(synthName("=BTC / GOLD")).toBe("BTC/GOLD");
  });
});

describe("canonicalSynth", () => {
  it("writes aliases as full keys and drops spaces", () => {
    expect(canonicalSynth("=BTC / GOLD", aliases)).toBe("=binance:BTCUSDT/tv:TVC:GOLD");
    expect(canonicalSynth('=2*("yahoo:SPY" - "yahoo:BRK-B")', aliases)).toBe('=2*(yahoo:SPY-"yahoo:BRK-B")');
    expect(canonicalSynth("=binance:BTCUSDT/tv:TVC:GOLD", aliases)).toBe("=binance:BTCUSDT/tv:TVC:GOLD");
  });
  it("keeps the meaning of a quoted key that is also an alias name", () => {
    const tricky = { "yahoo:SPY": "yahoo:QQQ" };
    const canon = canonicalSynth('="yahoo:SPY"/"yahoo:QQQ"', tricky);
    expect(canon).toBe('="yahoo:SPY"/yahoo:QQQ');
    expect(parseSynth(canon.slice(1), tricky).keys).toEqual(["yahoo:SPY", "yahoo:QQQ"]);
  });
  it("returns what it cannot read as is", () => {
    expect(canonicalSynth("=BTC/1 2", aliases)).toBe("=BTC/1 2");
    expect(canonicalSynth("=BTC/NOPE", aliases)).toBe("=BTC/NOPE");
    expect(canonicalSynth("=BTC % 2", aliases)).toBe("=BTC % 2");
  });
});

describe("parseSynth", () => {
  it("collects operands from aliases and quoted keys, in order", () => {
    expect(parseSynth("BTC/GOLD", aliases).keys).toEqual(["binance:BTCUSDT", "tv:TVC:GOLD"]);
    expect(parseSynth('"yahoo:SPY" - 2 * GOLD', aliases).keys).toEqual(["yahoo:SPY", "tv:TVC:GOLD"]);
  });

  it("takes keys without quotes", () => {
    expect(parseSynth("yahoo:^GSPC/tv:TVC:GOLD-yahoo:0700.HK^2", {}).keys).toEqual(["yahoo:^GSPC", "tv:TVC:GOLD", "yahoo:0700.HK"]);
    expect(parseSynth('2*(yahoo:SPY-"yahoo:BRK-B")', {}).keys).toEqual(["yahoo:SPY", "yahoo:BRK-B"]);
  });

  it.each([
    ["BTC/NOPE", "未知别名「NOPE」"],
    ['"bad key"', "无效的标的 key"],
    ["BTC +", "表达式不完整"],
    ["(BTC", "缺少「)」"],
    ["BTC GOLD", "表达式多了内容"],
    ["1 + 2", "至少要引用一个标的"],
    ["BTC % 2", "无法识别的字符"],
    ["nope:AAPL/BTC", "无效的标的 key「nope:AAPL」"],
    ["data:gpu/BTC", "无效的标的 key「data:gpu」"],
    ['"=yahoo:A/yahoo:B"/BTC', "不能嵌套合成标的"],
    ["toString/BTC", "未知别名「toString」"],
  ])("rejects %j", (expr, message) => {
    expect(() => parseSynth(expr, aliases)).toThrow(message);
  });

  it("rejects nested synthetic aliases", () => {
    const nested = { ...aliases, INNER: "=BTC/GOLD" };
    expect(() => parseSynth("INNER/yahoo:SPY", nested)).toThrow("不能嵌套合成标的");
  });
});

describe("evalSynth", () => {
  const btc = [bar("2026-01-03", 100, 110, 90, 105), bar("2026-01-04", 105, 120, 100, 110), bar("2026-01-05", 110, 115, 95, 100)];
  const gold = [bar("2026-01-05", 10, 11, 9, 10), bar("2026-01-06", 10, 12, 9.5, 11)];

  it("computes each OHLC field separately on the first operand's trading days", () => {
    const out = evalSynth(parseSynth("BTC/GOLD", aliases), { "binance:BTCUSDT": btc, "tv:TVC:GOLD": gold });
    // gold starts on the 5th, so the earlier BTC days are dropped; 115/11 and 95/9 sit inside
    // the open/close, so the candle's high/low are widened to the open and close
    expect(out).toEqual([{ t: day("2026-01-05"), o: 11, h: 11, l: 10, c: 10, v: null, adj: 1 }]);
    const [raw] = evalSynth(parseSynth("BTC*GOLD", aliases), { "binance:BTCUSDT": btc, "tv:TVC:GOLD": gold });
    expect(raw).toEqual({ t: day("2026-01-05"), o: 1100, h: 115 * 11, l: 95 * 9, c: 1000, v: null, adj: 1 });
  });

  it("forward-fills operands that did not trade and supports numbers and precedence", () => {
    const base = [bar("2026-01-05", 1, 1, 1, 1), bar("2026-01-06", 1, 1, 1, 1), bar("2026-01-07", 1, 1, 1, 1)];
    const out = evalSynth(parseSynth('2 * "yahoo:SPY" + GOLD ^ 2', aliases), { "yahoo:SPY": base, "tv:TVC:GOLD": gold });
    expect(out.map((b) => b.c)).toEqual([2 + 100, 2 + 121, 2 + 121]);
    expect(out.map((b) => b.t)).toEqual(base.map((b) => b.t));
  });

  it("keeps candles well-formed when ratios of highs and lows cross", () => {
    const a = [bar("2026-01-05", 10, 20, 5, 10)];
    const b = [bar("2026-01-05", 1, 10, 0.5, 1)];
    const [out] = evalSynth(parseSynth('"yahoo:A"/"yahoo:B"', {}), { "yahoo:A": a, "yahoo:B": b });
    expect(out.h).toBeGreaterThanOrEqual(Math.max(out.o, out.c));
    expect(out.l).toBeLessThanOrEqual(Math.min(out.o, out.c));
  });

  it("returns nothing when an operand has no data", () => {
    expect(evalSynth(parseSynth("BTC/GOLD", aliases), { "binance:BTCUSDT": btc })).toEqual([]);
  });
});

describe("synthNoData", () => {
  const cfg = normalizeConfig({ aliases });
  const errors: Record<string, string> = { "yahoo:SPX": "No data found, symbol may be delisted" };
  const syncError = (k: string) => errors[k] ?? null;

  it("names each operand without bars and its sync error", () => {
    const read = (k: string) => (k === "binance:BTCUSDT" ? [bar("2026-01-05", 1, 1, 1, 1)] : []);
    expect(synthNoData("=BTC/yahoo:SPX", cfg, syncError, read)).toBe("yahoo:SPX：No data found, symbol may be delisted");
    expect(synthNoData("=yahoo:SPX/GOLD", cfg, syncError, read)).toBe("yahoo:SPX：No data found, symbol may be delisted；tv:TVC:GOLD：暂无数据，等待同步");
    expect(synthNoData("=BTC*2", cfg, syncError, read)).toBe("各操作数的日期没有重叠");
  });
});
