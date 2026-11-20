import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// no network here: opening a symbol only has to ask sync for its bars
const synced = vi.hoisted(() => ({ keys: [] as string[], fail: null as string | null, during: null as (() => void) | null }));
vi.mock("@/lib/sync", async (original) => ({
  ...(await original<typeof import("@/lib/sync")>()),
  syncOne: async (key: string) => {
    synced.keys.push(key);
    synced.during?.();
    synced.during = null;
    return key === synced.fail ? { key, ok: false, error: "not found" } : { key, ok: true, bars: 1 };
  },
}));

const YAML = `aliases:
  BTC: binance:BTCUSDT
  GOLD: tv:TVC:GOLD
groups:
  - { name: 美股, symbols: [yahoo:SPY] }
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-load-symbol-"));
const root = path.join(dir, "vault");
const yamlFile = path.join(root, "hebi8.yaml");
const read = () => fs.readFileSync(yamlFile, "utf8");

beforeAll(() => {
  process.env.HEBI8_VAULT = root;
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  fs.mkdirSync(root);
});

afterAll(() => {
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(yamlFile, YAML);
  synced.keys = [];
  synced.fail = null;
});

describe("loadSymbol", () => {
  it("opening a symbol no list has fetches its bars (synthetic operands too) and leaves the yaml alone", async () => {
    const { loadSymbol } = await import("@/app/actions");
    expect(await loadSymbol("yahoo:AAPL")).toEqual({ ok: true });
    expect(await loadSymbol("=BTC/GOLD")).toEqual({ ok: true });
    expect(synced.keys).toEqual(["yahoo:AAPL", "binance:BTCUSDT", "tv:TVC:GOLD"]);
    synced.fail = "yahoo:NOPE";
    expect(await loadSymbol("yahoo:NOPE")).toEqual({ ok: false, error: "拉取 yahoo:NOPE 失败：not found" });
    expect(read()).toBe(YAML);
  });
});

describe("writes that wait for a fetch", () => {
  it("adding the same symbol twice at once adds it once and says so", async () => {
    const { addSymbol } = await import("@/app/actions");
    const [a, b] = await Promise.all([addSymbol({ key: "yahoo:AAPL", group: "美股" }), addSymbol({ key: "yahoo:AAPL", group: "美股" })]);
    expect([a, b]).toEqual([{ ok: true }, { ok: false, error: "yahoo:AAPL 已经在「美股」组里" }]);
    expect(read().match(/yahoo:AAPL/g)).toHaveLength(1);
  });

  it("an alias pointed elsewhere while a fetch was out is not written", async () => {
    const { addSymbol, setBench } = await import("@/app/actions");
    fs.writeFileSync(yamlFile, YAML.replace("aliases:", "aliases:\n  PICK: yahoo:AAA"));
    synced.during = () => fs.writeFileSync(yamlFile, read().replace("PICK: yahoo:AAA", "PICK: yahoo:SPY"));
    expect(await addSymbol({ key: "PICK", group: "美股" })).toEqual({ ok: false, error: "「PICK」在拉取期间改成了 yahoo:SPY，请重试" });
    expect(read()).not.toMatch(/- PICK|PICK]/);
    // a bench the same way: here it would make SPY its own bench
    fs.writeFileSync(yamlFile, YAML.replace("aliases:", "aliases:\n  PICK: yahoo:AAA"));
    synced.during = () => fs.writeFileSync(yamlFile, read().replace("PICK: yahoo:AAA", "PICK: yahoo:SPY"));
    expect(await setBench("yahoo:SPY", "PICK")).toEqual({ ok: false, error: "「PICK」在拉取期间改成了 yahoo:SPY，请重试" });
    expect(read()).not.toContain("bench");
  });

  it("adds into a group whose list is a yaml alias", async () => {
    const { addSymbol } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    fs.writeFileSync(yamlFile, `watch: &watch [yahoo:SPY]\ngroups:\n  - { name: 美股, symbols: *watch }\n`);
    expect(await addSymbol({ key: "yahoo:AAPL", group: "美股" })).toEqual({ ok: true });
    expect(readConfig(root).groups.map((g) => g.symbols.map((s) => s.key))).toEqual([["yahoo:SPY", "yahoo:AAPL"]]);
  });

  it("an alias written while a fetch was out stays", async () => {
    const { addSymbol } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    await Promise.all([addSymbol({ key: "yahoo:0700.HK", group: "美股", alias: "腾讯" }), addSymbol({ key: "yahoo:TCEHY", group: "美股", alias: "腾讯" })]);
    expect(readConfig(root).aliases["腾讯"]).toBe("yahoo:0700.HK");
  });

  it("a new indicator is saved and switched on in one write", async () => {
    const { saveIndicator } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    const writes = vi.spyOn(fs, "renameSync");
    expect(await saveIndicator({ id: "gap", label: "缺口", pane: "sub", formula: "open - ref(close, 1)" })).toEqual({ ok: true });
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
    expect(readConfig(root)).toMatchObject({ indicators: [{ id: "gap" }], chart: { indicators: ["MA", "VOL", "gap"] } });
  });
});

describe("chart changes", () => {
  it("each change builds on the one before it, whatever the page had when it sent them", async () => {
    const { editChartState } = await import("@/app/actions");
    const { readChartState, writeChartState } = await import("@/lib/vault");
    const line = { name: "segment", points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }] };
    writeChartState(root, "yahoo:SPY", { compare: [{ key: "yahoo:QQQ", mode: "percent", color: "#1" }, { key: "yahoo:NVDA", mode: "percent", color: "#2" }], overlays: [] });
    // two comparisons removed, a line drawn and a symbol added, all sent before any answer came back
    const sent = [
      editChartState("yahoo:SPY", { removeCompare: "yahoo:QQQ" }),
      editChartState("yahoo:SPY", { overlays: [line] }),
      editChartState("yahoo:SPY", { removeCompare: "yahoo:NVDA" }),
      editChartState("yahoo:SPY", { addCompare: { key: "GOLD", mode: "pane", color: "#3" } }),
    ];
    expect(await Promise.all(sent)).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    expect(readChartState(root, "yahoo:SPY")).toEqual({ compare: [{ key: "tv:TVC:GOLD", mode: "pane", color: "#3" }], overlays: [line] });
    expect(synced.keys).toEqual(["tv:TVC:GOLD"]);
    synced.fail = "yahoo:NOPE";
    expect(await editChartState("yahoo:SPY", { addCompare: { key: "yahoo:NOPE", mode: "percent", color: "#4" } })).toEqual({ ok: false, error: "拉取 yahoo:NOPE 失败：not found" });
    expect(readChartState(root, "yahoo:SPY").compare.map((c) => c.key)).toEqual(["tv:TVC:GOLD"]);
  });
});
