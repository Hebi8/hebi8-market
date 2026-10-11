/**
 * Where to read more about a symbol (design §2.8): the 相关链接 of the 商品详情 panel and of
 * `get_profile`. Computed on read from the key, the cached metadata and the stored profile; no
 * request is made and nothing is stored. Three kinds, in this order: what the source itself names
 * (the website), what a rule builds from the listing (the fund issuer's page, the exchange's or
 * regulator's filings), and a hand-kept table of official pages for things without a company
 * behind them (yields, currencies, commodities, indices, coins). The source's own quote page
 * comes last, so every real symbol has at least one.
 *
 * Every URL and every rule here was opened and read before it went in (2026-10-11). Add one the
 * same way: a page that 404s, lands on a search or redirects to a home page does not belong.
 */
import type { SourceProfile } from "./sources/types";

export interface ProfileLink {
  /** What the page is, in Chinese */
  label: string;
  url: string;
}

export interface LinkInput {
  key: string;
  /** `symbols.kind` and `symbols.exchange`, as the source reported them */
  kind: string | null;
  exchange: string | null;
  profile: SourceProfile | null;
  /** A `data:` key's dataset, when it is a repository anyone can open */
  repo?: string | null;
}

/** The host a link shows next to its label; null for anything that is not http(s). */
export function linkHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- where it is listed

type Market = "us" | "hk" | "sh" | "sz" | "jp";

interface Listing {
  market: Market;
  /** The code as that market's own sites write it: `NVDA`, `BRK-B`, `700`, `600519` */
  code: string;
}

const YAHOO_SUFFIX: Record<string, Market> = { HK: "hk", SS: "sh", SZ: "sz", T: "jp" };
const TV_EXCHANGE: Record<string, Market> = { NASDAQ: "us", NYSE: "us", AMEX: "us", HKEX: "hk", SSE: "sh", SZSE: "sz", TSE: "jp" };
/** Yahoo's names for the US exchanges; its OTC names are left out (an unsponsored ADR files nothing) */
const YAHOO_US = /^(nasdaq|nyse|cboe)/i;

function listingOf(source: string, ticker: string, exchange: string | null): Listing | null {
  if (source === "yahoo") {
    const dot = /^([A-Z0-9]+)\.([A-Z]+)$/.exec(ticker);
    if (dot) return YAHOO_SUFFIX[dot[2]] ? { market: YAHOO_SUFFIX[dot[2]], code: dot[2] === "HK" ? dot[1].replace(/^0+/, "") : dot[1] } : null;
    return /^[A-Z][A-Z0-9-]*$/.test(ticker) && exchange && YAHOO_US.test(exchange) ? { market: "us", code: ticker } : null;
  }
  if (source === "tv") {
    const [prefix, symbol] = ticker.split(":");
    const market = TV_EXCHANGE[prefix];
    // TradingView writes a share class with a dot, the SEC with a dash
    return market && symbol ? { market, code: market === "us" ? symbol.replace(".", "-") : symbol } : null;
  }
  return null;
}

const STOCK_KINDS = new Set(["equity", "stock"]);
const FUND_KINDS = new Set(["etf", "fund", "mutualfund"]);

/**
 * The filings of a listed company at its exchange or regulator, where a page opens by code.
 * EDGAR finds exchange-listed companies by ticker but not most ETFs (VOO, IVV, TLT: no match), so
 * funds are left to their issuer. Shanghai and Shenzhen go by the stock code ranges: Yahoo calls
 * their ETFs equities too. Tokyo has no page that opens by code.
 */
function filings(listing: Listing, kind: string): ProfileLink[] {
  const { market, code } = listing;
  const stock = STOCK_KINDS.has(kind);
  if (market === "us" && stock) return [{ label: "SEC EDGAR 公告", url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${code}` }];
  if (market === "hk" && stock) return [{ label: "港交所 · 行情与公告", url: `https://www.hkex.com.hk/Market-Data/Securities-Prices/Equities/Equities-Quote?sym=${code}&sc_lang=zh-HK` }];
  if (market === "hk" && FUND_KINDS.has(kind)) return [{ label: "港交所 · ETF 资料", url: `https://www.hkex.com.hk/Market-Data/Securities-Prices/Exchange-Traded-Products/Exchange-Traded-Products-Quote?sym=${code}&sc_lang=zh-HK` }];
  if (market === "sh" && /^6[08]\d{4}$/.test(code)) return [{ label: "上交所 · 公司公告", url: `https://www.sse.com.cn/assortment/stock/list/info/announcement/index.shtml?productId=${code}` }];
  if (market === "sz" && /^(00|30)\d{4}$/.test(code)) return [{ label: "深交所 · 公司资料与公告", url: `https://www.szse.cn/certificate/individual/index.html?code=${code}` }];
  return [];
}

// ---------------------------------------------------------------------------- fund issuers

/**
 * A fund's issuer, matched on the brand and issuer names the sources give (TradingView's issuer
 * is the parent company, its brand the name people know), per market: the product page where it
 * opens by ticker, the issuer's home page where it does not. One line each.
 */
export const ISSUERS: { match: RegExp; market: "us" | "hk" | "cn" | "jp"; label: string; url: string | ((ticker: string, mutual: boolean) => string | null) }[] = [
  { match: /vanguard/i, market: "us", label: "Vanguard 产品页", url: (t, mutual) => `https://investor.vanguard.com/investment-products/${mutual ? "mutual-funds" : "etfs"}/profile/${t.toLowerCase()}` },
  { match: /invesco/i, market: "us", label: "Invesco 产品页", url: (t, mutual) => (mutual ? null : `https://www.invesco.com/us/financial-products/etfs/product-detail?audienceType=Investor&ticker=${t}`) },
  { match: /schwab/i, market: "us", label: "Schwab 产品页", url: (t, mutual) => (mutual ? null : `https://www.schwabassetmanagement.com/products/${t.toLowerCase()}`) },
  { match: /\bark\b/i, market: "us", label: "ARK 产品页", url: (t, mutual) => (mutual ? null : `https://www.ark-funds.com/funds/${t.toLowerCase()}`) },
  { match: /global x/i, market: "us", label: "Global X 产品页", url: (t, mutual) => (mutual ? null : `https://www.globalxetfs.com/funds/${t.toLowerCase()}`) },
  { match: /state street|spdr/i, market: "us", label: "道富 SPDR", url: "https://www.ssga.com/us/en/intermediary" },
  { match: /ishares|blackrock/i, market: "us", label: "iShares 安硕", url: "https://www.ishares.com/us" },
  { match: /proshare/i, market: "us", label: "ProShares", url: "https://www.proshares.com/" },
  { match: /vaneck/i, market: "us", label: "VanEck", url: "https://www.vaneck.com/us/en/" },
  { match: /direxion/i, market: "us", label: "Direxion", url: "https://www.direxion.com/" },
  { match: /hang seng/i, market: "hk", label: "恒生投资管理", url: "https://www.hangsenginvestment.com/zh-hk/" },
  { match: /csop/i, market: "hk", label: "南方东英", url: "https://www.csopasset.com/tc/home" },
  { match: /china ?amc|china asset management/i, market: "hk", label: "华夏基金（香港）", url: "https://www.chinaamc.com.hk/" },
  { match: /ishares|blackrock/i, market: "hk", label: "iShares 安硕（香港）", url: "https://www.blackrock.com/hk/zh/ishares" },
  { match: /china ?amc|china asset management/i, market: "cn", label: "华夏基金", url: "https://www.chinaamc.com/" },
  { match: /china southern/i, market: "cn", label: "南方基金", url: "https://www.nffund.com/" },
  { match: /e fund/i, market: "cn", label: "易方达基金", url: "https://www.efunds.com.cn/" },
  { match: /harvest/i, market: "cn", label: "嘉实基金", url: "https://www.jsfund.cn/" },
  { match: /hua ?an/i, market: "cn", label: "华安基金", url: "https://www.huaan.com.cn/" },
  { match: /huatai/i, market: "cn", label: "华泰柏瑞基金", url: "https://www.huatai-pb.com/" },
  { match: /next funds|nomura/i, market: "jp", label: "野村 NEXT FUNDS", url: "https://nextfunds.jp/" },
];

function issuerPage(listing: Listing, kind: string, profile: SourceProfile | null): ProfileLink[] {
  const names = [profile?.brand, profile?.issuer].filter(Boolean).join(" ");
  if (!names) return [];
  const market = listing.market === "sh" || listing.market === "sz" ? "cn" : listing.market;
  const row = ISSUERS.find((r) => r.market === market && r.match.test(names));
  const url = typeof row?.url === "function" ? row.url(listing.code, kind === "mutualfund") : row?.url;
  return row && url ? [{ label: row.label, url }] : [];
}

// ---------------------------------------------------------------------------- official pages by asset

const TREASURY: [string, string] = ["美国财政部 · 每日国债收益率", "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve"];
const fred = (label: string, series: string): [string, string] => [`FRED · ${label}`, `https://fred.stlouisfed.org/series/${series}`];
const LBMA: [string, string] = ["LBMA · 贵金属定价", "https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices"];
const EIA: [string, string] = ["EIA · 原油现货价格", "https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm"];

/**
 * Official and public pages for assets without a company: one asset a line, the keys it goes by
 * at each source (`*` stands for one or more characters: TradingView's many FX feeds, a yield's
 * tenor), and its links as [label, url]. An asset that is not here only gets its source's quote page.
 */
export const ASSETS: { keys: string[]; links: [string, string][] }[] = [
  // government bond yields
  { keys: ["tv:TVC:US02Y"], links: [TREASURY, fred("2 年期美债收益率", "DGS2")] },
  { keys: ["tv:TVC:US05Y", "yahoo:^FVX"], links: [TREASURY, fred("5 年期美债收益率", "DGS5")] },
  { keys: ["tv:TVC:US10Y", "yahoo:^TNX"], links: [TREASURY, fred("10 年期美债收益率", "DGS10")] },
  { keys: ["tv:TVC:US30Y", "yahoo:^TYX"], links: [TREASURY, fred("30 年期美债收益率", "DGS30")] },
  { keys: ["tv:TVC:JP*Y"], links: [["日本财务省 · 国债利率", "https://www.mof.go.jp/jgbs/reference/interest_rate/index.htm"]] },
  { keys: ["tv:TVC:CN*Y"], links: [["中国债券信息网 · 中债收益率曲线", "https://yield.chinabond.com.cn/"]] },
  { keys: ["tv:TVC:DE*Y"], links: [["德国联邦银行 · 利率与收益率", "https://www.bundesbank.de/en/statistics/money-and-capital-markets/interest-rates-and-yields"]] },
  // the dollar and the major pairs
  { keys: ["tv:TVC:DXY", "yahoo:DX-Y.NYB"], links: [["ICE · 美元指数期货", "https://www.ice.com/products/194/US-Dollar-Index-Futures"], fred("广义美元指数", "DTWEXBGS")] },
  { keys: ["tv:*:USDJPY", "yahoo:JPY=X"], links: [["日本银行 · 外汇行情（每日）", "https://www.boj.or.jp/statistics/market/forex/fxdaily/index.htm"], fred("美元兑日元", "DEXJPUS")] },
  { keys: ["tv:*:USDCNY", "tv:*:USDCNH", "yahoo:CNY=X", "yahoo:CNH=X"], links: [["中国货币网 · 人民币汇率中间价", "https://www.chinamoney.com.cn/chinese/bkccpr/"], fred("美元兑人民币", "DEXCHUS")] },
  { keys: ["tv:*:EURUSD", "yahoo:EURUSD=X"], links: [["欧洲央行 · 欧元兑美元参考汇率", "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html"], fred("欧元兑美元", "DEXUSEU")] },
  // commodities
  { keys: ["tv:TVC:GOLD", "tv:*:XAUUSD", "tv:COMEX:GC1!", "yahoo:GC=F"], links: [["世界黄金协会 · 金价数据", "https://www.gold.org/goldhub/data/gold-prices"], LBMA] },
  { keys: ["tv:TVC:SILVER", "tv:*:XAGUSD", "tv:COMEX:SI1!", "yahoo:SI=F"], links: [LBMA, ["白银协会", "https://silverinstitute.org/"]] },
  { keys: ["tv:TVC:USOIL", "tv:TVC:UKOIL", "tv:NYMEX:CL1!", "yahoo:CL=F", "yahoo:BZ=F"], links: [EIA, ["EIA · 石油与液体燃料", "https://www.eia.gov/petroleum/"]] },
  { keys: ["tv:COMEX:HG1!", "yahoo:HG=F"], links: [["伦敦金属交易所 · LME 铜", "https://www.lme.com/en/metals/non-ferrous/lme-copper"], ["国际铜业研究组织", "https://icsg.org/"]] },
  // indices
  { keys: ["yahoo:^GSPC", "tv:SP:SPX", "tv:TVC:SPX"], links: [fred("标普 500 指数", "SP500")] },
  { keys: ["yahoo:^DJI", "tv:DJ:DJI", "tv:TVC:DJI"], links: [fred("道琼斯工业平均指数", "DJIA")] },
  { keys: ["yahoo:^NDX", "tv:NASDAQ:NDX", "tv:TVC:NDX"], links: [["纳斯达克指数 · 纳斯达克 100", "https://indexes.nasdaqomx.com/Index/Overview/NDX"]] },
  { keys: ["yahoo:^IXIC", "tv:NASDAQ:IXIC", "tv:TVC:IXIC"], links: [["纳斯达克指数 · 纳斯达克综合", "https://indexes.nasdaqomx.com/Index/Overview/COMP"]] },
  { keys: ["yahoo:^VIX", "tv:CBOE:VIX", "tv:TVC:VIX"], links: [["Cboe · VIX 波动率指数", "https://www.cboe.com/tradable-products/vix"]] },
  { keys: ["yahoo:^HSI", "tv:HSI:HSI", "tv:TVC:HSI"], links: [["恒生指数公司 · 恒生指数", "https://www.hsi.com.hk/zh-cn/indexes/all-indexes/index-details/?seriesCode=hsi"]] },
  { keys: ["tv:HSI:HSTECH"], links: [["恒生指数公司 · 恒生科技指数", "https://www.hsi.com.hk/zh-cn/indexes/all-indexes/index-details/?seriesCode=hstech"]] },
  { keys: ["tv:SSE:000300", "yahoo:000300.SS"], links: [["中证指数 · 沪深 300", "https://www.csindex.com.cn/#/indices/family/detail?indexCode=000300"]] },
  { keys: ["tv:SSE:000001", "yahoo:000001.SS"], links: [["中证指数 · 上证综合指数", "https://www.csindex.com.cn/#/indices/family/detail?indexCode=000001"]] },
  { keys: ["yahoo:^N225", "tv:TVC:NI225"], links: [["日经指数 · 日经平均股价", "https://indexes.nikkei.co.jp/nkave/index/profile?idx=nk225"]] },
  { keys: ["tv:TSE:TOPIX"], links: [["日本交易所集团 · TOPIX", "https://www.jpx.co.jp/markets/indices/topix/"]] },
  // coins
  { keys: ["binance:BTCUSD*", "binance:BTCFDUSD", "yahoo:BTC-USD", "tv:*:BTCUSD", "tv:*:BTCUSDT"], links: [["比特币项目官网", "https://bitcoin.org/zh_CN/"]] },
  { keys: ["binance:ETHUSD*", "binance:ETHFDUSD", "yahoo:ETH-USD", "tv:*:ETHUSD", "tv:*:ETHUSDT"], links: [["以太坊项目官网", "https://ethereum.org/zh/"]] },
];

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const keyMatches = (pattern: string, key: string) => new RegExp(`^${pattern.split("*").map(escape).join(".+")}$`).test(key);

// ---------------------------------------------------------------------------- the source's own page

const BINANCE_QUOTES = /^([A-Z0-9]+?)(USDT|USDC|FDUSD|BTC|ETH|BNB)$/;

function quotePage(source: string, ticker: string): ProfileLink[] {
  if (source === "yahoo") return [{ label: "Yahoo Finance 行情页", url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/` }];
  if (source === "tv") return [{ label: "TradingView 商品页", url: `https://cn.tradingview.com/symbols/${ticker.replace(":", "-")}/` }];
  const pair = source === "binance" ? BINANCE_QUOTES.exec(ticker) : null;
  return pair ? [{ label: "Binance 交易页", url: `https://www.binance.com/zh-CN/trade/${pair[1]}_${pair[2]}` }] : [];
}

/**
 * Every link of a real key, most specific first; a synthetic key has none (its operands have
 * their own). A later link to the site the source's own website already names is dropped, as is a
 * repeated URL.
 */
export function profileLinks({ key, kind, exchange, profile, repo }: LinkInput): ProfileLink[] {
  if (key.startsWith("=")) return [];
  const at = key.indexOf(":");
  const [source, ticker] = [key.slice(0, at), key.slice(at + 1)];
  const k = kind?.toLowerCase() ?? "";
  const listing = listingOf(source, ticker, exchange);
  const site = profile?.website && linkHost(profile.website) ? [{ label: FUND_KINDS.has(k) ? "基金官网" : "官网", url: profile.website }] : [];
  const official = ASSETS.filter((a) => a.keys.some((p) => keyMatches(p, key))).flatMap((a) => a.links.map(([label, url]) => ({ label, url })));
  const all = [
    ...site,
    ...(listing && FUND_KINDS.has(k) ? issuerPage(listing, k, profile) : []),
    ...(listing ? filings(listing, k) : []),
    ...official,
    ...(source === "data" && repo ? [{ label: "数据集仓库", url: repo }] : []),
    ...quotePage(source, ticker),
  ];
  const siteHost = site[0] ? linkHost(site[0].url) : null;
  return all.filter((link, i) => all.findIndex((l) => l.url === link.url) === i && (i === 0 || !siteHost || linkHost(link.url) !== siteHost));
}
