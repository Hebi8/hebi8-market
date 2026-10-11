import type { Source } from "../symbols";
import { countUpstream } from "../traffic";
import { binance } from "./binance";
import { dataset } from "./dataset";
import { tradingview } from "./tradingview";
import type { SourceAdapter } from "./types";
import { yahoo } from "./yahoo";

/**
 * Every call of the listed methods is counted per source and day (§1.7): requests, failures, and
 * which of those look rate limited. Methods left out count their own requests inside.
 */
function counted(source: Source, adapter: SourceAdapter, methods: ("search" | "quotes")[] = ["search", "quotes"]): SourceAdapter {
  const { fetchDaily, search, quotes, profile } = adapter;
  return {
    ...adapter,
    fetchDaily: (ticker, since) => countUpstream(source, () => fetchDaily.call(adapter, ticker, since)),
    ...(search && methods.includes("search") && { search: (query, filter) => countUpstream(source, () => search.call(adapter, query, filter)) }),
    ...(quotes && methods.includes("quotes") && { quotes: (tickers) => countUpstream(source, () => quotes.call(adapter, tickers)) }),
    ...(profile && { profile: (ticker) => countUpstream(source, () => profile.call(adapter, ticker)) }),
  };
}

export const adapters: Record<Source, SourceAdapter> = {
  yahoo: counted("yahoo", yahoo),
  // search reads a cached pair list; usdtBases() counts the fetch when there is one
  binance: counted("binance", binance, ["quotes"]),
  tv: counted("tv", tradingview),
  // reads files on disk (a profile is a line of the manifest); only the git fetch of a remote dataset is counted, in dataset.ts
  data: dataset,
};
