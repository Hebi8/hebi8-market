import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar } from "@/lib/series";
import type { FetchResult } from "@/lib/sources/types";

const fetchDaily = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sources", () => ({ adapters: Object.fromEntries(["tv", "yahoo", "binance", "data"].map((s) => [s, { fetchDaily }])) }));
vi.mock("@/lib/profiles", () => ({ readProfile: () => null, refreshProfile: vi.fn() }));

import { getDb } from "@/lib/db";
import { ensureSymbol, getSymbol, markSynced, readDaily, writeBars } from "@/lib/store";
import { syncOne } from "@/lib/sync";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-sync-"));
const KEY = "tv:BINANCE:BTCUSDT";
const bars = (n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2017, 7, 17) / 1000 + i * 86400, o: 100, h: 100, l: 100, c: 100, v: 1, adj: 1 }));
const result = (rows: Bar[], mode: FetchResult["mode"] = "replace"): FetchResult => ({ bars: rows, mode, meta: { name: "updated" } });
const seed = (rows: Bar[], key = KEY) => {
  ensureSymbol(key);
  writeBars(key, rows, "replace");
};

beforeAll(() => {
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_VAULT = path.join(dir, "vault");
});
beforeEach(() => {
  getDb().exec("DELETE FROM bars; DELETE FROM symbols");
  fetchDaily.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  getDb().close();
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_VAULT;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("full-history sync", () => {
  it("retries BTC's missing first 45 days before writing, then replaces with the recovered history", async () => {
    const old = bars(3349);
    seed(old);
    // A full response can legitimately remove a stray interior bar.
    const recovered = old.filter((_, i) => i !== 100).map((b) => ({ ...b, c: 200 }));
    fetchDaily.mockResolvedValueOnce(result(old.slice(45))).mockImplementationOnce(async () => {
      expect(readDaily(KEY)).toEqual(old);
      return result(recovered);
    });
    expect(await syncOne(KEY, true)).toEqual({ key: KEY, ok: true, bars: 3348 });
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(fetchDaily).toHaveBeenNthCalledWith(2, "BINANCE:BTCUSDT", old.at(-1)!.t);
    expect(readDaily(KEY)).toEqual(recovered);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [KEY, 3349, 3304],
    ["tv:CME_MINI:ES1!", 7361, 6000],
  ])("merges a repeated truncated response for %s, keeping old bars and updating the overlap", async (key, count, received) => {
    const old = bars(count);
    seed(old, key);
    const partial = old.slice(count - received).map((b, i) => ({ ...b, c: i === received - 1 ? 101 : b.c, v: 2 }));
    fetchDaily.mockImplementation(async () => result(partial));
    expect(await syncOne(key, true)).toEqual({ key, ok: true, bars: received });
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(key)).toEqual([...old.slice(0, count - received), ...partial]);
    expect(getSymbol(key)).toMatchObject({ firstT: old[0].t, name: "updated", syncError: null });
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("merging to preserve stored history"));
  });

  it("replaces truncated TV history when a split changes the overlapping close", async () => {
    const old = bars(3349);
    const key = "tv:NASDAQ:AAPL";
    seed(old, key);
    const partial = old.slice(45).map((b) => ({ ...b, o: 10, h: 10, l: 10, c: 10 }));
    fetchDaily.mockImplementation(async () => result(partial));
    expect(await syncOne(key, true)).toEqual({ key, ok: true, bars: 3304 });
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(key)).toEqual(partial);
    expect(getSymbol(key)?.firstT).toBe(partial[0].t);
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("replacing truncated history to keep prices consistent"));
  });

  it.each([[100.00005, true], [100.0002, false]])("uses relative tolerance for an overlapping close of %f", async (close, merge) => {
    const old = bars(100);
    seed(old);
    const partial = old.slice(20).map((b) => ({ ...b, c: close }));
    fetchDaily.mockImplementation(async () => result(partial));
    await syncOne(KEY, true);
    expect(readDaily(KEY)).toEqual(merge ? [...old.slice(0, 20), ...partial] : partial);
  });

  it("checks the first shared day even if the response starts with a day missing from the cache", async () => {
    const old = bars(100).filter((_, i) => i !== 20);
    seed(old);
    const partial = bars(100).slice(20).map((b, i) => ({ ...b, c: i === 0 ? 200 : b.c }));
    fetchDaily.mockImplementation(async () => result(partial));
    await syncOne(KEY, true);
    expect(readDaily(KEY)).toEqual([...old.slice(0, 20), ...partial]);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
  });

  it("reports a truncated response with no shared day without changing the cache or sync time", async () => {
    const old = bars(100);
    seed(old);
    fetchDaily.mockImplementation(async () => result(bars(200).slice(100)));
    expect(await syncOne(KEY, true)).toEqual({ key: KEY, ok: false, error: "truncated history has no overlap with stored bars" });
    expect(readDaily(KEY)).toEqual(old);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(getSymbol(KEY)).toMatchObject({ syncedAt: null, syncError: "truncated history has no overlap with stored bars" });
  });

  it("keeps retrying and merging when TV permanently shortens its history", async () => {
    const old = bars(100);
    seed(old);
    fetchDaily.mockImplementation(async () => result(old.slice(20)));
    await syncOne(KEY, true);
    await syncOne(KEY, true);
    expect(fetchDaily).toHaveBeenCalledTimes(4);
    expect(readDaily(KEY)).toEqual(old);
  });

  it("replaces Yahoo's later-starting history without retrying", async () => {
    const old = bars(3349);
    const key = "yahoo:SPY";
    seed(old, key);
    const partial = old.slice(45).map((b) => ({ ...b, c: 200, adj: 0.9 }));
    fetchDaily.mockResolvedValue(result(partial));
    expect(await syncOne(key, true)).toEqual({ key, ok: true, bars: 3304 });
    expect(fetchDaily).toHaveBeenCalledTimes(1);
    expect(readDaily(key)).toEqual(partial);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([4, 15])("replaces US02Y's history with %i fewer interior bars and the same first day", async (missing) => {
    const old = bars(8579);
    seed(old);
    const next = old.filter((_, i) => i < 10 || i >= 10 + missing);
    fetchDaily.mockResolvedValue(result(next));
    await syncOne(KEY, true);
    expect(fetchDaily).toHaveBeenCalledTimes(1);
    expect(readDaily(KEY)).toEqual(next);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("detects a large loss even when the first day is unchanged", async () => {
    const old = bars(7361);
    seed(old);
    fetchDaily.mockImplementation(async () => result(old.slice(0, 6000)));
    await syncOne(KEY, true);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(KEY)).toEqual(old);
  });

  it("detects a later first day even when new recent bars keep the count unchanged", async () => {
    const old = bars(3349);
    seed(old);
    const next = bars(3394).slice(45);
    fetchDaily.mockImplementation(async () => result(next));
    await syncOne(KEY, true);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(KEY)).toEqual(bars(3394));
  });

  it("reports empty responses without changing even a short cached history or its sync time", async () => {
    const old = bars(10);
    seed(old);
    vi.spyOn(Date, "now").mockReturnValue(12345);
    markSynced(KEY, {});
    vi.mocked(Date.now).mockReturnValue(99999);
    fetchDaily.mockImplementation(async () => result([]));
    expect(await syncOne(KEY, true)).toEqual({ key: KEY, ok: false, error: "no data returned" });
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(KEY)).toEqual(old);
    expect(getSymbol(KEY)).toMatchObject({ syncedAt: 12345, syncError: "no data returned" });
  });

  it("leaves the cache untouched and records the error when the retry fails", async () => {
    const old = bars(3349);
    seed(old);
    fetchDaily.mockResolvedValueOnce(result(old.slice(45))).mockRejectedValueOnce(new Error("timeout"));
    expect(await syncOne(KEY, true)).toEqual({ key: KEY, ok: false, error: "timeout" });
    expect(readDaily(KEY)).toEqual(old);
    expect(getSymbol(KEY)?.syncError).toBe("timeout");
  });

  it("accepts a first fetch without a retry and still rejects an empty first fetch", async () => {
    fetchDaily.mockResolvedValueOnce(result(bars(10))).mockResolvedValueOnce(result([]));
    expect(await syncOne(KEY, true)).toEqual({ key: KEY, ok: true, bars: 10 });
    expect(await syncOne("tv:EMPTY", true)).toMatchObject({ ok: false, error: "no data returned" });
    expect(fetchDaily).toHaveBeenCalledTimes(2);
  });

  it("leaves intentional dataset replacements and incremental merges alone", async () => {
    const old = bars(100);
    seed(old, "data:mine/series");
    seed(old, "binance:BTCUSDT");
    fetchDaily.mockResolvedValueOnce(result(old.slice(50))).mockResolvedValueOnce(result(old.slice(90), "merge"));
    await syncOne("data:mine/series", true);
    await syncOne("binance:BTCUSDT", true);
    expect(readDaily("data:mine/series")).toEqual(old.slice(50));
    expect(readDaily("binance:BTCUSDT")).toEqual(old);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("still skips a fresh symbol without fetching", async () => {
    seed(bars(10));
    markSynced(KEY, {});
    expect(await syncOne(KEY)).toEqual({ key: KEY, ok: true, skipped: true });
    expect(fetchDaily).not.toHaveBeenCalled();
  });
});
