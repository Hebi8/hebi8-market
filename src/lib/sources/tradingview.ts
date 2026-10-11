import TradingView, { type MarketInfos } from "@mathieuc/tradingview";
import { dedupeBars } from "../series";
import { tradingDay } from "../time";
import type { FetchResult, QuoteSession, SearchHit, SourceAdapter, SourceMeta, SourceProfile, SourceQuote } from "./types";

/** More bars than any symbol has (DJI since 1896 is ~33k): the server returns its whole history, no login needed. */
const RANGE = 100_000;
const TIMEOUT_MS = 30_000;

/** One websocket per sync run: charts open one after another and the client closes with the last. */
let shared: { client: InstanceType<typeof TradingView.Client>; users: number } | null = null;
let queue: Promise<unknown> = Promise.resolve();

function acquire() {
  shared ??= { client: new TradingView.Client(), users: 0 };
  shared.users++;
  return shared.client;
}

function release() {
  if (shared && --shared.users === 0) {
    const { client } = shared;
    shared = null;
    void client.end();
    // end() leaves a socket that is still connecting (a request that timed out during the handshake) open: close it once it connects
    if (!client.isOpen) client.onConnected(() => void client.end());
  }
}

/**
 * When a symbol trades, from its symbol info: the regular hours, the holidays and the days with
 * other hours (half days). The lists go back decades, and so do the earlier versions of the hours
 * (`A#20070312/B#…`); only last year's and later are kept, enough for the bars and countdowns
 * that still move.
 */
export function calendarOf(infos: MarketInfos, now = Date.now()): Pick<SourceMeta, "hours" | "holidays" | "corrections"> {
  const from = `${new Date(now).getUTCFullYear() - 1}0101`;
  const recent = (dates: string) => dates.split(",").filter((d) => d >= from).join(",");
  const corrections = infos.subsessions?.find((s) => s.id === infos.subsession_id)?.["session-correction"] ?? "";
  return {
    hours: infos.session
      ?.split("/")
      .filter((version) => (/#(\d{8})$/.exec(version)?.[1] ?? "99999999") >= from)
      .join("/"),
    holidays: recent(infos.session_holidays ?? ""),
    corrections: corrections
      .split(";")
      .map((entry) => [entry.slice(0, entry.lastIndexOf(":")), recent(entry.slice(entry.lastIndexOf(":") + 1))])
      .filter(([, dates]) => dates)
      .map((entry) => entry.join(":"))
      .join(";"),
  };
}

/**
 * The calendar of a symbol, read from its symbol info as soon as that arrives: what a Yahoo symbol
 * borrows from its exchange (calendar.ts). The library asks for bars with every symbol, so one
 * daily bar is requested along with it and not waited for.
 */
export function fetchCalendar(ticker: string): Promise<Pick<SourceMeta, "hours" | "holidays" | "corrections">> {
  return new Promise((resolve, reject) => {
    const client = acquire();
    const chart = new client.Session.Chart();
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const calendar = error ? null : calendarOf(chart.infos);
      try {
        chart.delete();
      } catch {
        // the session may already be gone after an error
      }
      release();
      if (calendar) resolve(calendar);
      else reject(error!);
    };
    const timer = setTimeout(() => finish(new Error(`TradingView timeout: ${ticker}`)), QUOTE_TIMEOUT_MS);
    chart.onError((...args) => finish(new Error(`TradingView: ${args.map(String).join(" ")}`)));
    chart.onSymbolLoaded(() => finish(null));
    chart.setMarket(ticker, { timeframe: "D", range: 1 });
  });
}

function fetchChart(ticker: string): Promise<FetchResult> {
  return new Promise<FetchResult>((resolve, reject) => {
    const client = acquire();
    const chart = new client.Session.Chart();
    let settled = false;

    const finish = (error: Error | null, result?: FetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        chart.delete();
      } catch {
        // the session may already be gone after an error
      }
      release();
      if (error) reject(error);
      else resolve(result!);
    };

    const timer = setTimeout(() => finish(new Error(`TradingView timeout: ${ticker}`)), TIMEOUT_MS);

    chart.onError((...args) => finish(new Error(`TradingView: ${args.map(String).join(" ")}`)));
    chart.onUpdate(() => {
      const periods = chart.periods;
      if (!periods?.length) return;
      const infos = chart.infos ?? {};
      const timeZone = infos.timezone ?? "UTC";
      const bars = periods.map((p) => ({
        t: tradingDay(p.time, timeZone),
        o: p.open,
        h: p.max,
        l: p.min,
        c: p.close,
        v: Number.isFinite(p.volume) ? p.volume : null,
        adj: 1,
      }));
      finish(null, {
        bars: dedupeBars(bars),
        meta: {
          name: infos.description,
          exchange: infos.exchange,
          currency: infos.currency_code,
          timezone: timeZone,
          kind: infos.type,
          ...calendarOf(infos),
        },
        mode: "replace",
      });
    });
    chart.setMarket(ticker, { timeframe: "D", range: RANGE, adjustment: "splits" });
  });
}

/** `current_session` as reported; anything else it reports (out_of_session, holiday) is closed. */
const SESSIONS: Record<string, QuoteSession> = { market: "open", pre_market: "pre", post_market: "post" };
const QUOTE_TIMEOUT_MS = 20_000;

/**
 * Fields of many symbols over the quote session of the (reverse-engineered) websocket: its own
 * client for one round, closed when every symbol has answered or the timeout hits. Whatever
 * arrived by then is returned.
 */
function quoteFields(tickers: string[], fields: string[]): Promise<Record<string, Record<string, unknown>>> {
  return new Promise((resolve) => {
    const client = new TradingView.Client();
    const session = new client.Session.Quote({ customFields: fields });
    const data: Record<string, Record<string, unknown>> = {};
    let pending = tickers.length;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.delete();
      void client.end();
      // end() leaves a socket that is still connecting (a handshake that timed out) open: close it once it connects
      if (!client.isOpen) client.onConnected(() => void client.end());
      resolve(data);
    };
    const timer = setTimeout(finish, QUOTE_TIMEOUT_MS);
    const done = () => {
      if (--pending === 0) finish();
    };

    for (const ticker of tickers) {
      const market = new session.Market(ticker);
      market.onData((d) => {
        data[ticker] = { ...data[ticker], ...d };
      });
      market.onLoaded(done);
      market.onError(done);
    }
  });
}

/** Latest prices; nothing at all is an error. */
async function fetchQuotes(tickers: string[]): Promise<Record<string, SourceQuote>> {
  const data = await quoteFields(tickers, ["lp", "lp_time", "open_price", "high_price", "low_price", "volume", "current_session"]);
  const out: Record<string, SourceQuote> = {};
  for (const [ticker, d] of Object.entries(data)) {
    const price = d.lp;
    if (typeof price !== "number" || !Number.isFinite(price)) continue;
    out[ticker] = {
      price,
      time: typeof d.lp_time === "number" ? d.lp_time : Math.floor(Date.now() / 1000),
      ...(typeof d.open_price === "number" ? { dayOpen: d.open_price } : {}),
      ...(typeof d.high_price === "number" ? { dayHigh: d.high_price } : {}),
      ...(typeof d.low_price === "number" ? { dayLow: d.low_price } : {}),
      // 0 (a CFD) and 1e100 (a yield) stand for no volume
      ...(typeof d.volume === "number" && d.volume > 0 && d.volume < 1e99 ? { dayVolume: d.volume } : {}),
      ...(typeof d.current_session === "string" ? { session: SESSIONS[d.current_session] ?? "closed" } : {}),
    };
  }
  if (Object.keys(out).length === 0 && tickers.length > 0) throw new Error("TradingView quote: no data");
  return out;
}

/** `type` is asked for along with the profile so that any symbol TradingView knows answers with something. */
const PROFILE_FIELDS = [
  "type",
  "lp",
  "business_description",
  "sector",
  "industry",
  "country",
  "number_of_employees",
  "web_site_url",
  "total_shares_outstanding",
  "earnings_per_share_diluted_ttm",
  "dividends_yield",
  "earnings_release_next_date",
  "issuer",
  "brand",
  "expense_ratio",
  "aum",
  "top_holdings",
];

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A stock's or fund's profile from its quote fields, as measured: a stock has the description,
 * sector, industry, country, employees, website, shares, EPS, yield and next earnings date; a fund
 * the description, issuer, expense ratio, assets and top holdings (its category and sector split
 * only come as ids, and its sector and industry are the placeholders every fund has); an index, a commodity, a yield, an FX pair, a coin or a future has none of
 * them. The yearly dividend per share is the yield TradingView shows, taken back to an amount
 * with the price that came with it. Percentages arrive as 8.3 for 8.3%.
 */
export function tvProfile(d: Record<string, unknown>): SourceProfile {
  const holdings = (Array.isArray(d.top_holdings) ? (d.top_holdings as { name?: unknown; symbol?: unknown; weight?: unknown }[]) : []).flatMap((h) =>
    text(h?.name) && positive(h.weight) ? [{ name: text(h.name)!, ...(text(h.symbol) ? { key: `tv:${text(h.symbol)}` } : {}), weight: h.weight / 100 }] : [],
  );
  const company = d.type !== "fund";
  return {
    ...(text(d.business_description) ? { description: text(d.business_description) } : {}),
    ...(company && text(d.sector) ? { sector: text(d.sector) } : {}),
    ...(company && text(d.industry) ? { industry: text(d.industry) } : {}),
    ...(text(d.country) ? { country: text(d.country) } : {}),
    ...(positive(d.number_of_employees) ? { employees: d.number_of_employees } : {}),
    ...(text(d.web_site_url) ? { website: text(d.web_site_url) } : {}),
    ...(positive(d.total_shares_outstanding) ? { shares: d.total_shares_outstanding } : {}),
    ...(typeof d.earnings_per_share_diluted_ttm === "number" ? { eps: d.earnings_per_share_diluted_ttm } : {}),
    ...(positive(d.dividends_yield) && positive(d.lp) ? { dividend: (d.dividends_yield / 100) * d.lp } : {}),
    ...(positive(d.earnings_release_next_date) ? { earningsAt: d.earnings_release_next_date } : {}),
    ...(text(d.issuer) ? { issuer: text(d.issuer) } : {}),
    // the issuer is the parent company (HSBC for the Tracker Fund): the brand is the name to go by
    ...(text(d.brand) ? { brand: text(d.brand) } : {}),
    // 0 is a ratio: some funds charge nothing
    ...(typeof d.expense_ratio === "number" && d.expense_ratio >= 0 ? { expenseRatio: d.expense_ratio / 100 } : {}),
    ...(positive(d.aum) ? { netAssets: d.aum } : {}),
    ...(holdings.length ? { holdings: holdings.slice(0, 10) } : {}),
  };
}

/** One result of TradingView's symbol search, as far as it is used here. */
export interface TvSymbol {
  symbol: string;
  description: string;
  type: string;
  exchange: string;
  prefix?: string;
  typespecs?: string[] | null;
  logoid?: string | null;
  /** Coins have their logo only here, under `logo.logoid`; FX pairs have a second one in `logoid2` */
  logo?: { logoid?: string } | null;
  source_logoid?: string | null;
}

/** A TradingView search result as a hit; the id is built the way `@mathieuc/tradingview` builds it. */
export function tvSearchHit(s: TvSymbol): SearchHit {
  const id = s.prefix ? `${s.prefix}:${s.symbol}` : `${s.exchange.split(" ")[0].toUpperCase()}:${s.symbol}`;
  return {
    key: `tv:${id}`,
    name: s.description,
    exchange: s.exchange,
    kind: s.type,
    typespecs: s.typespecs ?? undefined,
    logo: s.logo?.logoid ?? s.logoid ?? undefined,
    sourceLogo: s.source_logoid ?? undefined,
  };
}

/**
 * The symbol search the library's `searchMarketV3` calls, asked directly: the library drops the
 * logos and typespecs the search box shows. `EXCHANGE:SYMBOL` searches that exchange only.
 */
async function searchSymbols(query: string, filter: string): Promise<TvSymbol[]> {
  const parts = query.toUpperCase().split(":");
  const params = new URLSearchParams({ text: parts.pop()!, search_type: filter, hl: "0", lang: "en", domain: "production" });
  if (parts.length === 1) params.set("exchange", parts[0]);
  const res = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { origin: "https://www.tradingview.com" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`TradingView search ${res.status}`);
  return ((await res.json()) as { symbols: TvSymbol[] }).symbols;
}

/**
 * Unofficial TradingView websocket client, no login. Covers what Yahoo lacks:
 * indices (HSI:HSTECH), yields (TVC:US10Y), FX (FX_IDC:USDCNH), dollar index (TVC:DXY).
 */
export const tradingview: SourceAdapter = {
  fetchDaily(ticker) {
    const job = queue.then(() => fetchChart(ticker));
    queue = job.catch(() => undefined);
    return job;
  },

  quotes: fetchQuotes,

  /** A symbol that does not answer at all (unknown, or the websocket changed) is an error, kept on that symbol. */
  async profile(ticker) {
    const d = (await quoteFields([ticker], PROFILE_FIELDS))[ticker];
    if (!d) throw new Error(`TradingView profile: no data for ${ticker}`);
    return tvProfile(d);
  },

  async search(query, filter = "") {
    return (await searchSymbols(query, filter)).slice(0, 6).map(tvSearchHit);
  },
};
