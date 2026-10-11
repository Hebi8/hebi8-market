/**
 * Symbol search, pure: the local layer (watchlist, aliases, dictionary) runs in the browser on
 * every keystroke; the external layer (Yahoo / Binance / TradingView / datasets) is filtered, deduplicated
 * and ranked here after the route handler has fetched it.
 */
import type { SearchHit } from "./sources/types";
import { isSource, isSynthetic, isValidKey, parseKey, SOURCES, tickerOf, type Source } from "./symbols";
import { canonicalSynth, lexSynth, writeSynth, type SynthToken } from "./synth";
import { displayName, WELLKNOWN, wellKnown, wellKnownName } from "./wellknown";

export type SearchSource = "key" | "watchlist" | "alias" | "wellknown" | Source;

export interface SearchResult {
  key: string;
  name: string;
  exchange?: string;
  kind?: string;
  typespecs?: string[];
  /** TradingView logo ids of the instrument and its exchange, see `logoUrl` */
  logo?: string;
  sourceLogo?: string;
  source: SearchSource;
  /** Group name when the key is already watched */
  inWatchlist?: string;
  suggestedGroup: string;
}

export interface WatchEntry {
  key: string;
  name: string;
  ticker: string;
  group: string;
}

export interface SearchContext {
  watchlist: WatchEntry[];
  aliases: Record<string, string>;
  /** Group names in yaml order */
  groups: string[];
}

export const MAX_RESULTS = 12;

export const normalizeQuery = (q: string) => q.trim().replace(/\s+/g, " ");

export const isCJK = (q: string) => /[㐀-䶿一-鿿぀-ヿ가-힯]/.test(q);

/** Queries about rates keep TradingView's bond results; everything else drops them. */
export const looksLikeYield = (q: string) =>
  /^us\d{1,2}y$/i.test(q) || /\d{1,2}y$/i.test(q) || /收益率|国债|美债|利率|yield|bond|treasury/i.test(q);

/** TradingView is worth asking when Yahoo cannot (CJK), was told an exchange, or found little. */
export const needsTv = (q: string, yahooCount: number) => isCJK(q) || q.includes(":") || yahooCount < 3;

/** The query typed as a key or an alias (case-insensitive), normalized to the stored form. */
export function directKey(query: string, aliases: Record<string, string>): string | null {
  const q = normalizeQuery(query);
  if (!q) return null;
  const lower = q.toLowerCase();
  for (const [name, key] of Object.entries(aliases)) if (name.toLowerCase() === lower) return key;
  if (isSynthetic(q)) return isValidKey(q) ? q : null;
  const i = q.indexOf(":");
  if (i <= 0) return null;
  const source = q.slice(0, i).toLowerCase();
  // dataset ids are file names, so their case is kept
  const ticker = source === "data" ? q.slice(i + 1) : q.slice(i + 1).toUpperCase();
  if (!(SOURCES as readonly string[]).includes(source) || !ticker) return null;
  const key = `${source}:${ticker}`;
  return isValidKey(key) ? key : null;
}

// ---------------------------------------------------------------------------- expressions

/**
 * Typed as a spread (`AAPL/MSFT`, `2*(SPY-QQQ)`, `^GSPC/^DJI`) rather than one symbol: it starts
 * with `=`, or it has an operator. A hyphen with no spaces around it and nothing else
 * (`BRK-B`, `BTC-USD`) stays a ticker, and so does a dataset key (`data:gpu/4090-xianyu`).
 */
export function isExpression(query: string): boolean {
  const q = normalizeQuery(query);
  if (q.startsWith("=")) return true;
  if (/^data:\S*$/i.test(q)) return false;
  const tokens = lexSynth(q);
  const ops = tokens.filter((t) => t.type === "op");
  const hyphenated = ops.every((t) => t.text === "-" && /\S/.test(q[t.start - 1] ?? "") && /\S/.test(q[t.end] ?? "")) && !tokens.some((t) => t.type === "num");
  return ops.length > 0 && !hyphenated;
}

/**
 * The key an operand stands for, without looking at the watchlist: an alias or key as typed, a
 * dictionary code or name (`GOLD`, `BTC`, `SPX`, `黄金`), a TradingView id (`NASDAQ:AAPL`), a
 * `…USDT` pair on Binance, else the external search hit `hits` whose code is exactly the ticker
 * (`PLTR`). Null when none of these says (`腾讯` outside the dictionary, `XYZNOTEXIST`).
 */
export function resolveOperand(text: string, quoted: boolean, aliases: Record<string, string>, hits: SearchResult[] = []): string | null {
  if (quoted) return isValidKey(text) && !isSynthetic(text) ? text : null;
  const direct = directKey(text, aliases);
  if (direct) return isSynthetic(direct) ? null : direct;
  const lower = text.toLowerCase();
  // codes and names only: pinyin initials like `bp` are real tickers too
  const dict = WELLKNOWN.find((e) => e.zh === text || e.en?.toLowerCase() === lower || [...bareCodes(e.key), ...(e.codes ?? []).map((c) => c.toLowerCase())].includes(lower));
  if (dict) return dict.key;
  // TradingView's own spelling, `NASDAQ:AAPL`, moves to the preferred source like a TV search hit;
  // `data:gpu` is half a key whose rest the lexer split off, not an exchange
  if (/^[A-Za-z0-9_]+:[A-Za-z0-9_.!]+$/.test(text) && !hasSourcePrefix(text)) return canonicalKey(`tv:${text.toUpperCase()}`);
  if (/^[A-Za-z0-9]+USDT$/i.test(text)) return `binance:${text.toUpperCase()}`;
  return hits.find((h) => !isSynthetic(h.key) && bareCodes(h.key).includes(lower))?.key ?? null;
}

const hasSourcePrefix = (text: string) => text.includes(":") && isSource(text.slice(0, text.indexOf(":")).toLowerCase());

/** The key in `keys` that is the same spread as `key`, written either way (`=BTC/GOLD` for `=binance:BTCUSDT/tv:TVC:GOLD`). */
export function sameSpread(key: string, keys: string[], aliases: Record<string, string>): string | undefined {
  const canon = canonicalSynth(key, aliases);
  return keys.find((k) => isSynthetic(k) && canonicalSynth(k, aliases) === canon);
}

/** `insert` typed over the selection `start..end` of `text`: the new text and where the caret goes. */
export function insertText(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

export interface ExprOperand {
  text: string;
  /** Position in the query, quotes included */
  start: number;
  end: number;
  key: string | null;
  /** No key yet because its external search has not answered; the search box asks for it */
  pending: boolean;
}

export interface ExprAnalysis {
  operands: ExprOperand[];
  /** The operand the caret is in or touches: the search box suggests for it and replaces it */
  active: ExprOperand | null;
  /** `=…` with every operand a full key, when the whole expression parses */
  key: string | null;
  error: string | null;
}

/**
 * An expression as typed, at caret position `caret`; positions are the query's own. `hits` gives
 * the external search results for an operand's text, undefined while they have not arrived.
 */
export function analyzeExpression(query: string, caret: number, aliases: Record<string, string>, hits: (text: string) => SearchResult[] | undefined = () => undefined): ExprAnalysis {
  // the leading `=` becomes a space so positions stay put
  const tokens = lexSynth(query.replace(/^(\s*)=/, "$1 "));
  const operands: ExprOperand[] = tokens.flatMap((t) => {
    if (t.type !== "ref") return [];
    const found = hits(t.text);
    const key = resolveOperand(t.text, t.quoted, aliases, found);
    return [{ text: t.text, start: t.start, end: t.end, key, pending: !key && !t.quoted && !hasSourcePrefix(t.text) && found === undefined }];
  });
  const active = operands.find((o) => o.start <= caret && caret <= o.end) ?? null;
  const keys = new Map<SynthToken, string>();
  let ref = 0;
  for (const t of tokens) {
    if (t.type === "bad") return { operands, active, key: null, error: t.message };
    if (t.type !== "ref") continue;
    const { text, key, pending } = operands[ref++];
    if (key) keys.set(t, key);
    else if (pending) return { operands, active, key: null, error: `「${text}」搜索中…` };
    else if (hasSourcePrefix(text)) return { operands, active, key: null, error: `「${text}」不是完整的 key；代码里有 - 或 / 时整个 key 要加引号，如 "data:gpu/4090-xianyu"` };
    else return { operands, active, key: null, error: `「${text}」要从搜索结果里选一个标的` };
  }
  try {
    return { operands, active, key: writeSynth(tokens, (t) => keys.get(t)!, aliases), error: null };
  } catch (err) {
    return { operands, active, key: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------- groups

export type GroupLabel = "加密" | "港 A" | "宏观" | "比价" | "数据" | "美股";

const MACRO_KINDS = new Set(["index", "bond", "commodity", "forex", "cfd", "currency", "economic", "spot"]);
const MACRO_EXCHANGES = /^(TVC|FX_IDC|OANDA|FX|FOREXCOM|CAPITALCOM|ECONOMICS|CBOT|COMEX|NYMEX|ICEUS|CME):/;

/** Where a new symbol most likely belongs, from its key and what the source calls it. */
export function groupLabel(key: string, kind?: string): GroupLabel {
  if (isSynthetic(key)) return "比价";
  const { source, ticker } = parseKey(key);
  const k = kind?.toLowerCase();
  if (source === "data") return "数据";
  if (source === "binance" || k === "cryptocurrency" || k === "crypto") return "加密";
  if (/\.(HK|SS|SZ)$/i.test(ticker) || (source === "tv" && /^(SSE|SZSE|HKEX):/.test(ticker))) return "港 A";
  if (source === "tv" && MACRO_EXCHANGES.test(ticker)) return "宏观";
  if (k && MACRO_KINDS.has(k)) return "宏观";
  return "美股";
}

const GROUP_SYNONYMS: Record<GroupLabel, string[]> = {
  加密: ["加密", "币", "crypto", "coin"],
  "港 A": ["港a", "港股", "a股", "港", "中国", "hk", "china"],
  宏观: ["宏观", "指数", "商品", "macro", "index"],
  比价: ["比价", "合成", "spread", "ratio"],
  数据: ["数据", "data", "价格", "price", "自定义"],
  美股: ["美股", "美国", "us", "stock"],
};

const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** The existing group that matches a label, else the first group, else the label itself. */
export function suggestGroup(key: string, kind: string | undefined, groups: string[]): string {
  const label = groupLabel(key, kind);
  const exact = groups.find((g) => compact(g) === compact(label));
  if (exact) return exact;
  const words = GROUP_SYNONYMS[label];
  const fuzzy = groups.find((g) => words.some((w) => compact(g).includes(w)));
  return fuzzy ?? groups[0] ?? label;
}

// ---------------------------------------------------------------------------- row labels

/** A logo id from TradingView's search, as the URL of its icon on TV's CDN. */
export const logoUrl = (logo: string) => `https://s3-symbol-logo.tradingview.com/${logo}.svg`;

const KIND_LABELS: Record<string, string> = {
  stock: "股票",
  equity: "股票",
  etf: "ETF",
  fund: "基金",
  mutualfund: "基金",
  index: "指数",
  futures: "期货",
  future: "期货",
  crypto: "加密",
  cryptocurrency: "加密",
  forex: "外汇",
  currency: "外汇",
  bond: "债券",
  commodity: "商品",
  cfd: "CFD",
  dataset: "数据",
};

/** A source's kind in Chinese (`equity` → 股票); one without a label stays as the source wrote it. */
export const kindLabel = (kind: string) => KIND_LABELS[kind.toLowerCase()] ?? kind;

/**
 * The short type on a search row, as TradingView shows it: its typespecs first (`commodity` +
 * `cfd` is a CFD, an index CFD says so), then the kind, then what the key itself says.
 */
export function typeLabel(r: Pick<SearchResult, "key" | "kind" | "typespecs">): string | undefined {
  const kind = r.kind ? KIND_LABELS[r.kind.toLowerCase()] : undefined;
  if (r.typespecs?.includes("cfd")) return kind && kind !== "商品" && kind !== "CFD" ? `${kind} CFD` : "CFD";
  if (r.typespecs?.includes("crypto")) return "加密";
  if (r.typespecs?.includes("etf")) return "ETF";
  if (kind) return kind;
  if (isSynthetic(r.key)) return "比价";
  const { source, ticker } = parseKey(r.key);
  if (source === "data") return "数据";
  if (source === "binance") return "加密";
  if (source === "yahoo") {
    // Yahoo's own spelling: ^ indices, =F futures, =X currencies
    if (ticker.startsWith("^")) return "指数";
    if (ticker.endsWith("=F")) return "期货";
    if (ticker.endsWith("=X")) return "外汇";
  }
  return undefined;
}

type RowInfo = Pick<SearchResult, "exchange" | "sourceLogo" | "kind" | "typespecs" | "logo">;

const HOME_EXCHANGES: Record<string, string> = { HK: "HKEX", SS: "SSE", SZ: "SZSE" };

/**
 * What the key and the dictionary say about a symbol that no source has answered for: the
 * exchange (TradingView's prefix, Binance, the home market of `.HK/.SS/.SZ`) with TV's logo for
 * it, and the dictionary's type and logo; a Binance pair's coin logo follows TV's naming.
 */
export function keyInfo(key: string): RowInfo {
  const dict = wellKnown(key);
  const info: RowInfo = { kind: dict?.kind, typespecs: dict?.typespecs, logo: dict?.logo };
  if (isSynthetic(key)) return info;
  const { source, ticker } = parseKey(key);
  if (source === "binance") return { ...info, exchange: "Binance", sourceLogo: "source/BINANCE", logo: `crypto/XTVC${ticker.replace(/USDT$/, "")}` };
  const exchange = source === "tv" ? ticker.split(":")[0] : source === "yahoo" ? HOME_EXCHANGES[ticker.split(".").pop()!.toUpperCase()] : undefined;
  return exchange ? { ...info, exchange, sourceLogo: `source/${exchange}` } : info;
}

/** A row with what it lacks taken from `keyInfo`: the type as one, the exchange together with its logo. */
function withKeyInfo(r: SearchResult): SearchResult {
  const k = keyInfo(r.key);
  const type = r.kind || r.typespecs ? r : k;
  const place = r.sourceLogo || !k.sourceLogo ? r : k;
  return { ...r, kind: type.kind, typespecs: type.typespecs, logo: r.logo ?? k.logo, exchange: place.exchange, sourceLogo: place.sourceLogo };
}

// ---------------------------------------------------------------------------- matching

interface Fields {
  codes: string[];
  names: string[];
  other: string[];
}

/** 3 exact code, 2 code or name prefix, 1 anywhere, 0 no match. */
function matchScore(lower: string, f: Fields): number {
  const codes = f.codes.map((c) => c.toLowerCase());
  if (codes.some((c) => c === lower)) return 3;
  const names = f.names.map((n) => n.toLowerCase());
  if (codes.some((c) => c.startsWith(lower)) || names.some((n) => n.startsWith(lower))) return 2;
  if ([...codes, ...names, ...f.other.map((o) => o.toLowerCase())].some((s) => s.includes(lower))) return 1;
  return 0;
}

/** Codes a key answers to: its ticker with and without exchange/suffix decorations. */
function codesOf(key: string): string[] {
  const ticker = tickerOf(key);
  const out = new Set<string>([key, ticker]);
  const bare = ticker.replace(/^\^/, "").replace(/\.(HK|SS|SZ)$/i, "").replace(/^[A-Z_]+:/, "");
  out.add(bare);
  if (key.startsWith("data:")) out.add(ticker.slice(ticker.indexOf("/") + 1));
  if (/^0\d{3}$/.test(bare)) out.add(bare.replace(/^0+/, ""));
  return [...out];
}

function aliasNames(key: string, aliases: Record<string, string>): string[] {
  return Object.entries(aliases)
    .filter(([, k]) => k === key)
    .map(([name]) => name);
}

/**
 * Watched symbols, then aliases and dictionary entries that are not watched yet; each section is
 * sorted by match quality and keeps its original order otherwise. Runs on the client.
 */
export function localSearch(query: string, ctx: SearchContext): SearchResult[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const lower = q.toLowerCase();
  const watched = new Map(ctx.watchlist.map((w) => [w.key, w]));
  const out: SearchResult[] = [];

  const direct = directKey(q, ctx.aliases);
  if (direct) {
    const w = watched.get(direct);
    out.push({
      key: direct,
      name: w?.name ?? displayName(direct),
      source: "key",
      inWatchlist: w?.group,
      suggestedGroup: w?.group ?? suggestGroup(direct, undefined, ctx.groups),
    });
  }

  const scored = <T>(items: T[], score: (item: T) => number): T[] =>
    items
      .map((item, i) => ({ item, s: score(item), i }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.item);

  const watchHits = scored(ctx.watchlist, (w) => {
    const dict = wellKnown(w.key);
    return matchScore(lower, {
      codes: [...codesOf(w.key), ...aliasNames(w.key, ctx.aliases), ...(dict?.aliases ?? []), ...(dict?.codes ?? [])],
      names: [w.name, ...(dict ? [dict.zh, dict.en ?? ""] : [])],
      other: [w.group],
    });
  });
  for (const w of watchHits) {
    if (w.key === direct) continue;
    out.push({ key: w.key, name: w.name, source: "watchlist", inWatchlist: w.group, suggestedGroup: w.group });
  }

  const seen = new Set(out.map((r) => r.key));
  type Common = { key: string; name: string; source: "alias" | "wellknown"; fields: Fields; kind?: string };
  const common: Common[] = [];
  for (const [name, key] of Object.entries(ctx.aliases)) {
    if (watched.has(key) || common.some((c) => c.key === key)) continue;
    common.push({ key, name: displayName(key), source: "alias", fields: { codes: [name, ...codesOf(key)], names: [wellKnownName(key) ?? ""], other: [] } });
  }
  for (const e of WELLKNOWN) {
    if (watched.has(e.key)) continue;
    const existing = common.find((c) => c.key === e.key);
    const fields: Fields = { codes: [...codesOf(e.key), ...e.aliases, ...(e.codes ?? [])], names: [e.zh, e.en ?? ""], other: [] };
    if (existing) {
      existing.fields.codes.push(...fields.codes);
      existing.fields.names.push(...fields.names);
    } else common.push({ key: e.key, name: e.zh, source: "wellknown", fields });
  }
  for (const c of scored(common, (c) => matchScore(lower, c.fields))) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ key: c.key, name: c.name, source: c.source, suggestedGroup: suggestGroup(c.key, undefined, ctx.groups) });
  }
  return out;
}

// ---------------------------------------------------------------------------- external

export interface RawExternal {
  yahoo: SearchHit[];
  binance: SearchHit[];
  tv: SearchHit[];
  /** Series from the yaml's datasets, read from disk */
  data?: SearchHit[];
}

const YAHOO_DROP = new Set(["future", "option", "mutualfund", "money_market"]);
/** Listings whose dotted suffix is not a home market for this tool. */
const HOME_SUFFIX = /\.(HK|SS|SZ)$/i;

const companyName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|class [a-z]|the)\b\.?/g, "")
    .replace(/[^a-z0-9㐀-鿿]/g, "");

/** Keep real instruments on their home market; one row per company. */
export function filterYahoo(query: string, hits: SearchHit[]): SearchHit[] {
  const dotted = query.includes(".");
  const seen = new Set<string>();
  return hits.filter((h) => {
    const kind = h.kind?.toLowerCase();
    if (kind && YAHOO_DROP.has(kind)) return false;
    const ticker = tickerOf(h.key);
    if (!dotted && ticker.includes(".") && !HOME_SUFFIX.test(ticker)) return false;
    const company = companyName(h.name);
    if (company && kind === "equity") {
      if (seen.has(company)) return false;
      seen.add(company);
    }
    return true;
  });
}

const TV_DROP = new Set(["structured", "swap", "dr", "warrant", "right", "fundamental"]);
/** Data vendors whose series are noise here (short volume, fundamentals). */
const TV_DROP_EXCHANGES = /^(FINRA|QUANDL|FRED|ECONOMICS):/;
const TV_EXCHANGES = ["TVC", "HSI", "SSE", "SZSE", "HKEX", "NASDAQ", "NYSE", "BINANCE", "FX_IDC", "OANDA"];
const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "NYSEARCA", "BATS", "CBOE", "OTC"]);

export function tvExchangeRank(key: string): number {
  const ex = tickerOf(key).split(":")[0];
  const i = TV_EXCHANGES.indexOf(ex);
  return i < 0 ? TV_EXCHANGES.length : i;
}

/**
 * Stocks and ETFs on the big exchanges are better served by Yahoo (full history, dividends),
 * so their TradingView ids become Yahoo keys; Binance pairs become Binance keys.
 */
export function canonicalKey(key: string, kind?: string): string {
  const { source, ticker } = parseKey(key);
  if (source === "yahoo") {
    const m = /^([A-Z0-9]{2,10})-USD$/.exec(ticker);
    return m ? `binance:${m[1]}USDT` : key;
  }
  if (source !== "tv") return key;
  const [ex, sym] = ticker.split(":");
  if (!sym) return key;
  const k = kind?.toLowerCase();
  const stockish = k === undefined || k === "stock" || k === "fund" || k === "etf";
  if (ex === "BINANCE" && /USDT$/.test(sym)) return `binance:${sym}`;
  if (!stockish) return key;
  if (ex === "HKEX" && /^\d{1,5}$/.test(sym)) return `yahoo:${sym.padStart(4, "0")}.HK`;
  if (ex === "SSE" && /^\d{6}$/.test(sym)) return `yahoo:${sym}.SS`;
  if (ex === "SZSE" && /^\d{6}$/.test(sym)) return `yahoo:${sym}.SZ`;
  if (US_EXCHANGES.has(ex) && /^[A-Z0-9.]+$/.test(sym)) return `yahoo:${sym.replace(/\./g, "-")}`;
  return key;
}

/** Drop paper and derivatives, strip highlight markup, move stocks to their Yahoo key. */
export function filterTv(query: string, hits: SearchHit[]): SearchHit[] {
  const yieldQuery = looksLikeYield(query);
  const futuresQuery = /!|期货|futures?/i.test(query);
  const seen = new Set<string>();
  return hits.flatMap((h) => {
    const kind = h.kind?.toLowerCase();
    if (kind && TV_DROP.has(kind)) return [];
    if (TV_DROP_EXCHANGES.test(tickerOf(h.key))) return [];
    if (kind === "bond" && !yieldQuery) return [];
    if (kind === "futures" && !futuresQuery) return [];
    const key = canonicalKey(h.key, kind);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...h, key, name: h.name.replace(/<[^>]+>/g, "") }];
  });
}

const isMacro = (h: SearchHit) => {
  const k = h.kind?.toLowerCase();
  if (k && MACRO_KINDS.has(k)) return true;
  const { source, ticker } = parseKey(h.key);
  return source === "tv" && MACRO_EXCHANGES.test(ticker);
};
const isCrypto = (h: SearchHit) => parseKey(h.key).source === "binance" || /^crypto/.test(h.kind?.toLowerCase() ?? "");

function sourceScore(h: SearchHit): number {
  const { source, ticker } = parseKey(h.key);
  if (source === "data") return 60;
  if (isCrypto(h)) return source === "binance" ? 60 : 30;
  if (isMacro(h)) {
    if (source === "tv") return /^(TVC|HSI|FX_IDC|OANDA):/.test(ticker) ? 60 : 20;
    return 40;
  }
  if (source === "yahoo") return 60;
  if (source === "tv") return tvExchangeRank(h.key) < TV_EXCHANGES.length ? 30 : 10;
  return 20;
}

/** The ticker written the way people type it: no `^`, no exchange, no `.HK`, no `USDT`. */
function bareCodes(key: string): string[] {
  const codes = codesOf(key).map((c) => c.toLowerCase());
  const ticker = tickerOf(key).toLowerCase();
  if (parseKey(key).source === "binance" && ticker.endsWith("usdt")) codes.push(ticker.slice(0, -4));
  return codes;
}

/**
 * External hits merged, deduplicated and ranked: exact code > watched > dictionary > preferred
 * source for the kind of instrument > name prefix > the rest in arrival order.
 */
export function rankExternal(query: string, raw: RawExternal, ctx: SearchContext): SearchResult[] {
  const q = normalizeQuery(query);
  const lower = q.toLowerCase();
  const watched = new Map(ctx.watchlist.map((w) => [w.key, w]));
  const merged = [...(raw.data ?? []), ...raw.binance, ...filterYahoo(q, raw.yahoo), ...filterTv(q, raw.tv)].filter((h) => isValidKey(h.key));

  // one row per instrument: the preferred key wins, otherwise the first seen; logos it lacks come
  // from the others (Yahoo has none, TradingView's listing of the same stock does), the exchange
  // logo with the exchange name it belongs to
  const groups = new Map<string, SearchHit[]>();
  for (const h of merged) {
    const canon = canonicalKey(h.key, h.kind);
    const list = groups.get(canon);
    if (list) list.push(h);
    else groups.set(canon, [h]);
  }
  const unique = [...groups.entries()].map(([canon, list]) => {
    const h = list.find((x) => x.key === canon) ?? list[0];
    const logo = h.logo ?? list.find((x) => x.logo)?.logo;
    const source = h.sourceLogo ? h : list.find((x) => x.sourceLogo);
    return { ...h, logo, sourceLogo: source?.sourceLogo, exchange: source?.exchange ?? h.exchange };
  });

  return unique
    .map((h, i) => {
      const w = watched.get(h.key);
      const dict = wellKnown(h.key);
      const codes = bareCodes(h.key);
      const nameLower = h.name.toLowerCase();
      let score = 0;
      if (codes.includes(lower)) score += 1000;
      else if (codes.some((c) => c.startsWith(lower))) score += 100;
      if (w) score += 500;
      if (dict) score += 400;
      score += sourceScore(h);
      if (nameLower.startsWith(lower) || dict?.zh.startsWith(q)) score += 20;
      else if (nameLower.includes(lower)) score += 5;
      if (parseKey(h.key).source === "tv") score += TV_EXCHANGES.length - tvExchangeRank(h.key);
      const result: SearchResult = {
        key: h.key,
        name: w?.name ?? dict?.zh ?? h.name,
        exchange: h.exchange,
        kind: h.kind,
        typespecs: h.typespecs,
        logo: h.logo,
        sourceLogo: h.sourceLogo,
        source: parseKey(h.key).source,
        inWatchlist: w?.group,
        suggestedGroup: w?.group ?? suggestGroup(h.key, h.kind, ctx.groups),
      };
      return { result, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_RESULTS)
    .map((x) => x.result);
}

/**
 * Local rows first; external rows that repeat a local key are dropped, after lending it what the
 * source says about the instrument (exchange, type, logos). What no source said comes from the
 * key and the dictionary.
 */
export function mergeResults(local: SearchResult[], external: SearchResult[]): SearchResult[] {
  const byKey = new Map(external.map((r) => [r.key, r]));
  const seen = new Set(local.map((r) => r.key));
  const out = local.map((r) => {
    const e = byKey.get(r.key);
    if (!e) return r;
    const { exchange, kind, typespecs, logo, sourceLogo } = e;
    return { exchange, kind, typespecs, logo, sourceLogo, ...r };
  });
  for (const r of external) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out.slice(0, MAX_RESULTS + 2).map(withKeyInfo);
}
