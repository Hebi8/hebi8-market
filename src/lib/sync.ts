import { runAlerts } from "./alerts";
import { syncKeys } from "./config";
import { profileDue } from "./profile";
import { readProfile, refreshProfile } from "./profiles";
import { adapters } from "./sources";
import type { FetchResult } from "./sources/types";
import { overviewStats } from "./quotes";
import { countBars, ensureSymbol, getSymbol, latestBarTime, markFullSync, markSyncError, markSynced, readDaily, writeBars } from "./store";
import { parseKey } from "./symbols";
import { compareKeys, loadVaults, readConfig, type VaultConfig } from "./vault";

/** Without `force`, a symbol synced this recently is left alone. */
const FRESH_MS = 60 * 60 * 1000;

export interface SyncOutcome {
  key: string;
  ok: boolean;
  skipped?: boolean;
  bars?: number;
  error?: string;
}

const inflight = new Map<string, Promise<SyncOutcome>>();
let allInFlight: Promise<SyncOutcome[]> | null = null;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function run(key: string, force: boolean): Promise<SyncOutcome> {
  let source, ticker;
  try {
    ({ source, ticker } = parseKey(key));
  } catch (err) {
    return { key, ok: false, error: message(err) };
  }
  ensureSymbol(key);
  const meta = getSymbol(key)!;
  if (!force && meta.syncedAt && Date.now() - meta.syncedAt < FRESH_MS) return { key, ok: true, skipped: true };
  try {
    const since = latestBarTime(key);
    // TV can silently truncate history; Yahoo's rolling window and edited datasets can shrink intentionally.
    const storedCount = source === "tv" ? countBars(key) : 0;
    const truncated = (r: FetchResult) => r.mode === "replace" && meta.firstT !== null && storedCount > 0 && (
      r.bars.length === 0 || r.bars[0].t > meta.firstT || storedCount - r.bars.length > Math.max(20, storedCount * 0.01)
    );
    let result = await adapters[source].fetchDaily(ticker, since);
    if (truncated(result)) {
      console.warn(`[hebi8m] ${key}: truncated history (${result.bars.length}/${storedCount} bars, first ${result.bars[0]?.t} vs ${meta.firstT}); retrying once`);
      result = await adapters[source].fetchDaily(ticker, since);
      if (truncated(result)) {
        if (result.bars.length === 0) throw new Error("no data returned");
        // A split changes the entire history: do not join old and new price scales.
        const closes = new Map(readDaily(key).map((b) => [b.t, b.c]));
        const overlap = result.bars.find((b) => closes.has(b.t));
        if (!overlap) throw new Error("truncated history has no overlap with stored bars");
        const oldClose = closes.get(overlap.t)!;
        if (Math.abs(overlap.c - oldClose) <= Math.abs(oldClose) * 1e-6) {
          console.warn(`[hebi8m] ${key}: history still truncated (${result.bars.length}/${storedCount} bars, first ${result.bars[0].t} vs ${meta.firstT}); merging to preserve stored history`);
          result.mode = "merge";
        } else {
          console.warn(`[hebi8m] ${key}: overlapping close changed (${oldClose} to ${overlap.c}); replacing truncated history to keep prices consistent`);
        }
      }
    }
    if (result.bars.length === 0 && since === null) throw new Error("no data returned");
    writeBars(key, result.bars, result.mode);
    markSynced(key, result.meta);
    // a dataset's description and links are in the manifest that just came with its bars: no request, so no week to wait (§2.8)
    if (source === "data") await refreshProfile(key);
    return { key, ok: true, bars: result.bars.length };
  } catch (err) {
    markSyncError(key, message(err));
    return { key, ok: false, error: message(err) };
  }
}

/** Fetch new bars for one key; concurrent calls share the same job. Never throws. */
function fetchKey(key: string, force: boolean): Promise<SyncOutcome> {
  let job = inflight.get(key);
  if (!job) {
    job = run(key, force).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

async function syncMany(keys: string[], force: boolean, concurrency = 4): Promise<SyncOutcome[]> {
  const queue = [...new Set(keys)];
  const results: SyncOutcome[] = [];
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) results.push(await fetchKey(key, force));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

/** What a sync fetches: the union of every vault's references and chart comparisons. */
export function unionSyncKeys(vaults: VaultConfig[]): string[] {
  return [...new Set(vaults.flatMap((v) => syncKeys(v.config, compareKeys(v.dir))))];
}

/**
 * Sync one key; used when adding a symbol (the fetch doubles as validation) and when opening one
 * that no list has. A profile it lacks or that is due
 * is asked for on the side (§2.8), since a symbol no list has is not in the weekly refresh: the
 * bars do not wait for it, and the panel that shows it looks again a moment later.
 */
export async function syncOne(key: string, force = false): Promise<SyncOutcome> {
  const outcome = await fetchKey(key, force);
  if (outcome.ok && profileDue(readProfile(key), Date.now())) void refreshProfile(key);
  return outcome;
}

/**
 * Everything any vault references, 4 at a time, then each vault's overview stats and alerts;
 * concurrent callers share the run. A run that gets through is recorded with its start, which the
 * scheduler's catch-up goes by (symbols that failed show their own error).
 */
export function syncAll(force = false): Promise<SyncOutcome[]> {
  if (allInFlight) return allInFlight;
  allInFlight = (async () => {
    const vaults = loadVaults();
    const started = Date.now();
    const results = await syncMany(unionSyncKeys(vaults), force);
    for (const v of vaults) overviewStats(v.id, v.config);
    const failed = results.filter((r) => !r.ok);
    console.log(
      `[hebi8m] synced ${results.length} symbols in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (failed.length ? `, failed: ${failed.map((r) => `${r.key} (${r.error})`).join(", ")}` : ""),
    );
    for (const v of vaults) await runAlerts(v, () => readConfig(v.dir));
    markFullSync(started);
    return results;
  })().finally(() => {
    allInFlight = null;
  });
  return allInFlight;
}
