/** In-app daily sync at the wall-clock times in `sync.at`, with a catch-up run after downtime. */
import { refreshProfiles } from "./profiles";
import { maxSyncedAt } from "./store";
import { loadVaults, syncAll, unionSyncKeys } from "./sync";
import { dayOf, partsIn, zonedToUtc } from "./tz";
import { ensureVault, readConfigSafe, vaultDir } from "./vault";

const DEFAULT_SYNC = { at: ["07:30", "17:30"], tz: "Asia/Tokyo" };

function occurrences(now: Date, at: string[], tz: string, dayOffsets: number[]): number[] {
  const today = partsIn(now, tz);
  return dayOffsets.flatMap((offset) =>
    at.map((hhmm) => {
      const [hh, mm] = hhmm.split(":").map(Number);
      return zonedToUtc({ ...dayOf(today, offset), hh, mm }, tz);
    }),
  );
}

/** The first scheduled time after `now`. */
export function nextRun(now: Date, at: string[], tz: string): Date {
  const t = now.getTime();
  return new Date(Math.min(...occurrences(now, at, tz, [0, 1, 2]).filter((x) => x > t)));
}

/** The most recent scheduled time at or before `now`. */
export function lastDue(now: Date, at: string[], tz: string): Date {
  const t = now.getTime();
  return new Date(Math.max(...occurrences(now, at, tz, [0, -1, -2]).filter((x) => x <= t)));
}

const log = (msg: string) => console.log(`[hebi8m] ${new Date().toISOString()} ${msg}`);

const globalForScheduler = globalThis as unknown as { hebi8Scheduler?: boolean; hebi8NextSync?: number };

/** When the running scheduler fires next (ms), or null if it has not started in this process. */
export function scheduledNextSync(): number | null {
  return globalForScheduler.hebi8NextSync ?? null;
}

export function startScheduler(): void {
  if (globalForScheduler.hebi8Scheduler) return;
  globalForScheduler.hebi8Scheduler = true;

  const settings = () => {
    try {
      ensureVault();
      return readConfigSafe(vaultDir()).config?.sync ?? DEFAULT_SYNC;
    } catch {
      return DEFAULT_SYNC;
    }
  };

  // on their own after a sync: a slow source must not hold back the next scheduled time
  const refreshDue = async () => {
    try {
      await refreshProfiles(unionSyncKeys(loadVaults()));
    } catch (err) {
      log(`profiles failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runSync = async (reason: string) => {
    log(`sync start (${reason})`);
    try {
      await syncAll();
    } catch (err) {
      log(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // after the bars and the alerts: the profiles that are a week old (§2.8)
    void refreshDue();
  };

  const schedule = () => {
    const { at, tz } = settings();
    const next = nextRun(new Date(), at, tz);
    globalForScheduler.hebi8NextSync = next.getTime();
    log(`next sync at ${next.toISOString()} (${at.join(" ")} ${tz})`);
    setTimeout(async () => {
      await runSync("scheduled");
      schedule();
    }, next.getTime() - Date.now());
  };

  // Like systemd's Persistent=true: if the last slot passed while the app was down, run it now.
  const { at, tz } = settings();
  let last: number | null = null;
  try {
    last = maxSyncedAt();
  } catch (err) {
    log(`cache unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (last === null || last < lastDue(new Date(), at, tz).getTime()) {
    setTimeout(() => void runSync("catch-up"), 5000);
  }
  schedule();
}
