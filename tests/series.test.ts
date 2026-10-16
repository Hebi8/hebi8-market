import { describe, expect, it } from "vitest";
import { aggregate, align, applyPrices, bucketStart, closeAtOrBefore, dedupeBars, type Bar } from "@/lib/series";

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
const bar = (iso: string, c: number, extra: Partial<Bar> = {}): Bar => ({
  t: day(iso),
  o: c,
  h: c,
  l: c,
  c,
  v: 1,
  adj: 1,
  ...extra,
});

describe("bucketStart", () => {
  it("weeks start on Monday, including for Sunday bars", () => {
    expect(bucketStart(day("2026-10-07"), "W")).toBe(day("2026-10-05")); // Wednesday
    expect(bucketStart(day("2026-10-11"), "W")).toBe(day("2026-10-05")); // Sunday
    expect(bucketStart(day("2026-10-05"), "W")).toBe(day("2026-10-05")); // Monday
  });

  it("months start on the 1st", () => {
    expect(bucketStart(day("2026-02-28"), "M")).toBe(day("2026-02-01"));
  });

  it("quarters start in January, April, July and October", () => {
    expect(bucketStart(day("2026-02-28"), "Q")).toBe(day("2026-01-01"));
    expect(bucketStart(day("2026-06-30"), "Q")).toBe(day("2026-04-01"));
    expect(bucketStart(day("2026-12-31"), "Q")).toBe(day("2026-10-01"));
  });
});

describe("aggregate", () => {
  const daily = [
    bar("2026-09-28", 10, { o: 9, h: 11, l: 8, v: 100 }),
    bar("2026-09-30", 12, { o: 10, h: 13, l: 10, v: 50, adj: 0.9 }),
    bar("2026-10-04", 11, { o: 12, h: 12, l: 9, v: 25 }), // Sunday, same week
    bar("2026-10-05", 14, { o: 11, h: 15, l: 11, v: 10 }),
  ];

  it("builds weekly OHLCV and keeps the last bar's adjustment factor", () => {
    expect(aggregate(daily, "W")).toEqual([
      { t: day("2026-09-28"), o: 9, h: 13, l: 8, c: 11, v: 175, adj: 1 },
      { t: day("2026-10-05"), o: 11, h: 15, l: 11, c: 14, v: 10, adj: 1 },
    ]);
  });

  it("builds monthly and quarterly OHLCV", () => {
    expect(aggregate(daily, "M").map((b) => [b.t, b.o, b.c])).toEqual([
      [day("2026-09-01"), 9, 12],
      [day("2026-10-01"), 12, 14],
    ]);
    expect(aggregate(daily, "Q").map((b) => [b.t, b.o, b.h, b.l, b.c, b.v])).toEqual([
      [day("2026-07-01"), 9, 13, 8, 12, 150],
      [day("2026-10-01"), 12, 15, 9, 14, 35],
    ]);
  });

  it("keeps volume null when the source has none", () => {
    const noVolume = daily.map((b) => ({ ...b, v: null }));
    expect(aggregate(noVolume, "W")[0].v).toBeNull();
  });

  it("does not mutate the daily input", () => {
    const copy = structuredClone(daily);
    aggregate(daily, "W");
    expect(daily).toEqual(copy);
  });
});

describe("applyPrices", () => {
  const daily = [bar("2026-01-01", 100, { o: 90, h: 110, l: 80, adj: 0.5 }), bar("2026-01-02", 100)];

  it("folds dividends into total-return prices and leaves split mode alone", () => {
    expect(applyPrices(daily, "split")).toBe(daily);
    const total = applyPrices(daily, "total");
    expect(total[0]).toEqual({ ...daily[0], o: 45, h: 55, l: 40, c: 50, adj: 1 });
    expect(total[1]).toBe(daily[1]); // factor 1: same object, nothing to do
  });
});

describe("align", () => {
  it("forward-fills the other series across days it did not trade", () => {
    const crypto = [bar("2026-10-02", 1), bar("2026-10-03", 1), bar("2026-10-04", 1), bar("2026-10-05", 1)];
    const stocks = [bar("2026-10-02", 100), bar("2026-10-05", 105)];
    expect(align(crypto, stocks).map((b) => b?.c)).toEqual([100, 100, 100, 105]);
  });

  it("is null before the other series starts", () => {
    expect(align([bar("2026-01-01", 1), bar("2026-01-02", 1)], [bar("2026-01-02", 7)]).map((b) => b?.c ?? null)).toEqual([null, 7]);
  });
});

describe("closeAtOrBefore / dedupeBars", () => {
  const bars = [bar("2026-01-01", 1), bar("2026-01-05", 5), bar("2026-01-09", 9)];

  it("finds the latest close at or before a time", () => {
    expect(closeAtOrBefore(bars, day("2026-01-07"))).toBe(5);
    expect(closeAtOrBefore(bars, day("2026-01-09"))).toBe(9);
    expect(closeAtOrBefore(bars, day("2025-12-31"))).toBeUndefined();
  });

  it("sorts and keeps the last bar per timestamp", () => {
    const out = dedupeBars([bar("2026-01-05", 5), bar("2026-01-01", 1), bar("2026-01-05", 6)]);
    expect(out.map((b) => b.c)).toEqual([1, 6]);
  });
});

describe("3D bars", () => {
  /** Every weekday from `from` to `to`, except the given holidays; closes count up from 1. */
  const weekdays = (from: string, to: string, holidays: string[] = []): Bar[] => {
    const out: Bar[] = [];
    for (let t = day(from); t <= day(to); t += 86400) {
      const iso = new Date(t * 1000).toISOString().slice(0, 10);
      const dow = new Date(t * 1000).getUTCDay();
      if (dow !== 0 && dow !== 6 && !holidays.includes(iso)) out.push(bar(iso, out.length + 1));
    }
    return out;
  };
  const dates = (bars: Bar[]) => bars.map((b) => new Date(b.t * 1000).toISOString().slice(0, 10));

  it("counts weekdays in threes from Monday 1970-01-05, so every symbol has the same buckets", () => {
    expect(bucketStart(day("1970-01-05"), "3D")).toBe(day("1970-01-05"));
    expect(bucketStart(day("1970-01-07"), "3D")).toBe(day("1970-01-05"));
    // Thursday, Friday and the next Monday make one bar
    expect(bucketStart(day("1970-01-08"), "3D")).toBe(day("1970-01-08"));
    expect(bucketStart(day("1970-01-12"), "3D")).toBe(day("1970-01-08"));
    // a weekend day belongs to the Friday before it
    expect(bucketStart(day("2026-10-10"), "3D")).toBe(day("2026-10-08"));
    // before 1970 too
    expect(bucketStart(day("1970-01-02"), "3D")).toBe(day("1969-12-31"));
  });

  it("joins three trading days across weekends; a holiday leaves its bar shorter", () => {
    // 2026-10-07 is a holiday here
    const daily = weekdays("2026-09-28", "2026-10-16", ["2026-10-07"]);
    const bars = aggregate(daily, "3D");
    expect(dates(bars)).toEqual(["2026-09-25", "2026-09-30", "2026-10-05", "2026-10-08", "2026-10-13", "2026-10-16"]);
    // Monday 09-28 and Tuesday 09-29 are the bar that started on Friday 09-25
    expect(bars[0]).toMatchObject({ o: 1, c: 2, v: 2 });
    // Monday and Tuesday only: Wednesday was the holiday
    expect(bars[2]).toMatchObject({ o: 6, c: 7, v: 2 });
    // Thursday, Friday and Monday
    expect(bars[3]).toMatchObject({ o: 8, c: 10, v: 3 });
    expect(bars[5]).toMatchObject({ o: 14, c: 14, v: 1 });
  });

  it("keeps every earlier bar as new days come in", () => {
    const daily = weekdays("2026-01-01", "2026-06-30", ["2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25"]);
    const full = aggregate(daily, "3D");
    for (let n = 1; n < daily.length; n++) {
      const part = aggregate(daily.slice(0, n), "3D");
      expect(part.slice(0, -1)).toEqual(full.slice(0, part.length - 1));
      expect(part.at(-1)!.t).toBe(full[part.length - 1].t);
    }
  });

  it("counts calendar days for a series that trades on weekends", () => {
    const crypto = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"].map((d, i) => bar(d, i + 1));
    const bars = aggregate(crypto, "3D");
    expect(dates(bars)).toEqual(["2026-10-02", "2026-10-05", "2026-10-08"]);
    expect(bars.map((b) => [b.o, b.c])).toEqual([[1, 2], [3, 5], [6, 8]]);
    // asked to count weekdays (it is compared on a stock's chart): the weekend joins Friday's bar
    expect(dates(aggregate(crypto, "3D", false))).toEqual(["2026-09-30", "2026-10-05", "2026-10-08"]);
  });
});
