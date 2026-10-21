import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentFirst, describeCondition, observe, parseCondition, type AlertCondition } from "@/lib/alert-conds";
import { decideCondition, type StateRow } from "@/lib/alerts";
import { ConfigError, normalizeConfig } from "@/lib/config";
import type { Bar } from "@/lib/series";

const DAY = 86400;
const T0 = Date.UTC(2026, 0, 5) / 1000;
const bar = (c: number, i = 0): Bar => ({ t: T0 + i * DAY, o: c, h: c, l: c, c, v: 1, adj: 1 });
const closes = (...cs: number[]) => cs.map((c, i) => bar(c, i));

/** Feed a sequence of prices (one check each, same bar unless `newBar`) through a condition. */
function run(c: AlertCondition, trigger: "once" | "bar", prices: (number | [number, "new"])[]): boolean[] {
  let row: StateRow | undefined;
  let i = 0;
  return prices.map((p) => {
    if (Array.isArray(p)) i++;
    const price = Array.isArray(p) ? p[0] : p;
    const { fire, next } = decideCondition(c, trigger, row, observe(c, [bar(price, i)]), T0 + i * DAY);
    if (next) row = next;
    return fire;
  });
}

describe("alerts in hebi8.yaml", () => {
  const aliases = { BTC: "binance:BTCUSDT", SPY: "yahoo:SPY" };

  it("reads TradingView conditions, defaults to once and enabled, and labels them", () => {
    const cfg = normalizeConfig({
      aliases,
      alerts: [
        { key: "BTC", cond: "crossing_up", value: 130000 },
        { key: "SPY", cond: "entering", value: [520, 500], trigger: "bar" },
        { key: "yahoo:NVDA", cond: "moving_down_pct", value: { pct: 5, bars: 3 }, enabled: false, label: "三天跌 5%" },
      ],
    });
    expect(cfg.alerts[0]).toMatchObject({
      key: "binance:BTCUSDT",
      condition: { cond: "crossing_up", value: 130000 },
      when: null,
      tf: "D",
      trigger: "once",
      enabled: true,
      label: "BTC 上穿 130,000",
      text: "上穿 130,000",
    });
    expect(cfg.alerts[1]).toMatchObject({ condition: { cond: "entering", value: [500, 520] }, trigger: "bar", label: "SPY 进入通道 500 ~ 520" });
    expect(cfg.alerts[2]).toMatchObject({ enabled: false, label: "三天跌 5%", text: "三天跌 5%" });
    expect(describeCondition(cfg.alerts[2].condition!)).toBe("3 根 K 线内下跌 5%");
  });

  it("keeps the id when the trigger changes or the alert is paused", () => {
    const one = normalizeConfig({ aliases, alerts: [{ key: "BTC", cond: "greater", value: 1 }] }).alerts[0].id;
    const other = normalizeConfig({ aliases, alerts: [{ key: "binance:BTCUSDT", cond: "greater", value: 1, trigger: "bar", enabled: false }] }).alerts[0].id;
    expect(one).toMatch(/^alert:[0-9a-f]{6}$/);
    expect(other).toBe(one);
    expect(normalizeConfig({ aliases, alerts: [{ key: "BTC", cond: "greater", value: 2 }] }).alerts[0].id).not.toBe(one);
  });

  it.each([
    [{ key: "BTC" }, "需要 cond"],
    [{ key: "BTC", cond: "greater", value: 1, when: "close > 1" }, "只能写一个"],
    [{ key: "BTC", cond: "sideways", value: 1 }, "未知的条件"],
    [{ key: "BTC", cond: "greater", value: "high" }, "价格"],
    [{ key: "BTC", cond: "inside", value: [1] }, "[低, 高]"],
    [{ key: "BTC", cond: "moving_up_pct", value: { pct: 3, bars: 1.5 } }, "正整数"],
    [{ key: "BTC", cond: "greater", value: 1, trigger: "always" }, "trigger"],
    [{ key: "BTC", cond: "greater", value: 1, enabled: "no" }, "enabled"],
  ])("rejects %j", (alert, msg) => {
    expect(() => normalizeConfig({ aliases, alerts: [alert] })).toThrow(ConfigError);
    expect(() => normalizeConfig({ aliases, alerts: [alert] })).toThrow(msg);
  });
});

describe("the alerts panel", () => {
  it("lists the open chart's alerts first and keeps the rest in yaml order", () => {
    const alerts = [{ id: "a", key: "yahoo:AAPL" }, { id: "w", key: null }, { id: "b", key: "yahoo:000001.SS" }, { id: "c", key: "binance:BTCUSDT" }, { id: "d", key: "yahoo:000001.SS" }];
    expect(currentFirst(alerts, "yahoo:000001.SS").map((a) => a.id)).toEqual(["b", "d", "a", "w", "c"]);
    expect(currentFirst(alerts, "yahoo:MSFT").map((a) => a.id)).toEqual(["a", "w", "b", "c", "d"]);
  });
});

describe("TradingView conditions", () => {
  const at = (cond: string, value: unknown) => parseCondition(cond, value);

  it("crossing up / down / either compare with the previous check; the first one only records", () => {
    expect(run(at("crossing_up", 100), "bar", [101, 99, 101, 102, 99])).toEqual([false, false, true, false, false]);
    expect(run(at("crossing_down", 100), "bar", [99, 101, [99, "new"], 101])).toEqual([false, false, true, false]);
    expect(run(at("crossing", 100), "bar", [99, [101, "new"], [99, "new"]])).toEqual([false, true, true]);
  });

  it("entering / exiting a channel are events too", () => {
    expect(run(at("entering", [90, 110]), "bar", [120, 100, [120, "new"], [105, "new"]])).toEqual([false, true, false, true]);
    expect(run(at("exiting", [90, 110]), "bar", [100, 80, [100, "new"], [111, "new"]])).toEqual([false, true, false, true]);
  });

  it("greater / less / inside / outside fire whenever they hold, the first check included", () => {
    expect(run(at("greater", 100), "bar", [101])).toEqual([true]);
    expect(run(at("less", 100), "bar", [101, 99])).toEqual([false, true]);
    expect(run(at("inside", [90, 110]), "bar", [95])).toEqual([true]);
    expect(run(at("outside", [90, 110]), "bar", [95, 111])).toEqual([false, true]);
  });

  it("crossings are strict like cross(): touching the line is not crossing it", () => {
    const up = at("crossing_up", 100);
    const down = at("crossing_down", 100);
    expect(run(up, "bar", [99, 100])).toEqual([false, false]);
    expect(run(up, "bar", [100, 101])).toEqual([false, true]);
    expect(run(down, "bar", [101, 100])).toEqual([false, false]);
    expect(run(down, "bar", [100, 99])).toEqual([false, true]);
    expect(run(at("crossing", 100), "bar", [99, 100, [101, "new"], [100, "new"], [99, "new"]])).toEqual([false, false, true, false, true]);
  });

  it("entering / exiting a channel need the strict inside / outside; an edge is neither", () => {
    const enter = at("entering", [90, 110]);
    const exit = at("exiting", [90, 110]);
    expect(run(enter, "bar", [120, 110])).toEqual([false, false]);
    expect(run(enter, "bar", [110, 109])).toEqual([false, true]);
    expect(run(exit, "bar", [100, 110])).toEqual([false, false]);
    expect(run(exit, "bar", [110, 111])).toEqual([false, true]);
  });

  it("bar fires at most once per daily bar; the next bar fires again", () => {
    expect(run(at("greater", 100), "bar", [101, 102, 103, [104, "new"], 105])).toEqual([true, false, false, true, false]);
  });

  it("moving up / down % look back `bars` daily bars", () => {
    const up = at("moving_up_pct", { pct: 10, bars: 2 });
    expect(observe(up, closes(100, 105, 109))).toBe(0);
    expect(observe(up, closes(100, 105, 110))).toBe(1);
    expect(observe(up, closes(105, 110))).toBeNull(); // not enough history
    const down = at("moving_down_pct", { pct: 10, bars: 1 });
    expect(observe(down, closes(100, 90))).toBe(1);
    expect(observe(down, closes(100, 91))).toBe(0);
  });
});

// ---------------------------------------------------------------------------- polling and judging

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-quotes-"));
const root = path.join(dir, "vault");
const bob = path.join(root, "users", "bob");
const BTC = "binance:BTCUSDT";
const SPY = "yahoo:SPY";

beforeAll(async () => {
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  fs.mkdirSync(bob, { recursive: true });
  const { ensureSymbol, markSynced } = await import("@/lib/store");
  for (const key of [BTC, SPY, "tv:TVC:GOLD"]) {
    ensureSymbol(key);
    markSynced(key, { timezone: key === SPY ? "America/New_York" : "UTC" });
  }
});

afterAll(() => {
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("quote polling", () => {
  it("polls every enabled alert's symbols, synthetic operands and formula references, but not datasets", async () => {
    const { quoteKeys } = await import("@/lib/quotes");
    const cfg = normalizeConfig({
      aliases: { BTC, GOLD: "tv:TVC:GOLD" },
      alerts: [
        { key: "=BTC/GOLD", cond: "greater", value: 30 },
        { key: SPY, when: 'close > close("yahoo:QQQ")' },
        { key: "data:gpu/4090", cond: "less", value: 11000 },
        { key: "yahoo:NVDA", cond: "less", value: 1, enabled: false },
      ],
    });
    expect(quoteKeys([cfg]).sort()).toEqual([BTC, "tv:TVC:GOLD", "yahoo:QQQ", SPY].sort());
  });

  it("polls every watched symbol and its benchmark, alerts or not", async () => {
    const { quoteKeys } = await import("@/lib/quotes");
    const mine = normalizeConfig({
      aliases: { BTC, GOLD: "tv:TVC:GOLD" },
      groups: [{ name: "a", symbols: [{ key: SPY, bench: "yahoo:QQQ" }, "=BTC/GOLD", "data:gpu/4090"] }],
      alerts: [{ cond: "moving_up_pct", value: { pct: 5, bars: 1 } }],
    });
    const theirs = normalizeConfig({ groups: [{ name: "b", symbols: ["yahoo:NVDA", SPY] }] });
    expect(quoteKeys([mine, theirs]).sort()).toEqual([BTC, "tv:TVC:GOLD", "yahoo:NVDA", "yahoo:QQQ", SPY].sort());
  });

  it("asks new symbols at once, open and always ones every 5 minutes, the rest hourly", async () => {
    const { dueKeys } = await import("@/lib/quotes");
    const now = 1_800_000_000_000;
    const seen = new Map([
      ["open", { at: now - 5 * 60_000, session: "open" as const }],
      ["crypto", { at: now - 4.6 * 60_000, session: "always" as const }],
      ["fresh", { at: now - 60_000, session: "open" as const }],
      ["closed", { at: now - 30 * 60_000, session: "closed" as const }],
      ["post", { at: now - 60 * 60_000, session: "post" as const }],
    ]);
    const unknown = { hours: null, timezone: null, holidays: null, corrections: null };
    expect(dueKeys(["new", "open", "crypto", "fresh", "closed", "post"], seen, now, () => unknown)).toEqual(["new", "open", "crypto", "post"]);
  });

  it("asks a pre-market symbol again as soon as its market opens", async () => {
    const { dueKeys } = await import("@/lib/quotes");
    const nasdaq = { hours: "0930-1600", timezone: "America/New_York", holidays: null, corrections: null };
    // asked at 13:08 UTC, the open is 13:30
    const seen = new Map([["pre", { at: Date.parse("2026-10-21T13:08:00Z"), session: "pre" as const }]]);
    expect(dueKeys(["pre"], seen, Date.parse("2026-10-21T13:28:00Z"), () => nasdaq)).toEqual([]);
    expect(dueKeys(["pre"], seen, Date.parse("2026-10-21T13:33:00Z"), () => nasdaq)).toEqual(["pre"]);
  });

  it("puts a quote on the local day of its trade: crypto on the UTC day, a stock on the exchange's date", async () => {
    const { withQuote } = await import("@/lib/quotes");
    const day = Date.UTC(2026, 9, 6) / 1000;
    const daily = [bar(100, 0), { ...bar(101, 0), t: day }];
    const quote = (time: number, session: "always" | "open" | "post") => ({ key: BTC, price: 102, time, session, fetchedAt: 2_000_000_000_000 });
    // 13:00 UTC Binance: the same UTC day, not the next one
    expect(withQuote(daily, quote(day + 13 * 3600, "always"), "UTC", null).map((b) => b.t)).toEqual([T0, day]);
    // 15:00 and 21:00 in New York (19:00 and 01:00 UTC): still the exchange's Oct 6
    expect(withQuote(daily, quote(day + 19 * 3600, "open"), "America/New_York", null).map((b) => b.t)).toEqual([T0, day]);
    expect(withQuote(daily, quote(day + 25 * 3600, "post"), "America/New_York", null).map((b) => b.t)).toEqual([T0, day]);
  });

  it("builds today's bar in memory from the quote and never writes it to bars", async () => {
    const { withQuote } = await import("@/lib/quotes");
    const daily = closes(100, 101);
    const day2 = T0 + DAY;
    const quote = (price: number, time: number, extra = {}) => ({ key: BTC, price, time, session: "always" as const, fetchedAt: 2_000_000_000_000, ...extra });
    // same trading day as the last bar: it is extended, not duplicated
    expect(withQuote(daily, quote(104, day2 + 3600, { dayHigh: 105, dayLow: 98 }), "UTC", null)).toEqual([daily[0], { t: day2, o: 101, h: 105, l: 98, c: 104, v: 1, adj: 1 }]);
    // a new day: appended, opening at the first price polling saw
    const next = withQuote(daily, quote(103, day2 + DAY + 600), "UTC", null, { t: day2 + DAY, o: 102, h: 103.5, l: 101.5 });
    expect(next.at(-1)).toEqual({ t: day2 + DAY, o: 102, h: 103.5, l: 101.5, c: 103, v: null, adj: 1 });
    // a daily sync after the quote wins
    expect(withQuote(daily, quote(104, day2 + DAY), "UTC", 3_000_000_000_000)).toBe(daily);
  });

  it("takes the day's open and volume from the source when it reports them", async () => {
    const { withQuote } = await import("@/lib/quotes");
    const daily = closes(100, 101);
    const day2 = T0 + DAY;
    const quote = { key: SPY, price: 104, time: day2 + DAY + 600, session: "open" as const, fetchedAt: 2_000_000_000_000, dayOpen: 99, dayHigh: 105, dayLow: 98.5, dayVolume: 12345 };
    // a new day: the source's open, not the first price polling saw; its volume instead of none
    expect(withQuote(daily, quote, "UTC", null, { t: day2 + DAY, o: 102, h: 103, l: 101.5 }).at(-1)).toEqual({ t: day2 + DAY, o: 99, h: 105, l: 98.5, c: 104, v: 12345, adj: 1 });
    // the same day as the synced bar: the source's figures replace the bar's
    expect(withQuote(daily, { ...quote, time: day2 + 600 }, "UTC", null).at(-1)).toEqual({ t: day2, o: 99, h: 105, l: 98.5, c: 104, v: 12345, adj: 1 });
    // an open outside the reported range still lies inside the bar
    expect(withQuote(daily, { ...quote, dayOpen: 106 }, "UTC", null).at(-1)).toMatchObject({ o: 106, h: 106 });
    // the day's volume never goes back: a quote that lags behind the synced bar keeps the bar's
    const synced = [daily[0], { ...daily[1], v: 20000 }];
    expect(withQuote(synced, { ...quote, time: day2 + 600 }, "UTC", null).at(-1)?.v).toBe(20000);
    expect(withQuote(synced, { ...quote, time: day2 + 600, dayVolume: 25000 }, "UTC", null).at(-1)?.v).toBe(25000);
    // a new day starts from the quote's own volume
    expect(withQuote(synced, quote, "UTC", null).at(-1)?.v).toBe(12345);
  });

  it("reads Binance's UTC trading day: open, high, low and volume of the daily bar", async () => {
    const { binance } = await import("@/lib/sources/binance");
    const closeTime = Date.UTC(2100, 0, 1) - 1;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ symbol: "BTCUSDT", openPrice: "82635.56", highPrice: "82892.01", lowPrice: "82545.82", lastPrice: "82756.00", volume: "1856.70133", closeTime }])),
    );
    const before = Math.floor(Date.now() / 1000);
    const quotes = await binance.quotes!(["BTCUSDT"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v3/ticker/tradingDay?type=MINI&symbols=%5B%22BTCUSDT%22%5D");
    expect(quotes.BTCUSDT).toMatchObject({ price: 82756, dayOpen: 82635.56, dayHigh: 82892.01, dayLow: 82545.82, dayVolume: 1856.70133, session: "always" });
    // the day's end is not the time of the trade
    expect(quotes.BTCUSDT.time).toBeGreaterThanOrEqual(before);
    expect(quotes.BTCUSDT.time).toBeLessThan(before + 60);
    fetchMock.mockRestore();
  });

  it("puts Sunday evening overnight quotes on Monday, matching the daily bars", async () => {
    const { withQuote } = await import("@/lib/quotes");
    const monday = Date.UTC(2026, 9, 5) / 1000;
    const time = Date.parse("2026-10-04T22:00:00Z") / 1000; // Sunday 18:00 New York
    const daily = [{ ...bar(100), t: monday }];
    for (const [key, zone, hours] of [["tv:TVC:GOLD", "America/New_York", "1800-1700"], ["tv:FX_IDC:EURUSD", "Etc/UTC", "2200-2200"], ["tv:CME_MINI:ES1!", "America/Chicago", "1700-1600:2345|1700-1500:6"]]) {
      const quote = { key, price: 110, time, session: "open" as const, fetchedAt: Date.now() };
      const calendar = { hours, timezone: zone, holidays: null, corrections: null };
      const live = withQuote(daily, quote, zone, null, undefined, calendar);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ t: monday, c: 110 });
      expect(withQuote([{ ...bar(100), t: monday - 3 * DAY }], quote, zone, null, undefined, calendar).map((b) => b.t)).toEqual([monday - 3 * DAY, monday]);
      // an hour before the stated start (FX opens at 21:00 UTC in summer) is Monday's all the same: Sunday is no trading day
      expect(withQuote(daily, { ...quote, time: time - 3600 }, zone, null, undefined, calendar).map((b) => [b.t, b.c])).toEqual([[monday, 110]]);
      // Monday afternoon stays on Monday, instead of rolling over at noon.
      expect(withQuote(daily, { ...quote, time: Date.parse("2026-10-05T19:00:00Z") / 1000 }, zone, null, undefined, calendar).map((b) => [b.t, b.c])).toEqual([[monday, 110]]);
      // Monday evening is Tuesday's session
      expect(withQuote(daily, { ...quote, time: Date.parse("2026-10-05T23:30:00Z") / 1000 }, zone, null, undefined, calendar).map((b) => [b.t, b.c])).toEqual([[monday, 100], [monday + DAY, 110]]);
    }
  });

  it("keeps a print after Friday's close on Friday instead of opening a Saturday bar", async () => {
    const { withQuote } = await import("@/lib/quotes");
    const friday = Date.UTC(2026, 9, 9) / 1000;
    const daily = [{ t: friday, o: 4134.44, h: 4207.54, l: 4130.85, c: 4194.145, v: 0, adj: 1 }];
    const brent = "0100-2300|2300F-2300:2#20261026/0000-2200|2200F-2200:2#20261102/0100-2300|2300F-2300:2";
    for (const [key, zone, hours, at] of [
      ["tv:TVC:GOLD", "America/New_York", "1800-1700", "2026-10-09T23:23:18Z"], // 19:23 in New York, after the 18:00 start of a session that never comes
      ["tv:TVC:US10Y", "America/New_York", "1900-1730", "2026-10-09T21:25:00Z"],
      ["tv:FOREXCOM:CNHJPY", "America/New_York", "1700-1700:23456", "2026-10-09T21:22:00Z"],
      ["tv:FX_IDC:THBUSD", "Etc/UTC", "2200-2200", "2026-10-09T22:30:00Z"],
      ["tv:TVC:UKOIL", "Europe/London", brent, "2026-10-09T21:59:59Z"], // 22:59 in London
    ]) {
      // a last price of its own: the quote is taken into Friday's bar, not dropped
      const quote = { key, price: 4200, time: Date.parse(at) / 1000, session: "closed" as const, fetchedAt: Date.now(), dayOpen: 4134.44, dayHigh: 4207.54, dayLow: 4130.85 };
      expect(withQuote(daily, quote, zone, null, undefined, { hours, timezone: zone, holidays: null, corrections: null })).toEqual([{ ...daily[0], c: 4200 }]);
    }
    // the evening before a holiday: Thursday 2026-12-24, 18:30 in New York, and Christmas Day has no session
    const fx = { hours: "1700-1700", timezone: "America/New_York", holidays: "20261225", corrections: null };
    const eve = [{ ...bar(100), t: Date.UTC(2026, 11, 24) / 1000 }];
    const late = { key: "tv:FX:EURUSD", price: 110, time: Date.parse("2026-12-24T23:30:00Z") / 1000, session: "closed" as const, fetchedAt: Date.now() };
    expect(withQuote(eve, late, fx.timezone, null, undefined, fx).map((b) => [b.t, b.c])).toEqual([[eve[0].t, 110]]);
    // without the holiday that evening would be Friday's session
    expect(withQuote(eve, late, fx.timezone, null, undefined, { ...fx, holidays: null }).map((b) => b.t)).toEqual([eve[0].t, eve[0].t + DAY]);
    // a Monday holiday the metals trade through: Tuesday's sessions are one bar from Sunday evening, stored as Monday 2026-01-19
    const gold = { hours: "1800-1700", timezone: "America/New_York", holidays: "20260119", corrections: "1800F2-1430F1,1800-1700:20260120" };
    const stored = [Date.UTC(2026, 0, 16), Date.UTC(2026, 0, 19)].map((ms) => ({ ...bar(100), t: ms / 1000 }));
    for (const at of ["2026-01-19T15:00:00Z", "2026-01-20T15:00:00Z"]) {
      const quote = { key: "tv:TVC:GOLD", price: 110, time: Date.parse(at) / 1000, session: "open" as const, fetchedAt: Date.now() };
      expect(withQuote(stored, quote, gold.timezone, null, undefined, gold).map((b) => [b.t, b.c])).toEqual([[stored[0].t, 100], [stored[1].t, 110]]);
    }
  });

  it("goes by the hours of the market, not by a fixed evening hour", async () => {
    const { withQuote } = await import("@/lib/quotes");
    const thursday = Date.UTC(2026, 9, 8) / 1000;
    const daily = [{ ...bar(100), t: thursday }];
    const brent = "0100-2300|2300F-2300:2#20261026/0000-2200|2200F-2200:2#20261102/0100-2300|2300F-2300:2";
    const days = (key: string, zone: string, hours: string | null, at: string) =>
      withQuote(daily, { key, price: 110, time: Date.parse(at) / 1000, session: "open" as const, fetchedAt: Date.now() }, zone, null, undefined, { hours, timezone: zone, holidays: null, corrections: null }).map((b) => b.t);
    // Brent trades 01:00 to 23:00 in London: Thursday 21:00 there is still Thursday's bar
    expect(days("tv:TVC:UKOIL", "Europe/London", brent, "2026-10-08T20:00:00Z")).toEqual([thursday]);
    // and Sunday 23:30 is Monday's
    expect(days("tv:TVC:UKOIL", "Europe/London", brent, "2026-10-11T22:30:00Z")).toEqual([thursday, thursday + 4 * DAY]);
    // a stock's after-hours print stays on its day; so does a market whose hours are not known yet
    expect(days("tv:NASDAQ:MSTR", "America/New_York", "0930-1600", "2026-10-08T23:59:00Z")).toEqual([thursday]);
    expect(days("tv:CME_MINI:ES1!", "America/Chicago", null, "2026-10-08T23:30:00Z")).toEqual([thursday]);
    // Yahoo's daily bars are calendar days
    expect(days("yahoo:GC=F", "America/New_York", "1800-1700", "2026-10-08T23:30:00Z")).toEqual([thursday]);
  });

  describe("rounds", () => {
    let calls: { source: string; tickers: string[] }[];
    let fail: Record<string, boolean>;
    let prices: Record<string, number>;

    beforeEach(async () => {
      const { adapters } = await import("@/lib/sources");
      const { resetQuotes } = await import("@/lib/quotes");
      const { getDb } = await import("@/lib/db");
      getDb().exec("DELETE FROM quotes; DELETE FROM alert_state;");
      resetQuotes();
      calls = [];
      fail = {};
      prices = { BTCUSDT: 105, SPY: 500 };
      for (const [source, session] of [["binance", "always"], ["yahoo", "closed"]] as const) {
        vi.spyOn(adapters[source], "quotes").mockImplementation(async (tickers) => {
          calls.push({ source, tickers });
          if (fail[source]) throw new Error(`${source} down`);
          const now = Math.floor(Date.now() / 1000);
          return Object.fromEntries(tickers.filter((t) => t in prices).map((t) => [t, { price: prices[t], time: now, session }]));
        });
      }
    });

    const vaultsWith = (rootAlerts: unknown[], bobAlerts: unknown[] = []) => {
      const yaml = (alerts: unknown[]) => `# 警报\naliases:\n  BTC: ${BTC} # 比特币\nalerts:\n${alerts.map((a) => `  - ${JSON.stringify(a)} # 保留这条注释\n`).join("")}`;
      fs.writeFileSync(path.join(root, "hebi8.yaml"), yaml(rootAlerts));
      fs.writeFileSync(path.join(bob, "hebi8.yaml"), yaml(bobAlerts));
      return [
        { id: "", dir: root, config: normalizeConfig({ aliases: { BTC }, alerts: rootAlerts }) },
        { id: "bob", dir: bob, config: normalizeConfig({ aliases: { BTC }, alerts: bobAlerts }) },
      ];
    };

    it("fetches each source in one batch, then only what is due", async () => {
      const { quoteRound } = await import("@/lib/quotes");
      const { readDaily, readQuotes, writeBars } = await import("@/lib/store");
      writeBars(BTC, closes(100, 101), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 1000 }, { key: SPY, cond: "less", value: 1 }]);
      const now = Date.now();
      await quoteRound(now, vaults);
      expect(calls).toEqual([
        { source: "binance", tickers: ["BTCUSDT"] },
        { source: "yahoo", tickers: ["SPY"] },
      ]);
      expect(Object.keys(readQuotes()).sort()).toEqual([BTC, SPY]);
      expect(readDaily(BTC)).toHaveLength(2);

      calls = [];
      await quoteRound(now + 60_000, vaults);
      expect(calls).toEqual([]);
      await quoteRound(now + 5 * 60_000, vaults);
      expect(calls).toEqual([{ source: "binance", tickers: ["BTCUSDT"] }]); // SPY is closed: hourly
      calls = [];
      await quoteRound(now + 60 * 60_000, vaults);
      expect(calls.map((c) => c.source).sort()).toEqual(["binance", "yahoo"]);
    });

    it("backs a failing source off to hourly after a few failures, without stopping the others", async () => {
      const { quoteRound } = await import("@/lib/quotes");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 1000 }, { key: SPY, cond: "less", value: 1 }]);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      fail.yahoo = true;
      const now = Date.now();
      for (let i = 0; i < 4; i++) await quoteRound(now + i * 5 * 60_000, vaults);
      expect(calls.filter((c) => c.source === "yahoo")).toHaveLength(3);
      expect(calls.filter((c) => c.source === "binance")).toHaveLength(4);
      expect(logs.mock.calls.flat().filter((m) => String(m).includes("yahoo failed"))).toHaveLength(1);
      await quoteRound(now + 3 * 5 * 60_000 + 60 * 60_000, vaults);
      expect(calls.filter((c) => c.source === "yahoo")).toHaveLength(4);
      logs.mockRestore();
    });

    it("asks a long list 100 symbols per request; the symbols of a request that failed are due again next round", async () => {
      const { adapters } = await import("@/lib/sources");
      const { quoteRound } = await import("@/lib/quotes");
      const { readQuotes } = await import("@/lib/store");
      const tickers = Array.from({ length: 250 }, (_, i) => `T${String(i).padStart(3, "0")}USDT`);
      const vault = { id: "", dir: root, config: normalizeConfig({ groups: [{ name: "all", symbols: tickers.map((t) => `binance:${t}`) }] }) };
      fs.writeFileSync(path.join(root, "hebi8.yaml"), "alerts: []\n");
      let down = true;
      vi.spyOn(adapters.binance, "quotes").mockImplementation(async (asked) => {
        calls.push({ source: "binance", tickers: asked });
        if (down && asked.includes("T100USDT")) throw new Error("binance down");
        return Object.fromEntries(asked.map((t) => [t, { price: 1, time: Math.floor(Date.now() / 1000), session: "always" as const }]));
      });
      const now = Date.now();
      await quoteRound(now, [vault]);
      expect(calls.map((c) => c.tickers.length)).toEqual([100, 100, 50]);
      expect(Object.keys(readQuotes())).toHaveLength(150);
      // a minute later nothing but the failed request's symbols is due
      calls = [];
      down = false;
      await quoteRound(now + 60_000, [vault]);
      expect(calls.map((c) => c.tickers)).toEqual([tickers.slice(100, 200)]);
      expect(Object.keys(readQuotes())).toHaveLength(250);
    });

    it("a quote without a session is open on a trading day of the symbol's calendar, closed on its holidays", async () => {
      const { adapters } = await import("@/lib/sources");
      const { quoteRound } = await import("@/lib/quotes");
      const { readQuotes } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      const QQQ = "yahoo:QQQ";
      const { ensureSymbol } = await import("@/lib/store");
      ensureSymbol(QQQ);
      // Thanksgiving 2026, noon in New York: SPY has the exchange's calendar, QQQ only knows its timezone
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.UTC(2026, 10, 26, 17));
      const calendar = getDb().prepare("UPDATE symbols SET timezone = 'America/New_York', hours = ?, holidays = ? WHERE key = ?");
      calendar.run("0930-1600", "20261126,20261225", SPY);
      calendar.run(null, null, QQQ);
      vi.spyOn(adapters.yahoo, "quotes").mockImplementation(async (tickers) => Object.fromEntries(tickers.map((t) => [t, { price: 500, time: Math.floor(Date.now() / 1000) }])));
      const vault = { id: "", dir: root, config: normalizeConfig({ groups: [{ name: "美股", symbols: [SPY, QQQ] }] }) };
      fs.writeFileSync(path.join(root, "hebi8.yaml"), "alerts: []\n");
      await quoteRound(Date.now(), [vault]);
      vi.useRealTimers();
      calendar.run(null, null, SPY);
      expect(readQuotes()[SPY].session).toBe("closed");
      expect(readQuotes()[QQQ].session).toBe("open");
    });

    it("stamps a quote when it arrives, so a daily sync that ends during the request does not hide it", async () => {
      const { adapters } = await import("@/lib/sources");
      const { quoteRound, liveReader } = await import("@/lib/quotes");
      const { getSymbol, markSynced, readQuotes, writeBars } = await import("@/lib/store");
      writeBars(BTC, closes(100, 101), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 1000 }]);
      vi.spyOn(adapters.binance, "quotes").mockImplementation(async () => {
        markSynced(BTC, { timezone: "UTC" }); // the daily sync finishes while the quote is on its way
        await new Promise((r) => setTimeout(r, 5));
        return { BTCUSDT: { price: 123, time: Math.floor(Date.now() / 1000), session: "always" } };
      });
      await quoteRound(Date.now(), vaults);
      expect(readQuotes()[BTC].fetchedAt).toBeGreaterThan(getSymbol(BTC)!.syncedAt!);
      expect(liveReader()(BTC).at(-1)?.c).toBe(123);
    });

    it("loads the config when a run starts: a once alert fires once, an alert paused in the queue holds", async () => {
      const { runAlerts, setAlertsEnabled } = await import("@/lib/alerts");
      const { readConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      writeBars(BTC, closes(100, 101), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 50 }], [{ key: "BTC", cond: "greater", value: 50 }]);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const load = (d: string) => () => readConfig(d);

      // a daily sync and a quote round queued together
      const both = await Promise.all([runAlerts(vaults[0], load(root)), runAlerts(vaults[0], load(root))]);
      expect(both.map((events) => events.length)).toEqual([1, 0]);
      expect(readConfig(root).alerts[0].enabled).toBe(false);

      // bob pauses his alert while his run waits behind another one
      const ahead = runAlerts(vaults[0], load(root));
      const queued = runAlerts(vaults[1], load(bob));
      setAlertsEnabled(bob, [vaults[1].config.alerts[0].id], false);
      await ahead;
      expect(await queued).toEqual([]);
      logs.mockRestore();
    });

    it("judges the whole watchlist after a daily sync only; quote rounds keep its rows, old cond: rows continue", async () => {
      const { runAlerts, readState, stateId } = await import("@/lib/alerts");
      const { liveReader } = await import("@/lib/quotes");
      const { readConfig, updateConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      writeBars(BTC, closes(100, 101), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 1000 }]);
      updateConfig(root, (doc) => {
        doc.set("groups", [{ name: "Crypto", symbols: ["BTC"] }]);
        doc.set("conditions", [{ id: "gate", label: "Above", formula: "close > ref(close, 1)", tf: "D" }]);
      });
      getDb().prepare("INSERT INTO alert_state (vault, rule, key, state) VALUES ('', 'cond:gate', ?, 0)").run(BTC);
      const load = () => readConfig(root);
      const rules = () => [...readState("").keys()].map((k) => k.split("\u0000")[0]).sort();
      const [alertId] = vaults[0].config.alerts.map((a) => a.id);

      // any pass renames the old row first; a quote round does not judge the watchlist
      await runAlerts(vaults[0], load, "quotes", liveReader());
      expect(rules()).toEqual([alertId, "alert:gate"].sort());
      expect(readState("").get(stateId("alert:gate", BTC))).toMatchObject({ state: 0, firedAt: null });
      // it was false before the upgrade and holds now: a turn, not a first sighting
      await runAlerts(vaults[0], load);
      expect(rules()).toEqual([alertId, "alert:gate"].sort());
      expect(readState("").get(stateId("alert:gate", BTC))).toMatchObject({ state: 1, firedAt: expect.any(Number) });
      await runAlerts(vaults[0], load, "quotes", liveReader());
      expect(rules()).toEqual([alertId, "alert:gate"].sort());
    });

    it("a committed once alert only retries its yaml switch-off; unrelated writes and manual enabling do not re-arm it", async () => {
      const { forgetAlerts, runAlerts, setAlertsEnabled } = await import("@/lib/alerts");
      const { readConfig, updateConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      writeBars(BTC, closes(100, 101), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 50 }]);
      const alertId = vaults[0].config.alerts[0].id;
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw new Error("ENOSPC");
      });
      expect(await runAlerts(vaults[0], () => readConfig(root))).toHaveLength(1);
      rename.mockRestore();
      expect(readConfig(root).alerts[0].enabled).toBe(true);
      const firedAt = getDb().prepare("SELECT fired_at FROM alert_state WHERE rule = ?").get(alertId);
      updateConfig(root, (doc) => doc.set("updown", "red-up"));
      expect(await runAlerts(vaults[0], () => readConfig(root))).toEqual([]);
      expect(readConfig(root).alerts[0].enabled).toBe(false);
      expect(getDb().prepare("SELECT fired_at FROM alert_state WHERE rule = ?").get(alertId)).toEqual(firedAt);
      setAlertsEnabled(root, [alertId], true); // hand-written enabled: true retains the firing
      expect(await runAlerts(vaults[0], () => readConfig(root))).toEqual([]);
      expect(readConfig(root).alerts[0].enabled).toBe(false);
      setAlertsEnabled(root, [alertId], true);
      forgetAlerts("", [alertId]); // the UI's restore starts over
      expect(await runAlerts(vaults[0], () => readConfig(root))).toHaveLength(1);
      logs.mockRestore();
    });

    it("judges each vault on the live bar; once switches itself off in the yaml, comments kept", async () => {
      const { quoteRound } = await import("@/lib/quotes");
      const { readConfig } = await import("@/lib/vault");
      const { readDaily, writeBars } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      const { runAlerts } = await import("@/lib/alerts");
      writeBars(BTC, closes(100, 101), "replace");
      // root: a state alert that holds now; bob: an event that needs a cross
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 104 }], [{ key: "BTC", cond: "crossing_up", value: 110, trigger: "bar" }]);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const now = Date.now();

      await quoteRound(now, vaults);
      const rootYaml = fs.readFileSync(path.join(root, "hebi8.yaml"), "utf8");
      expect(rootYaml).toContain("enabled: false");
      expect(rootYaml).toContain("# 保留这条注释");
      expect(rootYaml).toContain("# 比特币");
      expect(readConfig(root).alerts[0].enabled).toBe(false);
      expect(readConfig(bob).alerts[0].enabled).toBe(true);
      expect(logs.mock.calls.flat().join("\n")).toMatch(/1 new alert\(s\): binance:BTCUSDT/);
      expect(getDb().prepare("SELECT vault, rule FROM alert_state ORDER BY vault, rule").all()).toEqual([
        { vault: "", rule: vaults[0].config.alerts[0].id },
        { vault: "bob", rule: vaults[1].config.alerts[0].id },
      ]);

      // bob's cross: below 110 at the first check, above it now
      prices.BTCUSDT = 111;
      const bobOnly = [{ ...vaults[0], config: readConfig(root) }, vaults[1]];
      const events = await Promise.all([runAlerts(bobOnly[1], () => bobOnly[1].config, "quotes", (await import("@/lib/quotes")).liveReader())]);
      expect(events[0]).toEqual([]); // the stored quote is still 105
      await quoteRound(now + 5 * 60_000, bobOnly);
      expect(logs.mock.calls.flat().join("\n")).toMatch(/1 new alert\(s\) \(bob\): binance:BTCUSDT/);
      expect(readConfig(bob).alerts[0].enabled).toBe(true); // bar: stays on
      expect(readDaily(BTC)).toHaveLength(2);
      logs.mockRestore();
    });

    /** The root vault with BTC on its list and these alerts, written the way a person would. */
    const watching = async (alerts: string[]) => {
      const { readConfig } = await import("@/lib/vault");
      fs.writeFileSync(path.join(root, "hebi8.yaml"), `aliases:\n  BTC: ${BTC}\ngroups:\n  - { name: 加密, symbols: [BTC] }\nalerts:\n${alerts.map((a) => `  - ${a}\n`).join("")}`);
      return { id: "", dir: root, config: readConfig(root) };
    };

    it("check decides when an alert is judged: price ones after every quote round, close ones only after a sync", async () => {
      const { quoteKeys, quoteRound } = await import("@/lib/quotes");
      const { runAlerts, readState, stateId } = await import("@/lib/alerts");
      const { readConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      writeBars(BTC, closes(100, 101), "replace");
      const vault = await watching([
        "{ id: key-price, key: BTC, cond: greater, value: 104, trigger: bar }",
        "{ id: key-close, key: BTC, cond: greater, value: 103, trigger: bar, check: close }",
        '{ id: all-close, when: "close > 102" }',
        '{ id: all-price, when: "close > 101.5", check: price }',
        '{ id: all-ref, when: "close > close(\\"yahoo:QQQ\\")", check: price }',
        `{ id: far-close, key: ${SPY}, cond: greater, value: 1, check: close }`,
      ]);
      // what a price alert reads is polled, the whole watchlist's formula references too; a close alert's symbol is not
      expect(quoteKeys([vault.config]).sort()).toEqual([BTC, "yahoo:QQQ"].sort());
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const row = (id: string) => readState("").get(stateId(`alert:${id}`, BTC));

      // a quote round at 105: only the price alerts are judged, on today's live bar
      await quoteRound(Date.now(), [vault]);
      expect(row("key-price")).toMatchObject({ state: 1, firedAt: expect.any(Number) });
      // a formula's first sighting only records
      expect(row("all-price")).toMatchObject({ state: 1, firedAt: null });
      expect(row("key-close")).toBeUndefined();
      expect(row("all-close")).toBeUndefined();

      // the daily sync ends: the close alerts are judged on the last daily close, 101, not on the quote
      await runAlerts(vault, () => readConfig(root));
      expect(row("key-close")).toMatchObject({ state: 0, firedAt: null });
      expect(row("all-close")).toMatchObject({ state: 0, firedAt: null });
      // and the next quote round leaves them alone
      prices.BTCUSDT = 110;
      await quoteRound(Date.now() + 5 * 60_000, [vault]);
      expect(row("key-close")).toMatchObject({ state: 0, firedAt: null });
      expect(row("all-close")).toMatchObject({ state: 0, firedAt: null });
      logs.mockRestore();
    });

    it("a close alert does not look at a daily bar whose day is still going; a price alert does", async () => {
      const { runAlerts, readState, stateId } = await import("@/lib/alerts");
      const { readConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
      // the sync brought today's bar of the UTC day so far: 200, after yesterday's 101
      writeBars(BTC, [{ ...bar(101), t: today - DAY }, { ...bar(200), t: today }], "replace");
      const vault = await watching([
        "{ id: key-price, key: BTC, cond: greater, value: 150, trigger: bar }",
        "{ id: key-close, key: BTC, cond: greater, value: 150, trigger: bar, check: close }",
        '{ id: all-close, when: "close > 150" }',
        '{ id: all-price, when: "close > 150", check: price }',
      ]);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const row = (id: string) => readState("").get(stateId(`alert:${id}`, BTC));
      const load = () => readConfig(root);

      await runAlerts(vault, load);
      expect(row("key-price")).toMatchObject({ state: 1, firedBar: today, firedAt: expect.any(Number) });
      expect(row("all-price")).toMatchObject({ state: 1 });
      // yesterday's close is the last one that counts
      expect(row("key-close")).toMatchObject({ state: 0, firedAt: null });
      expect(row("all-close")).toMatchObject({ state: 0, firedAt: null });

      // the UTC day is over: the same bar is a close now
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime((today + DAY) * 1000 + 60_000);
      await runAlerts(vault, load);
      vi.useRealTimers();
      expect(row("key-close")).toMatchObject({ state: 1, firedBar: today, firedAt: expect.any(Number) });
      expect(row("all-close")).toMatchObject({ state: 1, firedBar: today, firedAt: expect.any(Number) });
      logs.mockRestore();
    });

    it("a price alert on the whole watchlist is judged every round and still fires once per bar, in its own vault only", async () => {
      const { quoteRound } = await import("@/lib/quotes");
      const { readState, stateId } = await import("@/lib/alerts");
      const { writeBars } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      writeBars(BTC, closes(100, 101), "replace");
      const mine = await watching(['{ id: hot, when: "close > 104", check: price }']);
      // bob watches BTC too, with the same alert left at its default: judged after a sync only
      fs.writeFileSync(path.join(bob, "hebi8.yaml"), `groups:\n  - { name: 加密, symbols: ["${BTC}"] }\nalerts:\n  - { id: hot, when: "close > 104" }\n`);
      const { readConfig } = await import("@/lib/vault");
      const vaults = [mine, { id: "bob", dir: bob, config: readConfig(bob) }];
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const now = Date.now();
      // below, above (turns true: fires), below, above again within the same daily bar
      for (const [i, price] of [100, 105, 99, 106].entries()) {
        prices.BTCUSDT = price;
        await quoteRound(now + i * 5 * 60_000, vaults);
      }
      expect(logs.mock.calls.flat().filter((m) => /new alert\(s\)/.test(String(m)))).toHaveLength(1);
      expect(readState("").get(stateId("alert:hot", BTC))).toMatchObject({ state: 1, firedAt: expect.any(Number) });
      expect(getDb().prepare("SELECT count(*) AS n FROM alert_state WHERE vault = 'bob'").get()).toEqual({ n: 0 });
      logs.mockRestore();
    });

    it("a sync that does not bring today's bar, between two quote rounds, does not let today's bar fire twice", async () => {
      const { quoteRound } = await import("@/lib/quotes");
      const { runAlerts, readState, stateId } = await import("@/lib/alerts");
      const { readConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      // the last daily bar, an old one, closed at 105: above 100 like today's price will be
      writeBars(BTC, closes(100, 105), "replace");
      const vault = await watching(['{ id: formula, key: BTC, when: "close > 100", trigger: bar }', "{ id: level, key: BTC, cond: greater, value: 100, trigger: bar }"]);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const fired = () => logs.mock.calls.flat().filter((m) => /new alert\(s\)/.test(String(m)));
      const now = Date.now();
      let round = 0;
      const quote = async (price: number) => {
        prices.BTCUSDT = price;
        await quoteRound(now + round++ * 5 * 60_000, [vault]);
      };
      await quote(99);
      await quote(101);
      expect(fired()).toEqual([expect.stringContaining("2 new alert(s)")]);
      const today = readState("").get(stateId("alert:formula", BTC))!.firedBar;
      await quote(99);
      // the daily sync fails: its pass sees the old bar, where both hold again
      await runAlerts(vault, () => readConfig(root));
      expect(readState("").get(stateId("alert:formula", BTC))).toMatchObject({ state: 1, firedBar: today });
      expect(readState("").get(stateId("alert:level", BTC))).toMatchObject({ state: 1, firedBar: today });
      await quote(99);
      await quote(101);
      expect(fired()).toHaveLength(1);
      logs.mockRestore();
    });

    it("a close alert reads the other symbols of its formula up to their own last close", async () => {
      const { runAlerts, readState, stateId } = await import("@/lib/alerts");
      const { readConfig } = await import("@/lib/vault");
      const { writeBars } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      const GOLD = "tv:TVC:GOLD";
      const oct7 = Date.UTC(2026, 9, 7) / 1000;
      // noon UTC on Oct 7: Tokyo closed at 15:00 (06:00 UTC), the UTC day of the other symbol is still going
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(oct7 * 1000 + 12 * 3600_000);
      const meta = getDb().prepare("UPDATE symbols SET timezone = ?, hours = ? WHERE key = ?");
      meta.run("Asia/Tokyo", "0900-1500", SPY);
      writeBars(SPY, [{ ...bar(100), t: oct7 - DAY }, { ...bar(101), t: oct7 }], "replace");
      writeBars(GOLD, [{ ...bar(50), t: oct7 - DAY }, { ...bar(999), t: oct7 }], "replace");
      const vault = await watching([`{ id: ref, key: ${SPY}, when: 'close > close("${GOLD}")', check: close, trigger: bar }`]);
      await runAlerts(vault, () => readConfig(root));
      vi.useRealTimers();
      meta.run("America/New_York", null, SPY);
      // 101 against yesterday's 50, not against the 999 of a day that is not over
      expect(readState("").get(stateId("alert:ref", SPY))).toMatchObject({ state: 1 });
    });

    it("the chart's last bar is today's live one, with the bench aligned to it", async () => {
      const { quoteRound } = await import("@/lib/quotes");
      const { writeBars } = await import("@/lib/store");
      const { NextRequest } = await import("next/server");
      const { GET } = await import("@/app/api/bars/route");
      writeBars(BTC, closes(100, 101), "replace");
      writeBars(SPY, closes(400, 410), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 1000 }]);
      fs.appendFileSync(path.join(root, "hebi8.yaml"), `groups:\n  - symbols:\n      - key: BTC\n        bench: ${SPY}\n`);
      await quoteRound(Date.now(), vaults);
      const res = await GET(new NextRequest(`http://h/api/bars?key=${encodeURIComponent(BTC)}&tf=D`));
      const body = await res.json();
      expect(body.bars).toHaveLength(3);
      expect(body.bars.at(-1)).toMatchObject({ open: 105, close: 105, bench: 410 });
      expect(body.symbol).toMatchObject({ session: "always", lastDay: body.bars.at(-1).timestamp });
    });

    it("/api/status gives an open chart its last bar on any timeframe, with the bench at it", async () => {
      const { writeBars, writeQuotes } = await import("@/lib/store");
      const { NextRequest } = await import("next/server");
      const { GET } = await import("@/app/api/status/route");
      // Monday Jan 5 and Tuesday Jan 6, then a quote on Wednesday with the source's open and volume
      writeBars(BTC, [{ ...bar(100, 0), h: 103, l: 99 }, bar(101, 1)], "replace");
      writeBars(SPY, closes(400, 410), "replace");
      const quote = { key: BTC, price: 150, time: T0 + 2 * DAY + 3600, session: "always" as const, fetchedAt: Date.now(), dayOpen: 102, dayHigh: 151, dayLow: 98, dayVolume: 7 };
      writeQuotes([quote]);
      vaultsWith([]);
      fs.appendFileSync(path.join(root, "hebi8.yaml"), `groups:\n  - symbols:\n      - key: BTC\n        bench: ${SPY}\n`);
      const status = async (tf: string, extra = "") => (await GET(new NextRequest(`http://h/api/status?key=${encodeURIComponent(BTC)}&tf=${tf}${extra}`))).json();
      const wednesday = (T0 + 2 * DAY) * 1000;
      const day = await status("D", `&with=${encodeURIComponent(SPY)}`);
      expect(day).toMatchObject({ session: "always", quotedAt: quote.fetchedAt });
      // `prev` lets a chart that stopped before Tuesday see that it missed a bar
      expect(day.tail).toEqual({ bar: { timestamp: wednesday, open: 102, high: 151, low: 98, close: 150, volume: 7, bench: 410 }, prev: wednesday - DAY * 1000, refs: { [SPY]: { o: 410, h: 410, l: 410, c: 410, v: 1 } }, lastDay: wednesday, weekends: false });
      // the week and the month so far: Monday's open, the range of all three days, the quote's close
      const week = { open: 100, high: 151, low: 98, close: 150, volume: 9, bench: 410 };
      expect((await status("W")).tail).toMatchObject({ bar: { timestamp: T0 * 1000, ...week }, prev: null, lastDay: wednesday });
      expect((await status("M")).tail).toMatchObject({ bar: { timestamp: Date.UTC(2026, 0, 1), ...week }, lastDay: wednesday });
      expect((await status("Q")).tail).toMatchObject({ bar: { timestamp: Date.UTC(2026, 0, 1), ...week }, lastDay: wednesday });
      expect((await GET(new NextRequest("http://h/api/status?key=nope"))).status).toBe(400);
    });

    it("the overview takes the price from any quote newer than the sync, the session only while it is current", async () => {
      const { quoteRound, liveStats } = await import("@/lib/quotes");
      const { getSymbol, readAllStats, writeBars, writeQuotes } = await import("@/lib/store");
      const GOLD = "tv:TVC:GOLD";
      writeBars(BTC, closes(100, 101), "replace");
      writeBars(SPY, closes(400, 410), "replace");
      writeBars(GOLD, closes(4000, 4100), "replace");
      const vaults = vaultsWith([{ key: "BTC", cond: "greater", value: 1000 }]);
      await quoteRound(Date.now(), vaults);
      const { getDb } = await import("@/lib/db");
      getDb().prepare("UPDATE symbols SET synced_at = ? WHERE key = ?").run(Date.now() - 3 * 3600_000, SPY);
      const day = Math.floor(Date.now() / 1000);
      const twoHoursAgo = Date.now() - 2 * 3600_000;
      // SPY's quote is two hours old: still the price (as on the chart and in alerts), but no session
      writeQuotes([
        { key: SPY, price: 500, time: day - 7200, session: "post", fetchedAt: twoHoursAgo },
        // older than GOLD's daily sync: the synced bar wins
        { key: GOLD, price: 5000, time: day, session: "closed", fetchedAt: getSymbol(GOLD)!.syncedAt! - 1000 },
      ]);
      const cfg = normalizeConfig({ aliases: { BTC, GOLD }, groups: [{ name: "all", symbols: ["BTC", SPY, GOLD, "yahoo:QQQ", "=BTC/GOLD"] }] });
      const live = liveStats("", cfg);
      expect(Object.keys(live).sort()).toEqual([BTC, SPY, "=BTC/GOLD"].sort());
      expect(live[BTC].status.session).toBe("always");
      expect(live[BTC].stats.last).toBe(105);
      expect(live[BTC].stats.changes["1W"]).toBeCloseTo(105 / 101 - 1);
      expect(live[SPY].status).toMatchObject({ session: null, quotedAt: twoHoursAgo });
      expect(live[SPY].stats.last).toBe(500);
      // a synthetic row moves with its operands' quotes, as on its chart: as old as the oldest one taken, no session
      expect(live["=BTC/GOLD"].stats.last).toBeCloseTo(105 / 4100);
      expect(live["=BTC/GOLD"].status).toEqual({ syncedAt: null, syncError: null, session: null, quotedAt: live[BTC].status.quotedAt });
      expect(readAllStats("")[BTC]?.last).not.toBe(105);
    });

    it("the overview's live stats are computed once per quote round or sync and vault, not per page view", async () => {
      const { liveStats } = await import("@/lib/quotes");
      const store = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      store.writeBars(BTC, closes(100, 101), "replace");
      const quote = { key: BTC, price: 105, time: Math.floor(Date.now() / 1000), session: "always" as const, fetchedAt: Date.now() };
      store.writeQuotes([quote]);
      const cfg = normalizeConfig({ groups: [{ name: "all", symbols: [BTC] }] });
      const reads = vi.spyOn(getDb(), "prepare");
      const barReads = () => reads.mock.calls.filter(([sql]) => sql.includes("FROM bars")).length;
      const first = liveStats("", cfg);
      expect(barReads()).toBe(1);
      // the same view again, and another person's page with the same list: no bars read for the first, once for the other
      expect(liveStats("", cfg)[BTC].stats).toBe(first[BTC].stats);
      expect(barReads()).toBe(1);
      expect(liveStats("bob", cfg)[BTC].stats).toEqual(first[BTC].stats);
      expect(barReads()).toBe(2);
      // a new quote, another prices mode, another list: computed again
      store.writeQuotes([{ ...quote, price: 110, fetchedAt: quote.fetchedAt + 1 }]);
      expect(liveStats("", cfg)[BTC].stats.last).toBe(110);
      expect(liveStats("", { ...cfg, prices: "total" })[BTC].stats).not.toBe(liveStats("", cfg)[BTC].stats);
      // a daily sync after the quote: the synced bar is the price again
      const before = barReads();
      store.markSynced(BTC, {});
      expect(liveStats("", cfg)).toEqual({});
      expect(barReads()).toBe(before);
      reads.mockRestore();
    });

    it("the overview leaves a quote for a day before the last bar alone: no tag, the daily close", async () => {
      const { liveReader, liveStats } = await import("@/lib/quotes");
      const { writeBars, writeQuotes } = await import("@/lib/store");
      const { getDb } = await import("@/lib/db");
      // the last bar is Tuesday Jan 6; after the sync a fresh quote for Monday comes in
      writeBars(SPY, closes(110, 120), "replace");
      getDb().prepare("UPDATE symbols SET synced_at = ? WHERE key = ?").run(Date.now() - 60_000, SPY);
      writeQuotes([{ key: SPY, price: 115, time: T0 + 15 * 3600, session: "open", fetchedAt: Date.now() }]);
      expect(liveStats("", normalizeConfig({ groups: [{ name: "all", symbols: [SPY] }] }))).toEqual({});
      expect(liveReader()(SPY).at(-1)?.c).toBe(120);
    });

    it("an unfinished weekly bar closes at each symbol's own latest price; a daily one aligns to the main symbol's days", async () => {
      const { writeBars, writeQuotes } = await import("@/lib/store");
      const { NextRequest } = await import("next/server");
      const { GET } = await import("@/app/api/bars/route");
      // SPY stops on Tuesday Jan 6; BTC has Monday, Tuesday and a quote on Wednesday
      writeBars(SPY, closes(400, 410), "replace");
      writeBars(BTC, closes(100, 101), "replace");
      writeQuotes([{ key: BTC, price: 150, time: T0 + 2 * DAY + 3600, session: "always", fetchedAt: Date.now() }]);
      vaultsWith([]);
      fs.appendFileSync(path.join(root, "hebi8.yaml"), `groups:\n  - symbols:\n      - key: ${SPY}\n        bench: BTC\n`);
      const last = async (tf: string) => (await (await GET(new NextRequest(`http://h/api/bars?key=${encodeURIComponent(SPY)}&tf=${tf}`))).json()).bars.at(-1);
      expect(await last("D")).toMatchObject({ close: 410, bench: 101 });
      expect(await last("W")).toMatchObject({ close: 410, bench: 150 });
      expect(await last("M")).toMatchObject({ close: 410, bench: 150 });
    });
  });
});
