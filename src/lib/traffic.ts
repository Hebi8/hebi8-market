/**
 * Counters for traffic monitoring (design §1.7): requests to this app, bumped by `src/proxy.ts`,
 * and calls to the upstream sources, bumped by `src/lib/sources/`. Both only add to maps in
 * memory; `src/lib/usage.ts` drains them into SQLite every 30 seconds. The maps hang off
 * `globalThis` because the proxy is its own bundle, loaded into the same Node process.
 *
 * No plain IP is kept anywhere: a visitor is an HMAC of the address with a salt from the secrets
 * dir. A session cookie is kept until the flush, which turns it into a login.
 */
import crypto from "node:crypto";
import { readJson, writeJson } from "./secrets";
import type { Source } from "./symbols";

/** Through the Cloudflare tunnel (a public host name) or straight over the tailnet */
export type Origin = "public" | "tailnet";
export type Kind = "page" | "prefetch" | "action" | "api";
export type Outcome = "ok" | "failed" | "limited";

export interface Hit {
  /** unix minutes; the flush turns them into local days */
  minute: number;
  origin: Origin;
  kind: Kind;
  path: string;
  visitor: string;
  /** the session cookie as sent, '' without one */
  session: string;
  n: number;
  /** unix seconds of the latest request */
  last: number;
}

export interface UpstreamHit {
  minute: number;
  source: Source;
  requests: number;
  /** limited ones included */
  failures: number;
  limited: number;
}

interface Counters {
  hits: Map<string, Hit>;
  upstream: Map<string, UpstreamHit>;
  salt?: string;
  /** Installed by the flusher; called when the buffer grows past `FLUSH_AT` keys */
  flushSoon?: () => void;
}

const FLUSH_AT = 5000;
const SALT_FILE = "traffic-salt.json";

const g = globalThis as unknown as { hebi8mTraffic?: Counters };
const counters: Counters = (g.hebi8mTraffic ??= { hits: new Map(), upstream: new Map() });

/** Only the tunnel serves a public host name; IPs, single labels, localhost and MagicDNS names are the tailnet. */
export function originOf(host: string | null): Origin {
  const name = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!name || name.startsWith("[") || name === "localhost" || !name.includes(".") || name.endsWith(".ts.net")) return "tailnet";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ? "tailnet" : "public";
}

/** Every page and route handler under `src/app` except `/chart/[key]`; tests/traffic.test.ts keeps this in step with the files. */
export const ROUTES = new Set([
  "/",
  "/review",
  "/claim",
  "/privacy",
  "/changelog",
  "/usage",
  "/settings",
  "/mcp",
  "/api/bars",
  "/api/search",
  "/api/help",
  "/api/status",
  "/api/github/callback",
  "/api/github/claim",
  "/api/github/claim/redeem",
  "/api/github/device",
  "/api/github/device/poll",
  "/api/github/issues",
  "/api/github/login",
  "/api/github/logout",
  "/api/notify",
  "/api/notify/bot",
  "/api/notify/push",
  "/api/notify/telegram",
  "/api/notify/telegram/cancel",
  "/api/notify/telegram/poll",
  "/api/notify/test",
  "/api/notify/webhook",
]);
/** Where every path that is no route of this app goes, so scanners cannot add rows */
export const OTHER = "(其他)";
/** A chart whose key is no symbol anyone has; the flush decides, it can see the database */
export const ANY_CHART = "/chart/[key]";
const MAX_KEY = 100;

/** The route a path belongs to; a chart keeps its key (in one spelling) until the flush checks it. */
export function routeOf(pathname: string): string {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (ROUTES.has(p)) return p;
  const chart = /^\/chart\/([^/]+)$/.exec(p);
  if (!chart) return OTHER;
  try {
    const key = decodeURIComponent(chart[1]);
    return key.length > MAX_KEY ? ANY_CHART : `/chart/${encodeURIComponent(key)}`;
  } catch {
    return ANY_CHART;
  }
}

/** Server Actions are POSTs to a page with `Next-Action`; router prefetches are counted apart from views. An agent's requests to `/mcp` count as API calls. */
export function kindOf(pathname: string, headers: Headers): Kind {
  if (pathname === "/api" || pathname.startsWith("/api/") || pathname === "/mcp") return "api";
  if (headers.has("next-action")) return "action";
  if (headers.has("next-router-prefetch") || headers.has("next-router-segment-prefetch")) return "prefetch";
  return "page";
}

/**
 * The client address: `CF-Connecting-IP` behind the tunnel; on the tailnet the socket address,
 * which Next puts in `X-Forwarded-For` when nothing in front of it did.
 */
export function clientIp(origin: Origin, headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
  const ip = (origin === "public" ? headers.get("cf-connecting-ip")?.trim() : null) || forwarded;
  return ip.replace(/^::ffff:(?=\d+\.)/, "");
}

/** 16 hex digits of HMAC-SHA256: stable across days, useless without the salt. */
export const visitorId = (ip: string, salt: string) => (ip ? crypto.createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16) : "-");

function salt(): string {
  if (counters.salt) return counters.salt;
  let value = readJson<{ salt?: string }>(SALT_FILE)?.salt;
  if (!value) {
    value = crypto.randomBytes(32).toString("base64url");
    writeJson(SALT_FILE, { salt: value });
  }
  return (counters.salt = value);
}

export interface RequestInfo {
  pathname: string;
  headers: Headers;
  session: string | undefined;
}

export function recordRequest(req: RequestInfo, now = Date.now()): void {
  const origin = originOf(req.headers.get("host"));
  const hit: Omit<Hit, "n" | "last"> = {
    minute: Math.floor(now / 60000),
    origin,
    kind: kindOf(req.pathname, req.headers),
    path: routeOf(req.pathname),
    visitor: visitorId(clientIp(origin, req.headers), salt()),
    session: req.session ?? "",
  };
  addHit({ ...hit, n: 1, last: Math.floor(now / 1000) });
}

function addHit(hit: Hit): void {
  const key = [hit.minute, hit.origin, hit.kind, hit.path, hit.visitor, hit.session].join("\t");
  const seen = counters.hits.get(key);
  if (seen) {
    seen.n += hit.n;
    seen.last = Math.max(seen.last, hit.last);
  } else {
    counters.hits.set(key, { ...hit });
    if (counters.hits.size >= FLUSH_AT) counters.flushSoon?.();
  }
}

/** HTTP 429 / 403 (and Binance's 418 ban), or an error that says so. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } | null;
  if ([e?.status, e?.statusCode, e?.code].some((s) => [403, 418, 429].includes(Number(s)))) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(403|418|429)\b|too many requests|rate[ -]?limit|forbidden/i.test(message);
}

export function recordUpstream(source: Source, outcome: Outcome, now = Date.now()): void {
  addUpstream({ minute: Math.floor(now / 60000), source, requests: 1, failures: outcome === "ok" ? 0 : 1, limited: outcome === "limited" ? 1 : 0 });
}

function addUpstream(hit: UpstreamHit): void {
  const key = `${hit.minute}\t${hit.source}`;
  const row = counters.upstream.get(key) ?? { minute: hit.minute, source: hit.source, requests: 0, failures: 0, limited: 0 };
  row.requests += hit.requests;
  row.failures += hit.failures;
  row.limited += hit.limited;
  counters.upstream.set(key, row);
}

/** Count one call to a source: the outcome comes from whether it threw and how. */
export async function countUpstream<T>(source: Source, call: () => Promise<T>): Promise<T> {
  try {
    const result = await call();
    recordUpstream(source, "ok");
    return result;
  } catch (err) {
    recordUpstream(source, isRateLimited(err) ? "limited" : "failed");
    throw err;
  }
}

/** Everything counted since the last drain; the buffer starts over. */
export function drainCounters(): { hits: Hit[]; upstream: UpstreamHit[] } {
  const out = { hits: [...counters.hits.values()], upstream: [...counters.upstream.values()] };
  counters.hits.clear();
  counters.upstream.clear();
  return out;
}

/** A drained batch that could not be written goes back, added to whatever came in meanwhile. */
export function restoreCounters(batch: { hits: Hit[]; upstream: UpstreamHit[] }): void {
  batch.hits.forEach(addHit);
  batch.upstream.forEach(addUpstream);
}

export function onBufferFull(flush: (() => void) | undefined): void {
  counters.flushSoon = flush;
}
