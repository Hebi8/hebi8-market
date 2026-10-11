import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const SHARED = `# 共用实例
owner: Dreaife # 实例主人
sync: { at: ["07:30"], tz: Asia/Tokyo }
aliases:
  BTC: binance:BTCUSDT # 比特币
groups:
  - { name: 加密, symbols: [BTC, binance:ETHUSDT] }
  - { name: 美股, symbols: [{ key: yahoo:SPY, bench: BTC }] }
alerts: [] # 图表上建的写在这里
`;
// the same vault without an owner: single-user mode
const SINGLE = SHARED.replace(/^owner:.*\n/m, "");

const BTC = "binance:BTCUSDT";
const ETH = "binance:ETHUSDT";
const DAY = 86400;
/** A Monday, long closed */
const T0 = Date.UTC(2024, 0, 1) / 1000;
const day = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10);
const bars = (closes: number[]) => closes.map((c, i) => ({ t: T0 + i * DAY, o: c, h: c + 1, l: c - 1, c, v: 10, adj: 1 }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-mcp-"));
const root = path.join(dir, "vault");
const yamlFile = path.join(root, "hebi8.yaml");
const tokensFile = path.join(dir, "secrets", "mcp-tokens.json");
const readYaml = () => fs.readFileSync(yamlFile, "utf8");

beforeAll(async () => {
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  fs.mkdirSync(root);
  fs.writeFileSync(yamlFile, SHARED);
  const { ensureSymbol, writeBars } = await import("@/lib/store");
  for (const key of [BTC, ETH]) ensureSymbol(key);
  // BTC: below 105, above it for two days, below, above again; ETH never gets there
  writeBars(BTC, bars([100, 101, 106, 107, 103, 108]), "replace");
  writeBars(ETH, bars([50, 51, 52, 53, 54, 55]), "replace");
});

afterAll(() => {
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(yamlFile, SHARED);
  fs.rmSync(tokensFile, { force: true });
});

/** A viewer as `/mcp` gets it: from a token of `login`. */
async function agent(login: string | null, write = true) {
  const { createToken } = await import("@/lib/secrets");
  const { tokenViewer } = await import("@/lib/viewer");
  return tokenViewer(createToken({ name: "test", login, write }))!;
}

async function call(viewer: Awaited<ReturnType<typeof agent>>, name: string, args: unknown = {}) {
  const { callTool } = await import("@/lib/mcp/tools");
  const result = await callTool(viewer, name, args);
  const text = result.content[0].text;
  return { error: result.isError ? text : null, text, data: result.isError || name === "formula_reference" ? null : JSON.parse(text) };
}

describe("a token becomes the viewer its owner is when logged in", () => {
  it("the owner's opens the root vault, anyone else's their own, and a read-only one cannot write", async () => {
    const { createToken } = await import("@/lib/secrets");
    const { tokenViewer } = await import("@/lib/viewer");
    expect(tokenViewer(createToken({ name: "o", login: "dreaife", write: true }))).toMatchObject({ vault: "", dir: root, login: "dreaife", canWrite: true, isOwner: true, shared: true });
    const alice = tokenViewer(createToken({ name: "a", login: "Alice", write: true }));
    expect(alice).toMatchObject({ vault: "alice", dir: path.join(root, "users", "alice"), login: "Alice", canWrite: true, isOwner: false });
    // her vault is made like on a first login
    expect(fs.existsSync(path.join(root, "users", "alice", "hebi8.yaml"))).toBe(true);
    expect(tokenViewer(createToken({ name: "r", login: "alice", write: false }))).toMatchObject({ vault: "alice", canWrite: false });
    expect(tokenViewer(createToken({ name: "ro", login: "Dreaife", write: false }))).toMatchObject({ vault: "", isOwner: true, canWrite: false });
  });

  it("no token, a made-up one and a revoked one are nobody", async () => {
    const { createToken, listTokens, revokeToken } = await import("@/lib/secrets");
    const { tokenViewer } = await import("@/lib/viewer");
    expect(tokenViewer(undefined)).toBeNull();
    expect(tokenViewer("")).toBeNull();
    expect(tokenViewer(`hebi8m_${"a".repeat(43)}`)).toBeNull();
    const token = createToken({ name: "laptop", login: "alice", write: true });
    expect(tokenViewer(token)).not.toBeNull();
    const [info] = listTokens("Alice");
    expect(info).toMatchObject({ name: "laptop", login: "alice", write: true });
    // only its owner can revoke it
    expect(revokeToken("bob", info.id)).toBe(false);
    expect(tokenViewer(token)).not.toBeNull();
    expect(revokeToken("ALICE", info.id)).toBe(true);
    expect(tokenViewer(token)).toBeNull();
    expect(listTokens("alice")).toEqual([]);
  });

  it("only the hash is stored, and the last use is written at most once a day", async () => {
    const { checkToken, createToken, listTokens } = await import("@/lib/secrets");
    const t0 = Date.UTC(2026, 9, 10);
    const token = createToken({ name: "n", login: "alice", write: false }, t0);
    expect(fs.readFileSync(tokensFile, "utf8")).not.toContain(token.slice(7));
    expect(fs.statSync(tokensFile).mode & 0o777).toBe(0o600);
    expect(listTokens("alice")[0].used_at).toBeNull();
    expect(checkToken(token, t0 + 1000)?.used_at).toBe(t0 + 1000);
    const written = fs.readFileSync(tokensFile, "utf8");
    expect(checkToken(token, t0 + 3600_000)?.used_at).toBe(t0 + 1000);
    expect(fs.readFileSync(tokensFile, "utf8")).toBe(written);
    expect(checkToken(token, t0 + 1000 + 86400_000)?.used_at).toBe(t0 + 1000 + 86400_000);
    expect(listTokens("alice")[0].used_at).toBe(t0 + 1000 + 86400_000);
  });

  it("single-user mode: a token opens the root vault; once the instance is shared it is nobody's", async () => {
    const { createToken, listTokens } = await import("@/lib/secrets");
    const { tokenViewer } = await import("@/lib/viewer");
    fs.writeFileSync(yamlFile, SINGLE);
    const token = createToken({ name: "solo", login: null, write: true });
    const readOnly = createToken({ name: "solo-ro", login: null, write: false });
    expect(tokenViewer(token)).toMatchObject({ vault: "", dir: root, login: null, canWrite: true, isOwner: false, shared: false });
    expect(tokenViewer(readOnly)).toMatchObject({ vault: "", canWrite: false });
    expect(listTokens(null).map((t) => t.name)).toEqual(["solo", "solo-ro"]);
    expect(listTokens("alice")).toEqual([]);
    fs.writeFileSync(yamlFile, SHARED);
    expect(tokenViewer(token)).toBeNull();
  });
});

describe("scan and test_formula read cached bars only", () => {
  it("scan: one formula on every watched symbol, with the value on the last two bars and why a symbol failed", async () => {
    const viewer = await agent("dreaife", false);
    const { data } = await call(viewer, "scan", { formula: "close > 105" });
    expect(data).toMatchObject({ tf: "D", check: "price", scanned: 3, true_now: 1, turned_true: [BTC], failed: 1 });
    expect(data.rows).toEqual([
      { key: BTC, alias: "BTC", name: expect.any(String), value: 1, prev: 0, holds: true, date: day(5) },
      { key: ETH, name: expect.any(String), value: 0, prev: 0, holds: false, date: day(5) },
      // never synced: reported, not fetched
      { key: "yahoo:SPY", name: expect.any(String), value: null, prev: null, date: null, error: "没有缓存的日线" },
    ]);
  });

  it("scan: a number formula, a group, a key list, only the true ones, and a formula that does not compile", async () => {
    const viewer = await agent("dreaife", false);
    expect((await call(viewer, "scan", { formula: "close - ref(close, 1)", group: "加密" })).data.rows.map((r: { value: number }) => r.value)).toEqual([5, 1]);
    // the ones that failed stay in sight
    expect((await call(viewer, "scan", { formula: "close > 105", only_true: true })).data.rows.map((r: { key: string }) => r.key)).toEqual([BTC, "yahoo:SPY"]);
    // an alias, and a reference to a symbol nobody cached
    const listed = (await call(viewer, "scan", { formula: "close > close(\"yahoo:QQQ\")", keys: ["BTC"] })).data;
    expect(listed.rows).toMatchObject([{ key: BTC, value: null }]);
    expect(listed.uncached_references).toEqual(["yahoo:QQQ"]);
    // `bench` is each symbol's own: an error only where there is none
    expect((await call(viewer, "scan", { formula: "close > bench", group: "加密" })).data.rows[0].error).toContain("基准");
    expect((await call(viewer, "scan", { formula: "close >" })).error).toMatch(/第 \d+ 个字符/);
    expect((await call(viewer, "scan", { formula: "close > 1", group: "没有" })).error).toBe("没有「没有」这个分组");
    expect((await call(viewer, "scan", { formula: "close > 1", tf: "5m" })).error).toContain("Invalid arguments for scan");
  });

  it("test_formula: the bars where it held and where it turned true", async () => {
    const viewer = await agent("dreaife", false);
    const { data } = await call(viewer, "test_formula", { key: "BTC", formula: "close > 105", bars: 5 });
    expect(data).toMatchObject({
      key: BTC,
      window: { bars: 5, from: day(1), to: day(5) },
      value: 1,
      prev: 0,
      true_bars: 3,
      no_value_bars: 0,
      turned_true: 2,
      turned_true_dates: [day(2), day(5)],
      true_runs: 2,
      true_ranges: [
        { from: day(2), to: day(3), bars: 2 },
        { from: day(5), to: day(5), bars: 1 },
      ],
    });
    expect(data.recent.at(-1)).toEqual([day(5), 1]);
    // a bar without a value changes nothing, and the first value ever seen only records
    const sma = (await call(viewer, "test_formula", { key: "BTC", formula: "close > sma(close, 3)" })).data;
    expect(sma).toMatchObject({ window: { bars: 6 }, no_value_bars: 2, true_bars: 3, turned_true: 1, turned_true_dates: [day(5)] });
    // weekly bars are aggregated on read
    expect((await call(viewer, "test_formula", { key: BTC, formula: "close > 0", tf: "W" })).data.window).toEqual({ bars: 1, from: day(0), to: day(0) });
    expect((await call(viewer, "test_formula", { key: "yahoo:SPY", formula: "close > 0" })).error).toBe("没有缓存的日线");
  });

  it("get_bars and overview read the same cache", async () => {
    const viewer = await agent("dreaife", false);
    const got = (await call(viewer, "get_bars", { key: "BTC", limit: 2 })).data;
    expect(got).toMatchObject({ key: BTC, tf: "D", total_bars: 6, last_daily_bar: { date: day(5), closed: true } });
    expect(got.bars).toEqual([
      [day(4), 103, 104, 102, 103, 10],
      [day(5), 108, 109, 107, 108, 10],
    ]);
    expect((await call(viewer, "get_bars", { key: "BTC", tf: "W" })).data.bars).toEqual([[day(0), 100, 109, 99, 108, 60]]);
    const overview = (await call(viewer, "overview")).data;
    expect(overview.groups.map((g: { name: string }) => g.name)).toEqual(["加密", "美股"]);
    expect(overview.groups[0].symbols[0]).toMatchObject({ key: BTC, alias: "BTC", price: 108, date: day(5) });
    expect(overview.groups[1].symbols[0]).toMatchObject({ key: "yahoo:SPY", bench: BTC, price: null });
  });

  it("true is what an alert takes for true: an infinite value holds, and is told from no value", async () => {
    const { decide } = await import("@/lib/alerts");
    const { evalRule } = await import("@/lib/conditions");
    const { ensureSymbol, writeBars } = await import("@/lib/store");
    const { readConfig } = await import("@/lib/vault");
    const SOL = "binance:SOLUSDT";
    const FORMULA = "1 / (close - ref(close, 1)) - 1";
    ensureSymbol(SOL);
    const closes = [100, 101, 101];
    // what the alert does, bar by bar: no value, false (0), then 1 / 0: true, and it fires
    const judged = closes.map((_, i) => {
      writeBars(SOL, bars(closes.slice(0, i + 1)), "replace");
      return evalRule(SOL, FORMULA, "D", readConfig(root));
    });
    expect(judged.map((r) => r.now)).toEqual([null, false, true]);
    expect(decide({ state: 0, firedBar: null }, judged[2]).fire).toBe(true);

    const viewer = await agent("dreaife", false);
    const tested = (await call(viewer, "test_formula", { key: SOL, formula: FORMULA })).data;
    expect(tested).toMatchObject({ value: "Infinity", prev: 0, true_bars: 1, no_value_bars: 1, turned_true: 1, turned_true_dates: [day(2)], true_ranges: [{ from: day(2), to: day(2), bars: 1 }] });
    expect(tested.recent).toEqual([
      [day(0), null],
      [day(1), 0],
      [day(2), "Infinity"],
    ]);
    const scanned = (await call(viewer, "scan", { formula: FORMULA, keys: [SOL, ETH], only_true: true })).data;
    expect(scanned).toMatchObject({ scanned: 2, true_now: 1, turned_true: [SOL] });
    expect(scanned.rows).toEqual([{ key: SOL, name: expect.any(String), value: "Infinity", prev: 0, holds: true, date: day(2) }]);
    expect((await call(viewer, "scan", { formula: `-(${FORMULA})`, keys: [SOL] })).data.rows[0]).toMatchObject({ value: "-Infinity", holds: true });
  });

  it("get_bars: the last daily bar is closed when its trading day is over, whatever a later quote made of its price", async () => {
    const { ensureSymbol, markSynced, writeBars, writeQuotes } = await import("@/lib/store");
    const XRP = "binance:XRPUSDT";
    const D9 = Date.UTC(2026, 9, 9) / 1000;
    const at = (h: number, m = 0) => (D9 + h * 3600 + m * 60) * 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // synced on the 9th with that day's bar at 100, then a quote the same day at 101
      vi.setSystemTime(at(20));
      ensureSymbol(XRP);
      writeBars(XRP, [{ t: D9 - DAY, o: 99, h: 99, l: 99, c: 99, v: 1, adj: 1 }, { t: D9, o: 100, h: 100, l: 100, c: 100, v: 1, adj: 1 }], "replace");
      markSynced(XRP, { hours: "24x7", timezone: "UTC" });
      writeQuotes([{ key: XRP, price: 101, time: at(21) / 1000, session: "always", fetchedAt: at(21) }]);
      const viewer = await agent("dreaife", false);
      // still the 9th: the bar carries the quote and is not done
      vi.setSystemTime(at(22));
      const open = (await call(viewer, "get_bars", { key: XRP, limit: 1 })).data;
      expect(open.bars[0].slice(0, 5)).toEqual(["2026-10-09", 100, 101, 100, 101]);
      expect(open.last_daily_bar).toEqual({ date: "2026-10-09", closed: false });
      // 12:31 UTC on the 10th: the same bar, the quote's price still on it, and the day is over
      vi.setSystemTime(at(36, 31));
      const done = (await call(viewer, "get_bars", { key: XRP, limit: 1 })).data;
      expect(done.bars[0].slice(0, 5)).toEqual(["2026-10-09", 100, 101, 100, 101]);
      expect(done.last_daily_bar).toEqual({ date: "2026-10-09", closed: true });
      // a synthetic bar is done when the bars it is made of are
      writeBars(BTC, [...bars([100, 101, 106, 107, 103, 108]), { t: D9, o: 50, h: 50, l: 50, c: 50, v: 1, adj: 1 }], "replace");
      expect((await call(viewer, "get_bars", { key: `=${XRP}/binance:BTCUSDT`, limit: 1 })).data).toMatchObject({ last_daily_bar: { date: "2026-10-09", closed: true }, bars: [["2026-10-09", 2, 2.02, 2, 2.02, null]] });
      vi.setSystemTime(at(22));
      expect((await call(viewer, "get_bars", { key: `=${XRP}/binance:BTCUSDT`, limit: 1 })).data.last_daily_bar.closed).toBe(false);
    } finally {
      writeBars(BTC, bars([100, 101, 106, 107, 103, 108]), "replace");
      vi.useRealTimers();
    }
  });

  it("the reference lists what the engine has", async () => {
    const { FUNCTIONS, SERIES_VARS } = await import("@/indicators/formula");
    const { ALERT_CONDS } = await import("@/lib/alert-conds");
    const { text } = await call(await agent("dreaife", false), "formula_reference");
    for (const name of Object.keys(SERIES_VARS)) expect(text).toContain(`- \`${name}\``);
    for (const name of Object.keys(FUNCTIONS)) expect(text).toContain(`- \`${name}(`);
    for (const cond of Object.keys(ALERT_CONDS)) expect(text).toContain(`- \`${cond}\``);
  });
});

describe("alerts an agent saves", () => {
  it("on the whole watchlist: a draft, marked as the agent's, that nothing judges until it is confirmed on the page", async () => {
    const { alertBadges, alertViews } = await import("@/lib/alert-view");
    const { readState, runAlerts } = await import("@/lib/alerts");
    const { confirmAlert } = await import("@/lib/ops");
    const { readConfig } = await import("@/lib/vault");
    const viewer = await agent("dreaife");

    const saved = (await call(viewer, "save_alert", { when: "close > 105", label: "站上 105" })).data;
    expect(saved).toMatchObject({ status: "draft", label: "站上 105" });
    expect(saved.message).toContain("DRAFT");
    expect(readYaml()).toContain("- { when: close > 105, label: 站上 105, by: agent, draft: true }");
    expect(readYaml()).toContain("# 比特币");
    expect(readConfig(root).alerts[0]).toMatchObject({ id: saved.id, key: null, draft: true, by: "agent", enabled: true });

    // a sync and a quote round pass it by: no state, no event, no badge
    expect(await runAlerts({ id: "", dir: root }, () => readConfig(root))).toEqual([]);
    expect(await runAlerts({ id: "", dir: root }, () => readConfig(root), "watchlist")).toEqual([]);
    expect(readState("").size).toBe(0);
    expect(alertBadges("", readConfig(root))).toEqual({});
    expect(alertViews("", readConfig(root), {})[0]).toMatchObject({ status: "draft", draft: true, by: "agent" });
    expect((await call(viewer, "list_alerts")).data[0]).toMatchObject({ id: saved.id, status: "draft", by: "agent", holds_on: [], last_fired: null });

    // the person confirms: an ordinary alert, judged right away like a new one on the whole watchlist
    await confirmAlert(viewer, saved.id);
    expect(readYaml()).toContain("- { when: close > 105, label: 站上 105, by: agent }");
    expect(readConfig(root).alerts[0]).toMatchObject({ id: saved.id, draft: false, by: "agent" });
    expect(readState("").size).toBe(2);
    expect(Object.keys(alertBadges("", readConfig(root)))).toEqual([BTC]);
    expect((await call(viewer, "list_alerts")).data[0]).toMatchObject({ status: "active", holds_on: [BTC] });
    expect((await call(viewer, "overview")).data.groups[0].symbols[0].alerts).toMatchObject([{ id: saved.id, label: "站上 105" }]);
  });

  it("an agent cannot put one on the whole watchlist into effect, nor take one out of it by editing: no resuming, no edit of one that is not a draft", async () => {
    const { readState } = await import("@/lib/alerts");
    const { confirmAlert } = await import("@/lib/ops");
    const { readConfig } = await import("@/lib/vault");
    const viewer = await agent("dreaife");
    const { id } = (await call(viewer, "save_alert", { when: "close > 105" })).data;
    await confirmAlert(viewer, id);
    expect(readState("").size).toBe(2);

    // stopping is allowed, resuming is the person's
    expect((await call(viewer, "set_alert_enabled", { id, enabled: false })).error).toBeNull();
    expect(readConfig(root).alerts[0].enabled).toBe(false);
    expect((await call(viewer, "set_alert_enabled", { id, enabled: true })).error).toBe("对全部自选的警报只能由用户在页面上恢复");
    expect(readConfig(root).alerts[0].enabled).toBe(false);

    // an edit of one that is not a draft, stopped or running, is refused and changes nothing
    const refused = "这条对全部自选的警报不是草稿，agent 不能改：不带 id 另存一条新的（会存成草稿），旧的继续生效，用户确认新的之后再删旧的";
    expect((await call(viewer, "save_alert", { id, when: "close > 106", tf: "W" })).error).toBe(refused);
    await confirmAlert(viewer, id);
    const before = readYaml();
    expect((await call(viewer, "save_alert", { id, when: "close > 106", tf: "W" })).error).toBe(refused);
    // nor may it become an alert on one symbol
    expect((await call(viewer, "save_alert", { id, key: "BTC", when: "close > 106" })).error).toBe(refused);
    expect(readYaml()).toBe(before);
    expect(readConfig(root).alerts).toMatchObject([{ id, when: "close > 105", draft: false, enabled: true }]);
    expect(readState("").size).toBe(2);

    // the way to change it: a new draft beside it, which the agent may go on editing
    const next = (await call(viewer, "save_alert", { when: "close > 106", tf: "W" })).data;
    expect(next.status).toBe("draft");
    const edited = (await call(viewer, "save_alert", { id: next.id, when: "close > 107", tf: "W", label: "站上 107" })).data;
    expect(edited.status).toBe("draft");
    expect(readConfig(root).alerts).toMatchObject([
      { id, when: "close > 105", draft: false },
      { id: edited.id, when: "close > 107", tf: "W", label: "站上 107", draft: true, by: "agent", enabled: true },
    ]);
    expect(readState("").size).toBe(2);
    // stopping and deleting the one in effect stay allowed
    expect((await call(viewer, "delete_alert", { id })).error).toBeNull();

    // a price condition needs a symbol, as on the page
    expect((await call(viewer, "save_alert", { cond: "greater", value: 1 })).error).toContain("价格和通道条件要写 key");
    expect((await call(viewer, "save_alert", {})).error).toBe("需要 cond + value，或 when 公式");
    expect((await call(viewer, "delete_alert", { id: edited.id })).error).toBeNull();
    expect((await call(viewer, "delete_alert", { id: edited.id })).error).toBe("这条警报已经不在 hebi8.yaml 里了");
    expect(readConfig(root).alerts).toEqual([]);
  });

  it("on one symbol: in effect at once, like one made on the page, and marked", async () => {
    const { readConfig } = await import("@/lib/vault");
    const { runAlerts } = await import("@/lib/alerts");
    const viewer = await agent("dreaife");
    const saved = (await call(viewer, "save_alert", { key: "BTC", cond: "greater", value: 105, trigger: "bar" })).data;
    expect(saved).toMatchObject({ status: "active", label: "BTC 大于 105" });
    expect(readYaml()).toContain("- { key: BTC, cond: greater, value: 105, trigger: bar, by: agent }");
    expect(readConfig(root).alerts[0]).toMatchObject({ key: BTC, draft: false, by: "agent", enabled: true });
    expect((await runAlerts({ id: "", dir: root }, () => readConfig(root))).map((e) => e.rule)).toEqual([saved.id]);
    // resuming one on a symbol is allowed
    await call(viewer, "set_alert_enabled", { id: saved.id, enabled: false });
    expect((await call(viewer, "set_alert_enabled", { id: saved.id, enabled: true })).error).toBeNull();
    expect(readConfig(root).alerts[0].enabled).toBe(true);
  });

  it("an edit on the page leaves a draft a draft and the agent's mark where it is", async () => {
    const { saveAlert } = await import("@/lib/ops");
    const { readConfig } = await import("@/lib/vault");
    const viewer = await agent("dreaife");
    const { id } = (await call(viewer, "save_alert", { when: "close > 105" })).data;
    const edited = await saveAlert(viewer, { id, key: null, cond: "formula", when: "close > 104", trigger: "bar", label: "改过" });
    expect(edited.draft).toBe(true);
    expect(readConfig(root).alerts[0]).toMatchObject({ when: "close > 104", label: "改过", draft: true, by: "agent" });
  });
});

describe("the other writes", () => {
  it("a read-only token is refused before anything runs", async () => {
    const { TOOLS } = await import("@/lib/mcp/tools");
    const viewer = await agent("dreaife", false);
    const before = readYaml();
    for (const tool of TOOLS.filter((t) => t.write)) expect((await call(viewer, tool.name, {})).error, tool.name).toContain("这个令牌是只读的");
    expect(readYaml()).toBe(before);
    expect(TOOLS.filter((t) => t.write).map((t) => t.name)).toEqual(["save_alert", "delete_alert", "set_alert_enabled", "add_symbol", "remove_symbol", "append_note", "append_journal", "save_indicator", "delete_indicator"]);
  });

  it("append_note and append_journal add to the end and never replace", async () => {
    const { JOURNAL_TEMPLATE, readJournal, readNote, writeNote } = await import("@/lib/vault");
    const viewer = await agent("dreaife");
    expect((await call(viewer, "read_note", { key: "BTC" })).data.note).toBeNull();
    expect((await call(viewer, "append_note", { key: "BTC", text: "## Agent\n第一条\n" })).error).toBeNull();
    expect(readNote(root, BTC)).toBe("## Agent\n第一条\n");
    // what the person wrote in between stays
    writeNote(root, BTC, "# 为什么看\n我写的");
    await call(viewer, "append_note", { key: BTC, text: "第二条" });
    expect(readNote(root, BTC)).toBe("# 为什么看\n我写的\n\n第二条\n");
    expect((await call(viewer, "read_note", { key: "BTC" })).data.note).toBe("# 为什么看\n我写的\n\n第二条\n");
    expect((await call(viewer, "read_note")).data.notes).toMatchObject([{ key: BTC }]);
    expect((await call(viewer, "append_note", { key: "BTC", text: "  " })).error).toBe("内容为空");
    expect((await call(viewer, "append_note", { key: "nope", text: "x" })).error).toContain("无效的 key");

    // a week nobody wrote starts from the page's template
    await call(viewer, "append_journal", { week: "2026-W41", text: "## Agent 记录\n扫了一遍" });
    expect(readJournal(root, "2026-W41")).toBe(`${JOURNAL_TEMPLATE.trimEnd()}\n\n## Agent 记录\n扫了一遍\n`);
    await call(viewer, "append_journal", { week: "2026-W41", text: "再一条" });
    expect(readJournal(root, "2026-W41")).toBe(`${JOURNAL_TEMPLATE.trimEnd()}\n\n## Agent 记录\n扫了一遍\n\n再一条\n`);
    const listed = (await call(viewer, "read_journal")).data;
    expect(listed.weeks).toMatchObject([{ week: "2026-W41" }]);
    expect(listed.current_week).toMatch(/^\d{4}-W\d{2}$/);
    expect((await call(viewer, "read_journal", { week: "2026-W41" })).data.journal).toContain("再一条");
    expect((await call(viewer, "append_journal", { week: "41", text: "x" })).error).toBe("无效的周");
  });

  it("indicators and the watchlist go through the page's operations", async () => {
    const { readConfig } = await import("@/lib/vault");
    const viewer = await agent("dreaife");
    expect((await call(viewer, "save_indicator", { id: "dev3", formula: "(close / sma(close, 3) - 1) * 100" })).error).toBeNull();
    expect(readConfig(root).indicators).toEqual([{ id: "dev3", label: "dev3", pane: "sub", formula: "(close / sma(close, 3) - 1) * 100" }]);
    expect(readConfig(root).chart.indicators).toContain("dev3");
    expect((await call(viewer, "save_indicator", { id: "3x", formula: "close" })).error).toBe("id 只能用字母、数字、下划线");
    expect((await call(viewer, "delete_indicator", { id: "dev3" })).error).toBeNull();
    expect((await call(viewer, "delete_indicator", { id: "dev3" })).error).toBe("没有 id 为「dev3」的公式指标");
    expect(readConfig(root).indicators).toEqual([]);

    expect((await call(viewer, "remove_symbol", { key: "binance:ETHUSDT" })).data).toEqual({ removed: ETH });
    expect(readConfig(root).groups[0].symbols.map((s) => s.key)).toEqual([BTC]);
    expect((await call(viewer, "remove_symbol", { key: "binance:ETHUSDT" })).error).toBe(`${ETH} 不在自选里`);
    expect((await call(viewer, "add_symbol", { key: "BTC" })).error).toBe(`${BTC} 已经在「加密」组里`);
    expect(readYaml()).toContain("# 比特币");
  });

  it("each person's token reaches their own vault only", async () => {
    const { readConfig } = await import("@/lib/vault");
    const alice = await agent("alice");
    expect((await call(alice, "save_alert", { key: "BTC", cond: "greater", value: 1 })).error).toBeNull();
    expect(readConfig(alice.dir).alerts).toHaveLength(1);
    expect(readConfig(root).alerts).toEqual([]);
    expect((await call(await agent("dreaife", false), "list_alerts")).data).toEqual([]);
  });
});

describe("POST /mcp", () => {
  const rpc = (token: string | null, body: unknown, method = "POST") =>
    new Request("http://localhost/mcp", {
      method,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

  it("needs a token, in single-user mode too", async () => {
    const { handleMcp } = await import("@/lib/mcp/server");
    const refused = await handleMcp(rpc(null, initialize));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("Bearer");
    expect((await handleMcp(rpc("hebi8m_nope", initialize))).status).toBe(401);
    fs.writeFileSync(yamlFile, SINGLE);
    expect((await handleMcp(rpc(null, initialize))).status).toBe(401);
    expect((await handleMcp(rpc(null, initialize, "GET"))).status).toBe(401);
  });

  it("answers initialize, tools/list and tools/call as JSON, without a session", async () => {
    const { handleMcp } = await import("@/lib/mcp/server");
    const { createToken } = await import("@/lib/secrets");
    const { TOOLS } = await import("@/lib/mcp/tools");
    const token = createToken({ name: "t", login: "dreaife", write: false });
    const init = await handleMcp(rpc(token, initialize));
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "hebi8-market" }, capabilities: { tools: {} } });
    expect((await handleMcp(rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    expect((await (await handleMcp(rpc(token, { jsonrpc: "2.0", id: 2, method: "ping" }))).json()).result).toEqual({});

    const listed = (await (await handleMcp(rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/list" }))).json()).result.tools as { name: string; inputSchema: { type: string; required?: string[] }; annotations: { readOnlyHint: boolean } }[];
    expect(listed.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(listed).toHaveLength(19);
    const scanTool = listed.find((t) => t.name === "scan")!;
    // defaults are optional for the caller
    expect(scanTool.inputSchema).toMatchObject({ type: "object", required: ["formula"] });
    expect(listed.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(TOOLS.filter((t) => t.write).map((t) => t.name));

    const called = (await (await handleMcp(rpc(token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "scan", arguments: { formula: "close > 105", group: "加密", only_true: true } } }))).json()).result;
    expect(JSON.parse(called.content[0].text).rows.map((r: { key: string }) => r.key)).toEqual([BTC]);
    const write = (await (await handleMcp(rpc(token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "append_note", arguments: { key: "BTC", text: "x" } } }))).json()).result;
    expect(write).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("只读") }] });
    expect((await handleMcp(rpc(token, initialize, "GET"))).status).toBe(405);
  });
});
