import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSETS, ISSUERS, linkHost, profileLinks, type LinkInput } from "@/lib/links";
import { tvProfile } from "@/lib/sources/tradingview";

const links = (input: Partial<LinkInput> & { key: string }) => profileLinks({ kind: null, exchange: null, profile: null, ...input });
const labels = (input: Partial<LinkInput> & { key: string }) => links(input).map((l) => l.label);
const url = (input: Partial<LinkInput> & { key: string }, label: string) => links(input).find((l) => l.label === label)?.url;

const YAHOO_PAGE = "Yahoo Finance 行情页";
const TV_PAGE = "TradingView 商品页";

describe("a company", () => {
  it("US-listed: its website, its filings at the SEC, the source's page", () => {
    const nvda = { key: "yahoo:NVDA", kind: "equity", exchange: "NasdaqGS", profile: { website: "https://www.nvidia.com" } };
    expect(links(nvda)).toEqual([
      { label: "官网", url: "https://www.nvidia.com" },
      { label: "SEC EDGAR 公告", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA" },
      { label: YAHOO_PAGE, url: "https://finance.yahoo.com/quote/NVDA/" },
    ]);
    // the same company at TradingView
    expect(links({ key: "tv:NASDAQ:NVDA", kind: "stock", exchange: "NASDAQ", profile: { website: "http://www.nvidia.com" } }).map((l) => l.url)).toEqual([
      "http://www.nvidia.com",
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA",
      "https://cn.tradingview.com/symbols/NASDAQ-NVDA/",
    ]);
  });

  it("a share class is BRK-B at the SEC whichever way the source writes it", () => {
    const edgar = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=BRK-B";
    expect(url({ key: "yahoo:BRK-B", kind: "equity", exchange: "NYSE" }, "SEC EDGAR 公告")).toBe(edgar);
    expect(url({ key: "tv:NYSE:BRK.B", kind: "stock", exchange: "NYSE" }, "SEC EDGAR 公告")).toBe(edgar);
    // TradingView's own page keeps the dot
    expect(url({ key: "tv:NYSE:BRK.B", kind: "stock", exchange: "NYSE" }, TV_PAGE)).toBe("https://cn.tradingview.com/symbols/NYSE-BRK.B/");
  });

  it("an OTC ADR files nothing at the SEC: no EDGAR link", () => {
    expect(labels({ key: "yahoo:TCEHY", kind: "equity", exchange: "OTC Markets OTCPK", profile: { website: "https://www.tencent.com" } })).toEqual(["官网", YAHOO_PAGE]);
    // nor does a coin, whose Yahoo ticker looks like a US one
    expect(labels({ key: "yahoo:SOL-USD", kind: "cryptocurrency", exchange: "CCC" })).toEqual([YAHOO_PAGE]);
  });

  it("Hong Kong: the exchange's page, by the code without leading zeros", () => {
    const hkex = "https://www.hkex.com.hk/Market-Data/Securities-Prices/Equities/Equities-Quote?sym=700&sc_lang=zh-HK";
    expect(url({ key: "yahoo:0700.HK", kind: "equity", exchange: "HKSE" }, "港交所 · 行情与公告")).toBe(hkex);
    expect(url({ key: "tv:HKEX:700", kind: "stock", exchange: "HKEX" }, "港交所 · 行情与公告")).toBe(hkex);
  });

  it("A shares: Shanghai's and Shenzhen's own pages, for stock codes only", () => {
    expect(url({ key: "yahoo:600519.SS", kind: "equity", exchange: "Shanghai" }, "上交所 · 公司公告")).toBe("https://www.sse.com.cn/assortment/stock/list/info/announcement/index.shtml?productId=600519");
    expect(url({ key: "tv:SSE:688981", kind: "stock", exchange: "SSE" }, "上交所 · 公司公告")).toContain("productId=688981");
    expect(url({ key: "yahoo:000001.SZ", kind: "equity", exchange: "Shenzhen" }, "深交所 · 公司资料与公告")).toBe("https://www.szse.cn/certificate/individual/index.html?code=000001");
    expect(url({ key: "tv:SZSE:300750", kind: "stock", exchange: "SZSE" }, "深交所 · 公司资料与公告")).toContain("code=300750");
    // Yahoo calls an ETF listed there an equity; an index shares the exchange too
    expect(labels({ key: "yahoo:510300.SS", kind: "equity", exchange: "Shanghai" })).toEqual([YAHOO_PAGE]);
    expect(labels({ key: "yahoo:159915.SZ", kind: "equity", exchange: "Shenzhen" })).toEqual([YAHOO_PAGE]);
  });

  it("Tokyo has no page that opens by code: the website and the source's page", () => {
    expect(labels({ key: "yahoo:7203.T", kind: "equity", exchange: "Tokyo", profile: { website: "https://global.toyota" } })).toEqual(["官网", YAHOO_PAGE]);
  });
});

describe("a fund", () => {
  it("goes to its issuer: the product page where one opens by ticker, the home page otherwise, and never to EDGAR", () => {
    const etf = (ticker: string, issuer: string, kind = "etf") => links({ key: `yahoo:${ticker}`, kind, exchange: "NYSEArca", profile: { issuer } });
    expect(etf("VOO", "Vanguard")).toEqual([
      { label: "Vanguard 产品页", url: "https://investor.vanguard.com/investment-products/etfs/profile/voo" },
      { label: YAHOO_PAGE, url: "https://finance.yahoo.com/quote/VOO/" },
    ]);
    expect(etf("VFIAX", "Vanguard", "mutualfund")[0].url).toBe("https://investor.vanguard.com/investment-products/mutual-funds/profile/vfiax");
    expect(etf("QQQ", "Invesco")[0]).toEqual({ label: "Invesco 产品页", url: "https://www.invesco.com/us/financial-products/etfs/product-detail?audienceType=Investor&ticker=QQQ" });
    expect(etf("SCHD", "Schwab ETFs")[0].url).toBe("https://www.schwabassetmanagement.com/products/schd");
    expect(etf("ARKK", "ARK ETF Trust")[0].url).toBe("https://www.ark-funds.com/funds/arkk");
    expect(etf("QYLD", "Global X Funds")[0].url).toBe("https://www.globalxetfs.com/funds/qyld");
    expect(etf("SPY", "State Street Investment Management")[0]).toEqual({ label: "道富 SPDR", url: "https://www.ssga.com/us/en/intermediary" });
    expect(etf("IVV", "iShares")[0].url).toBe("https://www.ishares.com/us");
    // a product page that only exists for the issuer's ETFs is not guessed for its mutual funds
    expect(etf("VADAX", "Invesco", "mutualfund").map((l) => l.label)).toEqual([YAHOO_PAGE]);
    // a bank that happens to be a "markets" company is not ARK
    expect(etf("XYZ", "Clark Capital").map((l) => l.label)).toEqual([YAHOO_PAGE]);
    for (const ticker of ["VOO", "QQQ", "SPY"]) expect(etf(ticker, "Vanguard").map((l) => l.label)).not.toContain("SEC EDGAR 公告");
  });

  it("an issuer nobody listed leaves the source's page", () => {
    expect(labels({ key: "yahoo:XYZ", kind: "etf", exchange: "NYSEArca", profile: { issuer: "Some Small Advisors LLC" } })).toEqual([YAHOO_PAGE]);
    expect(labels({ key: "yahoo:XYZ", kind: "etf", exchange: "NYSEArca", profile: {} })).toEqual([YAHOO_PAGE]);
  });

  it("the same issuer has another site in another market", () => {
    const ishares = (key: string, exchange: string) => links({ key, kind: "etf", exchange, profile: { issuer: "BlackRock Asset Management North Asia Ltd - ETF" } })[0];
    expect(ishares("yahoo:2823.HK", "HKSE")).toEqual({ label: "iShares 安硕（香港）", url: "https://www.blackrock.com/hk/zh/ishares" });
    expect(ishares("yahoo:IVV", "NYSEArca").url).toBe("https://www.ishares.com/us");
    // Hong Kong: the issuer, then the exchange's page for exchange traded products
    expect(links({ key: "yahoo:2800.HK", kind: "etf", exchange: "HKSE", profile: { issuer: "Hang Seng Investment Management Ltd" } }).map((l) => l.label)).toEqual(["恒生投资管理", "港交所 · ETF 资料", YAHOO_PAGE]);
    expect(url({ key: "yahoo:2800.HK", kind: "etf", exchange: "HKSE" }, "港交所 · ETF 资料")).toContain("Exchange-Traded-Products-Quote?sym=2800");
    expect(links({ key: "yahoo:1306.T", kind: "etf", exchange: "Tokyo", profile: { issuer: "Nomura Asset Management Co Ltd" } })[0].url).toBe("https://nextfunds.jp/");
  });

  it("TradingView names the parent as issuer and the fund family as brand: the brand is matched too", () => {
    // as measured: 510050 is ChinaAMC's, its issuer CITIC Securities
    const chinaAmc = tvProfile({ type: "fund", issuer: "CITIC Securities Co., Ltd.", brand: "ChinaAMC" });
    expect(chinaAmc).toEqual({ issuer: "CITIC Securities Co., Ltd.", brand: "ChinaAMC" });
    expect(links({ key: "tv:SSE:510050", kind: "fund", exchange: "SSE", profile: chinaAmc })).toEqual([
      { label: "华夏基金", url: "https://www.chinaamc.com/" },
      { label: TV_PAGE, url: "https://cn.tradingview.com/symbols/SSE-510050/" },
    ]);
    expect(links({ key: "tv:HKEX:3188", kind: "fund", exchange: "HKEX", profile: chinaAmc })[0]).toEqual({ label: "华夏基金（香港）", url: "https://www.chinaamc.com.hk/" });
    expect(links({ key: "tv:AMEX:GLD", kind: "fund", exchange: "AMEX", profile: { issuer: "World Gold Council Ltd.", brand: "SPDR" } })[0].label).toBe("道富 SPDR");
    expect(links({ key: "tv:SZSE:159915", kind: "fund", exchange: "SZSE", profile: { issuer: "E Fund Management Co., Ltd.", brand: "E Fund" } })[0].label).toBe("易方达基金");
  });

  it("a website the source gives is the fund's page, and the issuer's home page on the same site is not repeated", () => {
    const spy = links({ key: "tv:AMEX:SPY", kind: "fund", exchange: "AMEX", profile: { website: "http://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy", issuer: "State Street Corp.", brand: "SPDR" } });
    expect(spy.map((l) => l.label)).toEqual(["基金官网", TV_PAGE]);
    // another site: both
    expect(labels({ key: "tv:HKEX:2800", kind: "fund", exchange: "HKEX", profile: { website: "http://www.trahk.com.hk/", issuer: "HSBC Holdings Plc", brand: "Hang Seng" } })).toEqual(["基金官网", "恒生投资管理", "港交所 · ETF 资料", TV_PAGE]);
  });
});

describe("things without a company", () => {
  it("a Treasury yield goes to the Treasury and to its FRED series, whichever source it is watched at", () => {
    const tv = links({ key: "tv:TVC:US10Y", kind: "bond", exchange: "TVC" });
    expect(tv).toEqual([
      { label: "美国财政部 · 每日国债收益率", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve" },
      { label: "FRED · 10 年期美债收益率", url: "https://fred.stlouisfed.org/series/DGS10" },
      { label: TV_PAGE, url: "https://cn.tradingview.com/symbols/TVC-US10Y/" },
    ]);
    const yahoo = links({ key: "yahoo:^TNX", kind: "index", exchange: "Cboe Indices" });
    expect(yahoo.slice(0, 2)).toEqual(tv.slice(0, 2));
    expect(yahoo[2]).toEqual({ label: YAHOO_PAGE, url: "https://finance.yahoo.com/quote/%5ETNX/" });
    // each tenor its own series
    expect(url({ key: "tv:TVC:US02Y" }, "FRED · 2 年期美债收益率")).toBe("https://fred.stlouisfed.org/series/DGS2");
    expect(url({ key: "yahoo:^TYX" }, "FRED · 30 年期美债收益率")).toBe("https://fred.stlouisfed.org/series/DGS30");
    // other governments, any tenor
    expect(labels({ key: "tv:TVC:JP10Y" })).toEqual(["日本财务省 · 国债利率", TV_PAGE]);
    expect(labels({ key: "tv:TVC:CN02Y" })).toEqual(["中国债券信息网 · 中债收益率曲线", TV_PAGE]);
    expect(labels({ key: "tv:TVC:DE30Y" })).toEqual(["德国联邦银行 · 利率与收益率", TV_PAGE]);
  });

  it("the dollar, a pair from any of TradingView's feeds, gold, oil", () => {
    expect(labels({ key: "tv:TVC:DXY" })).toEqual(["ICE · 美元指数期货", "FRED · 广义美元指数", TV_PAGE]);
    expect(labels({ key: "yahoo:DX-Y.NYB" }).slice(0, 2)).toEqual(["ICE · 美元指数期货", "FRED · 广义美元指数"]);
    for (const key of ["tv:FX_IDC:USDCNH", "tv:OANDA:USDCNH", "tv:FX_IDC:USDCNY", "yahoo:CNH=X", "yahoo:CNY=X"]) expect(labels({ key }).slice(0, 2), key).toEqual(["中国货币网 · 人民币汇率中间价", "FRED · 美元兑人民币"]);
    for (const key of ["tv:FX:USDJPY", "tv:FX_IDC:USDJPY", "yahoo:JPY=X"]) expect(labels({ key })[0], key).toBe("日本银行 · 外汇行情（每日）");
    for (const key of ["tv:TVC:GOLD", "tv:OANDA:XAUUSD", "tv:COMEX:GC1!", "yahoo:GC=F"]) expect(labels({ key }).slice(0, 2), key).toEqual(["世界黄金协会 · 金价数据", "LBMA · 贵金属定价"]);
    for (const key of ["tv:TVC:USOIL", "tv:TVC:UKOIL", "yahoo:CL=F", "yahoo:BZ=F"]) expect(labels({ key })[0], key).toBe("EIA · 原油现货价格");
    // a futures key keeps its `!` in TradingView's address
    expect(url({ key: "tv:COMEX:HG1!" }, TV_PAGE)).toBe("https://cn.tradingview.com/symbols/COMEX-HG1!/");
  });

  it("an index goes to whoever publishes it", () => {
    for (const key of ["yahoo:^HSI", "tv:HSI:HSI", "tv:TVC:HSI"]) expect(labels({ key })[0], key).toBe("恒生指数公司 · 恒生指数");
    expect(labels({ key: "tv:HSI:HSTECH", kind: "index", exchange: "HSI" })).toEqual(["恒生指数公司 · 恒生科技指数", TV_PAGE]);
    expect(url({ key: "tv:SSE:000300", kind: "index", exchange: "SSE" }, "中证指数 · 沪深 300")).toBe("https://www.csindex.com.cn/#/indices/family/detail?indexCode=000300");
    // an index on the Shanghai exchange is not a company there
    expect(labels({ key: "yahoo:000001.SS", kind: "index", exchange: "Shanghai" })).toEqual(["中证指数 · 上证综合指数", YAHOO_PAGE]);
    for (const key of ["yahoo:^NDX", "tv:NASDAQ:NDX"]) expect(labels({ key, kind: "index", exchange: "NASDAQ" })[0], key).toBe("纳斯达克指数 · 纳斯达克 100");
    expect(labels({ key: "yahoo:^GSPC" })).toEqual(["FRED · 标普 500 指数", YAHOO_PAGE]);
    expect(labels({ key: "yahoo:^N225" })[0]).toBe("日经指数 · 日经平均股价");
  });

  it("bitcoin and ether, at an exchange or at a data vendor; another coin only has its source's page", () => {
    expect(links({ key: "binance:BTCUSDT", kind: "crypto", exchange: "Binance" })).toEqual([
      { label: "比特币项目官网", url: "https://bitcoin.org/zh_CN/" },
      { label: "Binance 交易页", url: "https://www.binance.com/zh-CN/trade/BTC_USDT" },
    ]);
    expect(labels({ key: "tv:BINANCE:BTCUSDT" })[0]).toBe("比特币项目官网");
    expect(labels({ key: "binance:ETHUSDT" })).toEqual(["以太坊项目官网", "Binance 交易页"]);
    // Yahoo names bitcoin.org itself: one link to that site, not two
    expect(labels({ key: "yahoo:BTC-USD", kind: "cryptocurrency", exchange: "CCC", profile: { website: "https://bitcoin.org/" } })).toEqual(["官网", YAHOO_PAGE]);
    expect(links({ key: "binance:SOLUSDT" })).toEqual([{ label: "Binance 交易页", url: "https://www.binance.com/zh-CN/trade/SOL_USDT" }]);
    // BTC against something else is not bitcoin's own page, and a coin whose name starts with BTC is not bitcoin
    expect(labels({ key: "binance:ETHBTC" })).toEqual(["Binance 交易页"]);
    expect(url({ key: "binance:ETHBTC" }, "Binance 交易页")).toBe("https://www.binance.com/zh-CN/trade/ETH_BTC");
    expect(labels({ key: "binance:BTCSTUSDT" })).toEqual(["Binance 交易页"]);
  });

  it("an asset the table does not know only has the source's page; a synthetic key has none", () => {
    expect(labels({ key: "tv:TVC:US03MY", kind: "bond", exchange: "TVC" })).toEqual([TV_PAGE]);
    expect(labels({ key: "yahoo:^RUT", kind: "index", exchange: "Chicago Options" })).toEqual([YAHOO_PAGE]);
    expect(labels({ key: "tv:FX_IDC:USDTHB", kind: "forex", exchange: "ICE" })).toEqual([TV_PAGE]);
    expect(links({ key: "=BTC/GOLD" })).toEqual([]);
    expect(links({ key: "=binance:BTCUSDT/tv:TVC:GOLD" })).toEqual([]);
  });
});

describe("a dataset series", () => {
  it("links to its repository when there is one to open", () => {
    expect(links({ key: "data:gpu/4090-xianyu", kind: "dataset", exchange: "显卡", repo: "https://github.com/someone/gpu-prices" })).toEqual([{ label: "数据集仓库", url: "https://github.com/someone/gpu-prices" }]);
    expect(links({ key: "data:gpu/4090-xianyu", kind: "dataset", exchange: "显卡", repo: null })).toEqual([]);
  });
});

describe("the tables", () => {
  it("every link is https, named, and listed once per asset; every key names a source", () => {
    for (const asset of ASSETS) {
      for (const key of asset.keys) expect(key, key).toMatch(/^(yahoo|tv|binance):\S+$/);
      for (const [label, link] of asset.links) {
        expect(link, label).toMatch(/^https:\/\//);
        expect(linkHost(link), label).not.toBeNull();
        expect(label.trim()).not.toBe("");
      }
      expect(new Set(asset.links.map(([, link]) => link)).size).toBe(asset.links.length);
    }
    for (const row of ISSUERS) {
      const link = typeof row.url === "function" ? row.url("TEST", false) : row.url;
      expect(link, row.label).toMatch(/^https:\/\//);
    }
    // no key is claimed by two assets
    const keys = ASSETS.flatMap((a) => a.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only http(s) addresses are links", () => {
    expect(linkHost("https://www.nvidia.com/en-us/")).toBe("nvidia.com");
    expect(linkHost("http://bank.pingan.com")).toBe("bank.pingan.com");
    expect(linkHost("javascript:alert(1)")).toBeNull();
    expect(linkHost("not a url")).toBeNull();
    // a website that is no address is not offered
    expect(labels({ key: "yahoo:NVDA", kind: "equity", exchange: "NasdaqGS", profile: { website: "javascript:alert(1)" } })).toEqual(["SEC EDGAR 公告", YAHOO_PAGE]);
  });
});

describe("the profile view and get_profile carry the links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-links-"));
  const root = path.join(dir, "vault");
  const yaml = (datasets: string) => `aliases:\n  BTC: binance:BTCUSDT\n  GOLD: tv:TVC:GOLD\ngroups:\n  - { name: 美股, symbols: [yahoo:NVDA] }\n${datasets}`;

  beforeAll(() => {
    process.env.HEBI8_VAULT = root;
    process.env.HEBI8_DB = path.join(dir, "hebi8.db");
    process.env.HEBI8_SECRETS = path.join(dir, "secrets");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "hebi8.yaml"), yaml("datasets:\n  gpu: https://github.com/someone/gpu-prices.git\n  private: https://token@github.com/someone/private.git\n  local: ./datasets/local\n  ssh: git@github.com:someone/ssh.git\n"));
  });
  afterAll(() => {
    delete process.env.HEBI8_VAULT;
    delete process.env.HEBI8_DB;
    delete process.env.HEBI8_SECRETS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("from the cached metadata and the stored profile, with nothing fetched", async () => {
    const { callTool } = await import("@/lib/mcp/tools");
    const { profileView, writeProfile } = await import("@/lib/profiles");
    const { createToken } = await import("@/lib/secrets");
    const { ensureSymbol, markSynced } = await import("@/lib/store");
    const { readConfig } = await import("@/lib/vault");
    const { tokenViewer } = await import("@/lib/viewer");
    const cfg = readConfig(root);
    ensureSymbol("yahoo:NVDA");
    markSynced("yahoo:NVDA", { name: "NVIDIA Corporation", exchange: "NasdaqGS", currency: "USD", timezone: "America/New_York", kind: "equity" });
    // before the profile is in: the filings and the source's page are there already
    expect(profileView("yahoo:NVDA", cfg).links.map((l) => l.label)).toEqual(["SEC EDGAR 公告", YAHOO_PAGE]);
    writeProfile("yahoo:NVDA", { website: "https://www.nvidia.com" });
    expect(profileView("yahoo:NVDA", cfg).links.map((l) => l.label)).toEqual(["官网", "SEC EDGAR 公告", YAHOO_PAGE]);
    // never cached: still its source's page
    expect(profileView("tv:TVC:US10Y", cfg).links.map((l) => l.label)).toEqual(["美国财政部 · 每日国债收益率", "FRED · 10 年期美债收益率", TV_PAGE]);
    expect(profileView("=BTC/GOLD", cfg).links).toEqual([]);

    const viewer = tokenViewer(createToken({ name: "t", login: null, write: false }))!;
    const got = JSON.parse((await callTool(viewer, "get_profile", { key: "yahoo:NVDA" })).content[0].text);
    expect(got.links).toEqual([
      { name: "官网", url: "https://www.nvidia.com" },
      { name: "SEC EDGAR 公告", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA" },
      { name: YAHOO_PAGE, url: "https://finance.yahoo.com/quote/NVDA/" },
    ]);
  });

  it("a dataset's repository is linked when its address is a plain https one", async () => {
    const { profileView } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    const cfg = readConfig(root);
    expect(profileView("data:gpu/4090-xianyu", cfg).links).toEqual([{ label: "数据集仓库", url: "https://github.com/someone/gpu-prices" }]);
    // credentials in the address, a directory on this machine, an ssh remote: nothing to open
    for (const key of ["data:private/x", "data:local/x", "data:ssh/x", "data:unknown/x"]) expect(profileView(key, cfg).links, key).toEqual([]);
  });
});
