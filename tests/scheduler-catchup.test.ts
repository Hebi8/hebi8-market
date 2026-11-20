import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fetchDaily = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sources", () => ({ adapters: Object.fromEntries(["tv", "yahoo", "binance", "data"].map((s) => [s, { fetchDaily }])) }));
vi.mock("@/lib/profiles", () => ({ readProfile: () => null, refreshProfile: vi.fn(), refreshProfiles: vi.fn() }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-catchup-"));
const WATCHED = "binance:BTCUSDT";
const OPENED = "binance:ETHUSDT";
const day = Date.UTC(2026, 9, 7);
const at = (hh: number, mm = 0) => day + (hh * 60 + mm) * 60_000;

beforeAll(() => {
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_VAULT = path.join(dir, "vault");
  fs.mkdirSync(path.join(dir, "vault"));
  fs.writeFileSync(path.join(dir, "vault", "hebi8.yaml"), `sync: { at: ["06:30", "08:30"], tz: UTC }\ngroups:\n  - { name: 加密, symbols: [${WATCHED}] }\n`);
  fetchDaily.mockResolvedValue({ bars: [{ t: day / 1000, o: 1, h: 1, l: 1, c: 1, v: 1, adj: 1 }], mode: "merge", meta: {} });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.useRealTimers();
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_VAULT;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A process start: the scheduler runs once per process. */
async function start(now: number) {
  vi.setSystemTime(now);
  delete (globalThis as { hebi8Scheduler?: boolean }).hebi8Scheduler;
  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
  await vi.advanceTimersByTimeAsync(5100);
}

describe("the catch-up run after downtime", () => {
  it("goes by the last full sync, not by a symbol opened on its own since", async () => {
    vi.useFakeTimers();
    const { syncAll, syncOne } = await import("@/lib/sync");
    // the 06:30 run went through; the app was down at 08:30; at 11:00 someone opened a symbol no list has
    vi.setSystemTime(at(6, 30));
    await syncAll();
    vi.setSystemTime(at(11));
    await syncOne(OPENED);
    fetchDaily.mockClear();
    await start(at(11, 5));
    expect(fetchDaily.mock.calls.map(([ticker]) => ticker)).toEqual(["BTCUSDT"]);
    // that run covers 08:30: the next start has nothing to catch up
    fetchDaily.mockClear();
    await start(at(11, 10));
    expect(fetchDaily).not.toHaveBeenCalled();
  });
});
