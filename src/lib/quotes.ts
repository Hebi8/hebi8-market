/**
 * Intraday polling (design §2.6). Every 5 minutes the poller asks each source for the latest price
 * of every watched symbol, benchmark and alert symbol: open markets and crypto every round,
 * pre/post/closed ones hourly, new ones right away. The price goes to the `quotes` table; today's
 * unfinished daily bar is built from it in memory for the chart, the overview and the alerts,
 * never written to `bars`.
 */
import { compile } from "@/indicators/formula";
import type { SymbolStatus } from "./api-types";
import { runAlerts } from "./alerts";
import { loadDaily } from "./bars";
import { allItems, findItem, isLive, type Config } from "./config";
import type { Bar } from "./series";
import { QUOTE_ROUND_MS, QUOTE_SLOW_MS, quoteIsCurrent, scheduledSession, sessionStartsBetween, tradingDayAt, type TradingCalendar } from "./session";
import { adapters } from "./sources";
import type { Quote, QuoteSession } from "./sources/types";
import { computeStats, type Stats } from "./stats";
import { calendarOfRow, getSymbol, lastClose, listSymbols, readDaily, readQuotes, writeQuotes, type QuoteRow, type SymbolRow } from "./store";
import { isSynthetic, isValidKey, parseKey, type Source } from "./symbols";
import { parseSynth } from "./synth";
import { loadVaults, type VaultConfig } from "./sync";
import { localDay } from "./time";
import { readConfig, readConfigSafe, vaultDir } from "./vault";

export const ROUND_MS = QUOTE_ROUND_MS;
const SLOW_MS = QUOTE_SLOW_MS;
/** A timer that fires a little early still counts as the next round. */
const SLACK_MS = 30 * 1000;
/** Failures in a row before a source is only asked hourly. */
const BACKOFF_AFTER = 3;
const FAST: QuoteSession[] = ["open", "always"];
/**
 * Symbols per request, so a round stays a few requests per source however long the lists get:
 * Binance takes at most 100; Yahoo (one URL) and a TradingView quote session answer 150 in about a
 * second.
 */
const CHUNK = 100;

/** Today's first price and the extremes polling has seen */
interface Intraday {
  t: number;
  o: number;
  h: number;
  l: number;
}

/** A vault's overview stats on today's live bars, as long as `stamp` (quotes, syncs, the list) stays the same */
interface LiveCache {
  stamp: string;
  rows: Record<string, { stats: Stats; quotedAt: number }>;
}

interface State {
  started: boolean;
  /** When each key was last asked for, and the session it reported */
  seen: Map<string, { at: number; session: QuoteSession }>;
  failures: Map<Source, { count: number; until: number }>;
  /** Today's first price and the extremes seen by polling, per key */
  intraday: Map<string, Intraday>;
  live: Map<string, LiveCache>;
}

const g = globalThis as unknown as { hebi8mQuotes?: State };
const state: State = (g.hebi8mQuotes ??= { started: false, seen: new Map(), failures: new Map(), intraday: new Map(), live: new Map() });

const log = (msg: string) => console.log(`[hebi8m] quotes: ${msg}`);

/**
 * The real keys a round asks for: every watched symbol and its benchmark, and what enabled alerts
 * judged on the price read (synthetic ones expanded into their operands). `data:` only has daily bars.
 */
export function quoteKeys(configs: Config[]): string[] {
  const keys = new Set<string>();
  for (const cfg of configs) {
    const add = (key: string) => {
      if (!isValidKey(key)) return;
      if (isSynthetic(key)) {
        try {
          parseSynth(key.slice(1), cfg.aliases).keys.forEach(add);
        } catch {
          // reported where the symbol is shown
        }
      } else if (parseKey(key).source !== "data") keys.add(key);
    };
    for (const item of allItems(cfg)) {
      add(item.key);
      if (item.bench) add(item.bench);
    }
    for (const alert of cfg.alerts) {
      // one judged at the close reads daily bars only
      if (!isLive(alert) || alert.check !== "price") continue;
      // on the whole watchlist: the watched symbols and their benchmarks are in already
      if (alert.key) add(alert.key);
      if (!alert.when) continue;
      try {
        compile(alert.when, { aliases: cfg.aliases, bench: alert.key ? (findItem(cfg, alert.key)?.bench ?? null) : undefined }).refs.forEach(add);
      } catch {
        // a broken formula is reported by the alert itself
      }
    }
  }
  return [...keys];
}

/**
 * Which keys a round fetches: never asked → now; open or always → every round; otherwise hourly,
 * and as soon as one of the symbol's sessions has begun since it was last asked (the open after
 * the pre-market, the end of a lunch break).
 */
export function dueKeys(keys: string[], seen: State["seen"], now: number, calendarOf: (key: string) => TradingCalendar): string[] {
  return keys.filter((key) => {
    const last = seen.get(key);
    if (!last) return true;
    if (now - last.at >= (FAST.includes(last.session) ? ROUND_MS : SLOW_MS) - SLACK_MS) return true;
    return !FAST.includes(last.session) && sessionStartsBetween(last.at, now, calendarOf(key));
  });
}

/**
 * The trading day a quote belongs to: the UTC day around the clock, the day of its session for a
 * TradingView symbol (`tradingDayAt`: an evening session is the next day's, as in the daily bars,
 * and a print after Friday's close stays on Friday), the exchange's calendar day otherwise (Yahoo's
 * daily bars are calendar days) and while the hours are not known.
 */
function quoteDay(key: string, q: Pick<Quote, "time" | "session">, timeZone: string, calendar?: TradingCalendar): number {
  if (q.session === "always") return localDay(q.time, "UTC");
  if (!calendar?.hours || parseKey(key).source !== "tv") return localDay(q.time, timeZone);
  const day = tradingDayAt(q.time * 1000, calendar);
  return Date.UTC(day.y, day.m - 1, day.d) / 1000;
}

/**
 * The trading day a quote extends or adds after a last bar at `lastT`, or null when it is not
 * taken: not newer than the last daily sync (the synced bar wins), or on a day before the last bar.
 */
export function quoteDayIn(lastT: number | null | undefined, quote: QuoteRow, timeZone: string, syncedAt: number | null, calendar?: TradingCalendar): number | null {
  if (syncedAt !== null && quote.fetchedAt <= syncedAt) return null;
  const t = quoteDay(quote.key, quote, timeZone, calendar);
  return lastT != null && t < lastT ? null : t;
}

/**
 * Daily bars with today's unfinished bar from the quote: merged into the last bar when it is the
 * same trading day, appended when it is a new one. A quote older than the last daily sync is
 * ignored, the synced bar is newer. Memory only.
 */
export function withQuote(bars: Bar[], quote: QuoteRow | undefined, timeZone: string, syncedAt: number | null, seen?: Intraday, calendar?: TradingCalendar): Bar[] {
  if (!quote) return bars;
  const last = bars.at(-1);
  const t = quoteDayIn(last?.t, quote, timeZone, syncedAt, calendar);
  if (t === null) return bars;
  const same = last?.t === t ? last : null;
  const ownDay = seen?.t === t ? seen : null;
  const highs = [quote.price, quote.dayHigh, same?.h, ownDay?.h].filter((v): v is number => v !== undefined);
  const lows = [quote.price, quote.dayLow, same?.l, ownDay?.l].filter((v): v is number => v !== undefined);
  // the day's volume only grows: a quote that lags behind the synced bar does not take it back
  const volumes = [quote.dayVolume, same?.v].filter((v): v is number => v != null);
  const o = quote.dayOpen ?? same?.o ?? ownDay?.o ?? quote.price;
  const bar: Bar = { t, o, h: Math.max(o, ...highs), l: Math.min(o, ...lows), c: quote.price, v: volumes.length > 0 ? Math.max(...volumes) : null, adj: 1 };
  return same ? [...bars.slice(0, -1), bar] : [...bars, bar];
}

/** The daily reader for judging alerts between syncs, and for the chart and the overview. */
export function liveReader(quotes = readQuotes()): (key: string) => Bar[] {
  return (key) => {
    const meta = getSymbol(key);
    return withQuote(readDaily(key), quotes[key], meta?.timezone ?? "UTC", meta?.syncedAt ?? null, state.intraday.get(key), calendarOfRow(meta));
  };
}

function remember(key: string, q: Quote, timeZone: string, calendar: TradingCalendar): void {
  const t = quoteDay(key, q, timeZone, calendar);
  const day = state.intraday.get(key);
  if (day?.t === t) state.intraday.set(key, { t, o: day.o, h: Math.max(day.h, q.price), l: Math.min(day.l, q.price) });
  else state.intraday.set(key, { t, o: q.price, h: q.price, l: q.price });
}

/**
 * Ask one source for its due keys, `CHUNK` per request. Failures back off to hourly after a few
 * rounds in a row without any answer and are logged once; the keys of a request that failed are
 * due again next round.
 */
async function fetchSource(source: Source, keys: string[], now: number): Promise<QuoteRow[]> {
  const fetchQuotes = adapters[source].quotes;
  if (!fetchQuotes) return [];
  const fail = state.failures.get(source);
  if (fail && fail.until > now) return [];
  const chunks: Map<string, string>[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) chunks.push(new Map(keys.slice(i, i + CHUNK).map((k) => [parseKey(k).ticker, k])));
  const answers = await Promise.allSettled(chunks.map((byTicker) => fetchQuotes([...byTicker.keys()])));
  // when the answers arrived, not when the round began: a daily sync that ended in between is older
  const receivedAt = Date.now();
  const failed = answers.find((a) => a.status === "rejected");
  if (answers.every((a) => a.status === "rejected")) {
    const count = (fail?.count ?? 0) + 1;
    state.failures.set(source, { count, until: count >= BACKOFF_AFTER ? now + SLOW_MS : 0 });
    if (count === BACKOFF_AFTER) log(`${source} failed ${count} times in a row, asking hourly: ${failed!.reason instanceof Error ? failed!.reason.message : String(failed!.reason)}`);
    return [];
  }
  if (fail && fail.count >= BACKOFF_AFTER) log(`${source} answers again`);
  state.failures.delete(source);
  const rows: QuoteRow[] = [];
  answers.forEach((answer, i) => {
    if (answer.status === "rejected") return;
    for (const [ticker, key] of chunks[i]) {
      const sent = answer.value[ticker];
      const meta = getSymbol(key);
      // a source that does not report the session: open on a trading day of the symbol's calendar
      const q = sent && { ...sent, session: sent.session ?? scheduledSession(receivedAt, calendarOfRow(meta)) };
      // a symbol the source left out is asked again with the slow ones
      state.seen.set(key, { at: now, session: q?.session ?? "closed" });
      if (!q) continue;
      remember(key, q, meta?.timezone ?? "UTC", calendarOfRow(meta));
      rows.push({ key, ...q, fetchedAt: receivedAt });
    }
  });
  return rows;
}

/** One round: fetch what is due, store it, then judge every vault's alerts on the live bars and have its overview stats ready. */
export async function quoteRound(now = Date.now(), vaults: VaultConfig[] = loadVaults()): Promise<QuoteRow[]> {
  if (state.seen.size === 0) {
    // after a restart the table says what was asked when, so nothing is fetched twice at once
    for (const q of Object.values(readQuotes())) state.seen.set(q.key, { at: q.fetchedAt, session: q.session });
  }
  const symbols = listSymbols();
  const due = dueKeys(quoteKeys(vaults.map((v) => v.config)), state.seen, now, (key) => calendarOfRow(symbols[key]));
  const bySource = new Map<Source, string[]>();
  for (const key of due) {
    const source = parseKey(key).source;
    bySource.set(source, [...(bySource.get(source) ?? []), key]);
  }
  const rows = (await Promise.all([...bySource].map(([source, keys]) => fetchSource(source, keys, now)))).flat();
  if (rows.length === 0) return rows;
  writeQuotes(rows);
  const read = liveReader();
  for (const v of vaults) await runAlerts(v, () => readConfig(v.dir), "quotes", read);
  for (const id of state.live.keys()) if (!vaults.some((v) => v.id === id)) state.live.delete(id);
  for (const v of vaults) liveStats(v.id, v.config);
  return rows;
}

/** Started once per process from instrumentation, like the daily scheduler. */
export function startQuotes(): void {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      // a broken root yaml waits for the fix; the page reports it
      if (readConfigSafe(vaultDir()).config) await quoteRound();
    } catch (err) {
      log(`round failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  setTimeout(() => void tick(), 15_000);
  setInterval(() => void tick(), ROUND_MS);
}

/** Forget what was polled (tests). */
export function resetQuotes(): void {
  state.seen.clear();
  state.failures.clear();
  state.intraday.clear();
  state.live.clear();
}

/** A real key's quote where `withQuote` takes it (`quoteDayIn`), judged from the symbol's row alone. */
function takenQuote(quote: QuoteRow | undefined, meta: SymbolRow | null | undefined): QuoteRow | null {
  return quote && quoteDayIn(meta?.lastT, quote, meta?.timezone ?? "UTC", meta?.syncedAt ?? null, calendarOfRow(meta)) !== null ? quote : null;
}

/**
 * The latest price of a real key as it trades: the quote where `withQuote` takes it, else the last
 * daily close, never with the dividend factor a `prices: total` chart applies. What market cap,
 * P/E and yield are computed with (§2.8); null for a key without bars, a synthetic one included.
 */
export function tradedPrice(key: string, quotes = readQuotes()): number | null {
  return takenQuote(quotes[key], getSymbol(key))?.price ?? lastClose(key);
}

/** The oldest quote among the ones a key's price comes from: its own, or for a synthetic key its operands'. */
function quotedAt(key: string, aliases: Record<string, string>, quotes: Record<string, QuoteRow>, symbols: (key: string) => SymbolRow | null | undefined): number | null {
  const keys = isSynthetic(key) ? parseSynth(key.slice(1), aliases).keys : [key];
  const taken = keys.flatMap((k) => takenQuote(quotes[k], symbols(k))?.fetchedAt ?? []);
  return taken.length > 0 ? Math.min(...taken) : null;
}

/**
 * The chart's status strip: sync time and error, the last quote, and its session until the round
 * after next is overdue. A synthetic key has no sync or session of its own: it is as fresh as the
 * oldest quote its operands' prices come from.
 */
export function symbolStatus(key: string, aliases: Record<string, string> = {}, quotes = readQuotes()): SymbolStatus {
  if (isSynthetic(key)) return { syncedAt: null, syncError: null, quotedAt: quotedAt(key, aliases, quotes, getSymbol), session: null };
  const row = getSymbol(key);
  const quote = quotes[key];
  return { syncedAt: row?.syncedAt ?? null, syncError: row?.syncError ?? null, quotedAt: quote?.fetchedAt ?? null, session: currentSession(quote) };
}

/** A quote's session while polling keeps it current. */
function currentSession(quote: QuoteRow | undefined): QuoteSession | null {
  return quote && quoteIsCurrent(quote.session, quote.fetchedAt, Date.now()) ? quote.session : null;
}

/**
 * The overview's rows whose price comes from a quote (their own, or for a synthetic row an
 * operand's), wherever `withQuote` takes it: stats from today's live bar, so the price and the
 * changes match the chart and the alerts. Never stored: computed once after each quote round or
 * sync and kept in memory per vault, so a page view reads no bars. `status.session` is only set
 * while the quote is current; a synthetic row has none.
 */
export function liveStats(vault: string, cfg: Config, symbols = listSymbols()): Record<string, { stats: Stats; status: SymbolStatus }> {
  const quotes = readQuotes();
  const keys = allItems(cfg).map((i) => i.key);
  const newest = (values: (number | null)[]) => Math.max(0, ...values.map((v) => v ?? 0));
  const stamp = JSON.stringify([newest(Object.values(quotes).map((q) => q.fetchedAt)), newest(Object.values(symbols).map((s) => s.syncedAt)), cfg.prices, keys, cfg.aliases]);
  let cache = state.live.get(vault);
  if (cache?.stamp !== stamp) {
    const read = liveReader(quotes);
    cache = { stamp, rows: {} };
    for (const key of keys) {
      const at = quotedAt(key, cfg.aliases, quotes, (k) => symbols[k]);
      if (at === null) continue;
      const stats = computeStats(loadDaily(key, cfg.prices, cfg, read), { currency: symbols[key]?.currency ?? null });
      if (stats) cache.rows[key] = { stats, quotedAt: at };
    }
    state.live.set(vault, cache);
  }
  return Object.fromEntries(
    Object.entries(cache.rows).map(([key, { stats, quotedAt }]) => {
      const row = symbols[key];
      return [key, { stats, status: { syncedAt: row?.syncedAt ?? null, syncError: row?.syncError ?? null, quotedAt, session: isSynthetic(key) ? null : currentSession(quotes[key]) } }];
    }),
  );
}
