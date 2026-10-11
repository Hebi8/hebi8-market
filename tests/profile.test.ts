import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILE_RETRY_MS, PROFILE_TTL_MS, fmtAmount, fmtHours, isChinese, nextEarnings, profileDue, valuation } from "@/lib/profile";
import { parseManifest } from "@/lib/sources/dataset";
import { tvProfile } from "@/lib/sources/tradingview";
import { yahooProfile } from "@/lib/sources/yahoo";

const session = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session.id ? { value: session.id } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 11, 3);

describe("the numbers that follow the price", () => {
  it("market cap, P/E and yield come from the stored facts and the latest price", () => {
    const facts = { shares: 24_147_000_000, eps: 7.91, dividend: 1 };
    const at229 = valuation(facts, 229.28);
    expect(at229.marketCap).toBeCloseTo(5.5364e12, -9);
    expect(at229.pe).toBeCloseTo(28.986, 3);
    expect(at229.dividendYield).toBeCloseTo(0.004361, 6);
    // the same facts a week later, at another price
    const at200 = valuation(facts, 200);
    expect(at200).toEqual({ marketCap: 4_829_400_000_000, pe: 200 / 7.91, dividendYield: 0.005 });
  });

  it("no P/E while earnings are negative, and nothing without a price or the fact behind it", () => {
    expect(valuation({ shares: 100, eps: -2 }, 10)).toEqual({ marketCap: 1000, pe: null, dividendYield: null });
    expect(valuation({ shares: 100, eps: 0 }, 10).pe).toBeNull();
    expect(valuation({ shares: 100, eps: 2, dividend: 1 }, null)).toEqual({ marketCap: null, pe: null, dividendYield: null });
    expect(valuation({ shares: 100, eps: 2, dividend: 1 }, 0)).toEqual({ marketCap: null, pe: null, dividendYield: null });
    expect(valuation(null, 10)).toEqual({ marketCap: null, pe: null, dividendYield: null });
  });

  it("the next earnings report is a day on the exchange's calendar, shown through that day and not after", () => {
    const at = (iso: string) => ({ earningsAt: Date.parse(iso) / 1000 });
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
    const NY = "America/New_York";
    // after the close on Nov 17 in New York
    const report = at("2026-11-17T21:20:00Z");
    expect(nextEarnings(report, Date.parse("2026-10-11T03:00:00Z"), NY)).toBe(day("2026-11-17"));
    // the report is out, the day is not over: still shown
    expect(nextEarnings(report, Date.parse("2026-11-18T03:00:00Z"), NY)).toBe(day("2026-11-17"));
    // midnight in New York: gone, though it is less than a day old
    expect(nextEarnings(report, Date.parse("2026-11-18T05:00:00Z"), NY)).toBeNull();
    // a morning report in Tokyo is still the day before in UTC: the date is Tokyo's
    const tokyo = at("2026-10-29T23:30:00Z");
    expect(nextEarnings(tokyo, Date.parse("2026-10-29T12:00:00Z"), "Asia/Tokyo")).toBe(day("2026-10-30"));
    expect(nextEarnings(tokyo, Date.parse("2026-10-30T14:59:00Z"), "Asia/Tokyo")).toBe(day("2026-10-30"));
    expect(nextEarnings(tokyo, Date.parse("2026-10-30T15:00:00Z"), "Asia/Tokyo")).toBeNull();
    expect(nextEarnings({}, NOW, NY)).toBeNull();
    expect(nextEarnings(null, NOW, NY)).toBeNull();
  });
});

describe("when a profile is fetched again", () => {
  it("never fetched is due; a fetched one after a week; a failed one after a day", () => {
    expect(profileDue(null, NOW)).toBe(true);
    const ok = { fetchedAt: NOW, triedAt: NOW, error: null };
    expect(profileDue(ok, NOW + PROFILE_TTL_MS - 1)).toBe(false);
    expect(profileDue(ok, NOW + PROFILE_TTL_MS)).toBe(true);
    // failed yesterday, on top of facts from last month: tomorrow's sync tries again, not next week's
    const failed = { fetchedAt: NOW - 30 * DAY, triedAt: NOW, error: "TradingView timeout" };
    expect(profileDue(failed, NOW + PROFILE_RETRY_MS - 1)).toBe(false);
    expect(profileDue(failed, NOW + PROFILE_RETRY_MS)).toBe(true);
    // never worked
    expect(profileDue({ fetchedAt: null, triedAt: NOW, error: "no data" }, NOW + 3600_000)).toBe(false);
  });
});

describe("how the panel writes things", () => {
  it("a description that is already Chinese needs no translation", () => {
    expect(isChinese("贵州茅台酒股份有限公司主要从事茅台酒及系列酒的生产与销售。")).toBe(true);
    expect(isChinese("NVIDIA Corporation operates as a data center scale AI infrastructure company.")).toBe(false);
    // a Chinese text that names a company in Latin letters
    expect(isChinese("腾讯控股有限公司（Tencent Holdings Limited）是一家投资控股公司。")).toBe(true);
    expect(isChinese("Kweichow Moutai Co., Ltd. (贵州茅台) produces liquor.")).toBe(false);
    expect(isChinese("")).toBe(false);
  });

  it("hours in TradingView's notation as clock times", () => {
    expect(fmtHours("0930-1600")).toBe("09:30–16:00");
    expect(fmtHours("24x7")).toBe("全天");
    expect(fmtHours("0930-1130,1300-1500")).toBe("09:30–11:30 · 13:00–15:00");
    // other days' hours after |, and the hours before a change of schedule
    expect(fmtHours("1700-1600:2345|1700-1500:6")).toBe("17:00–16:00");
    expect(fmtHours("1800-1700|1800-1500:6")).toBe("18:00–17:00");
    expect(fmtHours("0900-1500#20260803/0900-1530")).toBe("09:00–15:30");
    expect(fmtHours("1700F-1900")).toBe("17:00–19:00");
    expect(fmtHours("nonsense")).toBeNull();
  });

  it("large amounts", () => {
    expect(fmtAmount(5_536_424_132_608)).toBe("5.54T");
    expect(fmtAmount(816_735_908_245)).toBe("816.74B");
    expect(fmtAmount(42_500_000)).toBe("42.50M");
    expect(fmtAmount(9_500)).toBe("9.50K");
    expect(fmtAmount(12)).toBe("12.00");
  });
});

describe("Yahoo's quoteSummary as a profile", () => {
  it("a company: the facts, with the share count Yahoo's own market cap uses", () => {
    const profile = yahooProfile({
      assetProfile: { longBusinessSummary: " NVIDIA Corporation operates… ", sector: "Technology", industry: "Semiconductors", country: "United States", fullTimeEmployees: 42000, website: "https://www.nvidia.com" },
      summaryDetail: { dividendRate: 1, trailingAnnualDividendRate: 0.28 },
      defaultKeyStatistics: { impliedSharesOutstanding: 24_147_000_000, sharesOutstanding: 24_100_000_000, trailingEps: 7.91 },
      calendarEvents: { earnings: { earningsDate: [new Date("2026-11-17T20:00:00.000Z")] } },
    });
    expect(profile).toEqual({
      description: "NVIDIA Corporation operates…",
      sector: "Technology",
      industry: "Semiconductors",
      country: "United States",
      employees: 42000,
      website: "https://www.nvidia.com",
      shares: 24_147_000_000,
      eps: 7.91,
      dividend: 1,
      earningsAt: Date.UTC(2026, 10, 17, 20) / 1000,
    });
    // nothing that follows the price is kept
    expect(Object.keys(profile)).not.toContain("marketCap");
  });

  it("a fund: issuer, category, cost, assets, ten holdings and the sectors by weight", () => {
    const holdings = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, holdingName: `Holding ${i}`, holdingPercent: 0.08 - i * 0.005 }));
    const profile = yahooProfile({
      assetProfile: { longBusinessSummary: "The trust seeks…" },
      summaryDetail: { trailingAnnualDividendRate: 5.662, totalAssets: 809_216_114_688 },
      defaultKeyStatistics: {},
      fundProfile: { family: "State Street Investment Management", categoryName: "Large Blend", feesExpensesInvestment: { annualReportExpenseRatio: 0.000945 } },
      topHoldings: { holdings, sectorWeightings: [{ realestate: 0.017 }, { technology: 0.4045 }, { financial_services: 0.112 }, { utilities: 0 }, { something_new: 0.01 }] },
    });
    expect(profile).toMatchObject({ description: "The trust seeks…", dividend: 5.662, issuer: "State Street Investment Management", category: "Large Blend", expenseRatio: 0.000945, netAssets: 809_216_114_688 });
    expect(profile.holdings).toHaveLength(10);
    expect(profile.holdings![0]).toEqual({ name: "Holding 0", key: "yahoo:S0", weight: 0.08 });
    // largest first, in Chinese where the id is known, without the empty ones
    expect(profile.sectors).toEqual([
      { name: "科技", weight: 0.4045 },
      { name: "金融服务", weight: 0.112 },
      { name: "房地产", weight: 0.017 },
      { name: "something_new", weight: 0.01 },
    ]);
    expect(profile.shares).toBeUndefined();
  });

  it("a fund that charges nothing has an expense ratio of 0, not none", () => {
    expect(yahooProfile({ fundProfile: { family: "BNY Mellon", feesExpensesInvestment: { annualReportExpenseRatio: 0 } } })).toEqual({ issuer: "BNY Mellon", expenseRatio: 0 });
    expect(yahooProfile({ fundProfile: { family: "BNY Mellon", feesExpensesInvestment: {} } })).toEqual({ issuer: "BNY Mellon" });
    expect(tvProfile({ type: "fund", issuer: "BNY Mellon", expense_ratio: 0 })).toEqual({ issuer: "BNY Mellon", expenseRatio: 0 });
    expect(tvProfile({ type: "fund", issuer: "BNY Mellon" })).toEqual({ issuer: "BNY Mellon" });
  });

  it("an index or an FX pair has nothing; a coin has its supply; a date that was not coerced still reads", () => {
    expect(yahooProfile({ summaryDetail: {}, defaultKeyStatistics: {} })).toEqual({});
    expect(yahooProfile({ assetProfile: { description: "Bitcoin (BTC) is a cryptocurrency…", website: "https://bitcoin.org/" }, summaryDetail: { circulatingSupply: 20_096_496 } })).toEqual({
      description: "Bitcoin (BTC) is a cryptocurrency…",
      website: "https://bitcoin.org/",
      shares: 20_096_496,
    });
    expect(yahooProfile({ calendarEvents: { earnings: { earningsDate: ["2026-11-18T08:10:00.000Z"] } } }).earningsAt).toBe(Date.UTC(2026, 10, 18, 8, 10) / 1000);
    expect(yahooProfile({ calendarEvents: { earnings: { earningsDate: [1795608000] } } }).earningsAt).toBe(1795608000);
    expect(yahooProfile({ calendarEvents: { earnings: { earningsDate: [] } } })).toEqual({});
  });
});

describe("TradingView's quote fields as a profile", () => {
  it("a stock: the yield comes back as a yearly amount per share", () => {
    expect(
      tvProfile({
        type: "stock",
        lp: 229.28,
        business_description: "NVIDIA Corp. engages in…",
        sector: "Electronic Technology",
        industry: "Semiconductors",
        country: "United States",
        number_of_employees: 42000,
        web_site_url: "http://www.nvidia.com",
        total_shares_outstanding: 24_100_000_000,
        earnings_per_share_diluted_ttm: 7.9106,
        dividends_yield: 0.4361479413817167,
        earnings_release_next_date: 1795608000,
      }),
    ).toEqual({
      description: "NVIDIA Corp. engages in…",
      sector: "Electronic Technology",
      industry: "Semiconductors",
      country: "United States",
      employees: 42000,
      website: "http://www.nvidia.com",
      shares: 24_100_000_000,
      eps: 7.9106,
      dividend: expect.closeTo(1, 6),
      earningsAt: 1795608000,
    });
  });

  it("a fund: percentages become fractions, and the placeholder sector every fund has is dropped", () => {
    const profile = tvProfile({
      type: "fund",
      lp: 778.57,
      business_description: "SPY is the best-recognized…",
      sector: "Miscellaneous",
      industry: "Investment Trusts/Mutual Funds",
      country: "United States",
      issuer: "State Street Corp.",
      expense_ratio: 0.0945,
      aum: 816_735_908_245.651,
      top_holdings: [
        { name: "NVIDIA Corporation", symbol: "NASDAQ:NVDA", weight: 8.317411962275981, shares: 295571381 },
        { name: "Apple Inc.", symbol: "NASDAQ:AAPL", weight: 7.408596758467232 },
        { name: "Cash", weight: 0.1 },
        { weight: 3 },
      ],
    });
    expect(profile).toEqual({
      description: "SPY is the best-recognized…",
      country: "United States",
      issuer: "State Street Corp.",
      expenseRatio: expect.closeTo(0.000945, 9),
      netAssets: 816_735_908_245.651,
      holdings: [
        { name: "NVIDIA Corporation", key: "tv:NASDAQ:NVDA", weight: expect.closeTo(0.083174, 6) },
        { name: "Apple Inc.", key: "tv:NASDAQ:AAPL", weight: expect.closeTo(0.074086, 6) },
        { name: "Cash", weight: 0.001 },
      ],
    });
  });

  it("an index, a commodity or a yield answers with its type and nothing to keep", () => {
    expect(tvProfile({ type: "index", lp: 98.7 })).toEqual({});
    expect(tvProfile({ type: "commodity", lp: 4216 })).toEqual({});
    expect(tvProfile({ type: "bond", lp: 4.1, coupon: 4.625 })).toEqual({});
  });
});

describe("a dataset series", () => {
  it("may carry a description in the manifest", () => {
    const manifest = parseManifest(`name: 显卡\nseries:\n  - { id: 4090-xianyu, name: RTX 4090 咸鱼, description: " 闲鱼上 RTX 4090 的每日中位成交价 " }\n  - { id: 4090-jd }\n`);
    expect(manifest.series[0].description).toBe("闲鱼上 RTX 4090 的每日中位成交价");
    expect(manifest.series[1]).toEqual({ id: "4090-jd", name: "4090-jd", file: "4090-jd.csv" });
  });
});

// ---------------------------------------------------------------------------- the cache

const SHARED = `owner: dreaife
aliases:
  BTC: binance:BTCUSDT
  GOLD: tv:TVC:GOLD
groups:
  - { name: 美股, symbols: [{ key: yahoo:NVDA, name: 英伟达 }, yahoo:SPY] }
  - { name: 比价, symbols: ["=BTC/GOLD"] }
`;
const NVDA = "yahoo:NVDA";
const EN = "NVIDIA Corporation operates as a data center scale AI infrastructure company.";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-profile-"));
const root = path.join(dir, "vault");
const secrets = path.join(dir, "secrets");
const yamlFile = path.join(root, "hebi8.yaml");
const llmFile = path.join(secrets, "llm.json");

beforeAll(() => {
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = secrets;
  fs.mkdirSync(root);
  fs.mkdirSync(secrets);
});

afterAll(() => {
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.writeFileSync(yamlFile, SHARED);
  fs.writeFileSync(llmFile, JSON.stringify({ base: "http://llm.test/v1/", key: "sk-test", model: "test-model" }));
  session.id = undefined;
  const { getDb } = await import("@/lib/db");
  getDb().exec("DELETE FROM profiles; DELETE FROM translations; DELETE FROM symbols; DELETE FROM bars; DELETE FROM quotes");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A model that answers after `ms`, and what it was asked. */
function fakeModel(answer: string, ms = 0) {
  const calls: { url: string; auth: string | null; body: { model: string; messages: { role: string; content: string }[] } }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    await new Promise((r) => setTimeout(r, ms));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: ` ${answer}\n` } }] }), { status: 200 });
  });
  return calls;
}

async function login(name: string) {
  const { createSession } = await import("@/lib/secrets");
  session.id = createSession({ login: name, avatar_url: "", access_token: null, access_expires_at: null, refresh_token: null, refresh_expires_at: null });
}

describe("fetching profiles into the cache", () => {
  it("a fetch is stored; a failed one keeps the facts from before and its error on that symbol", async () => {
    const { adapters } = await import("@/lib/sources");
    const { readProfile, refreshProfile } = await import("@/lib/profiles");
    const fetched = vi.spyOn(adapters.yahoo, "profile").mockResolvedValue({ description: EN, shares: 100, eps: 2 });
    // asked twice at once: one request
    await Promise.all([refreshProfile(NVDA), refreshProfile(NVDA)]);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveBeenCalledWith("NVDA");
    const first = readProfile(NVDA)!;
    expect(first).toMatchObject({ profile: { description: EN, shares: 100, eps: 2 }, error: null });
    expect(first.fetchedAt).toBe(first.triedAt);

    fetched.mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    await expect(refreshProfile(NVDA)).resolves.toBeUndefined();
    const second = readProfile(NVDA)!;
    expect(second).toMatchObject({ profile: { description: EN, shares: 100, eps: 2 }, fetchedAt: first.fetchedAt, error: "HTTP 429 Too Many Requests" });

    // a symbol that never had one: only the error
    await refreshProfile("yahoo:SPY");
    expect(readProfile("yahoo:SPY")).toMatchObject({ profile: null, fetchedAt: null, error: "HTTP 429 Too Many Requests" });
    // a source without profiles is not asked and gets no row
    await refreshProfile("binance:BTCUSDT");
    expect(readProfile("binance:BTCUSDT")).toBeNull();
  });

  it("the weekly refresh only asks for what is due", async () => {
    const { adapters } = await import("@/lib/sources");
    const { readProfile, refreshProfiles, writeProfile } = await import("@/lib/profiles");
    const yahoo = vi.spyOn(adapters.yahoo, "profile").mockResolvedValue({ description: "new" });
    const tv = vi.spyOn(adapters.tv, "profile").mockRejectedValue(new Error("TradingView profile: no data for TVC:GOLD"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeProfile(NVDA, { description: "six days old" }, NOW - 6 * DAY);
    writeProfile("yahoo:SPY", { description: "eight days old" }, NOW - 8 * DAY);
    await refreshProfiles([NVDA, "yahoo:SPY", "yahoo:SPY", "tv:TVC:GOLD", "binance:BTCUSDT"], NOW);
    expect(yahoo.mock.calls).toEqual([["SPY"]]);
    expect(tv.mock.calls).toEqual([["TVC:GOLD"]]);
    expect(readProfile(NVDA)!.profile).toEqual({ description: "six days old" });
    expect(readProfile("yahoo:SPY")!.profile).toEqual({ description: "new" });
    expect(readProfile("tv:TVC:GOLD")).toMatchObject({ profile: null, error: "TradingView profile: no data for TVC:GOLD" });
    // the failure does not come up again at the next sync of the day, only after a day
    await refreshProfiles(["tv:TVC:GOLD"], Date.now() + 12 * 3600_000);
    expect(tv).toHaveBeenCalledTimes(1);
    await refreshProfiles(["tv:TVC:GOLD"], Date.now() + PROFILE_RETRY_MS);
    expect(tv).toHaveBeenCalledTimes(2);
  });

  it("a symbol's first sync asks for its profile without waiting for it, and a failing profile does not fail the sync", async () => {
    const { adapters } = await import("@/lib/sources");
    const { readProfile, refreshProfile } = await import("@/lib/profiles");
    const { syncOne } = await import("@/lib/sync");
    const bar = { t: Date.UTC(2026, 9, 9) / 1000, o: 1, h: 1, l: 1, c: 1, v: null, adj: 1 };
    vi.spyOn(adapters.yahoo, "fetchDaily").mockResolvedValue({ bars: [bar], meta: { name: "NVIDIA", kind: "equity" }, mode: "replace" });
    // a source that takes its time, like a TradingView session running into its timeout
    let fail!: (err: Error) => void;
    const profile = vi.spyOn(adapters.yahoo, "profile").mockReturnValue(new Promise((_, reject) => (fail = reject)));
    expect(await syncOne(NVDA, true)).toMatchObject({ ok: true, bars: 1 });
    // the bars are in while the profile is still on its way
    expect(profile).toHaveBeenCalledTimes(1);
    expect(readProfile(NVDA)).toBeNull();
    fail(new Error("boom"));
    await refreshProfile(NVDA);
    expect(readProfile(NVDA)).toMatchObject({ profile: null, error: "boom" });
    // opened again within the day: neither fetched again
    profile.mockResolvedValue({ description: EN });
    expect(await syncOne(NVDA)).toMatchObject({ ok: true, skipped: true });
    expect(profile).toHaveBeenCalledTimes(1);
  });
});

describe("translating a description", () => {
  it("asks the model once however many click, keeps the answer, and drops it when the text changes", async () => {
    const { profileView, readTranslation, translateDescription, writeProfile } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    const cfg = readConfig(root);
    writeProfile(NVDA, { description: EN });
    expect(profileView(NVDA, cfg)).toMatchObject({ translation: null, translatable: true });

    const calls = fakeModel("英伟达公司是一家数据中心级的 AI 基础设施公司。", 20);
    const got = await Promise.all([translateDescription(NVDA), translateDescription(NVDA), translateDescription(NVDA)]);
    // each answer names the text it translates
    expect(got).toEqual(Array(3).fill({ source: EN, text: "英伟达公司是一家数据中心级的 AI 基础设施公司。" }));
    const answers = got.map((g) => g.text);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://llm.test/v1/chat/completions", auth: "Bearer sk-test", body: { model: "test-model" } });
    expect(calls[0].body.messages.at(-1)).toEqual({ role: "user", content: EN });
    // stored: the next one to open the symbol gets it without the model
    expect(await translateDescription(NVDA)).toEqual({ source: EN, text: answers[0] });
    expect(calls).toHaveLength(1);
    expect(profileView(NVDA, cfg).translation).toBe(answers[0]);

    // the weekly refresh brings the same text: still good
    writeProfile(NVDA, { description: EN, shares: 1 });
    expect(readTranslation(NVDA, EN)).toBe(answers[0]);
    // another text: the old translation is not its translation, and the button is back
    const changed = `${EN} It was incorporated in 1993.`;
    writeProfile(NVDA, { description: changed });
    expect(profileView(NVDA, cfg)).toMatchObject({ translation: null, translatable: true });
    expect((await translateDescription(NVDA)).source).toBe(changed);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.messages.at(-1)!.content).toBe(changed);
    expect(readTranslation(NVDA, EN)).toBeNull();
  });

  it("a text that changes while the model works: whoever asks next gets the new text's translation, and the late answer is not kept", async () => {
    const { profileView, readTranslation, translateDescription, writeProfile } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    const NEW = `${EN} It was incorporated in 1993.`;
    // a model that answers the old text slowly and the new one at once
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const text = (JSON.parse(String(init.body)) as { messages: { content: string }[] }).messages.at(-1)!.content;
      asked.push(text);
      await new Promise((r) => setTimeout(r, text === EN ? 60 : 5));
      return new Response(JSON.stringify({ choices: [{ message: { content: text === EN ? "旧原文的译文" : "新原文的译文" } }] }), { status: 200 });
    });
    writeProfile(NVDA, { description: EN });
    const first = translateDescription(NVDA);
    // the weekly refresh lands while the first request is on its way
    writeProfile(NVDA, { description: NEW });
    const second = translateDescription(NVDA);
    // not the first one's request: the new text is asked for and comes back as what it is
    expect(await second).toEqual({ source: NEW, text: "新原文的译文" });
    expect(asked).toEqual([EN, NEW]);
    // whoever clicked first gets what they asked for, marked as the old text's, so their page does not show it under the new one
    expect(await first).toEqual({ source: EN, text: "旧原文的译文" });
    // and its late arrival did not replace the stored translation of the text that is there now
    expect(readTranslation(NVDA, NEW)).toBe("新原文的译文");
    expect(profileView(NVDA, readConfig(root)).translation).toBe("新原文的译文");
  });

  it("is not offered without a model, for a Chinese description, or where there is nothing to translate", async () => {
    const { profileView, translateDescription, writeProfile } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    const cfg = readConfig(root);
    const calls = fakeModel("不该被调用");
    writeProfile(NVDA, { description: "贵州茅台酒股份有限公司主要从事茅台酒及系列酒的生产与销售。" });
    expect(profileView(NVDA, cfg).translatable).toBe(false);
    writeProfile("yahoo:SPY", { issuer: "State Street" });
    expect(profileView("yahoo:SPY", cfg).translatable).toBe(false);
    await expect(translateDescription("yahoo:SPY")).rejects.toThrow("没有可翻译的简介");
    await expect(translateDescription("=BTC/GOLD")).rejects.toThrow("没有可翻译的简介");

    writeProfile(NVDA, { description: EN });
    fs.rmSync(llmFile);
    expect(profileView(NVDA, cfg).translatable).toBe(false);
    await expect(translateDescription(NVDA)).rejects.toThrow("没有配置翻译用的模型");
    // a file that lacks one of the three is no configuration
    fs.writeFileSync(llmFile, JSON.stringify({ base: "http://llm.test/v1", key: "", model: "m" }));
    expect(profileView(NVDA, cfg).translatable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a model that fails stores nothing and can be asked again; the person is told what to do, the log what happened", async () => {
    const { translateProfile } = await import("@/app/actions");
    const { readTranslation, translateDescription, writeProfile } = await import("@/lib/profiles");
    writeProfile(NVDA, { description: EN });
    fs.writeFileSync(yamlFile, SHARED.replace(/^owner:.*\n/m, ""));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lastLog = () => String(logged.mock.calls.at(-1)![0]);

    vi.stubGlobal("fetch", async () => new Response('{"error":{"message":"quota exceeded"}}', { status: 429 }));
    expect(await translateProfile(NVDA)).toEqual({ ok: false, error: "翻译服务返回了错误，请稍后再试" });
    expect(lastLog()).toContain("model API 429");
    expect(lastLog()).toContain("quota exceeded");
    // an answer without a translation, and a proxy's error page with a 200
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(translateDescription(NVDA)).rejects.toThrow("翻译服务返回了错误，请稍后再试");
    vi.stubGlobal("fetch", async () => new Response("<html>Bad Gateway</html>", { status: 200 }));
    await expect(translateDescription(NVDA)).rejects.toThrow("翻译服务返回了错误，请稍后再试");
    expect(lastLog()).toContain("Bad Gateway");
    // nobody answers at all
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await translateProfile(NVDA)).toEqual({ ok: false, error: "连不上翻译服务，请稍后再试" });
    expect(lastLog()).toContain("fetch failed");
    expect(lastLog()).toContain("http://llm.test/v1/");
    // the key never reaches the log
    expect(logged.mock.calls.flat().join("\n")).not.toContain("sk-test");

    expect(readTranslation(NVDA, EN)).toBeNull();
    fakeModel("译文");
    expect((await translateDescription(NVDA)).text).toBe("译文");
  });

  it("on a shared instance a visitor cannot ask; someone logged in can, and the visitor then sees it", async () => {
    const { translateProfile } = await import("@/app/actions");
    const { profileView, writeProfile } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    writeProfile(NVDA, { description: EN });
    const calls = fakeModel("译文");
    expect(await translateProfile(NVDA)).toEqual({ ok: false, error: "请先登录" });
    expect(calls).toHaveLength(0);
    await login("alice");
    expect(await translateProfile(NVDA)).toEqual({ ok: true, source: EN, text: "译文" });
    expect(await translateProfile("not a key")).toMatchObject({ ok: false });
    session.id = undefined;
    expect(profileView(NVDA, readConfig(root)).translation).toBe("译文");
    expect(calls).toHaveLength(1);
  });

  it("without an owner anyone may ask, like every other write", async () => {
    fs.writeFileSync(yamlFile, SHARED.replace(/^owner:.*\n/m, ""));
    const { translateProfile } = await import("@/app/actions");
    const { writeProfile } = await import("@/lib/profiles");
    writeProfile(NVDA, { description: EN });
    fakeModel("译文");
    expect(await translateProfile(NVDA)).toEqual({ ok: true, source: EN, text: "译文" });
  });
});

describe("reading a profile", () => {
  it("the page's view: cached metadata, the facts, and whether the source still owes a profile", async () => {
    const { ensureSymbol, markSynced } = await import("@/lib/store");
    const { profileView, writeProfile } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    const cfg = readConfig(root);
    ensureSymbol(NVDA);
    markSynced(NVDA, { name: "NVIDIA Corporation", exchange: "NasdaqGS", currency: "USD", timezone: "America/New_York", kind: "equity", hours: "0930-1600" });
    expect(profileView(NVDA, cfg)).toMatchObject({ source: "yahoo", kind: "equity", exchange: "NasdaqGS", currency: "USD", hours: "0930-1600", profile: null, fetchedAt: null, pending: true, legs: null });
    const soon = Math.floor(Date.now() / 1000) + 30 * 86400;
    writeProfile(NVDA, { description: EN, earningsAt: soon }, NOW);
    // the day on the exchange's calendar, which is what the panel prints
    const { localDay } = await import("@/lib/time");
    expect(profileView(NVDA, cfg)).toMatchObject({ profile: { description: EN }, fetchedAt: NOW, earningsDay: localDay(soon, "America/New_York"), pending: false });
    writeProfile(NVDA, { earningsAt: soon - 60 * 86400 }, NOW);
    expect(profileView(NVDA, cfg).earningsDay).toBeNull();
    // Binance has no profiles: nothing is pending, the metadata is all there is
    expect(profileView("binance:BTCUSDT", cfg)).toMatchObject({ source: "binance", profile: null, pending: false, translatable: false });
  });

  it("the valuation price is the traded one: `prices: total` and a dividend factor on the last bar do not move it", async () => {
    const { callTool } = await import("@/lib/mcp/tools");
    const { loadDaily } = await import("@/lib/bars");
    const { writeProfile } = await import("@/lib/profiles");
    const { tradedPrice } = await import("@/lib/quotes");
    const { createToken } = await import("@/lib/secrets");
    const { ensureSymbol, markSynced, writeBars, writeQuotes } = await import("@/lib/store");
    const { readConfig } = await import("@/lib/vault");
    const { tokenViewer } = await import("@/lib/viewer");
    fs.writeFileSync(yamlFile, `prices: total\n${SHARED}`);
    const cfg = readConfig(root);
    expect(cfg.prices).toBe("total");
    ensureSymbol(NVDA);
    // the ex-dividend day's bar is not in yet: the last stored one still carries the factor
    const t = Date.UTC(2026, 9, 8) / 1000;
    writeBars(
      NVDA,
      [
        { t: t - 86400, o: 99, h: 101, l: 98, c: 99, v: 10, adj: 0.98 },
        { t, o: 99, h: 101, l: 98, c: 100, v: 10, adj: 0.98 },
      ],
      "replace",
    );
    markSynced(NVDA, { currency: "USD", timezone: "America/New_York", kind: "equity" });
    writeProfile(NVDA, { shares: 1000, eps: 5, dividend: 2 });
    // what a total-return chart draws, and what it trades at
    expect(loadDaily(NVDA, cfg.prices, cfg).at(-1)!.c).toBeCloseTo(98, 9);
    expect(tradedPrice(NVDA)).toBe(100);
    const viewer = tokenViewer(createToken({ name: "t", login: "dreaife", write: false }))!;
    const get = async () => JSON.parse((await callTool(viewer, "get_profile", { key: NVDA })).content[0].text);
    expect(await get()).toMatchObject({ price: 100, market_cap: 100_000, pe_ttm: 20, dividend_yield_pct: 2 });
    // a quote newer than the sync is the price, as on the chart
    writeQuotes([{ key: NVDA, price: 110, time: Math.floor(Date.now() / 1000), session: "open", fetchedAt: Date.now() + 1000 }]);
    expect(tradedPrice(NVDA)).toBe(110);
    expect(await get()).toMatchObject({ price: 110, market_cap: 110_000, pe_ttm: 22 });
    // one from before the sync is not: the synced bar is newer
    writeQuotes([{ key: NVDA, price: 90, time: Math.floor(Date.now() / 1000) - 7200, session: "closed", fetchedAt: Date.now() - 3600_000 }]);
    expect(tradedPrice(NVDA)).toBe(100);
    // nothing cached, a synthetic key: no price to compute with
    expect(tradedPrice("yahoo:NOPE")).toBeNull();
    expect(tradedPrice("=BTC/GOLD")).toBeNull();
  });

  it("a synthetic symbol lists its operands under the viewer's names", async () => {
    const { profileView } = await import("@/lib/profiles");
    const { readConfig } = await import("@/lib/vault");
    expect(profileView("=BTC/GOLD", readConfig(root))).toMatchObject({
      source: "expr",
      profile: null,
      pending: false,
      legs: [
        { key: "binance:BTCUSDT", name: expect.any(String) },
        { key: "tv:TVC:GOLD", name: expect.any(String) },
      ],
    });
  });

  it("get_profile: the stored facts, the numbers at the latest price, and the translation", async () => {
    const { callTool } = await import("@/lib/mcp/tools");
    const { createToken } = await import("@/lib/secrets");
    const { profileView, translateDescription, writeProfile } = await import("@/lib/profiles");
    const { ensureSymbol, markSynced, writeBars, writeQuotes } = await import("@/lib/store");
    const { tokenViewer } = await import("@/lib/viewer");
    const viewer = tokenViewer(createToken({ name: "t", login: "dreaife", write: false }))!;
    const get = async (key: string) => JSON.parse((await callTool(viewer, "get_profile", { key })).content[0].text);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);

    ensureSymbol(NVDA);
    const t = Date.UTC(2026, 9, 9) / 1000;
    writeBars(NVDA, [{ t, o: 198, h: 201, l: 197, c: 200, v: 10, adj: 1 }], "replace");
    markSynced(NVDA, { name: "NVIDIA Corporation", exchange: "NasdaqGS", currency: "USD", timezone: "America/New_York", kind: "equity", hours: "0930-1600" });
    // nothing fetched yet: what the cache has, and no request for more
    expect(await get(NVDA)).toMatchObject({ key: NVDA, name: "英伟达", source: "yahoo", type: "equity", price: 200, profile_fetched_at: null });

    writeProfile(NVDA, { description: EN, sector: "Technology", shares: 1000, eps: 8, dividend: 1, holdings: [{ name: "x", key: "yahoo:X", weight: 0.0831 }] }, NOW);
    expect(await get(NVDA)).toMatchObject({
      description: EN,
      sector: "Technology",
      price: 200,
      market_cap: 200_000,
      pe_ttm: 25,
      dividend_yield_pct: 0.5,
      shares_outstanding: 1000,
      eps_ttm: 8,
      top_holdings: [{ name: "x", key: "yahoo:X", weight_pct: 8.31 }],
      profile_fetched_at: new Date(NOW).toISOString(),
    });
    // a quote after the sync moves the price, and the numbers with it; the stored facts are the same
    writeQuotes([{ key: NVDA, price: 240, time: Math.floor(Date.now() / 1000), session: "open", fetchedAt: Date.now() + 1000 }]);
    expect(await get(NVDA)).toMatchObject({ price: 240, market_cap: 240_000, pe_ttm: 30, shares_outstanding: 1000 });
    expect(network).not.toHaveBeenCalled();

    fakeModel("译文");
    await translateDescription(NVDA);
    expect((await get(NVDA)).description_zh).toBe("译文");
    expect(profileView(NVDA, (await import("@/lib/vault")).readConfig(root)).translation).toBe("译文");
    expect(await get("=BTC/GOLD")).toMatchObject({ source: "expr", operands: [{ key: "binance:BTCUSDT" }, { key: "tv:TVC:GOLD" }] });
  });
});
