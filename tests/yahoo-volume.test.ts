import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Yahoo as it answered at the Shanghai lunch break of 2026-10-12
const api = vi.hoisted(() => ({ quote: [] as object[], chart: {} as Record<string, object> }));
vi.mock("yahoo-finance2", () => ({
  default: class {
    async quote() {
      return api.quote;
    }
    async chart(ticker: string) {
      return api.chart[ticker];
    }
  },
}));
vi.mock("@/lib/sources/calendar", () => ({ exchangeCalendar: async () => null }));

import { yahoo } from "@/lib/sources/yahoo";

const NOON = Date.UTC(2026, 9, 12, 4, 55);
const day = (d: number) => Date.UTC(2026, 9, d) / 1000;
// daily rows are stamped at the 09:30 open, 01:30 UTC
const row = (d: number, volume: number) => ({ date: new Date(Date.UTC(2026, 9, d, 1, 30)), open: 3800, high: 3830, low: 3790, close: 3810, adjclose: 3810, volume });
const chart = (instrumentType: string, rows: object[]) => ({ meta: { exchangeTimezoneName: "Asia/Shanghai", exchangeName: "SHH", instrumentType }, quotes: rows });

describe("a mainland index's volume on Yahoo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });
  afterEach(() => vi.useRealTimers());

  it("the quote of the day in progress carries none: it is not in the unit of the settled days", async () => {
    const at = new Date(Date.UTC(2026, 9, 12, 3, 30));
    api.quote = [
      { symbol: "000001.SS", quoteType: "INDEX", marketState: "REGULAR", regularMarketPrice: 3809.08, regularMarketTime: at, regularMarketVolume: 4_169_905_624 },
      { symbol: "399001.SZ", quoteType: "INDEX", marketState: "REGULAR", regularMarketPrice: 12512.1, regularMarketTime: at, regularMarketVolume: 2_160_270_974 },
      { symbol: "600519.SS", quoteType: "EQUITY", marketState: "REGULAR", regularMarketPrice: 1400, regularMarketTime: at, regularMarketVolume: 1_860_456 },
      { symbol: "^GSPC", quoteType: "INDEX", marketState: "CLOSED", regularMarketPrice: 6700, regularMarketTime: at, regularMarketVolume: 2_645_750_000 },
    ];
    const quotes = await yahoo.quotes!(["000001.SS", "399001.SZ", "600519.SS", "^GSPC"]);
    expect(quotes["000001.SS"]).toMatchObject({ price: 3809.08, session: "open" });
    expect(quotes["000001.SS"].dayVolume).toBeUndefined();
    expect(quotes["399001.SZ"].dayVolume).toBeUndefined();
    // a stock there and an index elsewhere are counted the same way all day
    expect(quotes["600519.SS"].dayVolume).toBe(1_860_456);
    expect(quotes["^GSPC"].dayVolume).toBe(2_645_750_000);
  });

  it("the chart's row for today carries none either, the settled days keep theirs", async () => {
    api.chart = {
      "000001.SS": chart("INDEX", [row(8, 482_200), row(9, 535_100), row(12, 4_169_905_624)]),
      "600519.SS": chart("EQUITY", [row(9, 3_511_051), row(12, 1_860_456)]),
    };
    const index = await yahoo.fetchDaily("000001.SS", null);
    expect(index.bars.map((b) => [b.t, b.v])).toEqual([
      [day(8), 482_200],
      [day(9), 535_100],
      [day(12), null],
    ]);
    expect((await yahoo.fetchDaily("600519.SS", null)).bars.at(-1)).toMatchObject({ t: day(12), v: 1_860_456 });

    // the next morning's sync: the 12th is settled
    vi.setSystemTime(Date.UTC(2026, 9, 12, 22, 30));
    api.chart["000001.SS"] = chart("INDEX", [row(9, 535_100), row(12, 601_300)]);
    expect((await yahoo.fetchDaily("000001.SS", null)).bars.at(-1)).toMatchObject({ t: day(12), v: 601_300 });
  });
});
