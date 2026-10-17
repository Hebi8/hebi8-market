import { describe, expect, it } from "vitest";
import { cookieOptions } from "@/lib/github";
import { DAY } from "@/lib/time";
import fs from "node:fs";
import path from "node:path";
import { ANY_CHART, OTHER, ROUTES, clientIp, isRateLimited, kindOf, originOf, routeOf, visitorId, type Hit } from "@/lib/traffic";
import { capVisitors, fillDays, passedLimits, pathRows, upstreamRows, usageMessage, visitorRows } from "@/lib/usage";

const h = (init: Record<string, string>) => new Headers(init);

describe("where a request comes from", () => {
  it("a public host name is the tunnel; addresses, single labels and MagicDNS names are the tailnet", () => {
    expect(originOf("market-hebi8.dreaife.tokyo")).toBe("public");
    expect(originOf("Market-Hebi8.dreaife.tokyo:443")).toBe("public");
    for (const host of ["100.64.0.1:8808", "100.64.0.1", "localhost:3000", "devnuc:8808", "devnuc.tail1234.ts.net", "[fd7a:115c::1]:8808", "", null]) {
      expect(originOf(host)).toBe("tailnet");
    }
  });

  it("API routes, Server Actions, prefetches and page views", () => {
    expect(kindOf("/api/bars", h({}))).toBe("api");
    expect(kindOf("/api", h({}))).toBe("api");
    expect(kindOf("/apis", h({}))).toBe("page");
    expect(kindOf("/mcp", h({}))).toBe("api");
    expect(kindOf("/", h({ "next-action": "abc123" }))).toBe("action");
    expect(kindOf("/chart/x", h({ rsc: "1", "next-router-prefetch": "1" }))).toBe("prefetch");
    expect(kindOf("/chart/x", h({ rsc: "1" }))).toBe("page");
    expect(kindOf("/review", h({}))).toBe("page");
  });

  it("paths become routes of this app; anything else is one bucket", () => {
    expect(routeOf("/")).toBe("/");
    expect(routeOf("/review/")).toBe("/review");
    expect(routeOf("/api/notify/telegram/poll")).toBe("/api/notify/telegram/poll");
    for (const p of ["/random-1", "/random-2", "/wp-login.php", "/.env", "/api/nope", "/chart", "/chart/a/b", "/review/x"]) expect(routeOf(p)).toBe(OTHER);
    // one spelling per chart key; the flush decides whether the key is anyone's
    expect(routeOf("/chart/binance:BTCUSDT")).toBe("/chart/binance%3ABTCUSDT");
    expect(routeOf("/chart/binance%3ABTCUSDT")).toBe("/chart/binance%3ABTCUSDT");
    expect(routeOf("/chart/%3Dyahoo%3AAAPL%2Fyahoo%3A%5EGSPC")).toBe("/chart/%3Dyahoo%3AAAPL%2Fyahoo%3A%5EGSPC");
    expect(routeOf("/chart/=yahoo:AAPL%2F%22yahoo:BRK-B%22")).toBe("/chart/%3Dyahoo%3AAAPL%2F%22yahoo%3ABRK-B%22");
    expect(routeOf("/chart/%E0%A4%A")).toBe(ANY_CHART);
    expect(routeOf(`/chart/${"x".repeat(101)}`)).toBe(ANY_CHART);
  });

  it("knows every page and route handler under src/app", () => {
    const app = path.join(__dirname, "..", "src", "app");
    const found = (fs.readdirSync(app, { recursive: true }) as string[])
      .filter((f) => /(^|\/)(page\.tsx|route\.ts)$/.test(f))
      .map((f) => "/" + path.dirname(f).replace(/^\.$/, ""))
      .map((r) => (r === "/" ? r : r.replace(/\/$/, "")))
      .sort();
    expect(found).toEqual([...ROUTES, "/chart/[key]"].sort());
  });

  it("takes CF-Connecting-IP behind the tunnel and the socket address on the tailnet", () => {
    const headers = h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "172.18.0.2, 10.0.0.1" });
    expect(clientIp("public", headers)).toBe("203.0.113.9");
    // a CF header that reaches the tailnet port did not come from Cloudflare
    expect(clientIp("tailnet", headers)).toBe("172.18.0.2");
    expect(clientIp("public", h({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp("tailnet", h({ "x-forwarded-for": "::ffff:100.64.0.7" }))).toBe("100.64.0.7");
    expect(clientIp("tailnet", h({}))).toBe("");
  });

  it("a visitor is a salted hash, never the address", () => {
    const a = visitorId("203.0.113.9", "salt-a");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(visitorId("203.0.113.9", "salt-a"));
    expect(a).not.toBe(visitorId("203.0.113.9", "salt-b"));
    expect(a).not.toBe(visitorId("203.0.113.10", "salt-a"));
    expect(visitorId("", "salt-a")).toBe("-");
  });
});

describe("upstream rate limits", () => {
  it("429 / 403 / 418 by status or by message", () => {
    expect(isRateLimited(new Error("Binance 429: {\"code\":-1003}"))).toBe(true);
    expect(isRateLimited(new Error("Binance 418: banned"))).toBe(true);
    expect(isRateLimited(Object.assign(new Error("HTTPError"), { status: 429 }))).toBe(true);
    expect(isRateLimited(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimited(new Error("git fetch 失败：The requested URL returned error: 403"))).toBe(true);
    expect(isRateLimited(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimited(new Error("TradingView timeout: TVC:GOLD"))).toBe(false);
    expect(isRateLimited(new Error("Binance 400: invalid symbol"))).toBe(false);
    expect(isRateLimited("boom")).toBe(false);
  });
});

describe("aggregation", () => {
  // 2026-10-06 15:00 UTC is midnight in Tokyo
  const midnight = Date.UTC(2026, 9, 6, 15) / 60000;
  const oct6 = Date.UTC(2026, 9, 6) / 1000;
  const oct7 = oct6 + DAY;
  const hit = (over: Partial<Hit>): Hit => ({ minute: midnight, origin: "public", kind: "page", path: "/", visitor: "v1", session: "", n: 1, last: midnight * 60, ...over });

  it("paths: minutes become local days, charts of keys nobody has become one route", () => {
    const rows = pathRows(
      [
        hit({ minute: midnight - 1, n: 2 }),
        hit({ n: 3, visitor: "v2" }),
        hit({ path: "/chart/binance%3ABTCUSDT" }),
        hit({ path: "/chart/random-1" }),
        hit({ path: "/chart/random-2", n: 4 }),
        hit({ path: OTHER, kind: "api" }),
      ],
      "Asia/Tokyo",
      (key) => key === "binance:BTCUSDT",
    );
    expect(rows).toEqual([
      { day: oct6, origin: "public", kind: "page", path: "/", n: 2 },
      { day: oct7, origin: "public", kind: "page", path: "/", n: 3 },
      { day: oct7, origin: "public", kind: "page", path: "/chart/binance%3ABTCUSDT", n: 1 },
      { day: oct7, origin: "public", kind: "page", path: "/chart/[key]", n: 5 },
      { day: oct7, origin: "public", kind: "api", path: OTHER, n: 1 },
    ]);
    // the same minutes in UTC are one day
    expect(new Set(pathRows([hit({ minute: midnight - 1 }), hit({})], "UTC", () => true).map((r) => r.day)).size).toBe(1);
  });

  it("visitors: sessions become logins, equal rows add up across paths", () => {
    const rows = visitorRows(
      [
        hit({ n: 3, last: midnight * 60 + 5 }),
        hit({ path: "/review", session: "s-alice", last: midnight * 60 + 9 }),
        // a session that has expired, or was made up, is nobody
        hit({ path: "/usage", session: "s-gone", n: 4, last: midnight * 60 + 1 }),
        hit({ session: "s-alice", n: 2, last: midnight * 60 + 30 }),
      ],
      "Asia/Tokyo",
      (s: string) => (s === "s-alice" ? "alice" : ""),
    );
    expect(rows).toEqual([
      { day: oct7, origin: "public", visitor: "v1", login: "", n: 7, last: midnight * 60 + 5 },
      { day: oct7, origin: "public", visitor: "v1", login: "alice", n: 3, last: midnight * 60 + 30 },
    ]);
  });

  it("caps the distinct visitors of a day and origin; the rest add up in one row", () => {
    const row = (visitor: string, origin: "public" | "tailnet" = "public", day = oct7) => ({ day, origin, visitor, login: "", n: 1, last: 1 });
    const stored = new Set(["a"]);
    const capped = capVisitors(
      [row("a"), row("b"), row("c"), row("d"), row("b"), row("x", "tailnet"), row("e", "public", oct6)],
      (_day, origin, v) => origin === "public" && stored.has(v),
      (day, origin) => (day === oct7 && origin === "public" ? 1 : 0),
      2,
    );
    expect(capped.map((r) => [r.day === oct7 ? "oct7" : "oct6", r.origin, r.visitor, r.n])).toEqual([
      ["oct7", "public", "a", 1],
      ["oct7", "public", "b", 2],
      ["oct7", "public", OTHER, 2],
      ["oct7", "tailnet", "x", 1],
      ["oct6", "public", "e", 1],
    ]);
  });

  it("upstream calls add up per local day and source", () => {
    const rows = upstreamRows(
      [
        { minute: midnight, source: "yahoo", requests: 3, failures: 1, limited: 1 },
        { minute: midnight + 5, source: "yahoo", requests: 2, failures: 2, limited: 0 },
        { minute: midnight + 5, source: "tv", requests: 1, failures: 0, limited: 0 },
      ],
      "Asia/Tokyo",
    );
    expect(rows).toEqual([
      { day: oct7, source: "yahoo", requests: 5, failures: 3, limited: 1 },
      { day: oct7, source: "tv", requests: 1, failures: 0, limited: 0 },
    ]);
  });

  it("fills days without requests, newest first", () => {
    const today = Date.UTC(2026, 9, 7) / 1000;
    const out = fillDays([{ day: today - DAY, n: 5 }], today, 3, { n: 0 });
    expect(out).toEqual([
      { day: today, n: 0 },
      { day: today - DAY, n: 5 },
      { day: today - 2 * DAY, n: 0 },
    ]);
  });
});

describe("usage limits", () => {
  const today = Date.UTC(2026, 9, 7) / 1000;

  it("only limits that are set and strictly passed", () => {
    expect(passedLimits({ visitors: null, limited: null }, { visitors: 1e6, limited: 1e6 }, today)).toEqual([]);
    expect(passedLimits({ visitors: 100, limited: 20 }, { visitors: 100, limited: 21 }, today)).toEqual([{ day: today, kind: "limited", value: 21, limit: 20 }]);
    expect(passedLimits({ visitors: 100, limited: null }, { visitors: 101, limited: 50 }, today)).toEqual([{ day: today, kind: "visitors", value: 101, limit: 100 }]);
  });

  it("one message for everything passed, saying which day, with the page link when there is one", () => {
    const { title, text } = usageMessage(
      [
        { day: today - DAY, kind: "limited", value: 25, limit: 20 },
        { day: today, kind: "visitors", value: 235, limit: 200 },
      ],
      today,
      "https://market-hebi8.dreaife.tokyo",
    );
    expect(title).toBe("hebi8/market · 使用量提醒");
    expect(text).toContain("今天公网独立访客 235，超过 200");
    expect(text).toContain("昨天（10-06）上游疑似限流次数 25，超过 20");
    expect(text).toContain("https://market-hebi8.dreaife.tokyo/usage");
  });
});

describe("session cookie", () => {
  it("is Secure over HTTPS (the tunnel) and not on the tailnet's http", () => {
    expect(cookieOptions(60, h({ host: "market-hebi8.dreaife.tokyo", "x-forwarded-proto": "https" })).secure).toBe(true);
    expect(cookieOptions(60, h({ host: "100.64.0.1:8808", "x-forwarded-proto": "http" })).secure).toBe(false);
    expect(cookieOptions(60, h({ host: "100.64.0.1:8808" })).secure).toBe(false);
  });
});
