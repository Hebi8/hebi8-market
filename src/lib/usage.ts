/**
 * Traffic monitoring, the database side (design §1.7). Every 30 seconds the counters from
 * `traffic.ts` go into the `traffic`, `visitors` and `upstream` tables, one row per local day and
 * whatever tells requests apart; rows older than 90 days are deleted. Rows stay bounded whatever
 * comes in: paths are routes of this app, a chart keeps its key only when the key is a symbol
 * somebody has, and a day takes at most `MAX_VISITORS` visitors per origin, the rest counted
 * together as one. After a flush the owner's optional daily limits (`usage` in the root yaml) are
 * checked and passed ones notified once per day. Nothing here limits or blocks anyone.
 */
import { getDb } from "./db";
import { USAGE_LIMITS, allItems, type UsageLimits } from "./config";
import { channelNames, channelsFor, deliver } from "./notify";
import { liveSessions } from "./secrets";
import type { Source } from "./symbols";
import { DAY, localDay } from "./time";
import { ANY_CHART, OTHER, drainCounters, onBufferFull, restoreCounters, type Hit, type Kind, type Origin, type UpstreamHit } from "./traffic";
import { loadVaults, readConfigSafe, vaultDir } from "./vault";

export const FLUSH_MS = 30_000;
export const KEEP_DAYS = 90;
/** Distinct visitors kept per day and origin; anyone beyond is counted as `OTHER` */
export const MAX_VISITORS = 2000;
const CHECK_MS = 5 * 60 * 1000;
const PRUNE_MS = 60 * 60 * 1000;

const log = (msg: string) => console.log(`[hebi8m] usage: ${msg}`);

export interface PathRow {
  day: number;
  origin: Origin;
  kind: Kind;
  path: string;
  n: number;
}

export interface VisitorRow {
  day: number;
  origin: Origin;
  visitor: string;
  /** lower case, '' when not logged in */
  login: string;
  n: number;
  last: number;
}

export interface UpstreamRow {
  day: number;
  source: Source;
  requests: number;
  failures: number;
  limited: number;
}

/** Add up rows that share a key. */
function merge<T extends { n: number; last?: number }>(rows: T[], keyOf: (r: T) => string): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const key = keyOf(r);
    const seen = out.get(key);
    if (!seen) out.set(key, { ...r });
    else {
      seen.n += r.n;
      if (seen.last !== undefined && r.last !== undefined) seen.last = Math.max(seen.last, r.last);
    }
  }
  return [...out.values()];
}

/** Requests per local day, origin, kind and route; a chart of a key nobody has becomes `/chart/[key]`. */
export function pathRows(hits: Hit[], tz: string, knownKey: (key: string) => boolean): PathRow[] {
  const route = (path: string) => (path.startsWith("/chart/") && path !== ANY_CHART && !knownKey(decodeURIComponent(path.slice(7))) ? ANY_CHART : path);
  return merge(
    hits.map((h) => ({ day: localDay(h.minute * 60, tz), origin: h.origin, kind: h.kind, path: route(h.path), n: h.n })),
    (r) => [r.day, r.origin, r.kind, r.path].join("\t"),
  );
}

/** Requests per local day, origin, visitor and login; sessions become logins. */
export function visitorRows(hits: Hit[], tz: string, loginOf: (session: string) => string): VisitorRow[] {
  return merge(
    hits.map((h) => ({ day: localDay(h.minute * 60, tz), origin: h.origin, visitor: h.visitor, login: loginOf(h.session), n: h.n, last: h.last })),
    (r) => [r.day, r.origin, r.visitor, r.login].join("\t"),
  );
}

/**
 * At most `max` distinct visitors per day and origin: those already stored keep their rows, new
 * ones are let in while there is room, and the rest are added to the `OTHER` row.
 */
export function capVisitors(rows: VisitorRow[], stored: (day: number, origin: Origin, visitor: string) => boolean, count: (day: number, origin: Origin) => number, max: number): VisitorRow[] {
  const admitted = new Set<string>();
  const counts = new Map<string, number>();
  const capped = rows.map((r) => {
    if (r.visitor === OTHER) return r;
    const day = `${r.day}\t${r.origin}`;
    const id = `${day}\t${r.visitor}`;
    if (admitted.has(id) || stored(r.day, r.origin, r.visitor)) return r;
    const n = counts.get(day) ?? count(r.day, r.origin);
    if (n >= max) return { ...r, visitor: OTHER };
    admitted.add(id);
    counts.set(day, n + 1);
    return r;
  });
  return merge(capped, (r) => [r.day, r.origin, r.visitor, r.login].join("\t"));
}

export function upstreamRows(hits: UpstreamHit[], tz: string): UpstreamRow[] {
  const rows = new Map<string, UpstreamRow>();
  for (const h of hits) {
    const day = localDay(h.minute * 60, tz);
    const key = `${day}\t${h.source}`;
    const row = rows.get(key) ?? { day, source: h.source, requests: 0, failures: 0, limited: 0 };
    row.requests += h.requests;
    row.failures += h.failures;
    row.limited += h.limited;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** The instance's days are those of `sync.tz`, like everything else on the page. */
function instanceConfig() {
  return readConfigSafe(vaultDir()).config;
}
const instanceTz = () => instanceConfig()?.sync.tz ?? "UTC";

/** Drain the counters into the tables; a batch that cannot be written goes back into the counters. */
export function flushUsage(): void {
  const batch = drainCounters();
  const { hits, upstream } = batch;
  if (!hits.length && !upstream.length) return;
  try {
    const tz = instanceTz();
    // one read of the sessions file however many cookies came in, made up ones included
    const sessions = hits.some((h) => h.session) ? liveSessions() : {};
    const loginOf = (session: string) => (session && Object.hasOwn(sessions, session) ? sessions[session].login.toLowerCase() : "");
    const db = getDb();
    // a chart path keeps its key when the instance knows it: a symbol it has, a watched row with
    // stats, or a benchmark some vault refers to (a synthetic one has no row of its own)
    const known = new Set((db.prepare("SELECT key FROM symbols UNION SELECT key FROM stats").all() as { key: string }[]).map((r) => r.key));
    for (const v of loadVaults()) for (const item of allItems(v.config)) if (item.bench) known.add(item.bench);
    const isStored = db.prepare("SELECT 1 FROM visitors WHERE day = ? AND origin = ? AND visitor = ? LIMIT 1").pluck();
    const countStored = db.prepare("SELECT COUNT(DISTINCT visitor) FROM visitors WHERE day = ? AND origin = ? AND visitor != ?").pluck();
    const addPath = db.prepare(
      `INSERT INTO traffic (day, origin, kind, path, n) VALUES (@day, @origin, @kind, @path, @n)
       ON CONFLICT (day, origin, kind, path) DO UPDATE SET n = n + @n`,
    );
    const addVisitor = db.prepare(
      `INSERT INTO visitors (day, origin, visitor, login, n, last) VALUES (@day, @origin, @visitor, @login, @n, @last)
       ON CONFLICT (day, origin, visitor, login) DO UPDATE SET n = n + @n, last = max(last, @last)`,
    );
    const addUpstream = db.prepare(
      `INSERT INTO upstream (day, source, requests, failures, limited) VALUES (@day, @source, @requests, @failures, @limited)
       ON CONFLICT (day, source) DO UPDATE SET requests = requests + @requests, failures = failures + @failures, limited = limited + @limited`,
    );
    db.transaction(() => {
      for (const r of pathRows(hits, tz, (key) => known.has(key))) addPath.run(r);
      const visitors = capVisitors(
        visitorRows(hits, tz, loginOf),
        (day, origin, visitor) => isStored.get(day, origin, visitor) !== undefined,
        (day, origin) => countStored.get(day, origin, OTHER) as number,
        MAX_VISITORS,
      );
      for (const r of visitors) addVisitor.run(r);
      for (const r of upstreamRows(upstream, tz)) addUpstream.run(r);
    })();
  } catch (err) {
    restoreCounters(batch);
    throw err;
  }
}

/** Rows from before the last `KEEP_DAYS` days go. */
export function pruneUsage(now = Date.now()): void {
  const cutoff = localDay(now / 1000, instanceTz()) - (KEEP_DAYS - 1) * DAY;
  const db = getDb();
  for (const table of ["traffic", "visitors", "upstream", "usage_alerts"]) db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff);
}

// ---------------------------------------------------------------------------- limits

export interface UsageCounts {
  visitors: number;
  limited: number;
}

export interface Passed {
  day: number;
  kind: keyof UsageLimits;
  value: number;
  limit: number;
}

/** Limits a day passed (strictly above), in the order they are listed. */
export function passedLimits(limits: UsageLimits, counts: UsageCounts, day: number): Passed[] {
  return (Object.keys(USAGE_LIMITS) as (keyof UsageLimits)[]).flatMap((kind) => {
    const limit = limits[kind];
    return limit !== null && counts[kind] > limit ? [{ day, kind, value: counts[kind], limit }] : [];
  });
}

const mmdd = (day: number) => new Date(day * 1000).toISOString().slice(5, 10);

export function usageMessage(passed: Passed[], today: number, link?: string): { title: string; text: string } {
  const title = "hebi8/market · 使用量提醒";
  const when = (day: number) => (day === today ? "今天" : day === today - DAY ? `昨天（${mmdd(day)}）` : mmdd(day));
  const lines = passed.map((p) => `• ${when(p.day)}${USAGE_LIMITS[p.kind].replace(/^每日/, "")} ${p.value}，超过 ${p.limit}`);
  return { title, text: [title, "", ...lines, ...(link ? ["", `${link}/usage`] : [])].join("\n") };
}

export function usageOn(day: number): UsageCounts {
  const db = getDb();
  const visitors = db.prepare("SELECT COUNT(DISTINCT visitor) FROM visitors WHERE day = ? AND origin = 'public' AND visitor != ?").pluck().get(day, OTHER) as number;
  const limited = db.prepare("SELECT coalesce(SUM(limited), 0) FROM upstream WHERE day = ?").pluck().get(day) as number;
  return { visitors, limited };
}

/**
 * Notify the owner of limits passed today or yesterday that have not been notified yet, so a limit
 * passed in the last minutes before midnight is still told after it. Only a delivery that reached
 * a channel counts; without a channel, or when every channel fails, the next check tries again.
 */
export async function checkLimits(now = Date.now()): Promise<Passed[]> {
  const cfg = instanceConfig();
  if (!cfg || (cfg.usage.visitors === null && cfg.usage.limited === null)) return [];
  const today = localDay(now / 1000, cfg.sync.tz);
  const days = [today - DAY, today];
  const db = getDb();
  const done = new Set((db.prepare("SELECT kind, day FROM usage_alerts WHERE day IN (?, ?)").all(...days) as { kind: string; day: number }[]).map((r) => `${r.kind}\t${r.day}`));
  const passed = days.flatMap((day) => passedLimits(cfg.usage, usageOn(day), day)).filter((p) => !done.has(`${p.kind}\t${p.day}`));
  if (!passed.length) return [];
  const { config, error } = channelsFor("", cfg.owner);
  if (error) log(`notify.json: ${error}`);
  log(passed.map((p) => `${mmdd(p.day)} ${p.kind} ${p.value} > ${p.limit}`).join(", "));
  if (channelNames(config).length === 0) {
    log("no notification channel configured, will try again");
    return passed;
  }
  const { title, text } = usageMessage(passed, today, config.link);
  const delivery = await deliver(config, title, text);
  for (const f of delivery.failed) log(`notify via ${f.channel} failed: ${f.error}`);
  if (delivery.sent.length) {
    const insert = db.prepare("INSERT OR IGNORE INTO usage_alerts (kind, day) VALUES (?, ?)");
    for (const p of passed) insert.run(p.kind, p.day);
  }
  return passed;
}

// ---------------------------------------------------------------------------- the page

export interface DayTraffic {
  day: number;
  requests: number;
  page: number;
  prefetch: number;
  action: number;
  api: number;
  publicVisitors: number;
  tailnetVisitors: number;
  /** 1 when the day hit `MAX_VISITORS` for that origin: the count is a floor */
  publicFull: number;
  tailnetFull: number;
  logins: number;
}

const EMPTY_DAY = { requests: 0, page: 0, prefetch: 0, action: 0, api: 0, publicVisitors: 0, tailnetVisitors: 0, publicFull: 0, tailnetFull: 0, logins: 0 };

/** The last `days` days up to `today`, newest first; a day without requests is all zeros. */
export function fillDays<T extends { day: number }>(rows: T[], today: number, days: number, empty: Omit<T, "day">): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => today - i * DAY).map((day) => byDay.get(day) ?? ({ ...empty, day } as T));
}

export function dailyTraffic(today: number, days: number): DayTraffic[] {
  const db = getDb();
  const from = today - days * DAY;
  const requests = db
    .prepare(
      `SELECT day, SUM(n) AS requests,
         coalesce(SUM(CASE WHEN kind = 'page' THEN n END), 0) AS page,
         coalesce(SUM(CASE WHEN kind = 'prefetch' THEN n END), 0) AS prefetch,
         coalesce(SUM(CASE WHEN kind = 'action' THEN n END), 0) AS action,
         coalesce(SUM(CASE WHEN kind = 'api' THEN n END), 0) AS api
       FROM traffic WHERE day > ? GROUP BY day`,
    )
    .all(from) as { day: number }[];
  const visitors = db
    .prepare(
      `SELECT day,
         COUNT(DISTINCT CASE WHEN origin = 'public' AND visitor != @other THEN visitor END) AS publicVisitors,
         COUNT(DISTINCT CASE WHEN origin = 'tailnet' AND visitor != @other THEN visitor END) AS tailnetVisitors,
         MAX(origin = 'public' AND visitor = @other) AS publicFull,
         MAX(origin = 'tailnet' AND visitor = @other) AS tailnetFull,
         COUNT(DISTINCT nullif(login, '')) AS logins
       FROM visitors WHERE day > @from GROUP BY day`,
    )
    .all({ from, other: OTHER }) as { day: number }[];
  const byDay = new Map(visitors.map((v) => [v.day, v]));
  const rows = requests.map((r) => ({ ...EMPTY_DAY, ...r, ...byDay.get(r.day) }) as DayTraffic);
  return fillDays(rows, today, days, EMPTY_DAY);
}

export interface PathCount {
  path: string;
  kind: Kind;
  requests: number;
}

/** A day's busiest paths; prefetches are the router warming links, not visits. */
export function topPaths(day: number, limit = 15): PathCount[] {
  return getDb()
    .prepare(`SELECT path, kind, SUM(n) AS requests FROM traffic WHERE day = ? AND kind != 'prefetch' GROUP BY path, kind ORDER BY requests DESC, path LIMIT ?`)
    .all(day, limit) as PathCount[];
}

export interface VisitorCount {
  visitor: string;
  origin: Origin;
  requests: number;
  days: number;
  /** logins seen with this visitor, comma separated, '' for none */
  logins: string;
  last: number;
}

export function topVisitors(today: number, days: number, limit = 15): VisitorCount[] {
  return getDb()
    .prepare(
      `SELECT visitor, origin, SUM(n) AS requests, COUNT(DISTINCT day) AS days,
         coalesce(group_concat(DISTINCT nullif(login, '')), '') AS logins, MAX(last) AS last
       FROM visitors WHERE day > ? GROUP BY visitor, origin ORDER BY requests DESC LIMIT ?`,
    )
    .all(today - days * DAY, limit) as VisitorCount[];
}

/** When each login last made a request (unix seconds), within the kept days. */
export function lastSeen(): Map<string, number> {
  const rows = getDb().prepare("SELECT login, MAX(last) AS last FROM visitors WHERE login != '' GROUP BY login").all() as { login: string; last: number }[];
  return new Map(rows.map((r) => [r.login, r.last]));
}

export function dailyUpstream(today: number, days: number): UpstreamRow[] {
  return getDb().prepare("SELECT day, source, requests, failures, limited FROM upstream WHERE day > ? ORDER BY day DESC, source").all(today - days * DAY) as UpstreamRow[];
}

/** Today in the instance's timezone, as unix seconds at UTC midnight. */
export const usageDay = (now = Date.now()) => localDay(now / 1000, instanceTz());

// ---------------------------------------------------------------------------- timer

interface State {
  started: boolean;
  pending: boolean;
  checking: boolean;
  checkedAt: number;
  prunedAt: number;
}

const g = globalThis as unknown as { hebi8mUsage?: State };
const state: State = (g.hebi8mUsage ??= { started: false, pending: false, checking: false, checkedAt: 0, prunedAt: 0 });

function tick(): void {
  const now = Date.now();
  try {
    flushUsage();
    if (now - state.prunedAt >= PRUNE_MS) {
      state.prunedAt = now;
      pruneUsage(now);
    }
  } catch (err) {
    log(`flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (state.checking || now - state.checkedAt < CHECK_MS) return;
  state.checking = true;
  state.checkedAt = now;
  checkLimits(now)
    .catch((err) => log(`limit check failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => (state.checking = false));
}

/** Started once per process from instrumentation, like the scheduler; a full buffer flushes early. */
export function startUsage(): void {
  if (state.started) return;
  state.started = true;
  onBufferFull(() => {
    if (state.pending) return;
    state.pending = true;
    setImmediate(() => {
      state.pending = false;
      tick();
    });
  });
  setInterval(tick, FLUSH_MS);
}
