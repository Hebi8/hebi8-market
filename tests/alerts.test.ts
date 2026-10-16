import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide } from "@/lib/alerts";
import { ConfigError, isLive, normalizeConfig, syncKeys } from "@/lib/config";
import { formatDigest, parseNotifyConfig } from "@/lib/notify";

describe("decide", () => {
  it("records the first sighting without firing", () => {
    expect(decide(undefined, { now: true, t: 100 })).toEqual({ fire: false, next: { state: 1, firedBar: 100 } });
    expect(decide(undefined, { now: false, t: 100 })).toEqual({ fire: false, next: { state: 0, firedBar: null } });
  });

  it("fires when a rule turns true", () => {
    expect(decide({ state: 0, firedBar: null }, { now: true, t: 200 })).toEqual({ fire: true, next: { state: 1, firedBar: 200 } });
  });

  it("does not repeat while the rule stays true", () => {
    expect(decide({ state: 1, firedBar: 200 }, { now: true, t: 300 })).toEqual({ fire: false, next: { state: 1, firedBar: 200 } });
  });

  it("fires once per bar when the unfinished bar flickers", () => {
    const off = decide({ state: 1, firedBar: 200 }, { now: false, t: 200 });
    expect(off).toEqual({ fire: false, next: { state: 0, firedBar: 200 } });
    expect(decide(off.next!, { now: true, t: 200 }).fire).toBe(false);
    expect(decide(off.next!, { now: true, t: 207 }).fire).toBe(true);
  });

  it("leaves the state alone when the result is unknown", () => {
    // judged on an older bar than the one that fired (a sync without today's bar): no firing, and the fired bar stays
    expect(decide({ state: 0, firedBar: 207 }, { now: true, t: 200 })).toEqual({ fire: false, next: { state: 1, firedBar: 207 } });
    expect(decide({ state: 0, firedBar: null }, { now: null })).toEqual({ fire: false, next: null });
    expect(decide(undefined, { now: null })).toEqual({ fire: false, next: null });
  });
});

describe("alerts in hebi8.yaml", () => {
  const base = { aliases: { BTC: "binance:BTCUSDT", SPY: "yahoo:SPY" }, groups: [{ name: "加密", symbols: ["BTC"] }] };

  it("resolves keys, defaults the timeframe to D and hashes a stable id", () => {
    const cfg = normalizeConfig({ ...base, alerts: [{ key: "BTC", when: "close > 130000" }, { key: "SPY", id: "spy-200", label: "破 200 日", when: "close < sma(close, 200)", tf: "W" }] });
    expect(cfg.alerts[0]).toMatchObject({ key: "binance:BTCUSDT", label: "close > 130000", when: "close > 130000", tf: "D" });
    expect(cfg.alerts[0].id).toMatch(/^alert:[0-9a-f]{6}$/);
    expect(normalizeConfig({ ...base, alerts: [{ key: "BTC", when: "close > 130000" }] }).alerts[0].id).toBe(cfg.alerts[0].id);
    expect(cfg.alerts[1]).toEqual({
      id: "alert:spy-200",
      key: "yahoo:SPY",
      label: "破 200 日",
      text: "破 200 日",
      ownLabel: "破 200 日",
      condition: null,
      when: "close < sma(close, 200)",
      tf: "W",
      trigger: "once",
      check: "price",
      enabled: true,
      notify: true,
      draft: false,
      by: null,
    });
  });

  it("draft and by: a draft is not live, and only `by: agent` is a mark", () => {
    const cfg = normalizeConfig({ ...base, alerts: [{ when: "close > 1", by: "agent", draft: true }, { key: "BTC", when: "close > 2", by: "someone" }] });
    expect(cfg.alerts.map((a) => [a.draft, a.by, isLive(a)])).toEqual([[true, "agent", false], [false, null, true]]);
    // the id does not depend on either, so confirming a draft keeps it
    expect(normalizeConfig({ ...base, alerts: [{ when: "close > 1" }] }).alerts[0].id).toBe(cfg.alerts[0].id);
    expect(() => normalizeConfig({ ...base, alerts: [{ when: "close > 1", draft: "yes" }] })).toThrow("draft 应为 true 或 false");
  });

  it("check: an alert on a symbol follows the price, one on the whole watchlist waits for the close, unless written otherwise", () => {
    const cfg = normalizeConfig({
      ...base,
      alerts: [
        { key: "BTC", cond: "greater", value: 1 },
        { when: "close > 1" },
        { key: "BTC", cond: "less", value: 1, check: "close" },
        { when: "close > 2", check: "price" },
      ],
    });
    expect(cfg.alerts.map((a) => a.check)).toEqual(["price", "close", "close", "price"]);
    // switching it keeps the id, like the trigger
    expect(normalizeConfig({ ...base, alerts: [{ key: "BTC", cond: "less", value: 1 }] }).alerts[0].id).toBe(cfg.alerts[2].id);
    expect(() => normalizeConfig({ ...base, alerts: [{ key: "BTC", cond: "less", value: 1, check: "open" }] })).toThrow(/check 应为 price/);
  });

  it("syncs alert keys that are not watched, and their references", () => {
    const cfg = normalizeConfig({ ...base, alerts: [{ key: "SPY", when: 'close > close("yahoo:QQQ")' }] });
    expect(syncKeys(cfg)).toEqual(expect.arrayContaining(["binance:BTCUSDT", "yahoo:SPY", "yahoo:QQQ"]));
  });

  it("rejects incomplete and duplicate rules", () => {
    expect(() => normalizeConfig({ ...base, alerts: [{ key: "BTC" }] })).toThrow(ConfigError);
    expect(() => normalizeConfig({ ...base, alerts: [{ key: "BTC", when: "close > 1" }, { key: "binance:BTCUSDT", when: "close > 1" }] })).toThrow(/重复/);
  });

  it("reads an alert without a key as one on the whole watchlist: formulas and moves only, each bar at most once", () => {
    const cfg = normalizeConfig({
      ...base,
      alerts: [
        { label: "周线多头", when: "close > sma(close, 40)", tf: "W", notify: false, trigger: "once" },
        { cond: "moving_up_pct", value: { pct: 5, bars: 1 } },
      ],
    });
    expect(cfg.alerts[0]).toMatchObject({ key: null, label: "周线多头", tf: "W", trigger: "bar", notify: false, enabled: true });
    expect(cfg.alerts[1]).toMatchObject({ key: null, label: "1 根 K 线内上涨 5%", trigger: "bar", notify: true });
    expect(() => normalizeConfig({ ...base, alerts: [{ cond: "greater", value: 1 }] })).toThrow(/要写 key/);
    expect(() => normalizeConfig({ ...base, alerts: [{ key: "BTC", when: "close > 1", notify: "yes" }] })).toThrow(/notify/);
    // the same formula on a symbol and on the watchlist are two alerts
    expect(normalizeConfig({ ...base, alerts: [{ when: "close > 1" }, { key: "BTC", when: "close > 1" }] }).alerts).toHaveLength(2);
    expect(syncKeys(cfg)).toEqual(["binance:BTCUSDT"]);
  });

  it("reads the old conditions as alerts on the whole watchlist, weekly by default, pushed only with notify", () => {
    const cfg = normalizeConfig({ ...base, conditions: [{ id: "a", label: "甲", formula: "close > 1" }, { id: "b", formula: "close > 2", notify: true, tf: "D" }, { id: "趋势", formula: "close > 3" }] });
    expect(cfg.alerts.map(({ id, key, label, when, tf, notify }) => ({ id, key, label, when, tf, notify }))).toEqual([
      { id: "alert:a", key: null, label: "甲", when: "close > 1", tf: "W", notify: false },
      { id: "alert:b", key: null, label: "b", when: "close > 2", tf: "D", notify: true },
      // a free-text id cannot be an alert id; the label keeps it
      { id: expect.stringMatching(/^alert:[0-9a-f]{6}$/), key: null, label: "趋势", when: "close > 3", tf: "W", notify: false },
    ]);
  });
});

describe("notify.json", () => {
  it("fills defaults and accepts a bare webhook url", () => {
    expect(parseNotifyConfig({ telegram: { token: "1:a", chat: 42 }, webhook: "https://ntfy.sh/x/", link: "http://h:8808/" })).toEqual({
      telegram: { token: "1:a", chat: "42", apis: ["https://api.telegram.org"] },
      webhook: { url: "https://ntfy.sh/x", format: "text" },
      link: "http://h:8808",
    });
    expect(parseNotifyConfig({})).toEqual({});
    // a bot without a chat: on a shared instance people bind their chats on the page
    expect(parseNotifyConfig({ telegram: { token: "1:a" } })).toEqual({ telegram: { token: "1:a", apis: ["https://api.telegram.org"] } });
  });

  it("reports sections that are present but broken", () => {
    expect(() => parseNotifyConfig({ telegram: { chat: 42 } })).toThrow(/token/);
    expect(() => parseNotifyConfig({ webhook: { url: "ftp://x" } })).toThrow(/http/);
    expect(() => parseNotifyConfig({ webhook: { url: "https://x", format: "xml" } })).toThrow(/format/);
    expect(() => parseNotifyConfig([])).toThrow();
  });
});

describe("formatDigest", () => {
  const event = { rule: "cond:below_200w", key: "yahoo:NVDA", name: "英伟达", label: "破200周", tf: "W" as const, close: 182.345 };

  it("lists each event with its timeframe and close, and links when a base is set", () => {
    expect(formatDigest([event])).toEqual({ title: "hebi8/market · 1 条新提醒", text: "hebi8/market · 1 条新提醒\n\n• 英伟达：破200周（周线）  收 182.35" });
    expect(formatDigest([{ ...event, close: null }], "http://h:8808").text.split("\n").slice(2)).toEqual([
      "• 英伟达：破200周（周线）",
      "  http://h:8808/chart/yahoo%3ANVDA",
    ]);
  });

  it("stays under Telegram's message limit", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ ...event, key: `yahoo:N${i}`, name: `标的 ${i}` }));
    expect(formatDigest(many).text.length).toBeLessThanOrEqual(4000);
  });
});

describe("runAlerts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-alerts-"));
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let fail = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = fail ? 500 : 200;
      res.end("ok");
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    process.env.HEBI8_DB = path.join(dir, "hebi8.db");
    process.env.HEBI8_SECRETS = path.join(dir, "secrets");
    fs.mkdirSync(process.env.HEBI8_SECRETS);
    fs.writeFileSync(path.join(process.env.HEBI8_SECRETS, "notify.json"), JSON.stringify({ webhook: `http://127.0.0.1:${port}/topic` }));
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records silently, fires on the turn, does not repeat, retries after a failed delivery", async () => {
    const { readState, runAlerts, stateId } = await import("@/lib/alerts");
    const { ensureSymbol, writeBars } = await import("@/lib/store");
    const key = "binance:BTCUSDT";
    const DAY = 86400;
    const t0 = Date.UTC(2026, 0, 1) / 1000;
    ensureSymbol(key);
    const bars = (closes: number[]) => closes.map((c, i) => ({ t: t0 + i * DAY, o: c, h: c, l: c, c, v: 1, adj: 1 }));
    const cfg = normalizeConfig({
      aliases: { BTC: key },
      groups: [{ name: "加密", symbols: [{ key: "BTC", name: "比特币" }] }],
      conditions: [{ id: "up", label: "上涨", formula: "close > ref(close, 1)", tf: "D", notify: true }],
      alerts: [
        { key: "BTC", label: "站上 100", when: "close > 100", trigger: "bar" },
        { label: "站上 50", when: "close > 50", tf: "D", notify: false },
        { label: "回落", when: "close < ref(close, 1)", tf: "D", notify: false },
      ],
    });
    const run = () => runAlerts({ id: "", dir: dir }, () => cfg);
    const firedAt = (i: number) => readState("").get(stateId(cfg.alerts[i].id, key))?.firedAt ?? null;

    writeBars(key, bars([90, 95, 101]), "replace");
    expect(await run()).toEqual([]); // first sighting: both rules hold, nothing sent
    expect(received).toHaveLength(0);

    writeBars(key, bars([90, 95, 101, 99]), "replace");
    expect(await run()).toEqual([]); // both turn false; 回落 turns true, recorded but never pushed
    expect(firedAt(2)).not.toBeNull();
    writeBars(key, bars([90, 95, 101, 99, 102]), "replace");
    fail = true;
    expect((await run()).map((e) => e.rule).sort()).toEqual([cfg.alerts[0].id, "alert:up"].sort());
    expect(received).toHaveLength(1);
    expect(firedAt(0)).toBeNull(); // not delivered: tried again next time

    fail = false;
    const retried = await run(); // nothing got through last time, so the same events go again
    expect(retried).toHaveLength(2);
    expect(received).toHaveLength(2);
    expect(received[1].body).toContain("• 比特币：站上 100（日线）  收 102.00");
    expect(received[1].headers.title).toBe("hebi8/market");

    expect(await run()).toEqual([]); // delivered, still true: quiet
    expect(received).toHaveLength(2);
  });
});
