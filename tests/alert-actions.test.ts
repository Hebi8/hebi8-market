import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hebi8m_session" && request.session ? { name, value: request.session } : undefined) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const YAML = `# 我的警报
aliases:
  BTC: binance:BTCUSDT # 比特币
groups:
  - { name: 加密, symbols: [BTC] }
alerts: [] # 图表上建的写在这里
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-alert-actions-"));
const root = path.join(dir, "vault");
const yamlFile = path.join(root, "hebi8.yaml");
const read = () => fs.readFileSync(yamlFile, "utf8");

beforeAll(() => {
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  fs.mkdirSync(root);
});

afterAll(() => {
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(yamlFile, YAML);
  request.session = undefined;
});

describe("alert Server Actions", () => {
  it("create writes a block list entry with the alias, keeping comments", async () => {
    const { saveAlert } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    expect(await saveAlert({ key: "binance:BTCUSDT", cond: "crossing_up", value: 130000, trigger: "once" })).toEqual({ ok: true });
    expect(await saveAlert({ key: "binance:BTCUSDT", cond: "inside", value: [90000, 80000], trigger: "bar", label: "震荡区间" })).toEqual({ ok: true });
    const text = read();
    expect(text).toContain("# 比特币");
    expect(text).toContain("# 我的警报");
    expect(text).toContain("- { key: BTC, cond: crossing_up, value: 130000, trigger: once }");
    expect(text).toContain("- { key: BTC, cond: inside, value: [ 80000, 90000 ], trigger: bar, label: 震荡区间 }");
    expect(readConfig(root).alerts.map((a) => a.label)).toEqual(["BTC 上穿 130,000", "震荡区间"]);
  });

  it("writes `check` only when it is not what the alert does by default, and takes it out again", async () => {
    const { saveAlert } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    const { alertViews } = await import("@/lib/alert-view");
    // the defaults, given or not: nothing in the yaml
    expect(await saveAlert({ key: "binance:BTCUSDT", cond: "greater", value: 1, trigger: "once", check: "price" })).toEqual({ ok: true });
    expect(await saveAlert({ key: null, cond: "formula", when: "close > 1", trigger: "bar", check: "close" })).toEqual({ ok: true });
    expect(await saveAlert({ key: "binance:BTCUSDT", cond: "less", value: 1, trigger: "once", check: "close" })).toEqual({ ok: true });
    expect(await saveAlert({ key: null, cond: "formula", when: "close > 2", trigger: "bar", check: "price" })).toEqual({ ok: true });
    expect(read()).toContain(`- { key: BTC, cond: greater, value: 1, trigger: once }
  - { when: close > 1 }
  - { key: BTC, cond: less, value: 1, trigger: once, check: close }
  - { when: close > 2, check: price }`);
    const alerts = readConfig(root).alerts;
    expect(alerts.map((a) => a.check)).toEqual(["price", "close", "close", "price"]);
    // the list says so where it is not the default
    expect(alertViews("", readConfig(root), {}).map((a) => a.summary)).toEqual(["收盘价大于 1", "日线公式 close > 1", "收盘价小于 1 · 日线收盘", "日线公式 close > 2 · 盘中价格"]);
    // back to the default: the field goes, the id (and with it the state) stays
    expect(await saveAlert({ id: alerts[2].id, key: "binance:BTCUSDT", cond: "less", value: 1, trigger: "once", check: "price" })).toEqual({ ok: true });
    expect(read()).toContain("- { key: BTC, cond: less, value: 1, trigger: once }\n");
    expect(readConfig(root).alerts[2]).toMatchObject({ id: alerts[2].id, check: "price" });
  });

  it("edit replaces the entry in place and restarts it; pause, resume and delete find it by id", async () => {
    const { deleteAlert, saveAlert, setAlertEnabled } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    const { getDb } = await import("@/lib/db");
    await saveAlert({ key: "BTC", cond: "greater", value: 1, trigger: "once" });
    await saveAlert({ key: "BTC", cond: "less", value: 2, trigger: "once" });
    const [first, second] = readConfig(root).alerts;
    getDb().prepare("INSERT INTO alert_state (vault, rule, key, state, fired_at) VALUES ('', ?, ?, 1, 1)").run(first.id, first.key);

    expect(await saveAlert({ id: first.id, key: "BTC", cond: "greater", value: 5, trigger: "bar" })).toEqual({ ok: true });
    const edited = readConfig(root).alerts;
    expect(edited.map((a) => a.condition)).toEqual([{ cond: "greater", value: 5 }, { cond: "less", value: 2 }]);
    expect(getDb().prepare("SELECT count(*) AS n FROM alert_state WHERE rule = ?").get(first.id)).toEqual({ n: 0 });

    expect(await setAlertEnabled(second.id, false)).toEqual({ ok: true });
    expect(read()).toContain("cond: less, value: 2, trigger: once, enabled: false }");
    expect(await setAlertEnabled(second.id, true)).toEqual({ ok: true });
    expect(readConfig(root).alerts[1].enabled).toBe(true);
    expect(read()).not.toContain("enabled");

    expect(await deleteAlert(edited[0].id)).toEqual({ ok: true });
    expect(readConfig(root).alerts.map((a) => a.id)).toEqual([second.id]);
    expect(await saveAlert({ id: "alert:gone00", key: "BTC", cond: "less", value: 3, trigger: "once" })).toEqual({ ok: false, error: "这条警报已经不在 hebi8.yaml 里了" });
  });

  it("editing a hand-written alert changes only the fields the dialog has: tf, an explicit id and comments stay", async () => {
    const { saveAlert } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    fs.writeFileSync(
      yamlFile,
      YAML.replace(
        "alerts: [] # 图表上建的写在这里\n",
        `alerts:
  - key: yahoo:NVDA # 英伟达
    id: nvda-200
    tf: W # 周线
    when: "close < sma(close, 200)" # 200 周
    note: 自己记的
`,
      ),
    );
    const before = readConfig(root).alerts[0];
    expect(before).toMatchObject({ id: "alert:nvda-200", tf: "W", trigger: "once" });

    // only the name and the trigger change in the dialog
    expect(await saveAlert({ id: before.id, key: "yahoo:NVDA", cond: "formula", when: before.when!, tf: before.tf, trigger: "bar", label: "破 200 周" })).toEqual({ ok: true });
    let text = read();
    for (const kept of ["key: yahoo:NVDA # 英伟达", "id: nvda-200", "tf: W # 周线", 'when: "close < sma(close, 200)" # 200 周', "note: 自己记的", "trigger: bar", "label: 破 200 周"]) {
      expect(text).toContain(kept);
    }
    expect(readConfig(root).alerts[0]).toMatchObject({ id: "alert:nvda-200", tf: "W", trigger: "bar", label: "破 200 周" });

    // turned into a condition: the formula and its tf go, the id and the key's comment stay
    expect(await saveAlert({ id: before.id, key: "yahoo:NVDA", cond: "less", value: 100, trigger: "bar" })).toEqual({ ok: true });
    text = read();
    expect(text).toContain("key: yahoo:NVDA # 英伟达");
    expect(text).not.toContain("when:");
    expect(text).not.toContain("tf:");
    expect(text).not.toContain("label:");
    expect(readConfig(root).alerts[0]).toMatchObject({ id: "alert:nvda-200", condition: { cond: "less", value: 100 }, tf: "D" });
  });

  it("an edit during delivery waits for the old commit, then stays enabled with fresh state", async () => {
    const { saveAlert } = await import("@/app/actions");
    const { runAlerts } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");
    const { getDb } = await import("@/lib/db");
    await saveAlert({ key: "BTC", cond: "greater", value: 100, trigger: "once" });
    const alert = readConfig(root).alerts[0];
    const secrets = path.join(dir, "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, "notify.json"), JSON.stringify({ webhook: "http://fixture" }));
    let started!: () => void;
    const delivering = new Promise<void>((resolve) => { started = resolve; });
    let release!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
      release = resolve;
      started();
    }));
    const job = runAlerts({ id: "", dir: root }, () => readConfig(root), "quotes", () => [{ t: 1, o: 110, h: 110, l: 110, c: 110, v: 1, adj: 1 }]);
    await delivering;
    const edited = saveAlert({ id: alert.id, key: "BTC", cond: "greater", value: 100, trigger: "once", label: "Edited" });
    release(new Response("ok"));
    expect(await job).toHaveLength(1);
    expect(await edited).toEqual({ ok: true });
    expect(readConfig(root).alerts[0]).toMatchObject({ enabled: true, label: "Edited" });
    expect(getDb().prepare("SELECT count(*) AS n FROM alert_state WHERE vault = '' AND rule = ?").get(alert.id)).toEqual({ n: 0 });
    fetch.mockRestore();
    fs.rmSync(path.join(secrets, "notify.json"));
  });

  it("a new alert on the whole watchlist is judged at once; the old conditions moved into alerts at startup are alerts like any other", async () => {
    const { saveAlert, setAlertEnabled } = await import("@/app/actions");
    const { readConfig, readConfigSafe } = await import("@/lib/vault");
    const { migrateConditions, readState, stateId } = await import("@/lib/alerts");
    const { ensureSymbol, writeBars } = await import("@/lib/store");
    const t0 = Date.UTC(2026, 0, 5) / 1000;
    ensureSymbol("binance:BTCUSDT");
    writeBars("binance:BTCUSDT", [100, 110].map((c, i) => ({ t: t0 + i * 7 * 86400, o: c, h: c, l: c, c, v: 1, adj: 1 })), "replace");
    fs.writeFileSync(
      yamlFile,
      YAML.replace(
        "alerts: [] # 图表上建的写在这里\n",
        `conditions: # 旧的条件
  - { id: trend, label: 趋势, formula: "close > 1" }
  - { id: hot, label: 新高, formula: "close >= highest(close, 52)", notify: true, tf: D }
alerts: [] # 图表上建的写在这里
`,
      ),
    );
    // not read while the app runs; the next start moves them
    expect(readConfigSafe(root).error).toContain("conditions 是旧的写法");
    expect(migrateConditions({ id: "", dir: root })).toBe(true);
    expect(migrateConditions({ id: "", dir: root })).toBe(false);
    expect(readConfig(root).alerts.map((a) => [a.id, a.key, a.notify])).toEqual([
      ["alert:trend", null, false],
      ["alert:hot", null, true],
    ]);
    let text = read();
    expect(text).not.toContain("conditions:");
    expect(text).toContain("# 比特币");
    // the nodes themselves move: the formula is renamed, the old defaults are written out
    expect(text).toContain('- { id: trend, label: 趋势, when: "close > 1", tf: W, notify: false }');
    expect(text).toContain('- { id: hot, label: 新高, when: "close >= highest(close, 52)", notify: true, tf: D }');

    expect(await saveAlert({ key: null, cond: "formula", when: "close > ref(close, 1)", tf: "W", trigger: "once", label: "周涨", notify: false })).toEqual({ ok: true });
    text = read();
    expect(text).toContain('- { when: "close > ref(close, 1)", tf: W, label: 周涨, notify: false }');
    const added = readConfig(root).alerts[2];
    expect(added).toMatchObject({ key: null, trigger: "bar", tf: "W", notify: false });
    // judged right away on the daily bars: it holds for BTC, recorded without firing
    expect(readState("").get(stateId(added.id, "binance:BTCUSDT"))).toMatchObject({ state: 1, firedAt: null });

    expect(await setAlertEnabled("alert:trend", false)).toEqual({ ok: true });
    expect(readConfig(root).alerts[0]).toMatchObject({ id: "alert:trend", enabled: false });
    // a price needs a symbol
    expect(await saveAlert({ key: null, cond: "greater", value: 1, trigger: "once" })).toMatchObject({ ok: false, error: expect.stringContaining("要写 key") });
  });

  it("an old condition keeps comments and aliases when it moves, yields its id to an alert, and keeps its state", async () => {
    const { migrateConditions, readState, stateId } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");
    const { alertBadges } = await import("@/lib/alert-view");
    const { getDb } = await import("@/lib/db");
    const BTC = "binance:BTCUSDT";
    fs.writeFileSync(
      yamlFile,
      `# 我的警报
aliases:
  BTC: binance:BTCUSDT # 比特币
groups:
  - { name: 加密, symbols: [BTC] }
indicators:
  - { id: up, label: 上涨, pane: sub, formula: &up "close > ref(close, 1)" }
conditions: # 旧的条件
  # 周线趋势
  - id: trend # 趋势的 id
    formula: *up # 和指标同一个公式
  - { id: 趋势, formula: "close > 2" }
alerts:
  - { key: BTC, id: trend, cond: greater, value: 1 }
`,
    );
    const firedAt = Date.now();
    const db = getDb();
    db.prepare("DELETE FROM alert_state WHERE vault = ''").run();
    db.prepare("INSERT INTO alert_state (vault, rule, key, state, fired_bar, fired_at) VALUES ('', 'cond:trend', ?, 1, 7, ?)").run(BTC, firedAt);
    db.prepare("INSERT INTO alert_state (vault, rule, key, state) VALUES ('', 'alert:trend', ?, 0)").run(BTC);

    expect(migrateConditions({ id: "", dir: root })).toBe(true);
    const text = read();
    expect(text).not.toContain("conditions:");
    expect(text).not.toContain("formula: *up");
    for (const kept of ["# 周线趋势", "id: cond-trend # 趋势的 id", "when: *up # 和指标同一个公式", "label: trend", 'formula: &up "close > ref(close, 1)"']) expect(text).toContain(kept);
    // a free-text id cannot be an alert id: it goes, the label keeps it, and the alert is known by a hash
    expect(text).toContain('- { when: "close > 2", label: 趋势, tf: W, notify: false }');
    const after = readConfig(root);
    // the price alert keeps `trend`, the condition becomes cond-trend
    expect(after.alerts.map((a) => [a.id, a.key, a.when, a.tf, a.notify])).toEqual([
      ["alert:trend", BTC, null, "D", true],
      ["alert:cond-trend", null, "close > ref(close, 1)", "W", false],
      [expect.stringMatching(/^alert:[0-9a-f]{6}$/), null, "close > 2", "W", false],
    ]);

    // the condition's state went with it; the price alert's row is its own
    expect(readState("").get(stateId("alert:cond-trend", BTC))).toEqual({ state: 1, firedBar: 7, firedAt, seenT: null });
    expect(readState("").get(stateId("alert:trend", BTC))).toMatchObject({ state: 0 });
    expect(alertBadges("", after)[BTC].find((b) => b.id === "alert:cond-trend")).toMatchObject({ label: "trend", state: "fresh" });
  });

  it("an old condition written with yaml aliases moves as it reads", async () => {
    const { migrateConditions, readState, stateId } = await import("@/lib/alerts");
    const { readConfig } = await import("@/lib/vault");
    const { getDb } = await import("@/lib/db");
    const BTC = "binance:BTCUSDT";
    const shared = `defaults: { id: &id trend, tf: &tf D, notify: &on true }
groups:
  - { name: 加密, symbols: [${BTC}] }
`;
    const db = getDb();
    db.prepare("DELETE FROM alert_state WHERE vault = ''").run();
    db.prepare("INSERT INTO alert_state (vault, rule, key, state, fired_bar) VALUES ('', 'cond:trend', ?, 1, 7)").run(BTC);
    fs.writeFileSync(yamlFile, `${shared}conditions:\n  - { id: *id, formula: "close > 1", tf: *tf, notify: *on }\n`);
    expect(migrateConditions({ id: "", dir: root })).toBe(true);
    expect(readConfig(root).alerts.map((a) => [a.id, a.when, a.tf, a.notify])).toEqual([["alert:trend", "close > 1", "D", true]]);
    expect(readState("").get(stateId("alert:trend", BTC))).toMatchObject({ state: 1, firedBar: 7 });
    // the whole list as an alias: its entries move as copies, the list it points at stays
    fs.writeFileSync(yamlFile, `${shared}old: &old\n  - { id: up, formula: "close > 2" }\nconditions: *old\n`);
    expect(migrateConditions({ id: "", dir: root })).toBe(true);
    expect(readConfig(root).alerts.map((a) => [a.id, a.when, a.tf, a.notify])).toEqual([["alert:up", "close > 2", "W", false]]);
    expect(read()).toContain("old: &old");
  });

  it("moves every vault's old conditions when the app starts, the root's first", async () => {
    const { migrateAllConditions } = await import("@/lib/alerts");
    const { readConfig, userVaultDir } = await import("@/lib/vault");
    const old = `conditions:\n  - { id: trend, formula: "close > 1" }\n`;
    fs.writeFileSync(yamlFile, `owner: dreaife\n${old}`);
    const alice = userVaultDir("alice");
    fs.mkdirSync(alice, { recursive: true });
    fs.writeFileSync(path.join(alice, "hebi8.yaml"), old);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    migrateAllConditions();
    logs.mockRestore();
    expect(readConfig(root).alerts.map((a) => a.id)).toEqual(["alert:trend"]);
    expect(readConfig(alice).alerts.map((a) => a.id)).toEqual(["alert:trend"]);
  });

  it("checks the input and the formula", async () => {
    const { saveAlert } = await import("@/app/actions");
    expect(await saveAlert({ key: "BTC", cond: "greater", value: Number.NaN, trigger: "once" })).toEqual({ ok: false, error: "greater 的 value 应是一个价格" });
    expect((await saveAlert({ key: "BTC", cond: "formula", when: "close >", trigger: "once" })).ok).toBe(false);
    expect(await saveAlert({ key: "BTC", cond: "formula", when: "cross(close, sma(close, 20))", trigger: "bar" })).toEqual({ ok: true });
    expect(await saveAlert({ key: "BTC", cond: "greater", value: 1, trigger: "once" })).toEqual({ ok: true });
    expect((await saveAlert({ key: "BTC", cond: "greater", value: 1, trigger: "bar" })).ok).toBe(false); // same condition twice
    expect(read()).toContain('when: "cross(close, sma(close, 20))"');
  });

  it("refuses a visitor on a shared instance", async () => {
    const { saveAlert, deleteAlert, setAlertEnabled } = await import("@/app/actions");
    fs.writeFileSync(yamlFile, `owner: someone\n${YAML}`);
    for (const result of [await saveAlert({ key: "BTC", cond: "greater", value: 1, trigger: "once" }), await deleteAlert("alert:x"), await setAlertEnabled("alert:x", false)]) {
      expect(result).toEqual({ ok: false, error: "请先登录" });
    }
    expect(read()).toBe(`owner: someone\n${YAML}`);
  });
});

describe("the alert list", () => {
  it("badges: fired this week, fired or holding, not fired, stopped; the watchlist ones only where they hold", async () => {
    const { alertBadges } = await import("@/lib/alert-view");
    const { normalizeConfig } = await import("@/lib/config");
    const { getDb } = await import("@/lib/db");
    const BTC = "binance:BTCUSDT";
    const ETH = "binance:ETHUSDT";
    const cfg = normalizeConfig({
      sync: { tz: "Asia/Tokyo" },
      aliases: { BTC },
      groups: [{ name: "加密", symbols: ["BTC", ETH] }],
      alerts: [
        { key: "BTC", label: "破十三万", cond: "crossing_up", value: 130000 },
        { key: "BTC", cond: "greater", value: 1, trigger: "bar" },
        { key: "BTC", cond: "less", value: 1 },
        { key: "BTC", cond: "less", value: 2, enabled: false },
        { label: "周线多头", when: "close > sma(close, 40)", tf: "W", notify: false },
      ],
    });
    const now = new Date("2026-10-07T03:00:00Z"); // a Wednesday in Tokyo
    const lastWeek = Date.parse("2026-10-02T03:00:00Z");
    const put = (i: number, key: string, state: number, firedAt: number | null) =>
      getDb().prepare("INSERT OR REPLACE INTO alert_state (vault, rule, key, state, fired_at) VALUES ('badges', ?, ?, ?, ?)").run(cfg.alerts[i].id, key, state, firedAt);
    put(0, BTC, 1, Date.parse("2026-10-05T01:00:00Z"));
    put(1, BTC, 1, lastWeek);
    put(4, BTC, 1, null);
    put(4, ETH, 0, lastWeek);
    const badges = alertBadges("badges", cfg, now);
    expect(badges[BTC].map((b) => [b.label, b.state])).toEqual([
      ["破十三万", "fresh"],
      ["BTC 大于 1", "on"],
      ["BTC 小于 1", "idle"],
      ["BTC 小于 2", "stopped"],
      ["周线多头", "on"],
    ]);
    expect(badges[ETH]).toBeUndefined();
    expect(badges[BTC][0].title).toBe("破十三万\n收盘价上穿 130,000\n盘中价格 · 仅一次 · 推送到通知通道\n状态：本周新触发（10/05 10:00）");
    expect(badges[BTC][1].title).toContain("状态：成立中（上次触发 10/02 12:00）");
    expect(badges[BTC][4].title).toBe("周线多头\n周线公式 close > sma(close, 40)\n全部自选 · 日线收盘 · 每根 K 线最多一次 · 只在总览显示\n状态：成立中");
  });

  it("tells a fired once alert (已触发) from a paused one (已停止) and draws only active levels", async () => {
    const { alertViews } = await import("@/lib/alert-view");
    const { normalizeConfig } = await import("@/lib/config");
    const { getDb } = await import("@/lib/db");
    const cfg = normalizeConfig({
      aliases: { BTC: "binance:BTCUSDT" },
      alerts: [
        { key: "BTC", cond: "entering", value: [1, 2] },
        { key: "BTC", cond: "greater", value: 3, enabled: false },
        { key: "BTC", cond: "less", value: 4, enabled: false },
      ],
    });
    getDb().prepare("INSERT OR REPLACE INTO alert_state (vault, rule, key, state, fired_at) VALUES ('', ?, 'binance:BTCUSDT', 1, 5)").run(cfg.alerts[1].id);
    const views = alertViews("", cfg, {});
    expect(views.map((v) => [v.status, v.levels])).toEqual([
      ["active", [1, 2]],
      ["triggered", []],
      ["stopped", []],
    ]);
  });
});
