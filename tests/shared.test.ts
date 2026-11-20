import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, normalizeConfig, normalizeUserConfig } from "@/lib/config";

// Server Actions read the session cookie through next/headers; here it is whatever the test says.
const request = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hebi8m_session" && request.session ? { name, value: request.session } : undefined) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ROOT_YAML = `# 共用实例的根 vault
owner: Dreaife # 实例主人
sync:
  at: ["07:30"]
  tz: Asia/Tokyo
updown: green-up
aliases:
  BTC: binance:BTCUSDT # 比特币
groups:
  # 先看币
  - name: 加密
    symbols: [BTC]
alerts:
  - { key: BTC, label: 站上 100, when: "close > 100" }
  - { id: up, label: 上涨, when: "close > ref(close, 1)", tf: D, notify: false }
datasets:
  gpu: ./gpu
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-shared-"));
const root = path.join(dir, "vault");
const users = path.join(root, "users");
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const writeRoot = (text: string) => fs.writeFileSync(path.join(root, "hebi8.yaml"), text);

let sessions: Record<string, string>;

beforeAll(async () => {
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_DB = path.join(dir, "data", "hebi8.db");
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  fs.mkdirSync(root);
  writeRoot(ROOT_YAML);
  const { createSession } = await import("@/lib/secrets");
  const as = (login: string) => createSession({ login, avatar_url: `https://avatars.example/${login}`, access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
  sessions = { owner: as("dreaife"), alice: as("Alice"), aliceUpper: as("ALICE"), bob: as("bob"), evil: as("../evil") };
});

afterAll(() => {
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  request.session = undefined;
});

describe("owner in hebi8.yaml", () => {
  it("must look like a GitHub login", () => {
    expect(normalizeConfig({ owner: "Dreaife" }).owner).toBe("Dreaife");
    expect(normalizeConfig({}).owner).toBeNull();
    expect(() => normalizeConfig({ owner: "../x" })).toThrow(ConfigError);
    expect(() => normalizeConfig({ owner: "a--b" })).toThrow(ConfigError);
  });

  it("can list several logins, e.g. one person's two accounts; the first is the one named", () => {
    expect(normalizeConfig({ owner: ["dreaife", " dreaifekks "] })).toMatchObject({ owners: ["dreaife", "dreaifekks"], owner: "dreaife" });
    expect(normalizeConfig({ owner: "dreaife" }).owners).toEqual(["dreaife"]);
    expect(normalizeConfig({}).owners).toEqual([]);
    expect(() => normalizeConfig({ owner: ["dreaife", "../x"] })).toThrow(ConfigError);
  });

  it("is ignored in a user's yaml, with sync and datasets, which come from the root", () => {
    const rootCfg = normalizeConfig({ owner: "o", sync: { at: ["06:00"], tz: "UTC" }, datasets: { gpu: "./gpu" } });
    const cfg = normalizeUserConfig({ owner: "me", sync: { tz: "Mars/Olympus" }, datasets: { x: "bad" }, updown: "red-up" }, rootCfg);
    expect(cfg).toMatchObject({ owner: "o", sync: { at: ["06:00"], tz: "UTC" }, datasets: { gpu: "./gpu" }, updown: "red-up" });
    expect(cfg.ignored).toEqual(["owner", "sync", "datasets"]);
    expect(normalizeUserConfig({}, rootCfg).ignored).toEqual([]);
  });
});

describe("resolveViewer", () => {
  it("single-user mode: everyone reads and writes the root vault, logged in or not", async () => {
    const { resolveViewer } = await import("@/lib/viewer");
    writeRoot(ROOT_YAML.replace(/^owner:.*\n/m, ""));
    try {
      for (const id of [undefined, sessions.alice]) {
        expect(resolveViewer(id)).toMatchObject({ vault: "", dir: root, canWrite: true, isOwner: false, shared: false });
      }
      expect(resolveViewer(sessions.alice).login).toBe("Alice");
      expect(fs.existsSync(users)).toBe(false);
    } finally {
      writeRoot(ROOT_YAML);
    }
  });

  it("shared, not logged in: the root vault, read only", async () => {
    const { resolveViewer } = await import("@/lib/viewer");
    expect(resolveViewer(undefined)).toEqual({ vault: "", dir: root, login: null, avatarUrl: null, canWrite: false, isOwner: false, shared: true, owner: "Dreaife" });
    expect(resolveViewer("not-a-session-id-at-all-xxxxxxxx")).toMatchObject({ vault: "", canWrite: false });
  });

  it("shared, the owner (case-insensitive): the root vault with write access", async () => {
    const { resolveViewer } = await import("@/lib/viewer");
    expect(resolveViewer(sessions.owner)).toMatchObject({ vault: "", dir: root, login: "dreaife", canWrite: true, isOwner: true, shared: true });
  });

  it("shared, any listed owner: the root vault, with notification channels kept under the first owner", async () => {
    const { resolveViewer } = await import("@/lib/viewer");
    const { notifyCaller } = await import("@/lib/notify-caller");
    const { NextRequest } = await import("next/server");
    writeRoot(ROOT_YAML.replace("owner: Dreaife # 实例主人", "owner: [Dreaife, bob] # 实例主人的两个账号"));
    try {
      expect(resolveViewer(sessions.bob)).toMatchObject({ vault: "", dir: root, login: "bob", canWrite: true, isOwner: true, owner: "Dreaife" });
      expect(fs.existsSync(path.join(users, "bob"))).toBe(false);
      const caller = notifyCaller(new NextRequest("http://h/api/notify", { headers: { cookie: `hebi8m_session=${sessions.bob}` } }));
      expect(caller).toMatchObject({ login: "Dreaife", vault: "" });
    } finally {
      writeRoot(ROOT_YAML);
    }
  });

  it("shared, anyone else: their own lower-case vault, started from the root yaml", async () => {
    const { resolveViewer } = await import("@/lib/viewer");
    const alice = resolveViewer(sessions.alice);
    expect(alice).toMatchObject({ vault: "alice", dir: path.join(users, "alice"), login: "Alice", canWrite: true, isOwner: false, shared: true });

    const text = read(users, "alice", "hebi8.yaml");
    // nothing is assigned: none of the owner's alerts come along
    for (const gone of ["owner:", "sync:", "datasets:", "alerts:", "站上 100", "上涨"]) expect(text).not.toContain(gone);
    expect(text.startsWith("# 共用实例的根 vault\n")).toBe(true);
    expect(text).toContain("# 比特币");
    expect(text).toContain("# 先看币");
    expect(fs.existsSync(path.join(users, "alice", "notes"))).toBe(false);

    const { readConfig } = await import("@/lib/vault");
    const cfg = readConfig(alice.dir);
    expect(cfg).toMatchObject({ owner: "Dreaife", sync: { at: ["07:30"], tz: "Asia/Tokyo" }, datasets: { gpu: "./gpu" }, alerts: [], ignored: [] });
    expect(cfg.groups[0].symbols[0].key).toBe("binance:BTCUSDT");

    // the copy happens once; later changes to either side stay apart
    fs.appendFileSync(path.join(users, "alice", "hebi8.yaml"), "periods: [1M]\n");
    expect(resolveViewer(sessions.aliceUpper)).toMatchObject({ vault: "alice", dir: path.join(users, "alice"), login: "ALICE" });
    expect(read(users, "alice", "hebi8.yaml")).toContain("periods: [1M]");
    expect(read(root, "hebi8.yaml")).toBe(ROOT_YAML);
  });

  it("treats a session whose login is not a GitHub login as nobody", async () => {
    const { resolveViewer } = await import("@/lib/viewer");
    const { userVaultDir } = await import("@/lib/vault");
    expect(resolveViewer(sessions.evil)).toMatchObject({ vault: "", login: null, canWrite: false });
    expect(fs.existsSync(path.join(root, "evil"))).toBe(false);
    expect(() => userVaultDir("../evil")).toThrow(/无效的 GitHub 用户名/);
    expect(() => userVaultDir("a/b")).toThrow();
    expect(userVaultDir("MiXeD")).toBe(path.join(users, "mixed"));
  });
});

describe("Server Actions write as the viewer", () => {
  const note = (vaultDir: string) => path.join(vaultDir, "notes", "binance_BTCUSDT.md");

  it("refuses visitors who are not logged in on a shared instance", async () => {
    const { editWatchlist, saveNote, saveJournal, setUpdown } = await import("@/app/actions");
    for (const result of [await saveNote("binance:BTCUSDT", "x"), await saveJournal("2026-W41", "x"), await setUpdown("red-up"), await editWatchlist({ type: "removeSymbol", key: "binance:BTCUSDT" })]) {
      expect(result).toEqual({ ok: false, error: "请先登录" });
    }
    expect(fs.existsSync(note(root))).toBe(false);
    expect(fs.existsSync(path.join(root, "journal"))).toBe(false);
    expect(read(root, "hebi8.yaml")).toBe(ROOT_YAML);
  });

  it("puts each person's writes in their own vault only", async () => {
    const { saveNote, setUpdown } = await import("@/app/actions");
    const { readConfig, readNote } = await import("@/lib/vault");
    const alice = path.join(users, "alice");
    const bob = path.join(users, "bob");

    request.session = sessions.alice;
    expect(await saveNote("binance:BTCUSDT", "Alice 的笔记")).toEqual({ ok: true });
    expect(await setUpdown("red-up")).toEqual({ ok: true });
    request.session = sessions.bob;
    expect(await saveNote("binance:BTCUSDT", "Bob 的笔记")).toEqual({ ok: true });
    request.session = sessions.owner;
    expect(await saveNote("binance:BTCUSDT", "主人的笔记")).toEqual({ ok: true });

    expect(readNote(alice, "binance:BTCUSDT")).toBe("Alice 的笔记\n");
    expect(readNote(bob, "binance:BTCUSDT")).toBe("Bob 的笔记\n");
    expect(readNote(root, "binance:BTCUSDT")).toBe("主人的笔记\n");
    expect(readConfig(alice).updown).toBe("red-up");
    expect(readConfig(bob).updown).toBe("green-up");
    expect(readConfig(root).updown).toBe("green-up");

    // the same person in another case is the same vault
    request.session = sessions.aliceUpper;
    expect(await saveNote("binance:BTCUSDT", "还是 Alice")).toEqual({ ok: true });
    expect(readNote(alice, "binance:BTCUSDT")).toBe("还是 Alice\n");
    expect(fs.readdirSync(users).sort()).toEqual(["alice", "bob"]);
  });
});

describe("drafts", () => {
  it("are kept per vault, with the root vault's keys as before", async () => {
    const { draftKey } = await import("@/lib/use-autosave");
    expect(draftKey("", "notes/yahoo_NVDA.md")).toBe("hebi8:draft:notes/yahoo_NVDA.md");
    expect(draftKey("alice", "journal/2026-W41.md")).toBe("hebi8:draft:users/alice/journal/2026-W41.md");
  });
});

describe("sync across vaults", () => {
  it("fetches the union of every vault's keys and comparisons, skipping broken and stale vaults", async () => {
    const { unionSyncKeys } = await import("@/lib/sync");
    const { loadVaults } = await import("@/lib/vault");
    const { writeChartState } = await import("@/lib/vault");
    const alice = path.join(users, "alice");
    fs.writeFileSync(path.join(alice, "hebi8.yaml"), read(alice, "hebi8.yaml").replace(/symbols: \[ ?BTC ?\]/, "symbols: [BTC, yahoo:SPY]"));
    writeChartState(alice, "yahoo:SPY", { compare: [{ key: "yahoo:QQQ", mode: "percent", color: "#0e9aa7" }], overlays: [] });
    fs.writeFileSync(path.join(users, "bob", "hebi8.yaml"), "groups: [oops");
    // the owner's vault is the root one, whatever is left under users/
    fs.mkdirSync(path.join(users, "dreaife"));
    fs.writeFileSync(path.join(users, "dreaife", "hebi8.yaml"), "groups:\n  - { name: x, symbols: [tv:TVC:GOLD] }\n");

    const vaults = loadVaults();
    expect(vaults.map((v) => v.id)).toEqual(["", "alice"]);
    const keys = unionSyncKeys(vaults);
    expect(keys.sort()).toEqual(["binance:BTCUSDT", "yahoo:QQQ", "yahoo:SPY"]);

    // single-user mode: only the root vault counts
    writeRoot(ROOT_YAML.replace(/^owner:.*\n/m, ""));
    try {
      expect(loadVaults().map((v) => v.id)).toEqual([""]);
      expect(unionSyncKeys(loadVaults())).toEqual(["binance:BTCUSDT"]);
    } finally {
      writeRoot(ROOT_YAML);
    }
  });
});

describe("stats and alerts per vault", () => {
  const KEY = "binance:BTCUSDT";
  const t0 = Date.UTC(2026, 0, 1) / 1000;
  const bars = (closes: number[]) => closes.map((c, i) => ({ t: t0 + i * 86400, o: c, h: c, l: c, c, v: 1, adj: 1 }));
  const rootCfg = normalizeConfig({
    aliases: { BTC: KEY },
    groups: [{ name: "加密", symbols: ["BTC"] }],
    alerts: [
      { key: "BTC", label: "站上 100", when: "close > 100", trigger: "bar" },
      { id: "up", label: "上涨", when: "close > ref(close, 1)", tf: "D", notify: false },
    ],
  });
  const aliceCfg = normalizeConfig({
    aliases: { BTC: KEY },
    groups: [{ name: "币", symbols: ["BTC"] }],
    alerts: [{ id: "down", label: "下跌", when: "close < ref(close, 1)", tf: "D" }],
  });

  it("keeps each vault's stats in its own rows", async () => {
    const { overviewStats } = await import("@/lib/quotes");
    const { ensureSymbol, writeBars } = await import("@/lib/store");
    const { getDb } = await import("@/lib/db");
    const rows = (vault: string) => getDb().prepare("SELECT key, json FROM stats WHERE vault = ?").all(vault) as { key: string; json: string }[];
    ensureSymbol(KEY);
    writeBars(KEY, bars([90, 95, 101]), "replace");
    expect(overviewStats("", rootCfg)[KEY].stats.last).toBe(101);
    expect(overviewStats("alice", aliceCfg)[KEY].stats.last).toBe(101);
    expect(rows("").map((r) => [r.key, JSON.parse(r.json).last])).toEqual([[KEY, 101]]);
    expect(rows("alice").map((r) => r.key)).toEqual([KEY]);
    expect(rows("bob")).toEqual([]);
  });

  it("hides the owner's last review from visitors, retaining it for the owner and single-user mode", async () => {
    const { writeJournal } = await import("@/lib/vault");
    const { default: Home } = await import("@/app/page");
    writeJournal(root, "2026-W41", "owner's review");
    expect((await Home()).props).toMatchObject({ data: { lastReviewDays: null } });
    request.session = sessions.owner;
    expect((await Home()).props).toMatchObject({ data: { lastReviewDays: 0 } });
    request.session = undefined;
    writeRoot(ROOT_YAML.replace(/^owner:.*\n/m, ""));
    try {
      expect((await Home()).props).toMatchObject({ data: { lastReviewDays: 0 } });
    } finally {
      writeRoot(ROOT_YAML);
    }
  });

  it("computes a vault's stats from the cache the first time a page asks", async () => {
    const { overviewStats } = await import("@/lib/quotes");
    expect(overviewStats("carol", aliceCfg)[KEY]).toEqual({ stats: expect.objectContaining({ last: 101 }), status: null });
  });

  it("the chart's watchlist panel shows the price the overview does, a quote newer than the sync included", async () => {
    const { getDb } = await import("@/lib/db");
    const { markSynced, writeQuotes } = await import("@/lib/store");
    const { default: Home } = await import("@/app/page");
    const { default: ChartPage } = await import("@/app/chart/[key]/page");
    request.session = sessions.owner;
    markSynced(KEY, {});
    writeQuotes([{ key: KEY, price: 120, time: Math.floor(Date.now() / 1000), session: "always", fetchedAt: Date.now() + 1000 }]);
    try {
      const home = (await Home()).props.data.groups[0].items[0];
      const panel = (await ChartPage({ params: Promise.resolve({ key: encodeURIComponent(KEY) }) })).props.watchlist[0].items[0];
      expect(home.stats.last).toBe(120);
      expect(panel).toMatchObject({ key: KEY, last: 120 });
    } finally {
      getDb().exec("DELETE FROM quotes");
    }
  });

  it("/api/bars answers per person, never from a shared conditional cache", async () => {
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/bars/route");
    const get = (session?: string) =>
      GET(new NextRequest(`http://h/api/bars?key=${encodeURIComponent(KEY)}&tf=D`, { headers: { ...(session ? { cookie: `hebi8m_session=${session}` } : {}), "if-none-match": '"x"' } }));
    for (const res of [await get(), await get(sessions.alice)]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("etag")).toBeNull();
    }
  });

  it("judges each vault's rules against its own state", async () => {
    const { runAlerts } = await import("@/lib/alerts");
    const { writeBars } = await import("@/lib/store");
    const { getDb } = await import("@/lib/db");
    const run = async () => ({ root: (await runAlerts({ id: "", dir: root }, () => rootCfg)).map((e) => e.rule), alice: (await runAlerts({ id: "alice", dir: path.join(users, "alice") }, () => aliceCfg)).map((e) => e.rule) });

    writeBars(KEY, bars([90, 95, 101]), "replace");
    expect(await run()).toEqual({ root: [], alice: [] }); // first sighting everywhere
    const rows = getDb().prepare("SELECT vault, rule FROM alert_state ORDER BY vault, rule").all();
    // one row per alert and watched symbol, in each vault
    expect(rows).toEqual([
      ...[rootCfg.alerts[0].id, "alert:up"].sort().map((rule) => ({ vault: "", rule })),
      { vault: "alice", rule: "alert:down" },
    ]);

    writeBars(KEY, bars([90, 95, 101, 99]), "replace");
    expect(await run()).toEqual({ root: [], alice: ["alert:down"] });
    // the root rule's row survived Alice's run, so its turn is noticed; 上涨 turns too but was never pushed
    writeBars(KEY, bars([90, 95, 101, 99, 102]), "replace");
    expect(await run()).toEqual({ root: [rootCfg.alerts[0].id], alice: [] });
  });
});
