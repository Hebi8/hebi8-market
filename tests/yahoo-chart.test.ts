import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MSCI's indices on Yahoo as they answered on 2026-10-16 (issue #9)
const api = vi.hoisted(() => ({ calls: [] as { ticker: string; options: { period1: Date }; module?: object }[], answers: [] as (object | Error)[] }));
vi.mock("yahoo-finance2", () => ({
  default: class {
    async chart(ticker: string, options: { period1: Date }, module?: object) {
      api.calls.push({ ticker, options, module });
      const answer = api.answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    }
  },
}));
vi.mock("@/lib/sources/calendar", () => ({ exchangeCalendar: async () => null }));

import { yahoo } from "@/lib/sources/yahoo";

const NOW = Date.UTC(2026, 9, 16, 6);
const row = (d: number, close: number) => ({ date: new Date(Date.UTC(2026, 9, d, 4)), open: close, high: close, low: close, close, adjclose: close, volume: 0 });
// no currency: the library's schema wants a string there and fails the whole result
const msci = (rows: object[]) => ({
  meta: { currency: null, symbol: "^990100-USD-STRD", exchangeName: "NIM", fullExchangeName: "Nasdaq GIDS", instrumentType: "INDEX", exchangeTimezoneName: "America/New_York", shortName: "MSCI WORLD" },
  quotes: rows,
});
const tooLong = () =>
  new Error("1d data not available for startTime=-5364662400 and endTime=1792120573. Only 100 years worth of day granularity data are allowed to be fetched per request.");

describe("Yahoo's daily history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    api.calls = [];
    api.answers = [];
  });
  afterEach(() => vi.useRealTimers());

  it("is read without the library's schema check, so a symbol without a currency still syncs", async () => {
    api.answers = [msci([row(14, 4380.5), row(15, 4402.25)])];
    const result = await yahoo.fetchDaily("^990100-USD-STRD", null);
    expect(api.calls[0].module).toEqual({ validateResult: false });
    expect(result.bars.map((b) => b.c)).toEqual([4380.5, 4402.25]);
    expect(result.meta).toMatchObject({ name: "MSCI WORLD", exchange: "Nasdaq GIDS", timezone: "America/New_York", kind: "index" });
    expect(result.meta.currency).toBeFalsy();
  });

  it("asks from 1800 and, when Yahoo knows no first trade date and refuses 100+ years, once more from 99 years back", async () => {
    api.answers = [tooLong(), msci([row(15, 3912.8)])];
    const result = await yahoo.fetchDaily("^750108-USD-STRD", null);
    expect(result.bars).toHaveLength(1);
    expect(api.calls.map((c) => c.options.period1.toISOString())).toEqual(["1800-01-01T00:00:00.000Z", "1927-10-16T06:00:00.000Z"]);
    expect(api.calls[1].module).toEqual({ validateResult: false });
  });

  it("does not retry other errors", async () => {
    api.answers = [new Error("No data found, symbol may be delisted"), msci([])];
    await expect(yahoo.fetchDaily("^NOPE", null)).rejects.toThrow("delisted");
    expect(api.calls).toHaveLength(1);
  });
});
