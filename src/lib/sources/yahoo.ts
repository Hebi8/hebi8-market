import YahooFinance from "yahoo-finance2";
import { dedupeBars, type Bar } from "../series";
import { tradingDay } from "../time";
import { partsIn } from "../tz";
import { exchangeCalendar } from "./calendar";
import type { QuoteSession, SourceAdapter, SourceProfile, SourceQuote } from "./types";

const SESSIONS: Record<string, QuoteSession> = { REGULAR: "open", PRE: "pre", PREPRE: "pre", POST: "post", POSTPOST: "post", CLOSED: "closed" };

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/** A trading period as `HHMM-HHMM` on the exchange's clock. */
function clockHours(period: { start: Date; end: Date }, timeZone: string): string {
  const hhmm = (d: Date) => {
    const p = partsIn(d, timeZone);
    return `${String(p.hh).padStart(2, "0")}${String(p.mm).padStart(2, "0")}`;
  };
  return `${hhmm(period.start)}-${hhmm(period.end)}`;
}

/** The `quoteSummary` modules a profile is read from, as far as they are used; dates come as `Date`, or as sent when the result did not validate. */
export interface YahooSummary {
  assetProfile?: { longBusinessSummary?: string; description?: string; sector?: string; industry?: string; country?: string; fullTimeEmployees?: number; website?: string };
  summaryDetail?: { dividendRate?: number; trailingAnnualDividendRate?: number; totalAssets?: number; circulatingSupply?: number };
  defaultKeyStatistics?: { impliedSharesOutstanding?: number; sharesOutstanding?: number; trailingEps?: number };
  calendarEvents?: { earnings?: { earningsDate?: (Date | string | number)[] } };
  fundProfile?: { family?: string | null; categoryName?: string | null; feesExpensesInvestment?: { annualReportExpenseRatio?: number } };
  topHoldings?: { holdings?: { symbol?: string; holdingName?: string; holdingPercent?: number }[]; sectorWeightings?: Record<string, number>[] };
}

/** Yahoo's sector ids in a fund's split, as TradingView's Chinese site names the sectors */
const SECTORS: Record<string, string> = {
  technology: "科技",
  financial_services: "金融服务",
  healthcare: "医疗保健",
  consumer_cyclical: "周期性消费",
  consumer_defensive: "防御性消费",
  communication_services: "通信服务",
  industrials: "工业",
  energy: "能源",
  utilities: "公用事业",
  realestate: "房地产",
  basic_materials: "基础材料",
};

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A company's or fund's profile from `quoteSummary`. An index, an FX pair or a future has none of
 * these modules and comes out empty. Market cap, P/E and yield are left to the reader: only the
 * share count (the one Yahoo's own market cap uses; a coin's circulating supply), the trailing EPS
 * and the yearly dividend per share are kept.
 */
export function yahooProfile(r: YahooSummary): SourceProfile {
  const { assetProfile: asset, summaryDetail: detail, defaultKeyStatistics: stats, fundProfile: fund, topHoldings: top } = r;
  const earnings = r.calendarEvents?.earnings?.earningsDate?.[0];
  const earningsAt = earnings == null ? NaN : Math.floor(new Date(typeof earnings === "number" ? earnings * 1000 : earnings).getTime() / 1000);
  const shares = stats?.impliedSharesOutstanding ?? stats?.sharesOutstanding ?? detail?.circulatingSupply;
  const dividend = detail?.dividendRate ?? detail?.trailingAnnualDividendRate;
  const holdings = (top?.holdings ?? []).flatMap((h) => (text(h.holdingName) && positive(h.holdingPercent) ? [{ name: h.holdingName!.trim(), ...(text(h.symbol) ? { key: `yahoo:${h.symbol}` } : {}), weight: h.holdingPercent }] : []));
  const sectors = (top?.sectorWeightings ?? [])
    .flatMap((entry) => Object.entries(entry))
    .filter(([, weight]) => positive(weight))
    .map(([id, weight]) => ({ name: SECTORS[id] ?? id, weight }))
    .sort((a, b) => b.weight - a.weight);
  const description = text(asset?.longBusinessSummary) ?? text(asset?.description);
  return {
    ...(description ? { description } : {}),
    ...(text(asset?.sector) ? { sector: text(asset?.sector) } : {}),
    ...(text(asset?.industry) ? { industry: text(asset?.industry) } : {}),
    ...(text(asset?.country) ? { country: text(asset?.country) } : {}),
    ...(positive(asset?.fullTimeEmployees) ? { employees: asset.fullTimeEmployees } : {}),
    ...(text(asset?.website) ? { website: text(asset?.website) } : {}),
    ...(positive(shares) ? { shares } : {}),
    ...(typeof stats?.trailingEps === "number" ? { eps: stats.trailingEps } : {}),
    ...(positive(dividend) ? { dividend } : {}),
    ...(Number.isFinite(earningsAt) ? { earningsAt } : {}),
    ...(text(fund?.family) ? { issuer: text(fund?.family) } : {}),
    ...(text(fund?.categoryName) ? { category: text(fund?.categoryName) } : {}),
    ...(positive(fund?.feesExpensesInvestment?.annualReportExpenseRatio) ? { expenseRatio: fund.feesExpensesInvestment.annualReportExpenseRatio } : {}),
    ...(positive(detail?.totalAssets) ? { netAssets: detail.totalAssets } : {}),
    ...(holdings.length ? { holdings: holdings.slice(0, 10) } : {}),
    ...(sectors.length ? { sectors } : {}),
  };
}

/**
 * Full daily history. The chart endpoint's OHLC is already split-adjusted and is stored as is;
 * `adjclose / close` carries the dividend factor. Raw HTTP requests get 429, the library handles
 * the cookie/crumb dance.
 */
export const yahoo: SourceAdapter = {
  async fetchDaily(ticker) {
    const result = await yf.chart(ticker, { period1: new Date("1800-01-01"), interval: "1d" });
    const timeZone = result.meta.exchangeTimezoneName ?? "UTC";
    const bars: Bar[] = [];
    for (const q of result.quotes) {
      if (q.open == null || q.high == null || q.low == null || q.close == null || !q.close) continue;
      bars.push({
        t: tradingDay(q.date.getTime() / 1000, timeZone),
        o: q.open,
        h: q.high,
        l: q.low,
        c: q.close,
        v: q.volume ?? null,
        adj: q.adjclose != null ? q.adjclose / q.close : 1,
      });
    }
    const meta = result.meta;
    const calendar = await exchangeCalendar(meta.exchangeName);
    return {
      bars: dedupeBars(bars),
      meta: {
        name: meta.longName ?? meta.shortName,
        exchange: meta.fullExchangeName ?? meta.exchangeName,
        currency: meta.currency,
        timezone: timeZone,
        kind: meta.instrumentType?.toLowerCase(),
        ...(meta.currentTradingPeriod ? { hours: clockHours(meta.currentTradingPeriod.regular, timeZone) } : {}),
        ...calendar,
      },
      mode: "replace",
    };
  },

  /** One request for every ticker; Yahoo leaves out symbols it does not know. */
  async quotes(tickers) {
    const rows = await yf.quote(tickers, {
      return: "array",
      fields: ["symbol", "regularMarketPrice", "regularMarketTime", "regularMarketOpen", "regularMarketDayHigh", "regularMarketDayLow", "regularMarketVolume", "marketState", "quoteType"],
    });
    const out: Record<string, SourceQuote> = {};
    for (const q of rows) {
      if (q.regularMarketPrice == null || !q.regularMarketTime) continue;
      const session = q.quoteType === "CRYPTOCURRENCY" ? "always" : SESSIONS[q.marketState ?? ""];
      out[q.symbol] = {
        price: q.regularMarketPrice,
        time: Math.floor(q.regularMarketTime.getTime() / 1000),
        ...(q.regularMarketOpen != null ? { dayOpen: q.regularMarketOpen } : {}),
        ...(q.regularMarketDayHigh != null ? { dayHigh: q.regularMarketDayHigh } : {}),
        ...(q.regularMarketDayLow != null ? { dayLow: q.regularMarketDayLow } : {}),
        // FX reports 0: no volume, as in its daily bars
        ...(q.regularMarketVolume ? { dayVolume: q.regularMarketVolume } : {}),
        ...(session ? { session } : {}),
      };
    }
    return out;
  },

  /**
   * Not validated against the library's schema: Yahoo's fund modules drift from it (a mutual
   * fund's brokerage list), and a profile reads a few fields that are checked one by one.
   */
  async profile(ticker) {
    const modules = ["assetProfile", "summaryDetail", "defaultKeyStatistics", "calendarEvents", "fundProfile", "topHoldings"] as const;
    return yahooProfile((await yf.quoteSummary(ticker, { modules: [...modules] }, { validateResult: false })) as YahooSummary);
  },

  async search(query) {
    const result = await yf.search(query, { quotesCount: 8, newsCount: 0 });
    return result.quotes.flatMap((q) => {
      if (!q.isYahooFinance) return [];
      const name = q.longname ?? q.shortname ?? q.symbol;
      const kind = "quoteType" in q ? String(q.quoteType).toLowerCase() : undefined;
      return [{ key: `yahoo:${q.symbol}`, name, exchange: q.exchDisp ?? q.exchange, kind }];
    });
  },
};
