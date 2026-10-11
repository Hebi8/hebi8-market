import type { Bar } from "../series";

/** What the source knows about an instrument; stored as cache, never edited by the user. */
export interface SourceMeta {
  name?: string;
  exchange?: string;
  currency?: string;
  timezone?: string;
  kind?: string;
  /** The regular session by the exchange's clock, `HHMM-HHMM` (TradingView's notation, `1700-1600` runs overnight) or `24x7` */
  hours?: string;
  /** Days without trading (`20261126,20261225`) and days with other hours (`0930-1300:20261127;dayoff:20250109`), see `TradingCalendar` */
  holidays?: string;
  corrections?: string;
}

export interface FetchResult {
  /** Daily bars with the dividend factor in `adj` */
  bars: Bar[];
  meta: SourceMeta;
  /**
   * `replace`: the result is the full history and supersedes stored bars
   * (adjusted prices shift the whole history whenever a split lands).
   * `merge`: the result only covers recent bars and is upserted.
   */
  mode: "replace" | "merge";
}

export interface SearchHit {
  key: string;
  name: string;
  exchange?: string;
  kind?: string;
  /** TradingView's finer kinds, e.g. `cfd`, `etf`, `crypto` */
  typespecs?: string[];
  /** TradingView logo ids (`metal/copper`, `source/NYSE`), loaded by the browser from TV's logo CDN */
  logo?: string;
  sourceLogo?: string;
}

export type QuoteSession = "open" | "closed" | "pre" | "post" | "always";

/** The latest trade, for price alerts between daily syncs (§2.6). */
export interface Quote {
  price: number;
  /** When it traded, unix seconds */
  time: number;
  /** The trading day's open, high, low and volume as the source reports them, when it does */
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
  dayVolume?: number;
  session: QuoteSession;
}

/** A quote as an adapter returns it: the session is left out when the source does not say, and comes from the calendar then. */
export type SourceQuote = Omit<Quote, "session"> & { session?: QuoteSession };

/** One line of a fund's holdings or of its sector split */
export interface ProfileWeight {
  name: string;
  /** The holding's own key at this source (`yahoo:NVDA`), when the source names its symbol */
  key?: string;
  /** Share of the fund, 0.08 = 8% */
  weight: number;
}

/**
 * What an instrument is, as its source describes it (design §2.8): the facts that change slowly,
 * fetched once a week. Nothing in here follows the price: market cap, P/E and the dividend yield
 * are computed on read from `shares`, `eps`, `dividend` and the latest price. A field the source
 * does not have is left out.
 */
export interface SourceProfile {
  description?: string;
  sector?: string;
  industry?: string;
  country?: string;
  employees?: number;
  website?: string;
  /** Shares outstanding (a coin's circulating supply) */
  shares?: number;
  /** Diluted earnings per share over the last twelve months */
  eps?: number;
  /** Dividends per share in a year */
  dividend?: number;
  /** The next earnings report, unix seconds */
  earningsAt?: number;
  /** A fund: who runs it */
  issuer?: string;
  category?: string;
  /** A fund's yearly cost, 0.0009 = 0.09% */
  expenseRatio?: number;
  netAssets?: number;
  /** A fund's largest holdings, at most ten, and its split by sector */
  holdings?: ProfileWeight[];
  sectors?: ProfileWeight[];
}

export interface SourceAdapter {
  /** @param since time of the latest stored bar, for incremental sources */
  fetchDaily(ticker: string, since: number | null): Promise<FetchResult>;
  /** @param filter source-specific category, e.g. TradingView's `index` / `cfd` / `stock` / `bond` */
  search?(query: string, filter?: string): Promise<SearchHit[]>;
  /** Latest prices for many tickers in one request; tickers the source does not know are left out */
  quotes?(tickers: string[]): Promise<Record<string, SourceQuote>>;
  /** What the instrument is; `{}` when the source knows it but has nothing to say (an index, an FX pair) */
  profile?(ticker: string): Promise<SourceProfile>;
}
