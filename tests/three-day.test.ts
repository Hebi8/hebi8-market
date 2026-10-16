import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chartTail, loadChart } from "@/lib/bars";
import { evalRule } from "@/lib/conditions";
import { normalizeConfig } from "@/lib/config";
import type { Bar } from "@/lib/series";
import { ensureSymbol, markSynced } from "@/lib/store";

// symbols' calendars come from the cache; a scratch one, never data/hebi8.db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-3d-"));
process.env.HEBI8_DB = path.join(dir, "hebi8.db");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Daily bars from `from` to `to` whose close is the day of the month; weekends only for `weekends`. */
function series(from: string, to: string, weekends: boolean): Bar[] {
  const out: Bar[] = [];
  for (let t = day(from); t <= day(to); t += 86400) {
    const dow = new Date(t * 1000).getUTCDay();
    if (!weekends && (dow === 0 || dow === 6)) continue;
    const c = new Date(t * 1000).getUTCDate();
    out.push({ t, o: c, h: c, l: c, c, v: 1, adj: 1 });
  }
  return out;
}

const STOCK = "yahoo:SPY";
const COIN = "binance:BTCUSDT";

describe("3D charts", () => {
  const cfg = normalizeConfig({});
  const data: Record<string, Bar[]> = { [STOCK]: series("2026-10-05", "2026-10-16", false), [COIN]: series("2026-10-03", "2026-10-16", true) };
  const read = (key: string) => data[key] ?? [];

  it("compares another symbol on the chart's own buckets", () => {
    // a stock's chart: the coin's weekend goes with Friday, as the stock's Thursday-Friday-Monday bar does
    const stock = loadChart(STOCK, "3D", "split", [COIN], cfg, read);
    expect(stock.bars.map((b) => iso(b.timestamp))).toEqual(["2026-10-05", "2026-10-08", "2026-10-13", "2026-10-16"]);
    expect(stock.bars.map((b) => b.close)).toEqual([7, 12, 15, 16]);
    expect(stock.refs[COIN].c).toEqual([7, 12, 15, 16]);
    expect(stock.refs[COIN].o).toEqual([5, 8, 13, 16]);
    // a coin's chart counts calendar days, and so does the stock compared on it
    const coin = loadChart(COIN, "3D", "split", [STOCK], cfg, read);
    expect(coin.bars.map((b) => iso(b.timestamp))).toEqual(["2026-10-02", "2026-10-05", "2026-10-08", "2026-10-11", "2026-10-14"]);
    expect(coin.refs[STOCK].c).toEqual([null, 7, 9, 13, 16]);
  });

  it("counts the chart's days for what it compares, however few bars it has", () => {
    // ten days of a coin: two 3D bars, both starting on a weekday, still counted in calendar days
    const short = (key: string) => (key === COIN ? series("2026-10-05", "2026-10-10", true) : read(key));
    const coin = loadChart(COIN, "3D", "split", [STOCK], cfg, short);
    expect(coin.weekends).toBe(true);
    expect(coin.bars.map((b) => iso(b.timestamp))).toEqual(["2026-10-05", "2026-10-08"]);
    // Thursday 10-08 to Saturday 10-10: the stock closed on Friday the 9th
    expect(coin.refs[STOCK].c).toEqual([7, 9]);
    expect(evalRule(COIN, `close("${STOCK}") > 10`, "3D", cfg, new Map(), short).now).toBe(false);
    // a synthetic symbol counts the way its first operand does
    const synth = loadChart(`=${COIN}/${STOCK}`, "3D", "split", [], cfg, short);
    expect([synth.weekends, synth.bars.map((b) => iso(b.timestamp))]).toEqual([true, ["2026-10-05", "2026-10-08"]]);
  });

  it("counts by the symbol's trading hours, so a stray weekend bar does not regroup its history", () => {
    const key = "yahoo:QQQ";
    ensureSymbol(key);
    markSynced(key, { hours: "0930-1600", timezone: "America/New_York" });
    const weekdays = series("2026-09-28", "2026-10-09", false);
    const before = loadChart(key, "3D", "split", [], cfg, () => weekdays);
    const after = loadChart(key, "3D", "split", [], cfg, () => [...weekdays, { ...weekdays.at(-1)!, t: day("2026-10-10") }]);
    expect(after.weekends).toBe(false);
    expect(after.bars.map((b) => iso(b.timestamp))).toEqual(["2026-09-25", "2026-09-30", "2026-10-05", "2026-10-08"]);
    expect(after.bars.slice(0, -1)).toEqual(before.bars.slice(0, -1));
  });

  it("tells an open chart when a series without hours starts counting calendar days, so it loads again", () => {
    const key = "data:gpu/4090";
    const weekdays = series("2026-09-28", "2026-10-09", false);
    expect(chartTail(loadChart(key, "3D", "split", [], cfg, () => weekdays))!.weekends).toBe(false);
    const saturday = chartTail(loadChart(key, "3D", "split", [], cfg, () => [...weekdays, { ...weekdays.at(-1)!, t: day("2026-10-10") }]))!;
    expect(saturday.weekends).toBe(true);
  });

  it("puts today's unfinished day into the last bar, or starts a new one", () => {
    const withDay = (to: string) => (key: string) => (key === STOCK ? series("2026-10-05", to, false) : read(key));
    // Monday 10-19 still belongs to the bar that started on Friday 10-16: the chart replaces its last bar
    const monday = chartTail(loadChart(STOCK, "3D", "split", [], cfg, withDay("2026-10-19")))!;
    expect(iso(monday.bar.timestamp)).toBe("2026-10-16");
    expect([monday.bar.open, monday.bar.close]).toEqual([16, 19]);
    expect(iso(monday.prev!)).toBe("2026-10-13");
    expect(iso(monday.lastDay)).toBe("2026-10-19");
    // Wednesday 10-21 starts the next one: the chart appends it
    const wednesday = chartTail(loadChart(STOCK, "3D", "split", [], cfg, withDay("2026-10-21")))!;
    expect(iso(wednesday.bar.timestamp)).toBe("2026-10-21");
    expect(iso(wednesday.prev!)).toBe("2026-10-16");
  });

  it("is a timeframe the yaml can keep, with its own indicator params and alerts", () => {
    const parsed = normalizeConfig({
      aliases: { SPY: STOCK },
      chart: { tf: "3D", params: { "3D": { MA: [10, 30] } } },
      alerts: [{ key: "SPY", when: "close > 1", tf: "3D" }],
    });
    expect(parsed.chart.tf).toBe("3D");
    expect(parsed.chart.params).toEqual({ "3D": { MA: [10, 30] } });
    expect(parsed.alerts[0].tf).toBe("3D");
  });
});
