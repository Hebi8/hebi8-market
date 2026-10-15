import { describe, expect, it, vi } from "vitest";
import type { Chart, Period } from "klinecharts";
import { tradesWeekends, tradingDayOffset, tradingDayTimestamp } from "@/components/drawing-time";
import { setOverlayChart, snapToBar } from "@/components/chart-overlays";

vi.mock("klinecharts", () => ({ getOverlayClass: vi.fn(), registerOverlay: vi.fn(), utils: {} }));

const day = (date: string) => Date.parse(`${date}T00:00:00Z`);
const barsOf = (...dates: string[]) => dates.map((date) => ({ timestamp: day(date) }));

describe("daily trading calendar", () => {
  it("infers weekends from recent bars, including either Saturday or Sunday", () => {
    expect(tradesWeekends(barsOf("2026-05-14", "2026-05-15"))).toBe(false);
    expect(tradesWeekends(barsOf("2026-05-15", "2026-05-16"))).toBe(true);
    expect(tradesWeekends(barsOf("2026-05-17", "2026-05-18"))).toBe(true);
    const recent = Array.from({ length: 60 }, (_, i) => ({ timestamp: tradingDayTimestamp(day("2026-05-18"), i, false) }));
    expect(tradesWeekends([...barsOf("2026-05-17"), ...recent])).toBe(false);
  });

  it("skips weekends from Friday and counts one day after Monday, regardless of the preceding gap", () => {
    expect(tradingDayTimestamp(day("2026-05-15"), 1, false)).toBe(day("2026-05-18"));
    expect(tradingDayTimestamp(day("2026-05-18"), 1, false)).toBe(day("2026-05-19"));
    expect(tradingDayTimestamp(day("2026-05-18"), -1, false)).toBe(day("2026-05-15"));
    expect(tradingDayTimestamp(day("2026-05-15"), -1, false)).toBe(day("2026-05-14"));
    expect(Math.floor(tradingDayOffset(day("2026-05-15"), day("2026-05-17"), false))).toBe(0);
    expect(Math.floor(tradingDayOffset(day("2026-05-18"), day("2026-05-17"), false))).toBe(-1);
  });

  it("interpolates a fractional position between Friday and Monday in both directions", () => {
    const halfway = day("2026-05-16") + 12 * 3600000;
    expect(tradingDayTimestamp(day("2026-05-15"), 0.5, false)).toBe(halfway);
    expect(tradingDayTimestamp(day("2026-05-18"), -0.5, false)).toBe(halfway);
    expect(tradingDayOffset(day("2026-05-15"), halfway, false)).toBe(0.5);
    expect(tradingDayOffset(day("2026-05-18"), halfway, false)).toBe(-0.5);
  });

  it("keeps calendar days for series that trade on weekends", () => {
    expect(tradingDayTimestamp(day("2026-05-15"), 1, true)).toBe(day("2026-05-16"));
    expect(tradingDayTimestamp(day("2026-05-18"), -1, true)).toBe(day("2026-05-17"));
    expect(tradingDayOffset(day("2026-05-15"), day("2026-05-18"), true)).toBe(3);
  });

  it.each([false, true])("round trips integer and fractional offsets, weekends=%s", (weekends) => {
    for (const date of ["1969-12-31", "2026-05-15", "2026-05-18", "2026-05-20"]) {
      const anchor = day(date);
      for (const offset of [-2000, -6.75, -5, -1, -0.5, 0, 0.25, 1, 4.5, 5, 2000.125]) {
        const timestamp = tradingDayTimestamp(anchor, offset, weekends);
        expect(tradingDayOffset(anchor, timestamp, weekends)).toBeCloseTo(offset, 8);
        if (Number.isInteger(offset) && !weekends) expect([0, 6]).not.toContain(new Date(timestamp).getUTCDay());
      }
      for (let days = -20; days <= 20; days += 0.25) {
        const timestamp = anchor + days * 86400000;
        expect(tradingDayTimestamp(anchor, tradingDayOffset(anchor, timestamp, weekends), weekends)).toBe(timestamp);
      }
    }
  });
});

/** Real chart entry point with a small store: sentinel methods expose any unintended delegation. */
function chartWith(dates: string[]) {
  let bars = barsOf(...dates);
  let period: Period = { type: "day", span: 1 };
  const originals = {
    timestampToDataIndex: vi.fn<(timestamp: number) => number>(() => 42),
    timestampToFloatIndex: vi.fn<(timestamp: number) => number>(() => 42.5),
    dataIndexToTimestamp: vi.fn<(index: number) => number | null>(() => 123),
    floatIndexToTimestamp: vi.fn<(index: number) => number | null>(() => 456),
  };
  const store = { ...originals };
  const chart = { getChartStore: () => store, getDataList: () => bars, getPeriod: () => period } as unknown as Chart;
  setOverlayChart(chart);
  return { chart, store, originals, setBars: (next: string[]) => (bars = barsOf(...next)), setPeriod: (next: Period) => (period = next), bars: () => bars };
}

describe("chart store daily mapping", () => {
  it.each([["2026-05-14", "2026-05-15"], ["2026-05-15", "2026-05-18"]])("shares four mappings with a last bar on %s / %s", (first, last) => {
    const { chart, store, originals } = chartWith([first, last]);
    expect(store.dataIndexToTimestamp(2)).toBe(day(last === "2026-05-15" ? "2026-05-18" : "2026-05-19"));
    for (const index of [-100, -1, 2, 100]) {
      const timestamp = store.dataIndexToTimestamp(index)!;
      expect(store.timestampToDataIndex(timestamp)).toBe(index);
      expect(store.floatIndexToTimestamp(index)).toBe(timestamp);
      expect(store.timestampToFloatIndex(timestamp)).toBe(index);
    }
    for (const index of [-100.25, -0.5, 1.5, 99.75]) {
      const timestamp = store.floatIndexToTimestamp(index)!;
      expect(store.timestampToFloatIndex(timestamp)).toBeCloseTo(index, 8);
      expect(store.timestampToDataIndex(timestamp)).toBe(Math.floor(index));
    }
    expect(snapToBar(chart, day("2026-05-23"))).toBe(day("2026-05-22"));
    expect(snapToBar(chart, day("2026-05-10"))).toBe(day("2026-05-08"));
    Object.values(originals).forEach((method) => expect(method).not.toHaveBeenCalled());
  });

  it("delegates every in-range conversion to the original method with its store", () => {
    const { store, originals } = chartWith(["2026-05-15", "2026-05-18"]);
    for (const timestamp of [day("2026-05-15"), day("2026-05-16"), day("2026-05-18")]) {
      expect(store.timestampToDataIndex(timestamp)).toBe(42);
      expect(store.timestampToFloatIndex(timestamp)).toBe(42.5);
    }
    for (const index of [0, 0.5, 1]) {
      expect(store.dataIndexToTimestamp(index)).toBe(123);
      expect(store.floatIndexToTimestamp(index)).toBe(456);
    }
    Object.values(originals).forEach((method) => expect(method.mock.contexts).toEqual([store, store, store]));
  });

  it.each<Period>([{ type: "week", span: 1 }, { type: "month", span: 1 }, { type: "month", span: 3 }])("keeps $span $type periods unchanged", (period) => {
    const { store, setPeriod } = chartWith(["2026-05-15", "2026-05-18"]);
    setPeriod(period);
    for (const index of [-10, 10]) {
      expect(store.dataIndexToTimestamp(index)).toBe(123);
      expect(store.floatIndexToTimestamp(index)).toBe(456);
    }
    for (const timestamp of [day("2020-01-01"), day("2033-06-01")]) {
      expect(store.timestampToDataIndex(timestamp)).toBe(42);
      expect(store.timestampToFloatIndex(timestamp)).toBe(42.5);
    }
  });

  it("reads the current data after reloads and live appends, with no stored calendar", () => {
    const { store, setBars, bars } = chartWith([]);
    expect(store.dataIndexToTimestamp(2)).toBe(123);
    expect(store.timestampToFloatIndex(day("2026-05-18"))).toBe(42.5);
    setBars(["2026-05-15"]);
    expect(store.dataIndexToTimestamp(1)).toBe(day("2026-05-18"));
    bars().push({ timestamp: day("2026-05-16") });
    expect(store.dataIndexToTimestamp(2)).toBe(day("2026-05-17"));
    expect(store.timestampToDataIndex(day("2026-05-18"))).toBe(3);
    expect(store.floatIndexToTimestamp(-0.5)).toBe(day("2026-05-15") - 12 * 3600000);
    setBars(["2026-05-15", "2026-05-18"]);
    expect(store.dataIndexToTimestamp(2)).toBe(day("2026-05-19"));
  });
});
