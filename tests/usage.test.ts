import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hebi8m_session" && request.session ? { name, value: request.session } : undefined) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-usage-"));
const root = path.join(dir, "vault");
const secrets = path.join(dir, "secrets");
const yamlFile = path.join(root, "hebi8.yaml");
const ROOT_YAML = `owner: [Owner, owner-alt] # 我
sync: { at: ["07:30"], tz: Asia/Tokyo }
groups:
  - { name: 加密, symbols: [binance:BTCUSDT, binance:ETHUSDT] }
`;

// a webhook that records what it is sent, and fails while `failing` is set
const posts: string[] = [];
let failing = false;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (failing) {
      res.statusCode = 500;
      return res.end("down");
    }
    posts.push(body);
    res.end("ok");
  });
});

let sessions: Record<string, string>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = secrets;
  fs.mkdirSync(root);
  fs.writeFileSync(yamlFile, ROOT_YAML);
  const { createSession, writeJson } = await import("@/lib/secrets");
  const as = (login: string) => createSession({ login, avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
  sessions = { owner: as("Owner"), alice: as("Alice") };
  writeJson("notify.json", { webhook: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, format: "text" }, link: "https://market-hebi8.dreaife.tokyo" });
});

afterAll(() => {
  server.close();
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.writeFileSync(yamlFile, ROOT_YAML);
  request.session = undefined;
  posts.length = 0;
  failing = false;
  const { getDb } = await import("@/lib/db");
  getDb().exec("DELETE FROM traffic; DELETE FROM visitors; DELETE FROM upstream; DELETE FROM usage_alerts; DELETE FROM symbols;");
  (await import("@/lib/traffic")).drainCounters();
});

const tunnel = (pathname: string, ip: string, init: { session?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://market-hebi8.dreaife.tokyo${pathname}`, {
    headers: {
      host: "market-hebi8.dreaife.tokyo",
      "cf-connecting-ip": ip,
      "x-forwarded-for": `${ip}, 172.18.0.2`,
      "x-forwarded-proto": "https",
      ...(init.session ? { cookie: `hebi8m_session=${init.session}` } : {}),
      ...init.headers,
    },
  });
const tailnet = (pathname: string, ip: string) => new NextRequest(`http://100.64.0.1:8808${pathname}`, { headers: { host: "100.64.0.1:8808", "x-forwarded-for": ip } });

describe("request counting", () => {
  it("the proxy counts in memory, the flush writes hashed visitors and logins per local day", async () => {
    const { proxy } = await import("@/proxy");
    const { flushUsage, dailyTraffic, topPaths, topVisitors, lastSeen, usageDay } = await import("@/lib/usage");
    const { getDb } = await import("@/lib/db");
    proxy(tunnel("/", "203.0.113.9"));
    proxy(tunnel("/", "203.0.113.9"));
    proxy(tunnel("/chart/binance%3ABTCUSDT", "198.51.100.4", { session: sessions.alice }));
    proxy(tunnel("/chart/binance%3ABTCUSDT", "198.51.100.4", { session: sessions.alice, headers: { "next-action": "deadbeef" } }));
    proxy(tunnel("/review", "198.51.100.4", { headers: { rsc: "1", "next-router-prefetch": "1" } }));
    proxy(tunnel("/api/bars", "198.51.100.4"));
    proxy(tailnet("/", "100.64.0.7"));
    // nothing is written until the flush
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM traffic").get()).toEqual({ n: 0 });
    flushUsage();

    const today = usageDay();
    const [day] = dailyTraffic(today, 30);
    expect(day).toEqual({ day: today, requests: 7, page: 4, prefetch: 1, action: 1, api: 1, publicVisitors: 2, tailnetVisitors: 1, publicFull: 0, tailnetFull: 0, logins: 1 });
    // no symbol is synced in this vault, so the chart key is not kept
    expect(topPaths(today)).toEqual([
      { path: "/", kind: "page", requests: 3 },
      { path: "/api/bars", kind: "api", requests: 1 },
      { path: "/chart/[key]", kind: "action", requests: 1 },
      { path: "/chart/[key]", kind: "page", requests: 1 },
    ]);
    const visitors = topVisitors(today, 30);
    expect(visitors.map((v) => [v.origin, v.requests, v.logins])).toEqual([
      ["public", 4, "alice"],
      ["public", 2, ""],
      ["tailnet", 1, ""],
    ]);
    expect(lastSeen().has("alice")).toBe(true);

    // no address anywhere in the table, and the salt is a secret
    const dump = JSON.stringify([getDb().prepare("SELECT * FROM traffic").all(), getDb().prepare("SELECT * FROM visitors").all()]);
    for (const ip of ["203.0.113.9", "198.51.100.4", "100.64.0.7"]) expect(dump).not.toContain(ip);
    expect(fs.statSync(path.join(secrets, "traffic-salt.json")).mode & 0o777).toBe(0o600);

    // a second flush adds to the same rows
    proxy(tunnel("/", "203.0.113.9"));
    flushUsage();
    expect(dailyTraffic(today, 1)[0].requests).toBe(8);
  });

  it("a scanner with random paths and changing addresses adds a bounded number of rows", async () => {
    const { proxy } = await import("@/proxy");
    const { flushUsage, MAX_VISITORS, topPaths, usageDay, dailyTraffic } = await import("@/lib/usage");
    const { getDb } = await import("@/lib/db");
    getDb().prepare("INSERT INTO symbols (key, source, ticker) VALUES ('binance:BTCUSDT', 'binance', 'BTCUSDT')").run();
    for (let i = 0; i < 10_000; i++) {
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      proxy(tunnel(i % 2 ? `/random-${i}` : `/chart/random-${i}`, ip));
      if (i % 1000 === 0) flushUsage();
    }
    proxy(tunnel("/chart/binance%3ABTCUSDT", "203.0.113.9"));
    flushUsage();
    const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("traffic")).toBe(3);
    expect(topPaths(usageDay())).toEqual([
      { path: "(其他)", kind: "page", requests: 5000 },
      { path: "/chart/[key]", kind: "page", requests: 5000 },
      { path: "/chart/binance%3ABTCUSDT", kind: "page", requests: 1 },
    ]);
    expect(count("visitors")).toBe(MAX_VISITORS + 1);
    const [day] = dailyTraffic(usageDay(), 1);
    expect([day.requests, day.publicVisitors, day.publicFull]).toEqual([10_001, MAX_VISITORS, 1]);
    const other = getDb().prepare("SELECT n FROM visitors WHERE visitor = '(其他)'").get() as { n: number };
    expect(other.n).toBe(10_001 - MAX_VISITORS);
  });

  it("reads the sessions file once per flush, however many made-up cookies come in", async () => {
    const { proxy } = await import("@/proxy");
    const { flushUsage, topVisitors, usageDay } = await import("@/lib/usage");
    for (let i = 0; i < 1000; i++) proxy(tunnel("/", "203.0.113.9", { session: `fake-session-cookie-${String(i).padStart(8, "0")}` }));
    proxy(tunnel("/", "203.0.113.9", { session: sessions.alice }));
    const read = vi.spyOn(fs, "readFileSync");
    try {
      flushUsage();
      expect(read.mock.calls.filter(([file]) => String(file).endsWith("sessions.json"))).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
    expect(topVisitors(usageDay(), 1).map((v) => [v.requests, v.logins])).toEqual([[1001, "alice"]]);
  });

  it("a flush that cannot write keeps its counts for the next one", async () => {
    const { proxy } = await import("@/proxy");
    const { recordUpstream } = await import("@/lib/traffic");
    const { flushUsage, dailyTraffic, dailyUpstream, usageDay } = await import("@/lib/usage");
    const { getDb } = await import("@/lib/db");
    proxy(tunnel("/", "203.0.113.9"));
    recordUpstream("yahoo", "limited");
    getDb().exec("ALTER TABLE upstream RENAME TO upstream_away");
    try {
      expect(() => flushUsage()).toThrow();
    } finally {
      getDb().exec("ALTER TABLE upstream_away RENAME TO upstream");
    }
    // came in while the database was down
    proxy(tunnel("/", "203.0.113.9"));
    flushUsage();
    expect(dailyTraffic(usageDay(), 1)[0].requests).toBe(2);
    expect(dailyUpstream(usageDay(), 1)).toEqual([{ day: usageDay(), source: "yahoo", requests: 1, failures: 1, limited: 1 }]);
  });

  it("calls to sources count requests, failures and suspected rate limits", async () => {
    const { countUpstream } = await import("@/lib/traffic");
    const { flushUsage, dailyUpstream, usageDay } = await import("@/lib/usage");
    await countUpstream("binance", async () => 1);
    await expect(countUpstream("binance", async () => Promise.reject(new Error("Binance 429: slow down")))).rejects.toThrow("429");
    await expect(countUpstream("binance", async () => Promise.reject(new Error("Binance 400")))).rejects.toThrow();
    await expect(countUpstream("tv", async () => Promise.reject(new Error("TradingView timeout: X")))).rejects.toThrow();
    flushUsage();
    expect(dailyUpstream(usageDay(), 30)).toEqual([
      { day: usageDay(), source: "binance", requests: 3, failures: 2, limited: 1 },
      { day: usageDay(), source: "tv", requests: 1, failures: 1, limited: 0 },
    ]);
  });

  it("a Binance search whose pair list gets 429 is a limited request, counted once, and still answers", async () => {
    const { adapters } = await import("@/lib/sources");
    const { flushUsage, dailyUpstream, usageDay } = await import("@/lib/usage");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 429 }));
    try {
      expect((await adapters.binance.search!("ETH")).map((h) => h.key)).toEqual(["binance:ETHUSDT"]);
    } finally {
      fetchMock.mockRestore();
    }
    flushUsage();
    expect(dailyUpstream(usageDay(), 1)).toEqual([{ day: usageDay(), source: "binance", requests: 1, failures: 1, limited: 1 }]);
  });

  it("keeps 90 days", async () => {
    const { getDb } = await import("@/lib/db");
    const { pruneUsage, usageDay } = await import("@/lib/usage");
    const { DAY } = await import("@/lib/time");
    const today = usageDay();
    const add = getDb().prepare("INSERT INTO upstream (day, source, requests, failures, limited) VALUES (?, 'yahoo', 1, 0, 0)");
    for (const ago of [0, 89, 90, 200]) add.run(today - ago * DAY);
    pruneUsage();
    expect((getDb().prepare("SELECT day FROM upstream ORDER BY day DESC").all() as { day: number }[]).map((r) => (today - r.day) / DAY)).toEqual([0, 89]);
  });
});

describe("usage limits", () => {
  it("notify the owner once a day per limit, and retry when delivery fails", async () => {
    const { proxy } = await import("@/proxy");
    const { checkLimits, flushUsage } = await import("@/lib/usage");
    const { recordUpstream } = await import("@/lib/traffic");
    // no limits: nothing to check
    proxy(tunnel("/", "203.0.113.1"));
    flushUsage();
    expect(await checkLimits()).toEqual([]);

    fs.writeFileSync(yamlFile, ROOT_YAML + "usage:\n  visitors: 2 # 公网独立访客\n  limited: 1\n");
    proxy(tunnel("/", "203.0.113.2"));
    proxy(tunnel("/", "203.0.113.3"));
    // tailnet visitors do not count
    proxy(tailnet("/", "100.64.0.8"));
    proxy(tailnet("/", "100.64.0.9"));
    recordUpstream("yahoo", "limited");
    flushUsage();

    failing = true;
    expect((await checkLimits()).map((p) => p.kind)).toEqual(["visitors"]);
    expect(posts).toEqual([]);
    failing = false;
    expect(await checkLimits()).toEqual([{ day: (await import("@/lib/usage")).usageDay(), kind: "visitors", value: 3, limit: 2 }]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("今天公网独立访客 3，超过 2");
    expect(posts[0]).toContain("https://market-hebi8.dreaife.tokyo/usage");

    // already told today; another limit passing later still goes out once
    proxy(tunnel("/", "203.0.113.4"));
    recordUpstream("tv", "limited");
    flushUsage();
    expect((await checkLimits()).map((p) => p.kind)).toEqual(["limited"]);
    expect(await checkLimits()).toEqual([]);
    expect(posts).toHaveLength(2);
  });

  it("a limit passed just before midnight is still told after it, as that day's", async () => {
    const { checkLimits } = await import("@/lib/usage");
    const { getDb } = await import("@/lib/db");
    fs.writeFileSync(yamlFile, ROOT_YAML + "usage:\n  visitors: 2\n");
    // 23:59 in Tokyo on 10-07: two visitors, nothing passed yet
    const oct7 = Date.UTC(2026, 9, 7) / 1000;
    const before = Date.UTC(2026, 9, 7, 14, 59);
    const add = getDb().prepare("INSERT INTO visitors (day, origin, visitor, login, n, last) VALUES (?, 'public', ?, '', 1, 0)");
    add.run(oct7, "v1");
    add.run(oct7, "v2");
    expect(await checkLimits(before)).toEqual([]);
    // a third arrives in the last minute; the next check is 00:04 on 10-08
    add.run(oct7, "v3");
    expect(await checkLimits(before + 5 * 60_000)).toEqual([{ day: oct7, kind: "visitors", value: 3, limit: 2 }]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("昨天（10-07）公网独立访客 3，超过 2");
    expect(getDb().prepare("SELECT kind, day FROM usage_alerts").all()).toEqual([{ kind: "visitors", day: oct7 }]);
    expect(await checkLimits(before + 10 * 60_000)).toEqual([]);
  });

  it("without a channel nothing is marked, so a channel set up later that day still gets it", async () => {
    const { checkLimits } = await import("@/lib/usage");
    const { recordUpstream } = await import("@/lib/traffic");
    const { flushUsage } = await import("@/lib/usage");
    const { getDb } = await import("@/lib/db");
    const { readJson, writeJson } = await import("@/lib/secrets");
    const notify = readJson<Record<string, unknown>>("notify.json")!;
    fs.writeFileSync(yamlFile, ROOT_YAML + "usage:\n  limited: 1\n");
    recordUpstream("tv", "limited");
    recordUpstream("tv", "limited");
    flushUsage();
    writeJson("notify.json", {});
    try {
      expect((await checkLimits()).map((p) => p.kind)).toEqual(["limited"]);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM usage_alerts").get()).toEqual({ n: 0 });
    } finally {
      writeJson("notify.json", notify);
    }
    expect((await checkLimits()).map((p) => p.kind)).toEqual(["limited"]);
    expect(posts).toHaveLength(1);
    expect(await checkLimits()).toEqual([]);
  });

  it("the owner sets them from the page, in the root yaml, keeping comments", async () => {
    const { setUsageLimits } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    request.session = sessions.alice;
    expect(await setUsageLimits({ visitors: 100, limited: null })).toEqual({ ok: false, error: "只有 owner 能改提醒阈值" });
    request.session = sessions.owner;
    expect(await setUsageLimits({ visitors: 0, limited: null })).toEqual({ ok: false, error: "每日公网独立访客应为正整数" });
    expect(await setUsageLimits({ visitors: 100, limited: null })).toEqual({ ok: true });
    expect(fs.readFileSync(yamlFile, "utf8")).toContain("# 我");
    expect(readConfig(root).usage).toEqual({ visitors: 100, limited: null });
    expect(await setUsageLimits({ visitors: 100, limited: 5 })).toEqual({ ok: true });
    expect(readConfig(root).usage).toEqual({ visitors: 100, limited: 5 });
    expect(await setUsageLimits({ visitors: null, limited: null })).toEqual({ ok: true });
    expect(fs.readFileSync(yamlFile, "utf8")).not.toContain("usage");
  });
});

describe("config", () => {
  it("usage is validated and only the root vault's counts", async () => {
    const { normalizeConfig, normalizeUserConfig, ConfigError } = await import("@/lib/config");
    expect(normalizeConfig({}).usage).toEqual({ visitors: null, limited: null });
    expect(normalizeConfig({ usage: { visitors: 50 } }).usage).toEqual({ visitors: 50, limited: null });
    expect(() => normalizeConfig({ usage: { limited: 1.5 } })).toThrow(ConfigError);
    expect(() => normalizeConfig({ usage: { visitors: "many" } })).toThrow(/usage.visitors/);
    const rootCfg = normalizeConfig({ owner: "Owner", usage: { visitors: 50 } });
    const user = normalizeUserConfig({ usage: { visitors: 1 } }, rootCfg);
    expect(user.usage).toEqual({ visitors: 50, limited: null });
    expect(user.ignored).toEqual(["usage"]);
  });
});

describe("the usage page", () => {
  it("is the owner's only: 404 for anyone else", async () => {
    const { default: UsagePage } = await import("@/app/usage/page");
    for (const session of [undefined, sessions.alice]) {
      request.session = session;
      await expect(UsagePage()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
    request.session = sessions.owner;
    await expect(UsagePage()).resolves.toBeTruthy();
  });
});
