import { getDb } from "./db";
import type { Bar } from "./series";
import type { TradingCalendar } from "./session";
import type { Quote, QuoteSession, SourceMeta } from "./sources/types";
import type { Stats } from "./stats";
import { parseKey, type Source } from "./symbols";

/** Cache row: what the source told us plus sync state. Nothing user-editable lives here. */
export interface SymbolRow {
  key: string;
  source: Source;
  ticker: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  timezone: string | null;
  kind: string | null;
  /** The regular session on the exchange's clock, `HHMM-HHMM` or `24x7`, with the days without trading and the days with other hours (`TradingCalendar`) */
  hours: string | null;
  holidays: string | null;
  corrections: string | null;
  syncedAt: number | null;
  syncError: string | null;
  firstT: number | null;
  lastT: number | null;
}

interface RawRow {
  key: string;
  source: Source;
  ticker: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  timezone: string | null;
  kind: string | null;
  hours: string | null;
  holidays: string | null;
  corrections: string | null;
  synced_at: number | null;
  sync_error: string | null;
  first_t: number | null;
  last_t: number | null;
}

const toRow = (r: RawRow): SymbolRow => ({
  key: r.key,
  source: r.source,
  ticker: r.ticker,
  name: r.name,
  exchange: r.exchange,
  currency: r.currency,
  timezone: r.timezone,
  kind: r.kind,
  hours: r.hours,
  holidays: r.holidays,
  corrections: r.corrections,
  syncedAt: r.synced_at,
  syncError: r.sync_error,
  firstT: r.first_t,
  lastT: r.last_t,
});

/** A symbol's trading calendar as far as its source gave one; nulls for a symbol that is not cached. */
export const calendarOfRow = (row: SymbolRow | null | undefined): TradingCalendar => ({
  hours: row?.hours ?? null,
  timezone: row?.timezone ?? null,
  holidays: row?.holidays ?? null,
  corrections: row?.corrections ?? null,
});

export function getSymbol(key: string): SymbolRow | null {
  const row = getDb().prepare("SELECT * FROM symbols WHERE key = ?").get(key) as RawRow | undefined;
  return row ? toRow(row) : null;
}

export function listSymbols(): Record<string, SymbolRow> {
  const rows = getDb().prepare("SELECT * FROM symbols").all() as RawRow[];
  return Object.fromEntries(rows.map((r) => [r.key, toRow(r)]));
}

export function ensureSymbol(key: string): void {
  const { source, ticker } = parseKey(key);
  getDb().prepare("INSERT OR IGNORE INTO symbols (key, source, ticker) VALUES (?, ?, ?)").run(key, source, ticker);
}

export function readDaily(key: string): Bar[] {
  return getDb().prepare("SELECT t, o, h, l, c, v, adj FROM bars WHERE key = ? ORDER BY t").all(key) as Bar[];
}

export function latestBarTime(key: string): number | null {
  const row = getDb().prepare("SELECT max(t) AS t FROM bars WHERE key = ?").get(key) as { t: number | null };
  return row.t;
}

export function countBars(key: string): number {
  return (getDb().prepare("SELECT count(*) AS n FROM bars WHERE key = ?").get(key) as { n: number }).n;
}

/** The close of the latest stored bar as traded: split-adjusted, no dividend factor. */
export function lastClose(key: string): number | null {
  const row = getDb().prepare("SELECT c FROM bars WHERE key = ? ORDER BY t DESC LIMIT 1").get(key) as { c: number } | undefined;
  return row?.c ?? null;
}

export function writeBars(key: string, bars: Bar[], mode: "replace" | "merge"): void {
  const db = getDb();
  const insert = db.prepare("INSERT OR REPLACE INTO bars (key, t, o, h, l, c, v, adj) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    if (mode === "replace") db.prepare("DELETE FROM bars WHERE key = ?").run(key);
    for (const b of bars) insert.run(key, b.t, b.o, b.h, b.l, b.c, b.v, b.adj);
    db.prepare(
      "UPDATE symbols SET first_t = (SELECT min(t) FROM bars WHERE key = @key), last_t = (SELECT max(t) FROM bars WHERE key = @key) WHERE key = @key",
    ).run({ key });
  })();
}

export function markSynced(key: string, meta: SourceMeta): void {
  getDb()
    .prepare(
      `UPDATE symbols SET synced_at = @now, sync_error = NULL,
         name = coalesce(@name, name), exchange = coalesce(@exchange, exchange), currency = coalesce(@currency, currency),
         timezone = coalesce(@timezone, timezone), kind = coalesce(@kind, kind), hours = coalesce(@hours, hours),
         holidays = coalesce(@holidays, holidays), corrections = coalesce(@corrections, corrections)
       WHERE key = @key`,
    )
    .run({
      key,
      now: Date.now(),
      name: meta.name ?? null,
      exchange: meta.exchange ?? null,
      currency: meta.currency ?? null,
      timezone: meta.timezone ?? null,
      kind: meta.kind ?? null,
      hours: meta.hours ?? null,
      holidays: meta.holidays ?? null,
      corrections: meta.corrections ?? null,
    });
}

export function markSyncError(key: string, message: string): void {
  getDb().prepare("UPDATE symbols SET sync_error = ? WHERE key = ?").run(message, key);
}

/** Stats are per vault ('' = root): the watchlist and the prices mode are each person's own. */
export function writeStats(vault: string, key: string, stats: Stats | null): void {
  const db = getDb();
  if (!stats) db.prepare("DELETE FROM stats WHERE vault = ? AND key = ?").run(vault, key);
  else db.prepare("INSERT OR REPLACE INTO stats (vault, key, computed_at, json) VALUES (?, ?, ?, ?)").run(vault, key, Date.now(), JSON.stringify(stats));
}

export function readAllStats(vault: string): Record<string, Stats> {
  const rows = getDb().prepare("SELECT key, json FROM stats WHERE vault = ?").all(vault) as { key: string; json: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.json) as Stats]));
}

export function maxSyncedAt(): number | null {
  return (getDb().prepare("SELECT max(synced_at) AS t FROM symbols").get() as { t: number | null }).t;
}

export function hasBars(): boolean {
  return getDb().prepare("SELECT 1 FROM bars LIMIT 1").get() !== undefined;
}

export interface QuoteRow extends Quote {
  key: string;
  /** ms */
  fetchedAt: number;
}

export function writeQuotes(rows: QuoteRow[]): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO quotes (key, price, time, day_open, day_high, day_low, day_volume, session, fetched_at)
     VALUES (@key, @price, @time, @dayOpen, @dayHigh, @dayLow, @dayVolume, @session, @fetchedAt)`,
  );
  db.transaction(() => {
    for (const r of rows) upsert.run({ ...r, dayOpen: r.dayOpen ?? null, dayHigh: r.dayHigh ?? null, dayLow: r.dayLow ?? null, dayVolume: r.dayVolume ?? null });
  })();
}

export function readQuotes(): Record<string, QuoteRow> {
  const rows = getDb().prepare("SELECT * FROM quotes").all() as {
    key: string;
    price: number;
    time: number;
    day_open: number | null;
    day_high: number | null;
    day_low: number | null;
    day_volume: number | null;
    session: QuoteSession;
    fetched_at: number;
  }[];
  return Object.fromEntries(
    rows.map((r) => [
      r.key,
      {
        key: r.key,
        price: r.price,
        time: r.time,
        session: r.session,
        fetchedAt: r.fetched_at,
        ...(r.day_open !== null ? { dayOpen: r.day_open } : {}),
        ...(r.day_high !== null ? { dayHigh: r.day_high } : {}),
        ...(r.day_low !== null ? { dayLow: r.day_low } : {}),
        ...(r.day_volume !== null ? { dayVolume: r.day_volume } : {}),
      },
    ]),
  );
}
