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
    ["yahoo:SPY", 3349, 3304],
  ])("merges a repeated truncated response for %s, keeping old bars and updating the overlap", async (key, count, received) => {
    const old = bars(count);
    seed(old, key);
    const partial = old.slice(count - received).map((b) => ({ ...b, c: 200, adj: 0.9 }));
    fetchDaily.mockImplementation(async () => result(partial));
    expect(await syncOne(key, true)).toEqual({ key, ok: true, bars: received });
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(key)).toEqual([...old.slice(0, count - received), ...partial]);
    expect(getSymbol(key)).toMatchObject({ firstT: old[0].t, name: "updated", syncError: null });
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining("merging to preserve stored history"));
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

  it("keeps even a short cached history when both responses are empty", async () => {
    const old = bars(10);
    seed(old);
    fetchDaily.mockImplementation(async () => result([]));
    await syncOne(KEY, true);
    expect(fetchDaily).toHaveBeenCalledTimes(2);
    expect(readDaily(KEY)).toEqual(old);
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
