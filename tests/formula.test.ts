import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { compile, evaluate, FormulaError, type OhlcvBar, type RefSeries } from "@/indicators/formula";
import { formulaTemplate } from "@/indicators/formula-indicators";
import { loadChart } from "@/lib/bars";
import { runFormula } from "@/lib/conditions";
import { normalizeConfig } from "@/lib/config";
import type { Bar } from "@/lib/series";
import type { Timeframe } from "@/lib/symbols";

const bars = (closes: number[], extra: Partial<OhlcvBar>[] = []): OhlcvBar[] =>
  closes.map((close, i) => ({ open: close, high: close + 1, low: close - 1, close, volume: 10, ...extra[i] }));

const run = (source: string, data: OhlcvBar[], refs?: Record<string, RefSeries>, opts = {}) =>
  evaluate(compile(source, opts), { bars: data, refs });
const round = (s: number[]) => s.map((v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v));

describe("compile", () => {
  it("names lines from assignments, or numbers them", () => {
    expect(compile("fast = ema(close, 10); slow = ema(close, 40)").outputs).toEqual(["fast", "slow"]);
    expect(compile("close\nopen").outputs).toEqual(["L1", "L2"]);
    expect(compile("close * 2").outputs).toEqual(["值"]);
  });

  it("ignores comments and blank lines", () => {
    expect(compile("# drawdown\n\n(close / cummax(close) - 1) * 100 # percent\n").outputs).toHaveLength(1);
  });

  it.each([
    ["", "公式为空"],
    ["clsoe", "未知变量「clsoe」"],
    ["foo(close)", "未知函数「foo」"],
    ["sma(close)", "参数个数不对"],
    ["(close + 1", "缺少「)」"],
    ["close close", "多了内容"],
    ["close +", "公式不完整"],
    ["close $ 2", "无法识别的字符"],
    ["b = a + 1; a = close", "未知变量「a」"],
    ['"yahoo:SPY" + 1', "字符串只能用在"],
    ["close(NOPE)", "未知别名「NOPE」"],
    ["close(sma(close, 2))", "应是别名"],
  ])("rejects %j", (source, message) => {
    expect(() => compile(source)).toThrow(FormulaError);
    expect(() => compile(source)).toThrow(message);
  });

  it("reports the position of the problem", () => {
    const error = (() => {
      try {
        compile("close + clsoe");
      } catch (err) {
        return err as FormulaError;
      }
    })();
    expect(error?.pos).toBe(8);
  });

  it("resolves symbol references through aliases and quotes, and reports them", () => {
    const program = compile('close(QQQ) / close("tv:TVC:GOLD") + open(QQQ)', { aliases: { QQQ: "yahoo:QQQ" } });
    expect(program.refs).toEqual(["yahoo:QQQ", "tv:TVC:GOLD"]);
    expect(program.benchKey).toBeNull();
  });

  it("maps bench to the configured benchmark", () => {
    const program = compile("close / close(bench) + bench", { bench: "yahoo:SPY" });
    expect(program.refs).toEqual(["yahoo:SPY"]);
    expect(program.benchKey).toBe("yahoo:SPY");
    expect(() => compile("close / bench", { bench: null })).toThrow("未设置基准");
    expect(compile("close / bench").refs).toEqual([]); // bench unknown: allowed, evaluates to NaN
  });
});

describe("evaluate", () => {
  const data = bars([1, 2, 3, 4, 5]);

  it("follows operator precedence and broadcasts scalars", () => {
    expect(run("1 + 2 * 3 ^ 2", data)[0]).toEqual([19, 19, 19, 19, 19]);
    expect(run("-close + 10", data)[0]).toEqual([9, 8, 7, 6, 5]);
    expect(run("2 ^ 3 ^ 2", data)[0][0]).toBe(512); // right-associative
  });

  it("provides price-derived series", () => {
    expect(run("hl2", data)[0]).toEqual([1, 2, 3, 4, 5]);
    expect(run("volume", data)[0]).toEqual([10, 10, 10, 10, 10]);
    expect(run("tr", data)[0]).toEqual([2, 2, 2, 2, 2]);
  });

  it("lets later statements reuse named lines", () => {
    const [a, b] = run("a = close * 2; a + 1", data);
    expect(a).toEqual([2, 4, 6, 8, 10]);
    expect(b).toEqual([3, 5, 7, 9, 11]);
  });

  it("computes rolling windows with a warm-up", () => {
    expect(run("sma(close, 2)", data)[0]).toEqual([NaN, 1.5, 2.5, 3.5, 4.5]);
    expect(run("highest(close, 3)", data)[0]).toEqual([NaN, NaN, 3, 4, 5]);
    expect(run("lowest(low, 2)", data)[0]).toEqual([NaN, 0, 1, 2, 3]);
    expect(run("sum(close, 5)", data)[0]).toEqual([NaN, NaN, NaN, NaN, 15]);
    expect(round(run("std(close, 2)", data)[0])).toEqual([NaN, 0.5, 0.5, 0.5, 0.5]);
  });

  it("seeds ema with the simple average", () => {
    expect(run("ema(close, 3)", data)[0]).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it("shifts and compares against earlier bars", () => {
    expect(run("ref(close, 2)", data)[0]).toEqual([NaN, NaN, 1, 2, 3]);
    expect(run("change(close)", data)[0]).toEqual([NaN, 1, 1, 1, 1]);
    expect(run("roc(close, 1)", bars([100, 110, 99]))[0].map(Math.round)).toEqual([NaN, 10, -10]);
  });

  it("tracks running extremes for drawdowns", () => {
    expect(run("(close / cummax(close) - 1) * 100", bars([100, 50, 75, 120, 90]))[0]).toEqual([0, -50, -25, 0, -25]);
    expect(run("cummin(close)", bars([3, 1, 2]))[0]).toEqual([3, 1, 1]);
  });

  it("computes RSI and handles one-way markets", () => {
    const rising = run("rsi(close, 3)", bars([1, 2, 3, 4, 5, 6]))[0];
    expect(rising.slice(3)).toEqual([100, 100, 100]);
    const mixed = run("rsi(close, 2)", bars([10, 11, 10, 11]))[0];
    expect(mixed.slice(2).every((v) => v > 0 && v < 100)).toBe(true);
  });

  it("supports elementwise helpers", () => {
    expect(run("max(close, 3)", data)[0]).toEqual([3, 3, 3, 4, 5]);
    expect(run("abs(close - 3)", data)[0]).toEqual([2, 1, 0, 1, 2]);
  });

  it("evaluates comparisons and logic as 0/1 with NaN passthrough", () => {
    expect(run("close > 2", data)[0]).toEqual([0, 0, 1, 1, 1]);
    expect(run("close >= 2 and close <= 4", data)[0]).toEqual([0, 1, 1, 1, 0]);
    expect(run("close == 1 or close != 5", data)[0]).toEqual([1, 1, 1, 1, 0]);
    expect(run("not close > 2", data)[0]).toEqual([1, 1, 0, 0, 0]);
    // not binds tighter than and, which binds tighter than or; all below arithmetic
    expect(run("not close > 4 and close + 1 > 2 or close == 5", data)[0]).toEqual([0, 1, 1, 1, 1]);
    expect(run("sma(close, 2) > 2", data)[0]).toEqual([NaN, 0, 1, 1, 1]);
  });

  it("reads other symbols aligned to the bars", () => {
    const refs = { "yahoo:QQQ": { c: [null, 10, 20, 20, 40], o: [null, 1, 2, 3, 4] } };
    const aliases = { QQQ: "yahoo:QQQ" };
    expect(run("close(QQQ)", data, refs, { aliases })[0]).toEqual([NaN, 10, 20, 20, 40]);
    expect(run('open("yahoo:QQQ") * 10', data, refs)[0]).toEqual([NaN, 10, 20, 30, 40]);
    expect(run("high(QQQ)", data, refs, { aliases })[0]).toEqual([NaN, NaN, NaN, NaN, NaN]);
    expect(run("close / close(bench)", data, refs, { bench: "yahoo:QQQ" })[0]).toEqual([NaN, 0.2, 0.15, 0.2, 0.125]);
    expect(run("bench", data, refs, { bench: "yahoo:QQQ" })[0]).toEqual([NaN, 10, 20, 20, 40]);
    expect(run("close(QQQ)", data, {}, { aliases })[0]).toEqual([NaN, NaN, NaN, NaN, NaN]);
  });

  it("offers iff, cross and barssince", () => {
    expect(run("iff(close > 3, 1, -1)", data)[0]).toEqual([-1, -1, -1, 1, 1]);
    expect(run("cross(close, 2.5)", data)[0]).toEqual([NaN, 0, 1, 0, 0]);
    // needs both bars of each side: the sma warm-up leaves the second bar undefined
    expect(run("cross(close, sma(close, 2))", bars([5, 1, 9, 9]))[0]).toEqual([NaN, NaN, 1, 0]);
    expect(run("barssince(close == 2)", data)[0]).toEqual([NaN, 0, 1, 2, 3]);
  });

  it("offers atr, corr and pctrank", () => {
    expect(run("atr(2)", data)[0]).toEqual([NaN, 2, 2, 2, 2]);
    expect(round(run("corr(close, close * 2, 3)", data)[0])).toEqual([NaN, NaN, 1, 1, 1]);
    expect(round(run("corr(close, -close, 3)", data)[0])).toEqual([NaN, NaN, -1, -1, -1]);
    expect(run("pctrank(close, 2)", bars([1, 3, 2, 5, 0]))[0]).toEqual([NaN, NaN, 50, 100, 0]);
  });

  it("requires window lengths to be positive integers", () => {
    expect(() => run("sma(close, 2.5)", data)).toThrow("n 必须是正整数");
    expect(() => run("sma(close, close)", data)).toThrow("n 必须是正整数");
    expect(() => run("ref(close, 0)", data)).toThrow("n 必须是正整数");
  });

  it("provides year, month and yearopen from UTC timestamps, with optional yearOpens overrides", () => {
    const dated: OhlcvBar[] = [
      { timestamp: Date.UTC(2025, 11, 29), open: 95, high: 102, low: 94, close: 100 },
      { timestamp: Date.UTC(2025, 11, 31), open: 99, high: 103, low: 98, close: 101 },
      { timestamp: Date.UTC(2026, 0, 5), open: 105, high: 110, low: 104, close: 108 },
      { timestamp: Date.UTC(2026, 5, 15), open: 120, high: 125, low: 118, close: 122 },
      { timestamp: Date.UTC(2027, 0, 4), open: 130, high: 135, low: 128, close: 132 },
    ];
    expect(run("year", dated)[0]).toEqual([2025, 2025, 2026, 2026, 2027]);
    expect(run("month", dated)[0]).toEqual([12, 12, 1, 6, 1]);
    // without yearOpens override: falls back to the first bar's open for each UTC year
    expect(run("yearopen", dated)[0]).toEqual([95, 95, 105, 105, 130]);
    // with yearOpens override (e.g. 2026-01-02 fell inside week 2025-12-29): uses exact calendar-year open
    expect(evaluate(compile("yearopen"), { bars: dated, yearOpens: { 2025: 80, 2026: 102 } })[0]).toEqual([80, 80, 102, 102, 130]);
    // bars without timestamps yield NaN
    expect(run("year", data)[0].every(Number.isNaN)).toBe(true);
    expect(run("month", data)[0].every(Number.isNaN)).toBe(true);
    expect(run("yearopen", data)[0].every(Number.isNaN)).toBe(true);
  });

  it("computes macd, macdsignal and macdhist consistently with ema, including cross-symbol refs and validation", () => {
    const closes = Array.from({ length: 45 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i * 0.5);
    const series = bars(closes);

    // default parameters (12, 26, 9) match explicit ema composition bit-for-bit
    const [m, sig, hist, manualM, manualSig, manualHist] = run(
      [
        "macd(close)",
        "macdsignal(close)",
        "macdhist(close)",
        "m = ema(close, 12) - ema(close, 26)",
        "s = ema(m, 9)",
        "m - s",
      ].join("\n"),
      series,
    );
    expect(m).toEqual(manualM);
    expect(sig).toEqual(manualSig);
    expect(hist).toEqual(manualHist);
    // warm-up: macd starts at index 25 (slow - 1); signal & hist start at index 25 + 8 = 33
    expect(m.slice(0, 25).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(m[25])).toBe(true);
    expect(sig.slice(0, 33).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(sig[33])).toBe(true);
    expect(hist.slice(0, 33).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(hist[33])).toBe(true);

    // custom parameters
    const [cm, cs, ch, cManualM, cManualS, cManualH] = run(
      "macd(close, 3, 6); macdsignal(close, 3, 6, 4); macdhist(close, 3, 6, 4); a = ema(close, 3) - ema(close, 6); b = ema(a, 4); a - b",
      series,
    );
    expect(cm).toEqual(cManualM);
    expect(cs).toEqual(cManualS);
    expect(ch).toEqual(cManualH);

    // cross-symbol reference with leading nulls
    const spxCloses = [null, null, ...closes.slice(2).map((v) => v * 10)];
    const refs: Record<string, RefSeries> = { "yahoo:^GSPC": { c: spxCloses } };
    const [refM, refS, refH, expM, expS, expH] = run(
      [
        "macd(close(SPX), 3, 5)",
        "macdsignal(close(SPX), 3, 5, 3)",
        "macdhist(close(SPX), 3, 5, 3)",
        "x = ema(close(SPX), 3) - ema(close(SPX), 5)",
        "y = ema(x, 3)",
        "x - y",
      ].join("\n"),
      series,
      refs,
      { aliases: { SPX: "yahoo:^GSPC" } },
    );
    expect(refM).toEqual(expM);
    expect(refS).toEqual(expS);
    expect(refH).toEqual(expH);
    // 2 leading nulls shift warm-up by 2: slow=5 -> index 6, signal=3 -> index 8
    expect(refM.slice(0, 6).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(refM[6])).toBe(true);
    expect(refS.slice(0, 8).every(Number.isNaN)).toBe(true);
    expect(Number.isFinite(refS[8])).toBe(true);

    // optional trailing defaults work like change()/roc()
    expect(run("macd(close, 8)", series)[0]).toEqual(run("macd(close, 8, 26)", series)[0]);
    expect(run("macdhist(close, 3, 6)", series)[0]).toEqual(run("macdhist(close, 3, 6, 9)", series)[0]);

    // arity and window parameter validation
    expect(() => compile("macd()")).toThrow("参数个数不对");
    expect(() => compile("macd(close, 12, 26, 9)")).toThrow("参数个数不对");
    expect(() => compile("macdsignal()")).toThrow("参数个数不对");
    expect(() => compile("macdsignal(close, 12, 26, 9, 1)")).toThrow("参数个数不对");
    expect(() => compile("macdhist()")).toThrow("参数个数不对");
    expect(() => compile("macdhist(close, 12, 26, 9, 1)")).toThrow("参数个数不对");
    expect(() => run("macd(close, 0, 26)", series)).toThrow("n 必须是正整数");
    expect(() => run("macd(close, 12, -1)", series)).toThrow("n 必须是正整数");
    expect(() => run("macd(close, 1.5, 26)", series)).toThrow("n 必须是正整数");
    expect(() => run("macd(close, close, 26)", series)).toThrow("n 必须是正整数");
    expect(() => run("macdsignal(close, 12, 26, 0)", series)).toThrow("n 必须是正整数");
    expect(() => run("macdhist(close, 12, 26, 2.5)", series)).toThrow("n 必须是正整数");
  });
});

describe("formulaTemplate", () => {
  const def = (id: string, formula: string, pane: "main" | "sub" = "main") => ({ id, label: "t", formula, pane });

  it("builds a KLineChart template whose calc maps lines to figure keys", async () => {
    const d = def("x1", "up = close + 1; dn = close - 1");
    const template = formulaTemplate(d, compile(d.formula), {});
    expect(template.name).toBe("F_x1");
    expect(template.series).toBe("price");
    expect(template.figures?.map((f) => f.key)).toEqual(["v0", "v1"]);
    const result = await template.calc(
      [
        { timestamp: 1, open: 1, high: 1, low: 1, close: 5 },
        { timestamp: 2, open: 1, high: 1, low: 1, close: 6 },
      ],
      template as never,
    );
    expect(result).toEqual([
      { v0: 6, v1: 4 },
      { v0: 7, v1: 5 },
    ]);
  });

  it("drops NaN so the chart leaves gaps, and reads refs through the closure", async () => {
    const d = def("x2", "sma(close, 2) + close(QQQ)", "sub");
    const program = compile(d.formula, { aliases: { QQQ: "yahoo:QQQ" } });
    const template = formulaTemplate(d, program, { "yahoo:QQQ": { c: [1, 1] } });
    expect(template.series).toBe("normal");
    const result = await template.calc(
      [
        { timestamp: 1, open: 1, high: 1, low: 1, close: 5 },
        { timestamp: 2, open: 1, high: 1, low: 1, close: 7 },
      ],
      template as never,
    );
    expect(result).toEqual([{ v0: undefined }, { v0: 7 }]);
  });

  it("matches server runFormula across all timeframes including 3D/W straddling a year boundary", async () => {
    // 2025-12-29 (Mon) .. 2026-01-02 (Fri) is one weekly bucket stamped 2025-12-29,
    // yet 2026-01-02 is the first trading day of 2026 (open 123). Both server and chart
    // must give yearopen = 123 for all 2026 bars on D, 3D, W, M, Q and Y.
    const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
    const makeBar = (iso: string, o: number, c: number): Bar => ({ t: day(iso), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100, adj: 1 });
    const stockDaily: Bar[] = [
      makeBar("2025-01-02", 80, 82),
      makeBar("2025-06-02", 90, 92),
      makeBar("2025-12-29", 95, 96),
      makeBar("2025-12-30", 96, 98),
      makeBar("2025-12-31", 98, 100),
      makeBar("2026-01-02", 123, 125),
      makeBar("2026-01-05", 130, 132),
      makeBar("2026-01-06", 132, 135),
      makeBar("2026-01-07", 135, 134),
      makeBar("2026-01-08", 134, 138),
      makeBar("2026-01-09", 138, 140),
      makeBar("2026-02-02", 141, 145),
      makeBar("2026-04-01", 146, 150),
    ];
    const spxDaily: Bar[] = stockDaily.map((b, i) => ({ ...b, o: 500 + i * 2, h: 502 + i * 2, l: 499 + i * 2, c: 501 + i * 2 }));
    const cfg = normalizeConfig({ aliases: { AAPL: "yahoo:AAPL", SPX: "yahoo:^GSPC" } });
    const read = (key: string) => (key === "yahoo:AAPL" ? stockDaily : key === "yahoo:^GSPC" ? spxDaily : []);

    const formulas = [
      "year",
      "month",
      "yearopen",
      "close / yearopen - 1",
      "macd(close, 2, 4)",
      "macdsignal(close, 2, 4, 2)",
      "macdhist(close(SPX), 2, 4, 2)",
    ];
    const tfs: Timeframe[] = ["D", "3D", "W", "M", "Q", "Y"];

    for (const tf of tfs) {
      const chart = loadChart("yahoo:AAPL", tf, "split", ["yahoo:^GSPC"], cfg, read);
      for (const source of formulas) {
        const server = runFormula("yahoo:AAPL", source, tf, cfg, read);
        const program = compile(source, { aliases: cfg.aliases });
        const tpl = formulaTemplate(def("cmp", source, "sub"), program, chart.refs, chart.yearOpens);
        const client = (await tpl.calc(chart.bars as KLineData[], tpl as never)).map((pt) => pt.v0 ?? NaN);
        expect(client.length).toBe(server.line.length);
        for (let i = 0; i < server.line.length; i++) {
          if (Number.isNaN(server.line[i])) expect(Number.isNaN(client[i])).toBe(true);
          else expect(client[i]).toBeCloseTo(server.line[i], 6);
        }
        // explicitly verify 2026 bars on W and 3D use Jan 2's open (123), not Jan 5's open (130)
        if (source === "yearopen" && (tf === "W" || tf === "3D")) {
          const i2026 = server.bars.findIndex((b) => new Date(b.t * 1000).getUTCFullYear() === 2026);
          expect(i2026).toBeGreaterThan(-1);
          expect(server.line[i2026]).toBe(123);
          expect(client[i2026]).toBe(123);
        }
      }
    }
  });
});
