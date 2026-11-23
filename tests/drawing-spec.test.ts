import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Chart, Overlay } from "klinecharts";
import {
  cloneSpec,
  countParkedOverlays,
  drawingOf,
  hasValidDrawingPoints,
  isPaneAvailable,
  isVisibleOnTimeframe,
  mergeSlots,
  normalizeTimeframes,
  patchHorizontalPoints,
  shouldRenderOverlay,
  specOf,
  type DrawingFlags,
  type DrawingSlot,
} from "@/components/drawing-spec";
import { FIB_DEFAULTS, FIB_PRESETS, applyFibTemplate } from "@/components/fib";
import type { OverlaySpec } from "@/lib/vault";

// KLineChart's own overlay objects: they keep the point objects they are given and merge styles in place
type Live = Overlay & {
  override: (o: object) => void;
  eventPressedPointMove: (point: object, index: number) => void;
  startPressedMove: (point: object) => void;
  eventPressedOtherMove: (point: object, store: unknown) => void;
};
let make: (name?: string) => Live;
let registerDrawingTemplates: () => void;
let setOverlayChart: (chart: Chart | null, scales?: (id: string) => "log" | "linear" | undefined) => void;
beforeAll(async () => {
  vi.stubGlobal("window", globalThis);
  const { getOverlayClass } = await import("klinecharts");
  const overlaysMod = await import("@/components/chart-overlays");
  registerDrawingTemplates = overlaysMod.registerDrawingTemplates;
  setOverlayChart = overlaysMod.setOverlayChart;
  registerDrawingTemplates();
  make = (name = "segment") => {
    const Clazz = getOverlayClass(name)!;
    const o = new Clazz() as unknown as Live;
    o.override({ id: "drawing_1", paneId: "candle_pane" });
    return o;
  };
});

const saved = (): OverlaySpec => ({
  name: "segment",
  points: [
    { timestamp: 1, value: 20 },
    { timestamp: 2, value: 30 },
  ],
  styles: { line: { color: "#ff0000" } },
  extendData: { note: "a" },
});

describe("saved drawings and the chart share no objects", () => {
  it("a point dragged after undo does not change the saved state it was drawn from", () => {
    const spec = saved();
    const shared = make();
    // what undo did before: the saved points went to KLineChart as they were
    shared.override({ points: spec.points });
    shared.eventPressedPointMove({ timestamp: 1, value: 40 }, 0);
    expect(spec.points[0].value).toBe(40);

    const fresh = saved();
    const o = make();
    o.override(drawingOf(fresh));
    o.eventPressedPointMove({ timestamp: 1, value: 40 }, 0);
    expect(fresh.points[0].value).toBe(20);
    expect(o.points[0].value).toBe(40);
  });

  it("a later style or text change does not reach a saved state", () => {
    const o = make();
    o.override(drawingOf(saved()));
    const red = specOf(o, new Map())!;
    o.override({ styles: { line: { color: "#0000ff" } }, extendData: { note: "b" } });
    expect(o.styles?.line?.color).toBe("#0000ff");
    expect(red.styles).toEqual({ line: { color: "#ff0000" } });
    expect(red.extendData).toEqual({ note: "a" });
    expect(specOf(o, new Map())!.styles).toEqual({ line: { color: "#0000ff" } });
  });

  it("replaces custom Fibonacci levels cleanly without KLineChart's merge() leaking old trailing items", () => {
    const o = make("fibonacciLine");
    const eleven = {
      ...FIB_DEFAULTS,
      levels: Array.from({ length: 11 }, (_, i) => ({ level: i * 0.5, color: "#2962ff" })),
    };
    o.override({ extendData: structuredClone(eleven) });
    expect((o.extendData as { levels: unknown[] }).levels).toHaveLength(11);

    // Clearing extendData before override replaces the shorter array (Rule of 7 has 6 levels) and default reset cleanly
    const r7 = applyFibTemplate(FIB_PRESETS[2]);
    o.extendData = undefined;
    o.override({ extendData: structuredClone(r7) });
    expect((o.extendData as { levels: { level: number }[] }).levels.map((l) => l.level)).toEqual([0, 1, 1.75, 2.333, 3.5, 7]);

    o.extendData = undefined;
    o.override({ extendData: structuredClone(FIB_DEFAULTS) });
    expect("levels" in (o.extendData as Record<string, unknown>)).toBe(false);
  });
});

describe("timeframe visibility and sub-pane preservation", () => {
  const line = (value: number, extra: Partial<OverlaySpec> = {}): OverlaySpec => ({
    name: "horizontalStraightLine",
    points: [{ timestamp: 1000, value }],
    ...extra,
  });

  it("normalizes timeframe lists generically and collapses all-selected / empty to undefined", () => {
    expect(normalizeTimeframes(undefined)).toBeUndefined();
    expect(normalizeTimeframes([])).toBeUndefined();
    expect(normalizeTimeframes(["Y", "D", "W", "D"])).toEqual(["D", "W", "Y"]);
    expect(normalizeTimeframes(["D", "3D", "W", "M", "Q", "Y"])).toBeUndefined();
    // Works with any custom timeframe list (e.g. future intraday timeframes)
    const future = ["1H", "4H", "D", "W"] as unknown as ("D" | "3D" | "W" | "M" | "Q" | "Y")[];
    expect(normalizeTimeframes(["W", "1H"], future)).toEqual(["1H", "W"]);
    expect(normalizeTimeframes(["1H", "4H", "D", "W"], future)).toBeUndefined();
  });

  it("evaluates timeframe visibility and pane availability independently", () => {
    const panes = new Map([
      ["RSI", "pane_RSI"],
      ["F_dev40", "pane_F_dev40"],
    ]);
    expect(isVisibleOnTimeframe({}, "D")).toBe(true);
    expect(isVisibleOnTimeframe({ timeframes: ["W", "M", "Y"] }, "D")).toBe(false);
    expect(isVisibleOnTimeframe({ timeframes: ["W", "M", "Y"] }, "W")).toBe(true);
    expect(isPaneAvailable({}, panes)).toBe(true);
    expect(isPaneAvailable({ pane: "RSI" }, panes)).toBe(true);
    expect(isPaneAvailable({ pane: "MACD" }, panes)).toBe(false);

    expect(shouldRenderOverlay({ pane: "RSI", timeframes: ["W"] }, "W", panes)).toBe(true);
    expect(shouldRenderOverlay({ pane: "RSI", timeframes: ["W"] }, "D", panes)).toBe(false);
    expect(shouldRenderOverlay({ pane: "MACD", timeframes: ["W"] }, "W", panes)).toBe(false);
  });

  it("never loses hidden-timeframe drawings when editing, adding or deleting on another timeframe", () => {
    const weeklyOnly = line(200, { timeframes: ["W", "M", "Y"] });

    // On D: weeklyOnly is parked, d1 (all timeframes) and d2 (D-only) are mounted
    const slotsOnD: DrawingSlot[] = [
      { mounted: true, id: "d1" },
      { mounted: false, spec: cloneSpec(weeklyOnly) },
      { mounted: true, id: "d2" },
    ];

    // User edits d1 (100 -> 105), deletes d2, and draws a brand-new line d3 (150) on D
    const liveOnD = new Map<string, OverlaySpec>([
      ["d1", line(105)],
      ["d3", line(150)],
    ]);
    const afterEdit = mergeSlots(slotsOnD, liveOnD);
    expect(afterEdit.specs).toEqual([line(105), weeklyOnly, line(150)]);
    expect(afterEdit.slots).toEqual([
      { mounted: true, id: "d1" },
      { mounted: false, spec: weeklyOnly },
      { mounted: true, id: "d3" },
    ]);
  });

  it("preserves sub-pane drawings across indicator close/reopen and main-pane edits", () => {
    const rsiLine = line(70, { pane: "RSI" });
    const formulaLine = line(0, { pane: "F_dev40", timeframes: ["W", "M"] });
    const cmpLine = line(400, { pane: "yahoo:QQQ" });

    // RSI and F_dev40 are currently closed (parked); main and QQQ compare pane are open
    const slots: DrawingSlot[] = [
      { mounted: true, id: "m1" },
      { mounted: false, spec: cloneSpec(rsiLine) },
      { mounted: false, spec: cloneSpec(formulaLine) },
      { mounted: true, id: "c1" },
    ];
    // User drags mainLine to 110 and draws a new line on QQQ compare pane
    const live = new Map<string, OverlaySpec>([
      ["m1", line(110)],
      ["c1", cmpLine],
      ["c2", line(420, { pane: "yahoo:QQQ" })],
    ]);
    const merged = mergeSlots(slots, live);
    expect(merged.specs).toEqual([line(110), rsiLine, formulaLine, cmpLine, line(420, { pane: "yahoo:QQQ" })]);
    // Reopening RSI makes rsiLine renderable again without losing its pane identity
    expect(shouldRenderOverlay(merged.specs[1], "D", new Set(["RSI"]))).toBe(true);
    expect(shouldRenderOverlay(merged.specs[2], "W", new Set(["F_dev40"]))).toBe(true);
    expect(shouldRenderOverlay(merged.specs[2], "D", new Set(["F_dev40"]))).toBe(false);
  });

  it("serializes pane and normalized timeframes from DrawingFlags via specOf", () => {
    const o = make("segment");
    o.override({
      points: [
        { timestamp: 1, value: 30 },
        { timestamp: 2, value: 70 },
      ],
    });
    const flags = new Map<string, DrawingFlags>([[o.id, { pane: "RSI", timeframes: ["Y", "W"], lock: true }]]);
    expect(specOf(o, flags)).toEqual({
      name: "segment",
      points: [
        { timestamp: 1, value: 30 },
        { timestamp: 2, value: 70 },
      ],
      lock: true,
      pane: "RSI",
      timeframes: ["W", "Y"],
    });
    // All timeframes selected collapses to omitted `timeframes`
    flags.set(o.id, { pane: "RSI", timeframes: ["D", "3D", "W", "M", "Q", "Y"] });
    expect("timeframes" in specOf(o, flags)!).toBe(false);
  });

  it("backfills timestamp for horizontalStraightLine clicked on a sub-pane y-axis, and rejects invalid points on other tools", () => {
    const h = make("horizontalStraightLine");
    h.override({ points: [{ value: 70 }] });
    const flags = new Map<string, DrawingFlags>([[h.id, { pane: "RSI" }]]);
    // Without fallback timestamp it has no timestamp; with fallback it persists cleanly
    expect(specOf(h, flags)).toBeNull();
    expect(patchHorizontalPoints("horizontalStraightLine", [{ value: 70 }], 1700000000000)).toEqual([{ value: 70, timestamp: 1700000000000 }]);
    expect(specOf(h, flags, 1700000000000)).toEqual({
      name: "horizontalStraightLine",
      points: [{ timestamp: 1700000000000, value: 70 }],
      pane: "RSI",
    });

    // Other tools clicked on a y-axis (missing timestamp) are not silently patched
    expect(patchHorizontalPoints("segment", [{ value: 70 }], 1700000000000)).toBeNull();
    expect(hasValidDrawingPoints([{ value: 70 }])).toBe(false);
    expect(hasValidDrawingPoints([{ timestamp: 1700000000000, value: 70 }])).toBe(true);
  });

  it("counts parked overlays hidden by timeframe or closed sub-panes", () => {
    const overlays = [
      line(100), // visible everywhere
      line(200, { timeframes: ["W", "M"] }), // parked on D
      line(70, { pane: "RSI" }), // parked when RSI closed
      line(400, { pane: "yahoo:QQQ", timeframes: ["D"] }), // visible on D when QQQ pane open
    ];
    expect(countParkedOverlays(overlays, "D", new Set(["yahoo:QQQ"]))).toBe(2);
    expect(countParkedOverlays(overlays, "W", new Set(["RSI", "yahoo:QQQ"]))).toBe(1);
    expect(countParkedOverlays(overlays, "D", new Set(["RSI", "yahoo:QQQ"]))).toBe(1);
    expect(countParkedOverlays([line(100)], "D", new Set())).toBe(0);
  });

  it("drags sub-pane drawings linearly (including negative values) even when main pane is log scale", () => {
    const noop = () => 0;
    const fakeChart = {
      getYAxes: ({ paneId }: { paneId: string }) => [{ name: paneId === "candle_pane" ? "logarithm" : "normal" }],
      getChartStore: () => ({ timestampToDataIndex: noop, dataIndexToTimestamp: noop, timestampToFloatIndex: noop, floatIndexToTimestamp: noop }),
    } as unknown as Chart;
    setOverlayChart(fakeChart, () => undefined);
    try {
      const sub = make("segment");
      sub.override({
        id: "sub_1",
        paneId: "pane_MACD",
        points: [
          { timestamp: 1, value: 2 },
          { timestamp: 2, value: -1 },
        ],
      });
      // Drag whole sub-pane line downwards by -3 (linear delta, crosses below 0)
      sub.startPressedMove({ timestamp: 1, value: 1 });
      sub.eventPressedOtherMove({ timestamp: 1, value: -2 }, {});
      expect(sub.points.map((p) => p.value)).toEqual([-1, -4]);
      // Drag single point to negative value
      sub.eventPressedPointMove({ timestamp: 1, value: -6.5 }, 0);
      expect(sub.points[0].value).toBe(-6.5);
    } finally {
      setOverlayChart(null);
    }
  });
});
