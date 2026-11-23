import { describe, expect, it } from "vitest";
import { DAY } from "@/lib/time";
import {
  TV_TOOLS,
  convertDrawing,
  convertDrawings,
  hexColor,
  importedIds,
  layoutId,
  normalizeDrawing,
  parseTvSources,
  pointDay,
  timeframesFromTv,
  type DrawingContext,
  type TvDrawing,
  type TvPoint,
} from "@/lib/tv-drawings";

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
/** US stocks: TradingView stamps the daily bar at the open, 09:30 New York (13:30 UTC in summer) */
const open = (iso: string) => day(iso) + 13.5 * 3600;
const ms = (iso: string) => day(iso) * 1000;

/** Weekdays of Aug–Sep 2026 without Labor Day (Sep 7), as the bars table has them. */
const DAYS: number[] = [];
for (let t = day("2026-08-03"); t <= day("2026-09-30"); t += DAY) {
  const wd = new Date(t * 1000).getUTCDay();
  if (wd !== 0 && wd !== 6 && t !== day("2026-09-07")) DAYS.push(t);
}
const US: DrawingContext = { days: DAYS, timeZone: "America/New_York", sessionMinutes: 390, tick: 0.01 };
/** No bars cached */
const BARE: DrawingContext = { days: [], timeZone: "UTC", sessionMinutes: 1440, tick: null };

const pt = (iso: string, price: number, extra: Partial<TvPoint> = {}): TvPoint => ({ time_t: open(iso), price, ...extra });
const drawing = (type: string, points: TvPoint[], state: Record<string, unknown> = {}, id = "d1"): TvDrawing => ({ id, symbol: "NASDAQ:NVDA", type, points, state });

describe("pointDay", () => {
  it("puts a daily bar's stamp on its trading day, like the sources store bars", () => {
    expect(pointDay(open("2026-09-01"), "America/New_York")).toBe(day("2026-09-01"));
    // Tokyo opens 09:00 JST = 00:00 UTC
    expect(pointDay(day("2026-09-01"), "Asia/Tokyo")).toBe(day("2026-09-01"));
    // FX: Monday's session starts Sunday 17:00 New York
    expect(pointDay(day("2026-08-30") + 21 * 3600, "America/New_York")).toBe(day("2026-08-31"));
    // crypto: UTC days
    expect(pointDay(day("2026-09-01"), "Etc/UTC")).toBe(day("2026-09-01"));
  });

  it("keeps an intraday point on its own day", () => {
    // 15:59 New York; the bars' +12h rule would make it the next day
    expect(pointDay(day("2026-09-01") + 19.98 * 3600, "America/New_York")).toBe(day("2026-09-01"));
    expect(pointDay(day("2026-09-01") + 23.5 * 3600, "UTC")).toBe(day("2026-09-01"));
    expect(pointDay(day("2026-09-01") + 6 * 3600, "Asia/Hong_Kong")).toBe(day("2026-09-01"));
  });
});

describe("normalizeDrawing / parseTvSources", () => {
  const stored = {
    id: "abc123",
    symbol: "NASDAQ:NVDA",
    ownerSource: "_seriesId",
    serverUpdateTime: 1767000000,
    state: {
      type: "LineToolHorzLine",
      id: "abc123",
      points: [{ time_t: open("2026-09-01"), offset: 0, price: 120.5 }],
      zorder: -5000,
      state: { linecolor: "rgba(242, 54, 69, 1)", linewidth: 2, linestyle: 2, intervalsVisibilities: { days: true }, showPrice: true },
    },
  };
  const expected: TvDrawing = {
    id: "abc123",
    symbol: "NASDAQ:NVDA",
    type: "LineToolHorzLine",
    points: [{ time_t: open("2026-09-01"), price: 120.5 }],
    state: { linecolor: "rgba(242, 54, 69, 1)", linewidth: 2, linestyle: 2, intervalsVisibilities: { days: true } },
  };

  it("reads a drawing as stored and as the library returns it", () => {
    expect(normalizeDrawing(stored)).toEqual(expected);
    // getDrawings spreads the stored `state` over the drawing
    expect(normalizeDrawing({ ...stored, ...stored.state })).toEqual(expected);
  });

  it("reads a symbol written with options, and gives up on what is not a drawing", () => {
    expect(normalizeDrawing({ ...stored, symbol: '={"adjustment":"splits","symbol":"NASDAQ:NVDA"}' })?.symbol).toBe("NASDAQ:NVDA");
    expect(normalizeDrawing({ id: "x", symbol: "A:B", state: { type: "study_RSI", points: [] } })).toBeNull();
    expect(normalizeDrawing({ id: "x", state: { type: "LineToolHorzLine", points: [] } })).toBeNull();
    expect(normalizeDrawing("text")).toBeNull();
  });

  it("takes the response, its sources, a list or one drawing", () => {
    const second = { ...stored, id: "def456", state: { ...stored.state, id: "def456" } };
    const sources = { abc123: stored, def456: second };
    const ids = (text: string) => parseTvSources(text).map((d) => d.id);
    expect(ids(JSON.stringify({ success: true, payload: { sources } }))).toEqual(["abc123", "def456"]);
    expect(ids(JSON.stringify({ sources }))).toEqual(["abc123", "def456"]);
    expect(ids(JSON.stringify(sources))).toEqual(["abc123", "def456"]);
    expect(ids(JSON.stringify([stored, second, stored]))).toEqual(["abc123", "def456"]);
    expect(ids(JSON.stringify(stored))).toEqual(["abc123"]);
    expect(() => parseTvSources("{ sources")).toThrow("不是 JSON");
  });
});

describe("convertDrawing: tools", () => {
  const three = [pt("2026-09-01", 100), pt("2026-09-08", 110), pt("2026-09-15", 105)];
  const many = (n: number) => Array.from({ length: n }, (_, i) => pt(new Date((DAYS[i * 2] ?? DAYS[0]) * 1000).toISOString().slice(0, 10), 100 + i));

  it("maps every TradingView tool in the table to the app's tool with its points", () => {
    for (const [type, map] of Object.entries(TV_TOOLS)) {
      const n = map.points === "many" ? 4 : map.points;
      const state = map.kind === "text" ? { text: "备注", color: "#2962FF" } : { linecolor: "#2962FF" };
      const r = convertDrawing(drawing(type, many(n), state), US);
      expect(r.ok, type).toBe(true);
      if (!r.ok) continue;
      expect(r.overlay.name, type).toBe(map.name);
      expect(r.overlay.points.length, type).toBe(n);
    }
  });

  it("covers the app's tools: everything in the toolbar but the price channel has a TradingView counterpart", async () => {
    const { DRAW_TOOLS } = await import("@/components/chart-types");
    const mapped = new Set([...Object.values(TV_TOOLS).map((m) => m.name), "segment", "straightLine", "rayLine", "horizontalRayLine", "ellipse", "curve", "longPosition", "shortPosition"]);
    expect(DRAW_TOOLS.map((t) => t.name).filter((n) => !mapped.has(n))).toEqual(["priceChannelLine"]);
  });

  it("turns a trend line into a segment, ray or extended line by its extend flags", () => {
    const two = three.slice(0, 2);
    const at = (state: Record<string, unknown>) => {
      const r = convertDrawing(drawing("LineToolTrendLine", two, state), US);
      return r.ok ? [r.overlay.name, r.overlay.points.map((p) => p.value)] : r.reason;
    };
    expect(at({})).toEqual(["segment", [100, 110]]);
    expect(at({ extendRight: true })).toEqual(["rayLine", [100, 110]]);
    expect(at({ extendLeft: true })).toEqual(["rayLine", [110, 100]]);
    expect(at({ extendLeft: true, extendRight: true })).toEqual(["straightLine", [100, 110]]);
  });

  it("gives a horizontal ray a second point to the right", () => {
    const r = convertDrawing(drawing("LineToolHorzRay", [pt("2026-09-01", 100)]), US);
    expect(r.ok && r.overlay).toMatchObject({ name: "horizontalRayLine", points: [{ timestamp: ms("2026-09-01"), value: 100 }, { timestamp: ms("2026-12-10"), value: 100 }] });
  });

  it("draws an ellipse from two corners, or from one axis and a point on the other", () => {
    const corners = convertDrawing(drawing("LineToolEllipse", three.slice(0, 2)), US);
    expect(corners.ok && corners.overlay.points).toEqual([
      { timestamp: ms("2026-09-01"), value: 100 },
      { timestamp: ms("2026-09-08"), value: 110 },
    ]);
    const axis = convertDrawing(drawing("LineToolEllipse", [pt("2026-09-01", 100), pt("2026-09-15", 100), pt("2026-09-08", 120)]), US);
    expect(axis.ok && axis.overlay.points).toEqual([
      { timestamp: ms("2026-09-01"), value: 120 },
      { timestamp: ms("2026-09-15"), value: 80 },
    ]);
  });

  it("puts a curve's third point halfway between its control point and the chord", () => {
    const r = convertDrawing(drawing("LineToolBezierQuadro", [pt("2026-09-01", 100), pt("2026-09-21", 100), pt("2026-09-11", 140)]), US);
    expect(r.ok && r.overlay).toMatchObject({ name: "curve", points: [{ value: 100 }, { value: 100 }, { timestamp: ms("2026-09-11"), value: 120 }] });
  });

  it("puts a position's target and stop, kept in ticks, at prices; without bars there is no tick", () => {
    const long = convertDrawing(drawing("LineToolRiskRewardLong", [pt("2026-09-01", 100), pt("2026-09-15", 100)], { profitLevel: 2000, stopLevel: 1000 }), US);
    expect(long.ok && long.overlay).toEqual({
      name: "longPosition",
      points: [
        { timestamp: ms("2026-09-01"), value: 100 },
        { timestamp: ms("2026-09-15"), value: 120 },
        { timestamp: ms("2026-09-15"), value: 90 },
      ],
    });
    const short = convertDrawing(drawing("LineToolRiskRewardShort", [pt("2026-09-01", 100)], { profitLevel: 2000, stopLevel: 1000 }), US);
    expect(short.ok && short.overlay.points).toEqual([
      { timestamp: ms("2026-09-01"), value: 100 },
      { timestamp: ms("2026-09-21"), value: 80 },
      { timestamp: ms("2026-09-21"), value: 110 },
    ]);
    expect(convertDrawing(drawing("LineToolRiskRewardLong", [pt("2026-09-01", 100)], {}), US)).toEqual({ ok: false, reason: "多空持仓缺少止盈 / 止损" });
    expect(convertDrawing(drawing("LineToolRiskRewardLong", [pt("2026-09-01", 100)], { stopLevel: 100, profitLevel: 200 }), BARE)).toEqual({ ok: false, reason: "没有 K 线，算不出最小变动价位" });
  });

  it("keeps a path's points, minus repeats, and needs two", () => {
    const r = convertDrawing(drawing("LineToolPath", [pt("2026-09-01", 1), pt("2026-09-01", 1), pt("2026-09-02", 2)]), US);
    expect(r.ok && r.overlay.points).toEqual([
      { timestamp: ms("2026-09-01"), value: 1 },
      { timestamp: ms("2026-09-02"), value: 2 },
    ]);
    expect(convertDrawing(drawing("LineToolPolyline", [pt("2026-09-01", 1)]), US)).toEqual({ ok: false, reason: "点不够" });
  });

  it("skips tools the app does not have, too few points and empty text", () => {
    expect(convertDrawing(drawing("LineToolFixedRangeVolumeProfile", three.slice(0, 2)), US)).toEqual({ ok: false, reason: "没有对应的工具：LineToolFixedRangeVolumeProfile" });
    expect(convertDrawing(drawing("LineToolParallelChannel", three.slice(0, 2)), US)).toEqual({ ok: false, reason: "点不够（LineToolParallelChannel 要 3 个）" });
    expect(convertDrawing(drawing("LineToolText", [pt("2026-09-01", 1)], { text: "  " }), US)).toEqual({ ok: false, reason: "文字为空" });
    expect(convertDrawing(drawing("LineToolHorzLine", [{ time_t: Number.NaN, price: 1 }]), US)).toEqual({ ok: false, reason: "点的数据不全" });
  });
});

describe("convertDrawing: points", () => {
  const line = (points: TvPoint[], ctx = US) => {
    const r = convertDrawing(drawing("LineToolTrendLine", points), ctx);
    return r.ok ? r.overlay.points.map((p) => new Date(p.timestamp).toISOString().slice(0, 10)) : r.reason;
  };

  it("lands every point on its bar's UTC midnight, a holiday on the bar before", () => {
    expect(line([pt("2026-09-01", 1), { time_t: day("2026-09-03") + 19 * 3600, price: 2 }])).toEqual(["2026-09-01", "2026-09-03"]);
    expect(line([pt("2026-09-07", 1), pt("2026-09-05", 2)])).toEqual(["2026-09-04", "2026-09-04"]);
    // outside the history the day stays as it is
    expect(line([pt("2026-07-01", 1), pt("2026-10-05", 2)])).toEqual(["2026-07-01", "2026-10-05"]);
  });

  it("counts an offset in trading bars, then calendar days past the last bar", () => {
    // 2026-09-03 + 3 bars: Fri 4, (Labor Day) Tue 8, Wed 9
    expect(line([pt("2026-09-01", 1), pt("2026-09-03", 2, { offset: 3 })])).toEqual(["2026-09-01", "2026-09-09"]);
    // the last bar is Sep 30; 5 bars after Sep 28 are 2 bars, then 3 days
    expect(line([pt("2026-09-01", 1), pt("2026-09-28", 2, { offset: 5 })])).toEqual(["2026-09-01", "2026-10-03"]);
    expect(line([pt("2026-09-01", 1), pt("2026-09-28", 2, { offset: 2, interval: "1D" })])).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("counts a negative offset left of the first bar in calendar days", () => {
    // 2026-08-04 - 3 bars: Aug 3 is the first bar, then 2 days before it
    expect(line([pt("2026-08-04", 1, { offset: -3 }), pt("2026-09-28", 2)])).toEqual(["2026-08-01", "2026-09-28"]);
    // an anchor before the cache (TradingView's history can start earlier)
    expect(line([pt("2026-07-20", 1, { offset: -2 }), pt("2026-09-28", 2)])).toEqual(["2026-07-18", "2026-09-28"]);
  });

  it("counts calendar days from an anchor past the cached bars (the cache can be behind TradingView)", () => {
    const utc: DrawingContext = { ...US, timeZone: "UTC" };
    const r = convertDrawing(drawing("LineToolTrendLine", [{ time_t: day("2026-09-01"), price: 1 }, { time_t: day("2026-10-08"), price: 2, offset: 2, interval: "1D" }]), utc);
    expect(r.ok && r.overlay.points[1].timestamp).toBe(ms("2026-10-10"));
  });

  it("ends a month offset on the target month's last day, as KLineChart does", () => {
    const r = convertDrawing(drawing("LineToolTrendLine", [{ time_t: day("2026-01-02"), price: 1 }, { time_t: day("2026-01-31"), price: 2, offset: 1, interval: "1M" }]), BARE);
    expect(r.ok && r.overlay.points[1].timestamp).toBe(ms("2026-02-28"));
  });

  it("counts weekly, monthly and yearly offsets in weeks and months", () => {
    expect(line([pt("2026-09-01", 1), pt("2026-08-31", 2, { offset: 2, interval: "1W" })])).toEqual(["2026-09-01", "2026-09-14"]);
    expect(line([pt("2026-09-01", 1), pt("2026-09-01", 2, { offset: 2, interval: "M" })])).toEqual(["2026-09-01", "2026-11-01"]);
    expect(line([pt("2026-09-01", 1), pt("2026-09-01", 2, { offset: 1, interval: "12M" })])).toEqual(["2026-09-01", "2027-09-01"]);
  });

  it("turns intraday offsets into trading days, a started day counting, and gives up on what it cannot count", () => {
    // 4 × 60 min on a 390-minute day → 1 day; 7 × 60 → 2 days (Sep 3 → Sep 4, Sep 8 past Labor Day)
    expect(line([pt("2026-09-01", 1), pt("2026-09-03", 2, { offset: 4, interval: "60" })])).toEqual(["2026-09-01", "2026-09-04"]);
    expect(line([pt("2026-09-01", 1), pt("2026-09-03", 2, { offset: 7, interval: "60" })])).toEqual(["2026-09-01", "2026-09-08"]);
    expect(line([pt("2026-09-01", 1), pt("2026-09-03", 2, { offset: 7, interval: "60" })], { ...US, sessionMinutes: 1440 })).toEqual(["2026-09-01", "2026-09-04"]);
    expect(line([pt("2026-09-01", 1), pt("2026-09-01", 2, { offset: 4, interval: "1S" })])).toBe("点在最后一根 K 线右边，换算不了");
    expect(line([pt("2026-09-01", 1), pt("2026-09-01", 2, { offset: 4 })], BARE)).toBe("点在最后一根 K 线右边，换算不了");
  });
});

describe("convertDrawing: styles", () => {
  it("reads colours in TradingView's formats", () => {
    expect(hexColor("#2962FF")).toBe("#2962ff");
    expect(hexColor("#29f")).toBe("#2299ff");
    expect(hexColor("#2962FFCC")).toBe("#2962ff");
    expect(hexColor("rgba(41, 98, 255, 0.5)")).toBe("#2962ff");
    expect(hexColor("rgb(8,153,129)")).toBe("#089981");
    expect(hexColor("blue")).toBeNull();
  });

  it("turns colour, width and line style into the app's style model", () => {
    const r = convertDrawing(drawing("LineToolTrendLine", [pt("2026-09-01", 1), pt("2026-09-02", 2)], { linecolor: "rgba(242, 54, 69, 1)", linewidth: 3, linestyle: 1 }), US);
    expect(r.ok && r.overlay.styles).toMatchObject({ line: { color: "#f23645", size: 3, style: "dashed", dashedValue: [1.5, 3] }, polygon: { borderColor: "#f23645" } });
    const dashed = convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 1)], { linecolor: "#089981", linewidth: 9, linestyle: 2 }), US);
    expect(dashed.ok && dashed.overlay.styles).toMatchObject({ line: { color: "#089981", size: 4, style: "dashed", dashedValue: [6, 4] } });
    const solid = convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 1)], { linecolor: "#089981" }), US);
    expect(solid.ok && solid.overlay.styles).toMatchObject({ line: { size: 1, style: "solid" } });
    // a fib retracement keeps its colour on the trend line; width and dash are its level lines'
    const fib = convertDrawing(drawing("LineToolFibRetracement", [pt("2026-09-01", 1), pt("2026-09-02", 2)], { trendline: { color: "#787B86", linewidth: 2, linestyle: 2 } }), US);
    expect(fib.ok && fib.overlay.styles).toMatchObject({ line: { color: "#787b86", size: 1, style: "solid" } });
    const thick = convertDrawing(drawing("LineToolTrendBasedFibExtension", [pt("2026-09-01", 1), pt("2026-09-02", 2), pt("2026-09-03", 1.5)], { trendline: { color: "#787B86", linestyle: 2 }, levelsStyle: { linewidth: 2, linestyle: 1 } }), US);
    expect(thick.ok && thick.overlay.styles).toMatchObject({ line: { color: "#787b86", size: 2, style: "dashed", dashedValue: [1.5, 3] } });
  });

  it("takes a Fibonacci drawing's background and extension where TradingView recorded them", () => {
    const points = [pt("2026-09-01", 1), pt("2026-09-02", 2)];
    // TradingView keeps only what was changed; its defaults are the app's
    const plain = convertDrawing(drawing("LineToolFibRetracement", points, {}), US);
    expect(plain.ok && "extendData" in plain.overlay).toBe(false);
    const changed = convertDrawing(drawing("LineToolFibRetracement", points, { fillBackground: false, transparency: 60, extendLines: true }), US);
    expect(changed.ok && changed.overlay.extendData).toEqual({ background: false, transparency: 60, extendLeft: false, extendRight: true, oneColor: false, reverse: false });
    const ext = convertDrawing(drawing("LineToolTrendBasedFibExtension", [...points, pt("2026-09-03", 1.5)], { extendLinesLeft: true, reverse: true }), US);
    expect(ext.ok && ext.overlay.extendData).toMatchObject({ background: true, transparency: 80, extendLeft: true, extendRight: false, reverse: true });
    // the points stay as TradingView has them
    expect(ext.ok && ext.overlay.points.map((p) => p.value)).toEqual([1, 2, 1.5]);
    // another tool's flags of the same name are not a Fibonacci setting
    const channel = convertDrawing(drawing("LineToolFibChannel", [...points, pt("2026-09-03", 1.5)], { fillBackground: false }), US);
    expect(channel.ok && "extendData" in channel.overlay).toBe(false);
  });

  it("leaves the default look when there is no colour", () => {
    const r = convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 1)], { linewidth: 2 }), US);
    expect(r).toEqual({ ok: true, overlay: { name: "horizontalStraightLine", points: [{ timestamp: ms("2026-09-01"), value: 1 }] } });
  });

  it("keeps a text's words, colour and size, a note's background colour", () => {
    const text = convertDrawing(drawing("LineToolText", [pt("2026-09-01", 1)], { text: "突破\n回踩", color: "#FF9800", fontsize: 20 }), US);
    expect(text.ok && text.overlay).toMatchObject({ name: "text", extendData: "突破\n回踩", styles: { line: { color: "#ff9800" }, text: { size: 20 } } });
    const note = convertDrawing(drawing("LineToolNote", [pt("2026-09-01", 1)], { text: "财报", backgroundColor: "rgba(103, 58, 183, 0.8)", textColor: "#ffffff", fontsize: 14 }), US);
    expect(note.ok && note.overlay).toMatchObject({ name: "simpleAnnotation", extendData: "财报", styles: { line: { color: "#673ab7" }, text: { size: 14 } } });
  });

  it("carries hidden and locked", () => {
    const r = convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 1)], { visible: false, frozen: true }), US);
    expect(r.ok && r.overlay).toMatchObject({ hidden: true, lock: true });
  });

  it("imports custom Fibonacci level1..level24 from full tables and sparse diffs, omitting defaults", () => {
    const points = [pt("2026-09-01", 100), pt("2026-09-08", 200)];
    // Full 24-slot default table (11 standard visible + extra hidden): matches defaults so levels/extendData omitted
    const fullDefault: Record<string, unknown> = {
      level1: { coeff: 0, color: "#787B86", visible: true },
      level2: { coeff: 0.236, color: "#F23645", visible: true },
      level3: { coeff: 0.382, color: "#FF9800", visible: true },
      level4: { coeff: 0.5, color: "#4CAF50", visible: true },
      level5: { coeff: 0.618, color: "#089981", visible: true },
      level6: { coeff: 0.786, color: "#00BCD4", visible: true },
      level7: { coeff: 1, color: "#787B86", visible: true },
      level8: { coeff: 1.618, color: "#2962FF", visible: true },
      level9: { coeff: 2.618, color: "#F23645", visible: true },
      level10: { coeff: 3.618, color: "#9C27B0", visible: true },
      level11: { coeff: 4.236, color: "#E91E63", visible: true },
      level12: { coeff: -0.272, color: "#2962FF", visible: false },
    };
    const defRes = convertDrawing(drawing("LineToolFibRetracement", points, fullDefault), US);
    expect(defRes.ok && "extendData" in defRes.overlay).toBe(false);

    // Custom Rule of 7 levels serialized via level1..level6 visible + level7..level11 hidden, normalized through normalizeDrawing
    const rawRule7 = {
      id: "r7",
      symbol: "NASDAQ:NVDA",
      state: {
        type: "LineToolFibRetracement",
        id: "r7",
        points: [pt("2026-09-01", 100), pt("2026-09-08", 200)],
        state: {
          level1: { coeff: 0, color: "#787B86", visible: true },
          level2: { coeff: 1, color: "#787B86", visible: true },
          level3: { coeff: 1.75, color: "rgba(41, 98, 255, 1)", visible: true },
          level4: { coeff: 2.333, color: "#089981", visible: true },
          level5: { coeff: 3.5, color: "#FF9800", visible: true },
          level6: { coeff: 7, color: "#F23645", visible: true },
          level7: { visible: false },
          level8: { visible: false },
          level9: { visible: false },
          level10: { visible: false },
          level11: { visible: false },
        },
      },
    };
    const normR7 = normalizeDrawing(rawRule7)!;
    const r7Res = convertDrawing(normR7, US);
    expect(r7Res.ok && r7Res.overlay.extendData).toMatchObject({
      levels: [
        { level: 0, color: "#787b86" },
        { level: 1, color: "#787b86" },
        { level: 1.75, color: "#2962ff" },
        { level: 2.333, color: "#089981" },
        { level: 3.5, color: "#ff9800" },
        { level: 7, color: "#f23645" },
      ],
    });

    // Sparse edit touching only 2 default slots must keep the remaining 9 default visible levels intact
    const sparse2 = convertDrawing(
      drawing("LineToolFibRetracement", points, {
        level1: { coeff: 0 },
        level3: { coeff: 0.35 },
      }),
      US,
    );
    expect(sparse2.ok).toBe(true);
    const sparse2Levels = (sparse2.ok ? (sparse2.overlay.extendData as { levels: { level: number }[] }).levels : []).map((l) => l.level);
    expect(sparse2Levels).toEqual([0, 0.236, 0.35, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236]);

    // Enabling hidden slot level24 without sending coeff uses TradingView's standard default coeff (4.764)
    const lv24 = convertDrawing(drawing("LineToolFibRetracement", points, { level24: { visible: true } }), US);
    expect(lv24.ok).toBe(true);
    const lv24Levels = (lv24.ok ? (lv24.overlay.extendData as { levels: { level: number }[] }).levels : []).map((l) => l.level);
    expect(lv24Levels).toHaveLength(12);
    expect(lv24Levels[11]).toBe(4.764);

    // Turning off every visible slot skips the drawing with a clear reason instead of falling back to 11 default levels
    const allHidden = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`level${i + 1}`, { visible: false }]));
    expect(convertDrawing(drawing("LineToolFibRetracement", points, allHidden), US)).toEqual({ ok: false, reason: "无可见斐波档位" });

    // Trend-based Fib extension with sparse diff (hide 0.236, add -0.272)
    const extRes = convertDrawing(
      drawing("LineToolTrendBasedFibExtension", [...points, pt("2026-09-15", 150)], {
        level2: { visible: false },
        level12: { coeff: -0.272, color: "#00bcd4", visible: true },
        extendLines: true,
      }),
      US,
    );
    expect(extRes.ok && extRes.overlay.extendData).toMatchObject({ extendRight: true });
    const extLevels = (extRes.ok ? (extRes.overlay.extendData as { levels: { level: number }[] }).levels : []).map((l) => l.level);
    expect(extLevels).not.toContain(0.236);
    expect(extLevels).toContain(-0.272);
    expect(extLevels).toContain(0.618);
  });

  it("maps TradingView intervalsVisibilities to timeframe visibility and skips intraday-only drawings", () => {
    expect(timeframesFromTv(undefined)).toBeUndefined();
    expect(timeframesFromTv({ days: true, weeks: true, months: true })).toBeUndefined();
    expect(timeframesFromTv({ days: false, weeks: true, months: true })).toEqual(["W", "M", "Q", "Y"]);
    expect(timeframesFromTv({ days: true, daysFrom: 1, daysTo: 1, weeks: false, months: false })).toEqual(["D"]);
    expect(timeframesFromTv({ days: true, daysFrom: 2, daysTo: 5, weeks: false, months: false })).toEqual(["3D"]);
    expect(timeframesFromTv({ days: false, weeks: true, months: true, monthsFrom: 3, monthsTo: 12 })).toEqual(["W", "Q", "Y"]);
    // Intraday-only or out-of-range visibility yields [] (never inverted to all timeframes!)
    expect(timeframesFromTv({ days: false, weeks: false, months: false })).toEqual([]);
    expect(timeframesFromTv({ days: true, daysFrom: 10, daysTo: 20, weeks: false, months: false })).toEqual([]);

    const weekly = convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 100)], { intervalsVisibilities: { days: false, weeks: true, months: true } }), US);
    expect(weekly.ok && weekly.overlay.timeframes).toEqual(["W", "M", "Q", "Y"]);
    const all = convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 100)], { intervalsVisibilities: { days: true } }), US);
    expect(all.ok && "timeframes" in all.overlay).toBe(false);

    // Intraday-only drawing is skipped in convertDrawing and counted in convertDrawings.skipped
    const intraday = drawing("LineToolHorzLine", [pt("2026-09-01", 100)], { intervalsVisibilities: { hours: true, days: false, weeks: false, months: false } }, "h1");
    expect(convertDrawing(intraday, US)).toEqual({ ok: false, reason: "仅日内周期可见" });
    expect(convertDrawings([intraday], US, new Set()).skipped).toEqual({ 仅日内周期可见: 1 });
    expect(
      convertDrawing(drawing("LineToolHorzLine", [pt("2026-09-01", 100)], { intervalsVisibilities: { days: true, daysFrom: 10, daysTo: 20, weeks: false, months: false } }), US),
    ).toEqual({ ok: false, reason: "不在支持的周期范围内" });
  });
});

describe("convertDrawings", () => {
  const list = [
    drawing("LineToolHorzLine", [pt("2026-09-01", 1)], {}, "a"),
    drawing("LineToolVertLine", [pt("2026-09-02", 1)], {}, "b"),
    drawing("LineToolSineLine", [pt("2026-09-01", 1), pt("2026-09-02", 2)], {}, "c"),
    drawing("LineToolSineLine", [pt("2026-09-01", 1), pt("2026-09-02", 2)], {}, "d"),
  ];

  it("converts, counts the skipped by reason and leaves out what was imported before", () => {
    const first = convertDrawings(list, US, new Set());
    expect(first.overlays.map((o) => [o.name, o.tvId])).toEqual([
      ["horizontalStraightLine", "a"],
      ["verticalStraightLine", "b"],
    ]);
    expect(first.skipped).toEqual({ "没有对应的工具：LineToolSineLine": 2 });
    expect(convertDrawings(list, US, importedIds(first.overlays))).toMatchObject({ overlays: [], already: 2 });
    // one deleted on the chart comes back
    expect(convertDrawings(list, US, importedIds(first.overlays.slice(1))).overlays.map((o) => o.tvId)).toEqual(["a"]);
  });
});

describe("layoutId", () => {
  it("takes a link or the id", () => {
    expect(layoutId("https://www.tradingview.com/chart/AbCd1234/")).toBe("AbCd1234");
    expect(layoutId("https://cn.tradingview.com/chart/AbCd1234/?symbol=NASDAQ%3ANVDA")).toBe("AbCd1234");
    expect(layoutId(" AbCd1234 ")).toBe("AbCd1234");
    expect(layoutId("https://example.com/x")).toBeNull();
  });
});
