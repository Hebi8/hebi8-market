import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "@/lib/config";
import type { Bar } from "@/lib/series";

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
const utc = (iso: string) => Date.parse(`${iso}Z`);
const bar = (iso: string, c: number, extra: Partial<Bar> = {}): Bar => ({
  t: day(iso),
  o: c,
  h: c,
  l: c,
  c,
  v: 10,
  adj: 1,
  ...extra,
});

const SPY = "yahoo:SPY";
const BTC = "binance:BTCUSDT";
const DATA = "data:macro/cpi";
const US_CAL = {
  exchange: "NYSE",
  timezone: "America/New_York",
  hours: "0930-1600",
  holidays: "20260101,20260403,20261225",
  corrections: "0930-1300:20261224",
};

describe("period close (check: close across D / 3D / W / M / Q / Y)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-period-close-"));
  const root = path.join(dir, "vault");

  beforeAll(() => {
    fs.mkdirSync(root, { recursive: true });
    process.env.HEBI8_DB = path.join(dir, "hebi8.db");
    process.env.HEBI8_VAULT = root;
    process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  });

  beforeEach(async () => {
    vi.useRealTimers();
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.exec("DELETE FROM alert_state; DELETE FROM quotes; DELETE FROM bars; DELETE FROM symbols;");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    delete process.env.HEBI8_DB;
    delete process.env.HEBI8_VAULT;
    delete process.env.HEBI8_SECRETS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeYaml(alerts: unknown[], extra = "") {
    const yaml = [
      `aliases: { SPY: "${SPY}", BTC: "${BTC}", CPI: "${DATA}" }`,
      `groups:`,
      `  - name: all`,
      `    symbols: [SPY, BTC]`,
      extra,
      `alerts:`,
      ...alerts.map((a) => `  - ${JSON.stringify(a)}`),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(root, "hebi8.yaml"), yaml);
  }

  async function seedSymbol(key: string, bars: Bar[], meta: Record<string, unknown> = {}, syncedAt?: number, syncError: string | null = null) {
    const { ensureSymbol, markSynced, writeBars } = await import("@/lib/store");
    ensureSymbol(key);
    writeBars(key, bars, "replace");
    markSynced(key, meta);
    const { getDb } = await import("@/lib/db");
    if (syncedAt !== undefined || syncError !== null) {
      getDb().prepare("UPDATE symbols SET synced_at = coalesce(?, synced_at), sync_error = ? WHERE key = ?").run(syncedAt ?? null, syncError, key);
    }
  }

  it("US stock weekly check: close ignores Tuesday spike and fires on Saturday 07:30 JST after Friday close", async () => {
    const { runAlerts, readState, stateId } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([{ id: "wk", key: "SPY", when: "close > 105", tf: "W", trigger: "bar", check: "close" }]);
    const vault = { id: "", dir: root };

    // Week 1 (2026-01-05..09) closed at 100 (false): baseline recorded on Monday 2026-01-12
    const week1 = [bar("2026-01-05", 100), bar("2026-01-09", 100)];
    await seedSymbol(SPY, week1, US_CAL, utc("2026-01-10T00:00:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-12T00:00:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);
    const initRow = readState("").get(stateId("alert:wk", SPY));
    expect(initRow).toMatchObject({ state: 0, firedBar: null, seen: { [SPY]: day("2026-01-09") } });

    // Week 2 Tuesday (2026-01-13) spikes to 120 after Tuesday close -> week is NOT closed, must NOT fire!
    await seedSymbol(SPY, [...week1, bar("2026-01-12", 102), bar("2026-01-13", 120)], US_CAL, utc("2026-01-13T22:30:00"));
    vi.setSystemTime(utc("2026-01-13T22:30:00")); // Wed 07:30 JST
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);
    // `seen` stays on Week 1's last trading day (2026-01-09) and `firedBar` is untouched
    expect(readState("").get(stateId("alert:wk", SPY))).toMatchObject({ state: 0, firedBar: null, seen: { [SPY]: day("2026-01-09") } });

    // Week 2 Friday (2026-01-16) closes at 110; sync runs Sat 07:30 JST (Fri 22:30 UTC, after 21:00 UTC close)
    await seedSymbol(
      SPY,
      [...week1, bar("2026-01-12", 102), bar("2026-01-13", 120), bar("2026-01-16", 110)],
      US_CAL,
      utc("2026-01-16T22:30:00"),
    );
    vi.setSystemTime(utc("2026-01-16T22:30:00"));
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: SPY, tf: "W", close: 110 });
    expect(readState("").get(stateId("alert:wk", SPY))).toMatchObject({
      state: 1,
      firedBar: day("2026-01-12"),
      seen: { [SPY]: day("2026-01-16") },
    });
  });

  it("does not false-fire on lagging or failed Friday sync and preserves seen monotonicity", async () => {
    const { runAlerts, readState, stateId } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([{ id: "lag", key: "SPY", when: "close > 105", tf: "W", trigger: "bar", check: "close" }]);
    const vault = { id: "", dir: root };

    const week1 = [bar("2026-01-05", 100), bar("2026-01-09", 100)];
    await seedSymbol(SPY, week1, US_CAL, utc("2026-01-10T00:00:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-12T00:00:00"));
    await runAlerts(vault, () => readConfig(root), "sync");

    // Saturday 07:30 JST (Fri 22:30 UTC), but Friday's bar is missing (only Thursday 120 synced)
    const thuOnly = [...week1, bar("2026-01-12", 102), bar("2026-01-15", 120)];
    await seedSymbol(SPY, thuOnly, US_CAL, utc("2026-01-16T22:30:00"));
    vi.setSystemTime(utc("2026-01-16T22:30:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);
    expect(readState("").get(stateId("alert:lag", SPY))).toMatchObject({ state: 0, firedBar: null, seen: { [SPY]: day("2026-01-09") } });

    // Even on Monday morning, if syncError is present, still do not close Week 2 on Thursday's bar
    await seedSymbol(SPY, thuOnly, US_CAL, utc("2026-01-19T00:00:00"), "upstream 503");
    vi.setSystemTime(utc("2026-01-19T00:00:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Friday's bar finally arrives (at 108) with clean sync -> closes Week 2 and fires with Friday's close
    await seedSymbol(SPY, [...thuOnly, bar("2026-01-16", 108)], US_CAL, utc("2026-01-19T01:00:00"), null);
    vi.setSystemTime(utc("2026-01-19T01:00:00"));
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events).toHaveLength(1);
    expect(events[0].close).toBe(108);
    expect(readState("").get(stateId("alert:lag", SPY))?.seen).toEqual({ [SPY]: day("2026-01-16") });
  });

  it("closes a Good Friday holiday week early after Thursday's close", async () => {
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([{ id: "hol", key: "SPY", when: "close > 105", tf: "W", trigger: "bar", check: "close" }]);
    const vault = { id: "", dir: root };

    // Previous week closed false
    const prev = [bar("2026-03-23", 100), bar("2026-03-27", 100)];
    await seedSymbol(SPY, prev, US_CAL, utc("2026-03-28T00:00:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-03-30T00:00:00"));
    await runAlerts(vault, () => readConfig(root), "sync");

    // Week of 2026-03-30: Friday 2026-04-03 is Good Friday (holiday), so Thu 2026-04-02 20:00 UTC closes the week
    const goodFriWeek = [...prev, bar("2026-03-30", 102), bar("2026-04-02", 112)];
    await seedSymbol(SPY, goodFriWeek, US_CAL, utc("2026-04-02T19:30:00"));
    vi.setSystemTime(utc("2026-04-02T19:30:00")); // 30 min before Thursday close
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    await seedSymbol(SPY, goodFriWeek, US_CAL, utc("2026-04-02T20:30:00"));
    vi.setSystemTime(utc("2026-04-02T20:30:00")); // 30 min after Thursday close
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events).toHaveLength(1);
    expect(events[0].close).toBe(112);
  });

  it("crypto 24x7 weekly check: close waits until Sunday 24:00 UTC (Saturday does not fire)", async () => {
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([{ id: "btc", key: "BTC", when: "close > 105", tf: "W", trigger: "bar", check: "close" }]);
    const vault = { id: "", dir: root };
    const cryptoMeta = { exchange: "Binance", kind: "crypto", timezone: "UTC", hours: "24x7" };

    const w1 = [bar("2026-01-05", 100), bar("2026-01-11", 100)];
    await seedSymbol(BTC, w1, cryptoMeta, utc("2026-01-12T00:05:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-12T00:05:00"));
    await runAlerts(vault, () => readConfig(root), "sync");

    // Saturday 2026-01-17 12:00 UTC with high close -> Sunday has not closed yet
    const sat = [...w1, bar("2026-01-12", 104), bar("2026-01-16", 120)];
    await seedSymbol(BTC, sat, cryptoMeta, utc("2026-01-17T12:00:00"));
    vi.setSystemTime(utc("2026-01-17T12:00:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Monday 2026-01-19 00:05 UTC with Sunday's bar synced -> fires!
    await seedSymbol(BTC, [...sat, bar("2026-01-18", 115)], cryptoMeta, utc("2026-01-19T00:05:00"));
    vi.setSystemTime(utc("2026-01-19T00:05:00"));
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events).toHaveLength(1);
    expect(events[0].close).toBe(115);
  });

  it("reports the closed period's close price (not a newer unfinished period's daily close) and works for Y and synthetic =BTC/SPY", async () => {
    const { runAlerts, readState, stateId } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([
      { id: "yr", key: "SPY", when: "close > 150", tf: "Y", trigger: "bar", check: "close" },
      { id: "syn", key: "=BTC/SPY", when: "close > 0.25", tf: "W", trigger: "bar", check: "close" },
    ]);
    const vault = { id: "", dir: root };
    const cryptoMeta = { exchange: "Binance", kind: "crypto", timezone: "UTC", hours: "24x7" };

    // Baseline: 2024 closed (SPY 120), 2025 closed (SPY 140), week 2026-01-05 closed (BTC 100 / SPY 500 = 0.20)
    const spyBase = [bar("2024-12-31", 120), bar("2025-12-31", 140), bar("2026-01-05", 500), bar("2026-01-09", 500)];
    const btcBase = [bar("2026-01-05", 100), bar("2026-01-11", 100)];
    await seedSymbol(SPY, spyBase, US_CAL, utc("2026-01-12T00:05:00"));
    await seedSymbol(BTC, btcBase, cryptoMeta, utc("2026-01-12T00:05:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-12T00:05:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Now on Tuesday 2026-01-20 after US close:
    // - Week 2026-01-12 closed with BTC Sun = 150, SPY Fri = 500 (ratio 0.30 > 0.25)
    // - Tuesday 2026-01-20 has BTC = 50, SPY = 500 (unfinished week 2026-01-19 ratio 0.10!)
    // - Year 2026 is still unfinished (SPY 500 > 150 must NOT fire yearly alert!)
    await seedSymbol(
      SPY,
      [...spyBase, bar("2026-01-12", 500), bar("2026-01-16", 500), bar("2026-01-20", 500)],
      US_CAL,
      utc("2026-01-20T22:00:00"),
    );
    await seedSymbol(
      BTC,
      [...btcBase, bar("2026-01-12", 140), bar("2026-01-18", 150), bar("2026-01-19", 50)],
      cryptoMeta,
      utc("2026-01-20T22:00:00"),
    );
    vi.setSystemTime(utc("2026-01-20T22:00:00"));

    const events = await runAlerts(vault, () => readConfig(root), "sync");
    // Only synthetic weekly alert fires (with week 2026-01-12's close 0.3, NOT 0.1); yearly 2026 stays quiet
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rule: "alert:syn", key: "=BTC/SPY", tf: "W", close: 0.3 });
    expect(readState("").get(stateId("alert:syn", "=BTC/SPY"))?.seen).toEqual({
      [BTC]: day("2026-01-18"),
      [SPY]: day("2026-01-16"),
    });
    expect(readState("").get(stateId("alert:yr", SPY))).toMatchObject({ state: 0, firedBar: null, seen: { [SPY]: day("2025-12-31") } });
  });

  it("handles 3D, M, Q and Y period close boundaries", async () => {
    const { closedSeries, periodClosed } = await import("@/lib/bars");
    const cfg = normalizeConfig({ aliases: { SPY } });
    // Build bars spanning 2025..2026
    const daily = [
      bar("2025-01-02", 100),
      bar("2025-12-31", 120),
      bar("2026-01-02", 122),
      bar("2026-01-30", 130),
      bar("2026-03-31", 140),
      bar("2026-10-08", 150),
      bar("2026-10-09", 155),
      bar("2026-10-12", 160),
    ];
    await seedSymbol(SPY, daily, US_CAL, utc("2026-10-12T22:00:00"));

    // Mid-3D (Fri 2026-10-09 after close; 3D bucket 2026-10-08 covers Thu/Fri/Mon -> closes Mon 2026-10-12 20:00 UTC)
    expect(periodClosed(SPY, day("2026-10-08"), "3D", cfg, undefined, false, utc("2026-10-09T21:00:00"))).toBe(false);
    expect(periodClosed(SPY, day("2026-10-08"), "3D", cfg, undefined, false, utc("2026-10-12T20:01:00"))).toBe(true);

    // Month 2026-01 (last trading day Fri Jan 30 21:00 UTC)
    expect(periodClosed(SPY, day("2026-01-01"), "M", cfg, undefined, false, utc("2026-01-30T20:00:00"))).toBe(false);
    expect(periodClosed(SPY, day("2026-01-01"), "M", cfg, undefined, false, utc("2026-01-30T21:00:00"))).toBe(true);

    // Quarter 2026-Q1 (last trading day Tue Mar 31 20:00 UTC EDT)
    expect(periodClosed(SPY, day("2026-01-01"), "Q", cfg, undefined, false, utc("2026-03-31T19:59:00"))).toBe(false);
    expect(periodClosed(SPY, day("2026-01-01"), "Q", cfg, undefined, false, utc("2026-03-31T20:00:00"))).toBe(true);

    // Year: 2025 is closed in Oct 2026, 2026 is NOT closed until 2026-12-31 21:00 UTC
    const closedYears = closedSeries(SPY, "Y", "split", cfg, undefined, false, utc("2026-10-12T22:00:00"));
    expect(closedYears.map((b) => b.t)).toEqual([day("2025-01-01")]);
    expect(periodClosed(SPY, day("2026-01-01"), "Y", cfg, undefined, false, utc("2026-12-31T20:59:00"))).toBe(false);
    await seedSymbol(SPY, [...daily, bar("2026-12-31", 170)], US_CAL, utc("2026-12-31T21:05:00"));
    expect(periodClosed(SPY, day("2026-01-01"), "Y", cfg, undefined, false, utc("2026-12-31T21:05:00"))).toBe(true);
  });

  it("handles data: datasets (D always closed; higher timeframes close at nextStartDay UTC)", async () => {
    const { periodClosed } = await import("@/lib/bars");
    const cfg = normalizeConfig({ aliases: { CPI: DATA } });
    await seedSymbol(DATA, [bar("2026-01-15", 3.1)]);

    expect(periodClosed(DATA, day("2026-01-15"), "D", cfg, undefined, false, utc("2026-01-15T01:00:00"))).toBe(true);
    expect(periodClosed(DATA, day("2026-01-01"), "M", cfg, undefined, false, utc("2026-01-31T23:59:00"))).toBe(false);
    expect(periodClosed(DATA, day("2026-01-01"), "M", cfg, undefined, false, utc("2026-02-01T00:00:00"))).toBe(true);
    expect(periodClosed(DATA, day("2026-01-01"), "Y", cfg, undefined, false, utc("2026-12-31T23:59:00"))).toBe(false);
    expect(periodClosed(DATA, day("2026-01-01"), "Y", cfg, undefined, false, utc("2027-01-01T00:00:00"))).toBe(true);
  });

  it("synthetic =BTC/SPY waits until both operands close, and tolerates a holiday-only operand week", async () => {
    const { periodClosed } = await import("@/lib/bars");
    const cfg = normalizeConfig({ aliases: { BTC, SPY } });
    const cryptoMeta = { exchange: "Binance", kind: "crypto", timezone: "UTC", hours: "24x7" };

    await seedSymbol(BTC, [bar("2026-01-05", 100), bar("2026-01-11", 110)], cryptoMeta, utc("2026-01-12T00:05:00"));
    await seedSymbol(SPY, [bar("2026-01-05", 500), bar("2026-01-09", 505)], US_CAL, utc("2026-01-10T00:05:00"));

    // Saturday 2026-01-10 12:00 UTC: SPY closed Friday, but BTC has not closed Sunday -> false
    expect(periodClosed("=BTC/SPY", day("2026-01-05"), "W", cfg, undefined, true, utc("2026-01-10T12:00:00"))).toBe(false);
    // Monday 2026-01-12 00:05 UTC: both BTC (Sun) and SPY (Fri) closed -> true
    expect(periodClosed("=BTC/SPY", day("2026-01-05"), "W", cfg, undefined, true, utc("2026-01-12T00:05:00"))).toBe(true);

    // Holiday-only week for SPY (all 5 weekdays closed), while BTC trades: closes once BTC closes
    const spyAllHoliday = { ...US_CAL, holidays: "20260112,20260113,20260114,20260115,20260116" };
    await seedSymbol(SPY, [bar("2026-01-05", 500), bar("2026-01-09", 505)], spyAllHoliday, utc("2026-01-19T00:05:00"));
    await seedSymbol(BTC, [bar("2026-01-05", 100), bar("2026-01-18", 120)], cryptoMeta, utc("2026-01-19T00:05:00"));
    expect(periodClosed("=BTC/SPY", day("2026-01-12"), "W", cfg, undefined, true, utc("2026-01-19T00:05:00"))).toBe(true);
  });

  it("cross-market formula ref (SPY weekly referencing close(BTC)) waits for ref period close and records ref in seen", async () => {
    const { runAlerts, readState, stateId } = await import("@/lib/alerts");
    const { runFormula } = await import("@/lib/conditions");
    const { readConfig } = await import("@/lib/vault");
    const QQQ = "yahoo:QQQ";
    const cryptoMeta = { exchange: "Binance", kind: "crypto", timezone: "UTC", hours: "24x7" };

    writeYaml([
      { id: "cross", key: "SPY", when: "close(BTC) > 250", tf: "W", trigger: "once", check: "close" },
      { id: "same-cal", key: "SPY", when: `close("${QQQ}") > 400`, tf: "W", trigger: "bar", check: "close" },
    ]);
    const vault = { id: "", dir: root };

    // Baseline week 2025-12-29 closed false for both alerts
    const spyW0 = [bar("2025-12-29", 100), bar("2026-01-02", 100)];
    const qqqW0 = [bar("2025-12-29", 350), bar("2026-01-02", 350)];
    const btcW0 = [bar("2025-12-29", 200), bar("2026-01-04", 200)];
    await seedSymbol(SPY, spyW0, US_CAL, utc("2026-01-05T00:05:00"));
    await seedSymbol(QQQ, qqqW0, US_CAL, utc("2026-01-05T00:05:00"));
    await seedSymbol(BTC, btcW0, cryptoMeta, utc("2026-01-05T00:05:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-05T00:05:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Friday 2026-01-09 22:30 UTC: SPY & QQQ week closed & synced, BTC spiked to 300 on Thu/Fri but BTC week is NOT closed!
    const spyW1 = [...spyW0, bar("2026-01-05", 102), bar("2026-01-09", 105)];
    const qqqW1 = [...qqqW0, bar("2026-01-05", 410), bar("2026-01-09", 420)];
    const btcMid = [...btcW0, bar("2026-01-05", 210), bar("2026-01-08", 300), bar("2026-01-09", 310)];
    await seedSymbol(SPY, spyW1, US_CAL, utc("2026-01-09T22:30:00"));
    await seedSymbol(QQQ, qqqW1, US_CAL, utc("2026-01-09T22:30:00"));
    await seedSymbol(BTC, btcMid, cryptoMeta, utc("2026-01-09T22:30:00"));
    vi.setSystemTime(utc("2026-01-09T22:30:00"));

    // Direct runFormula check: SPY + close(BTC) trims unfinished 2026-01-05 week, leaving only 2025-12-29
    const cfg = readConfig(root);
    const midFormula = runFormula(SPY, "close(BTC)", "W", cfg, undefined, new Map(), { closed: true, now: utc("2026-01-09T22:30:00") });
    expect(midFormula.bars.map((b) => b.t)).toEqual([day("2025-12-29")]);
    expect(midFormula.line).toEqual([200]);

    // Same-calendar ref (QQQ) fires immediately on Friday close; cross-market ref (BTC) waits for Sunday!
    const friEvents = await runAlerts(vault, () => readConfig(root), "sync");
    expect(friEvents.map((e) => e.rule)).toEqual(["alert:same-cal"]);
    expect(readState("").get(stateId("alert:cross", SPY))).toMatchObject({
      state: 0,
      firedBar: null,
      seen: { [SPY]: day("2026-01-02"), [BTC]: day("2026-01-04") },
    });

    // Monday 2026-01-12 00:05 UTC: BTC finished Sunday at 280 -> now cross-market alert fires once with immutable value!
    await seedSymbol(BTC, [...btcMid, bar("2026-01-11", 280)], cryptoMeta, utc("2026-01-12T00:05:00"));
    vi.setSystemTime(utc("2026-01-12T00:05:00"));
    const monEvents = await runAlerts(vault, () => readConfig(root), "sync");
    expect(monEvents.map((e) => e.rule)).toEqual(["alert:cross"]);
    expect(readState("").get(stateId("alert:cross", SPY))).toMatchObject({
      state: 1,
      firedBar: day("2026-01-05"),
      seen: { [SPY]: day("2026-01-09"), [BTC]: day("2026-01-11") },
    });
  });

  it("refuses stale pre-close intraday syncs when post-close sync fails (both D and W)", async () => {
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");
    const cryptoMeta = { exchange: "Binance", kind: "crypto", timezone: "UTC", hours: "24x7" };

    writeYaml([
      { id: "spy-d", key: "SPY", when: "close > 150", tf: "D", trigger: "bar", check: "close" },
      { id: "spy-w", key: "SPY", when: "close > 150", tf: "W", trigger: "bar", check: "close" },
      { id: "btc-d", key: "BTC", when: "close > 150", tf: "D", trigger: "bar", check: "close" },
      { id: "btc-w", key: "BTC", when: "close > 150", tf: "W", trigger: "bar", check: "close" },
    ]);
    const vault = { id: "", dir: root };

    // Baseline week 1 closed below 150
    const spyBase = [bar("2026-01-05", 100), bar("2026-01-09", 100)];
    const btcBase = [bar("2026-01-05", 100), bar("2026-01-11", 100)];
    await seedSymbol(SPY, spyBase, US_CAL, utc("2026-01-12T00:05:00"));
    await seedSymbol(BTC, btcBase, cryptoMeta, utc("2026-01-12T00:05:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-12T00:05:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Intraday partial bars written BEFORE close (SPY Fri 19:30 UTC, BTC Sun 22:30 UTC), then post-close sync FAILS!
    await seedSymbol(SPY, [...spyBase, bar("2026-01-16", 200)], US_CAL, utc("2026-01-16T19:30:00"), "upstream 503");
    await seedSymbol(BTC, [...btcBase, bar("2026-01-18", 200)], cryptoMeta, utc("2026-01-18T22:30:00"), "upstream 503");
    vi.setSystemTime(utc("2026-01-19T00:30:00"));
    // Even though clock is past close AND `bars` already contains Fri/Sun, syncedAt < closeAt prevents false firing!
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Post-close sync succeeds with refreshed final closes -> all 4 fire cleanly
    await seedSymbol(SPY, [...spyBase, bar("2026-01-16", 180)], US_CAL, utc("2026-01-19T01:00:00"), null);
    await seedSymbol(BTC, [...btcBase, bar("2026-01-18", 180)], cryptoMeta, utc("2026-01-19T01:00:00"), null);
    vi.setSystemTime(utc("2026-01-19T01:00:00"));
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events.map((e) => e.rule).sort()).toEqual(["alert:btc-d", "alert:btc-w", "alert:spy-d", "alert:spy-w"]);
  });

  it("treats Yahoo cryptocurrency (0000-0000) as 24x7 and separates primary vs secondary calendars in synthetics (=SPY/BTC vs =BTC/SPY)", async () => {
    const { periodClosed } = await import("@/lib/bars");
    const YBTC = "yahoo:BTC-USD";
    const cfg = normalizeConfig({ aliases: { YBTC, BTC, SPY } });

    // Path 1: Yahoo crypto has kind="cryptocurrency" and hours="0000-0000" -> must NOT close on Friday!
    await seedSymbol(
      YBTC,
      [bar("2026-01-05", 100), bar("2026-01-09", 105), bar("2026-01-10", 108)],
      { kind: "cryptocurrency", hours: "0000-0000", timezone: "UTC" },
      utc("2026-01-10T12:00:00"),
    );
    expect(periodClosed(YBTC, day("2026-01-05"), "W", cfg, undefined, true, utc("2026-01-09T22:30:00"))).toBe(false);
    expect(periodClosed(YBTC, day("2026-01-05"), "W", cfg, undefined, true, utc("2026-01-10T12:00:00"))).toBe(false);
    await seedSymbol(
      YBTC,
      [bar("2026-01-05", 100), bar("2026-01-11", 112)],
      { kind: "cryptocurrency", hours: "0000-0000", timezone: "UTC" },
      utc("2026-01-12T00:05:00"),
    );
    expect(periodClosed(YBTC, day("2026-01-05"), "W", cfg, undefined, true, utc("2026-01-12T00:05:00"))).toBe(true);

    // Path 2: =SPY/BTC on W has trading days from SPY (Mon..Fri), so it closes once BOTH SPY and BTC finish Friday
    // (does NOT wait for Sunday, and does NOT misapply SPY's weekends=false to BTC when BTC has hours=null!).
    await seedSymbol(SPY, [bar("2026-01-05", 500), bar("2026-01-09", 505)], US_CAL, utc("2026-01-10T00:05:00"));
    await seedSymbol(
      BTC,
      [bar("2026-01-05", 100), bar("2026-01-09", 105), bar("2026-01-10", 106)], // weekend bar -> tradesWeekends(BTC) = true even with hours: null
      { timezone: "UTC" },
      utc("2026-01-10T00:05:00"),
    );
    // Friday 22:30 UTC: SPY closed Fri 21:00 UTC, but BTC Friday hasn't closed until Sat 00:00 UTC -> false
    expect(periodClosed("=SPY/BTC", day("2026-01-05"), "W", cfg, undefined, false, utc("2026-01-09T22:30:00"))).toBe(false);
    // Saturday 00:05 UTC: SPY Fri closed & synced AND BTC Fri closed & synced -> =SPY/BTC W is immutable & closed!
    expect(periodClosed("=SPY/BTC", day("2026-01-05"), "W", cfg, undefined, false, utc("2026-01-10T00:05:00"))).toBe(true);
    // Meanwhile =BTC/SPY on W STILL waits for BTC's Sunday!
    expect(periodClosed("=BTC/SPY", day("2026-01-05"), "W", cfg, undefined, true, utc("2026-01-10T00:05:00"))).toBe(false);
  });

  it("blocks weekend forward-fill on =BTC/SPY and close / close(SPY) when Friday SPY sync failed", async () => {
    const { periodClosed, refPeriodClosed } = await import("@/lib/bars");
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([
      { id: "btc-spy-synth", key: "=BTC/SPY", when: "close > 1.05", tf: "D", trigger: "bar", check: "close" },
      { id: "btc-spy-ref", key: "BTC", when: "close / close(SPY) > 1.05", tf: "D", trigger: "bar", check: "close" },
    ]);
    const vault = { id: "", dir: root };
    const cryptoCal = { kind: "crypto", timezone: "UTC", hours: "24x7" };

    // Thursday 2026-01-08 baseline (both 100 -> ratio 1.0, false)
    await seedSymbol(SPY, [bar("2026-01-08", 100)], US_CAL, utc("2026-01-09T00:05:00"));
    await seedSymbol(BTC, [bar("2026-01-08", 100)], cryptoCal, utc("2026-01-09T00:05:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-09T00:05:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Saturday 2026-01-10 BTC daily bar closes at 110 (synced Sun 00:05 UTC), while SPY's Friday 2026-01-09 sync failed
    // (cache stops at Thursday 100; ratio against stale Thursday SPY would be 1.10 > 1.05).
    await seedSymbol(BTC, [bar("2026-01-08", 100), bar("2026-01-09", 100), bar("2026-01-10", 110)], cryptoCal, utc("2026-01-11T00:05:00"));
    await seedSymbol(SPY, [bar("2026-01-08", 100)], US_CAL, utc("2026-01-09T18:00:00"), "timeout");
    vi.setSystemTime(utc("2026-01-11T00:05:00"));
    const cfg = readConfig(root);
    expect(periodClosed("=BTC/SPY", day("2026-01-10"), "D", cfg, undefined, true, utc("2026-01-11T00:05:00"))).toBe(false);
    expect(refPeriodClosed(SPY, day("2026-01-10"), "D", cfg, undefined, true, utc("2026-01-11T00:05:00"))).toBe(false);
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Once SPY Friday sync succeeds at 102 (real Saturday ratio 110 / 102 = 1.078 > 1.05), both close and fire with Friday's price
    await seedSymbol(SPY, [bar("2026-01-08", 100), bar("2026-01-09", 102)], US_CAL, utc("2026-01-11T00:10:00"), null);
    vi.setSystemTime(utc("2026-01-11T00:10:00"));
    expect(periodClosed("=BTC/SPY", day("2026-01-10"), "D", cfg, undefined, true, utc("2026-01-11T00:10:00"))).toBe(true);
    expect(refPeriodClosed(SPY, day("2026-01-10"), "D", cfg, undefined, true, utc("2026-01-11T00:10:00"))).toBe(true);
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events.map((e) => e.rule).sort()).toEqual(["alert:btc-spy-ref", "alert:btc-spy-synth"]);
    expect(events.find((e) => e.rule === "alert:btc-spy-synth")!.close).toBeCloseTo(110 / 102, 6);
  });

  it("handles ES Thanksgiving holiday-merged daily close and prevents cross-market synthetic =JP/SPY forward-fill while SPY is open", async () => {
    const { closedSeries, periodClosed } = await import("@/lib/bars");
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    // 1. ES Thanksgiving daily bar (Thu 2026-11-26) closes Fri 2026-11-27 12:15 Chicago (18:15 UTC), not Thu 22:00 UTC
    const ES_KEY = "tv:CME_MINI:ES1!";
    const ES_CAL = {
      timezone: "America/Chicago",
      hours: "1700-1600",
      holidays: "20261126",
      corrections: "1700F2-1200F1,1700-1215:20261127",
    };
    const esCfg = normalizeConfig({ aliases: { ES: ES_KEY } });
    await seedSymbol(ES_KEY, [bar("2026-11-25", 5000), bar("2026-11-26", 5050)], ES_CAL, utc("2026-11-26T23:00:00"));
    expect(periodClosed(ES_KEY, day("2026-11-26"), "D", esCfg, undefined, false, utc("2026-11-26T23:00:00"))).toBe(false);
    await seedSymbol(ES_KEY, [bar("2026-11-25", 5000), bar("2026-11-26", 5060)], ES_CAL, utc("2026-11-27T18:30:00"));
    expect(periodClosed(ES_KEY, day("2026-11-26"), "D", esCfg, undefined, false, utc("2026-11-27T18:30:00"))).toBe(true);

    // 2. Synthetic =JP/SPY on D: Tokyo closes Wed 06:00 UTC while US SPY is still open until Wed 21:00 UTC
    const JP = "yahoo:7203.T";
    const JP_CAL = { exchange: "TSE", timezone: "Asia/Tokyo", hours: "0900-1500" };
    writeYaml(
      [{ id: "jpspy", key: "=JP/SPY", when: "close > 1.1", tf: "D", trigger: "bar", check: "close" }],
      `  - name: jp\n    symbols: ["${JP}"]\n`,
    );
    // Add JP alias
    const yml = fs.readFileSync(path.join(root, "hebi8.yaml"), "utf8").replace('CPI: "', `JP: "${JP}", CPI: "`);
    fs.writeFileSync(path.join(root, "hebi8.yaml"), yml);
    const vault = { id: "", dir: root };

    // Tuesday closed: JP=100, SPY=100 -> ratio 1.0 (baseline false)
    await seedSymbol(JP, [bar("2026-01-06", 100)], JP_CAL, utc("2026-01-07T00:05:00"));
    await seedSymbol(SPY, [bar("2026-01-06", 100)], US_CAL, utc("2026-01-07T00:05:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-07T00:05:00"));
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Wednesday 15:00 UTC: JP closed at 120 (ratio against yesterday's SPY=100 would be 1.2 > 1.1!),
    // while SPY intraday is 120 (true ratio 1.0) and US session is still open until 21:00 UTC!
    await seedSymbol(JP, [bar("2026-01-06", 100), bar("2026-01-07", 120)], JP_CAL, utc("2026-01-07T15:00:00"));
    await seedSymbol(SPY, [bar("2026-01-06", 100), bar("2026-01-07", 120)], US_CAL, utc("2026-01-07T15:00:00"));
    vi.setSystemTime(utc("2026-01-07T15:00:00"));
    expect(closedSeries("=JP/SPY", "D", "split", readConfig(root), undefined, false, utc("2026-01-07T15:00:00")).map((b) => b.t)).toEqual([
      day("2026-01-06"),
    ]);
    // Must NOT forward-fill yesterday's SPY (100) onto today's JP (120) and falsely fire!
    expect(await runAlerts(vault, () => readConfig(root), "sync")).toEqual([]);

    // Wednesday 21:05 UTC: SPY closes & syncs at 105 (final ratio 120 / 105 = 1.1429 > 1.1) -> fires cleanly!
    await seedSymbol(SPY, [bar("2026-01-06", 100), bar("2026-01-07", 105)], US_CAL, utc("2026-01-07T21:05:00"));
    vi.setSystemTime(utc("2026-01-07T21:05:00"));
    const events = await runAlerts(vault, () => readConfig(root), "sync");
    expect(events).toHaveLength(1);
    expect(events[0].close).toBeCloseTo(120 / 105, 6);

    // US holiday (Fri 2026-04-03 Good Friday) where JP trades and SPY is closed: =JP/SPY closes at JP's close
    await seedSymbol(JP, [bar("2026-04-02", 100), bar("2026-04-03", 120)], JP_CAL, utc("2026-04-03T07:00:00"));
    await seedSymbol(SPY, [bar("2026-04-02", 100)], US_CAL, utc("2026-04-03T00:00:00"));
    expect(periodClosed("=JP/SPY", day("2026-04-03"), "D", readConfig(root), undefined, false, utc("2026-04-03T07:00:00"))).toBe(true);
  });

  it("keeps check: price behavior unchanged (fires mid-week on live quote)", async () => {
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");

    writeYaml([{ id: "live-wk", key: "SPY", when: "close > 105", tf: "W", trigger: "bar", check: "price" }]);
    const vault = { id: "", dir: root };

    const week1 = [bar("2026-01-05", 100), bar("2026-01-09", 100)];
    await seedSymbol(SPY, week1, US_CAL, utc("2026-01-10T00:00:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-12T00:00:00"));
    await runAlerts(vault, () => readConfig(root), "sync");

    // Tuesday intraday quote spikes to 112 -> check: price fires immediately mid-week
    vi.setSystemTime(utc("2026-01-13T16:00:00"));
    const liveRead = (k: string) => (k === SPY ? [...week1, bar("2026-01-13", 112)] : []);
    const events = await runAlerts(vault, () => readConfig(root), "quotes", liveRead);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: SPY, tf: "W", close: 112 });
  });

  it("MCP tools support tf: Y, new formula primitives, and period-close check: close", async () => {
    const { callTool } = await import("@/lib/mcp/tools");

    writeYaml([]);
    const daily = [
      bar("2025-01-02", 100, { o: 95 }),
      bar("2025-12-31", 120),
      bar("2026-01-05", 130, { o: 125 }),
      bar("2026-01-06", 140),
    ];
    await seedSymbol(SPY, daily, US_CAL, utc("2026-01-06T22:00:00"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc("2026-01-06T22:00:00")); // Tuesday of week 2026-01-05, year 2026 unfinished

    const viewer = { vault: "", dir: root, login: null, avatarUrl: null, canWrite: false, isOwner: false, shared: false, owner: null };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await callTool(viewer, name, args);
      return r.isError ? { error: r.content[0].text } : { data: JSON.parse(r.content[0].text) };
    };

    // formula_reference lists year, month, yearopen, macd family, and Y
    const refText = (await callTool(viewer, "formula_reference", {})).content[0].text;
    for (const token of ["`year`", "`month`", "`yearopen`", "`macd(", "`macdsignal(", "`macdhist(", "Y (年线)"]) {
      expect(refText).toContain(token);
    }

    // get_bars with tf: "Y"
    const yearly = (await call("get_bars", { key: "SPY", tf: "Y" })).data;
    expect(yearly.tf).toBe("Y");
    expect(yearly.bars).toEqual([
      ["2025-01-01", 95, 120, 100, 120, 20],
      ["2026-01-01", 125, 140, 130, 140, 20],
    ]);

    // scan with check: "close" on tf: "Y" drops unfinished 2026 and evaluates 2025
    const scanClosed = (await call("scan", { formula: "year == 2025 and yearopen == 95", tf: "Y", keys: ["SPY"], check: "close" })).data;
    expect(scanClosed.rows[0]).toMatchObject({ key: SPY, holds: true, date: "2025-01-01" });

    // scan with check: "price" on tf: "Y" sees unfinished 2026
    const scanPrice = (await call("scan", { formula: "year == 2026 and yearopen == 125", tf: "Y", keys: ["SPY"], check: "price" })).data;
    expect(scanPrice.rows[0]).toMatchObject({ key: SPY, holds: true, date: "2026-01-01" });

    // test_formula with check: "close" when only an unfinished week exists reports clear message
    await seedSymbol(BTC, [bar("2026-01-05", 100), bar("2026-01-06", 110)], { kind: "crypto", timezone: "UTC", hours: "24x7" }, utc("2026-01-06T22:00:00"));
    const onlyOpen = await call("test_formula", { key: "BTC", formula: "close > 0", tf: "W", check: "close" });
    expect(onlyOpen.error).toBe("还没有已收盘的周线");
  });
});
