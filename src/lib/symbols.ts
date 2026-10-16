export const SOURCES = ["yahoo", "binance", "tv", "data"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  yahoo: "Yahoo",
  binance: "Binance",
  tv: "TradingView",
  data: "数据集",
};

/** A dataset or series name: file-name safe, never `.` or `..`. */
export const DATA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `data:<dataset>/<series>`, case-sensitive. */
export const DATA_TICKER = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export type Timeframe = "D" | "3D" | "W" | "M" | "Q";
export const TIMEFRAMES: Timeframe[] = ["D", "3D", "W", "M", "Q"];
export const TF_LABELS: Record<Timeframe, string> = { D: "日", "3D": "3日", W: "周", M: "月", Q: "季" };

/** 「英伟达 NVDA · 周线」: the page title, and what a shared chart is called. */
export const chartTitle = (name: string, ticker: string, tf: Timeframe) => `${name === ticker ? ticker : `${name} ${ticker}`} · ${TF_LABELS[tf]}线`;

export function isSource(value: unknown): value is Source {
  return typeof value === "string" && (SOURCES as readonly string[]).includes(value);
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as string[]).includes(value);
}

/** `=BTC/GOLD`: computed from other symbols on read, never stored. */
export const isSynthetic = (key: string) => key.startsWith("=");

export function parseKey(key: string): { source: Source; ticker: string } {
  const i = key.indexOf(":");
  const source = key.slice(0, i);
  const ticker = key.slice(i + 1);
  if (i <= 0 || !isSource(source) || !ticker) throw new Error(`无效的标的 key「${key}」`);
  if (source === "data" && !DATA_TICKER.test(ticker)) throw new Error(`无效的数据集 key「${key}」，应为 data:数据集/序列`);
  return { source, ticker };
}

/** Keys are URL-encoded in links (`yahoo%3ASPY`, `%3DBTC%2FGOLD`); Next decodes most of it already. */
export function decodeChartKey(raw: string): string {
  try {
    return raw.includes("%") ? decodeURIComponent(raw) : raw;
  } catch {
    return raw;
  }
}

export function isValidKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  if (isSynthetic(key)) return key.length > 1;
  try {
    parseKey(key);
    return true;
  } catch {
    return false;
  }
}

/** The part after the source: `yahoo:0700.HK → 0700.HK`, `=BTC/GOLD → BTC/GOLD`. */
export function tickerOf(key: string): string {
  return isSynthetic(key) ? key.slice(1) : parseKey(key).ticker;
}

/** File name for a key: `tv:TVC:US10Y → tv_TVC_US10Y`, `=BTC/GOLD → expr_BTC_GOLD`. */
export function fileKey(key: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9.\-]/g, "_");
  return isSynthetic(key) ? `expr_${clean(key.slice(1))}` : clean(key);
}

/** Short stable hash (FNV-1a), appended to a file name when two keys sanitize alike. */
export function hash6(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}
