import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { columnSortKey, MAX_COLUMNS, nextSort, sortOverviewRows, type SortableOverviewRow } from "@/lib/columns";
import { ConfigError, INSTANCE_KEYS, normalizeConfig, normalizeUserConfig, syncKeys } from "@/lib/config";
import { fmtColumnValue } from "@/lib/format";
import type { Bar } from "@/lib/series";

const request = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hebi8m_session" && request.session ? { name, value: request.session } : undefined) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const BTC = "binance:BTCUSDT";
const ETH = "binance:ETHUSDT";
const DXY = "tv:TVC:DXY";
const SPY = "yahoo:SPY";
const GPU = "data:gpu/4090-xianyu";
const DAY = 86400;
/** Monday 2024-01-01 */
const T0 = Date.UTC(2024, 0, 1) / 1000;

function makeBars(closes: number[], opts: { start?: number; volume?: (i: number) => number; openOffset?: number } = {}): Bar[] {
  const start = opts.start ?? T0;
  return closes.map((c, i) => ({
    t: start + i * DAY,
    o: c + (opts.openOffset ?? 0),
    h: c + 1,
    l: c - 1,
    c,
    v: opts.volume ? opts.volume(i) : 100,
    adj: 1,
  }));
}

describe("columns config parsing & validation", () => {
  it("defaults to [] and fills default tf (D) and format (number)", () => {
    expect(normalizeConfig(null).columns).toEqual([]);
    const cfg = normalizeConfig({
      columns: [
        { id: "dev200w", label: "距200W", formula: "(close / sma(close, 200) - 1) * 100", tf: "W", format: "pct" },
        { id: "rsi_m", label: "月RSI", formula: "rsi(close, 14)", tf: "M" },
        { label: "默认列", formula: "close / open" },
      ],
    });
    expect(cfg.columns).toHaveLength(3);
    expect(cfg.columns[0]).toEqual({ id: "dev200w", label: "距200W", formula: "(close / sma(close, 200) - 1) * 100", tf: "W", format: "pct" });
    expect(cfg.columns[1]).toEqual({ id: "rsi_m", label: "月RSI", formula: "rsi(close, 14)", tf: "M", format: "number" });
    expect(cfg.columns[2]).toMatchObject({ label: "默认列", formula: "close / open", tf: "D", format: "number" });
    expect(cfg.columns[2].id).toMatch(/^c_[0-9a-f]{6}$/);
    // omitted id is deterministic for the same definition
    expect(normalizeConfig({ columns: [{ label: "默认列", formula: "close / open" }] }).columns[0].id).toBe(cfg.columns[2].id);
  });

  it("caps columns at MAX_COLUMNS (6)", () => {
    const rawCols = Array.from({ length: MAX_COLUMNS + 3 }, (_, i) => ({ id: `c${i}`, label: `列${i}`, formula: "close" }));
    const cfg = normalizeConfig({ columns: rawCols });
    expect(cfg.columns).toHaveLength(MAX_COLUMNS);
    expect(cfg.columns.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
  });

  it("allows hand-edited broken formula in yaml without crashing config loading", () => {
    const cfg = normalizeConfig({
      columns: [
        { id: "bad_syntax", label: "坏语法", formula: "close +" },
        { id: "bad_alias", label: "未知别名", formula: "close(NOPE)" },
      ],
    });
    expect(cfg.columns).toHaveLength(2);
  });

  it.each([
    [{ columns: [{ id: "a", formula: "close" }] }, "需要 label"],
    [{ columns: [{ id: "a", label: "价格" }] }, "需要 formula"],
    [{ columns: [{ id: "bad id!", label: "坏id", formula: "close" }] }, "只能用字母、数字、下划线、横线"],
    [{ columns: [{ id: "", label: "空id", formula: "close" }] }, "只能用字母、数字、下划线、横线"],
    [{ columns: [{ id: "a", label: "错周期", formula: "close", tf: "5m" }] }, "无效的周期"],
    [{ columns: [{ id: "a", label: "错格式", formula: "close", format: "currency" }] }, "format 应为"],
    [
      {
        columns: [
          { id: "dup", label: "一", formula: "close" },
          { id: "dup", label: "二", formula: "open" },
        ],
      },
      "重复的 id",
    ],
  ])("rejects invalid columns %j", (raw, message) => {
    expect(() => normalizeConfig(raw)).toThrow(ConfigError);
    expect(() => normalizeConfig(raw)).toThrow(message);
  });

  it("treats columns as a personal vault setting, not an instance key", () => {
    expect((INSTANCE_KEYS as readonly string[]).includes("columns")).toBe(false);
    const root = normalizeConfig({
      owner: "alice",
      columns: [{ id: "root_col", label: "根列", formula: "close" }],
    });
    const user = normalizeUserConfig(
      { columns: [{ id: "user_col", label: "用户列", formula: "rsi(close, 14)", tf: "W" }] },
      root,
    );
    expect(user.columns.map((c) => c.id)).toEqual(["user_col"]);
    expect(user.ignored).toEqual([]);
  });

  it("collects cross-symbol references from columns in syncKeys", () => {
    const cfg = normalizeConfig({
      aliases: { BTC, DXY, GPU4090: GPU, RATIO: `=${BTC}/${DXY}` },
      groups: [{ name: "加密", symbols: ["BTC"] }],
      columns: [
        { id: "c1", label: "相关", formula: 'corr(close, close(DXY), 20) + close("yahoo:SPY")' },
        { id: "c2", label: "合成引用", formula: "close(RATIO) + close(GPU4090)" },
        { id: "c3", label: "坏公式", formula: "close(" },
      ],
    });
    const keys = syncKeys(cfg);
    expect(keys).toEqual(expect.arrayContaining([BTC, DXY, SPY, GPU]));
    expect(keys.some((k) => k.startsWith("="))).toBe(false);
  });
});

describe("formatting and 3-state sorting", () => {
  it("formats number, pct, ratio and missing values cleanly", () => {
    expect(fmtColumnValue(null, "number")).toBe("—");
    expect(fmtColumnValue(undefined, "pct")).toBe("—");
    expect(fmtColumnValue(NaN, "ratio")).toBe("—");
    expect(fmtColumnValue(Infinity, "number")).toBe("—");

    // pct: direct percentage points, signed, no -0.0%
    expect(fmtColumnValue(15.44, "pct")).toBe("+15.4%");
    expect(fmtColumnValue(-8.26, "pct")).toBe("−8.3%");
    expect(fmtColumnValue(0, "pct")).toBe("0.0%");
    expect(fmtColumnValue(-0.02, "pct")).toBe("0.0%");
    expect(fmtColumnValue(1234.56, "pct")).toBe("+1,234.6%");

    // ratio
    expect(fmtColumnValue(2.354, "ratio")).toBe("2.35x");
    expect(fmtColumnValue(0.8, "ratio")).toBe("0.80x");
    expect(fmtColumnValue(-1.2, "ratio")).toBe("−1.20x");
    expect(fmtColumnValue(-0.001, "ratio")).toBe("0.00x");
    expect(fmtColumnValue(120.54, "ratio")).toBe("120.5x");

    // number: adaptive precision
    expect(fmtColumnValue(64.238, "number")).toBe("64.24");
    expect(fmtColumnValue(-0.724, "number")).toBe("−0.72");
    expect(fmtColumnValue(0, "number")).toBe("0.00");
    expect(fmtColumnValue(0.0042, "number")).toBe("0.0042");
    expect(fmtColumnValue(1234.56, "number")).toBe("1,234.6");
    expect(fmtColumnValue(12345.6, "number")).toBe("12,346");
  });

  it("cycles sort desc → asc → default and always puts null last", () => {
    const colKey = columnSortKey("rsi_m");
    const s1 = nextSort(null, colKey);
    expect(s1).toEqual({ key: "col:rsi_m", dir: -1 });
    const s2 = nextSort(s1, colKey);
    expect(s2).toEqual({ key: "col:rsi_m", dir: 1 });
    const s3 = nextSort(s2, colKey);
    expect(s3).toBeNull();
    // switching column resets to desc
    expect(nextSort(s2, columnSortKey("vol_r"))).toEqual({ key: "col:vol_r", dir: -1 });

    type Row = SortableOverviewRow & { key: string };
    const rows: Row[] = [
      { key: "A", stats: null, columns: { rsi_m: 40, last: 99 } },
      { key: "B", stats: null, columns: { rsi_m: null, last: 1 } },
      { key: "C", stats: null, columns: { rsi_m: 72.5, last: 50 } },
      { key: "D", stats: null, columns: { rsi_m: -5, last: null } },
    ];
    expect(sortOverviewRows(rows, s1).map((r) => r.key)).toEqual(["C", "A", "D", "B"]);
    expect(sortOverviewRows(rows, s2).map((r) => r.key)).toEqual(["D", "A", "C", "B"]);
    expect(sortOverviewRows(rows, null).map((r) => r.key)).toEqual(["A", "B", "C", "D"]);
    // column named "last" does not collide with built-in "last" sort key
    expect(sortOverviewRows(rows, { key: columnSortKey("last"), dir: -1 }).map((r) => r.key)).toEqual(["A", "C", "B", "D"]);
  });
});

describe("columns evaluation, caching, yaml ops, MCP and shared access", () => {
  const BASE_YAML = `# 顶部注释
owner: Dreaife # 主人
sync:
  at: ["07:30"]
  tz: Asia/Tokyo
aliases:
  BTC: ${BTC} # 比特币
  ETH: ${ETH}
  DXY: ${DXY}
groups:
  - name: 加密
    symbols:
      - BTC
      - { key: ETH, bench: BTC }
      - ${SPY}
# 公式列说明注释
columns:
  - { id: dev3, label: 距3日, formula: "(close / sma(close, 3) - 1) * 100", tf: D, format: pct } # 第一列注释
  - { id: vs_b, label: 对基准, formula: "close / close(bench)", tf: D, format: ratio } # 第二列注释
alerts: []
`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-cols-"));
  const root = path.join(dir, "vault");
  const yamlFile = path.join(root, "hebi8.yaml");
  const readYaml = () => fs.readFileSync(yamlFile, "utf8");
  let sessions: Record<string, string>;

  beforeAll(async () => {
    process.env.HEBI8_VAULT = root;
    process.env.HEBI8_DB = path.join(dir, "hebi8.db");
    process.env.HEBI8_SECRETS = path.join(dir, "secrets");
    fs.mkdirSync(root);
    fs.writeFileSync(yamlFile, BASE_YAML);
    const { createSession } = await import("@/lib/secrets");
    const as = (login: string) =>
      createSession({ login, avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
    sessions = { owner: as("dreaife"), alice: as("Alice") };

    const { ensureSymbol, writeBars, markSynced } = await import("@/lib/store");
    for (const k of [BTC, ETH, DXY]) ensureSymbol(k);
    // 40 daily bars spanning 2024-01-01 .. 2024-02-09 (multiple weeks & 2 months)
    const btcCloses = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const ethCloses = Array.from({ length: 40 }, (_, i) => 50 + i);
    const dxyCloses = Array.from({ length: 40 }, (_, i) => 100 + (i % 5));
    writeBars(BTC, makeBars(btcCloses, { volume: (i) => (i === 39 ? 300 : 100) }), "replace");
    writeBars(ETH, makeBars(ethCloses, { volume: () => 50 }), "replace");
    writeBars(DXY, makeBars(dxyCloses, { volume: () => 0 }), "replace");
    for (const k of [BTC, ETH, DXY]) markSynced(k, { timezone: "UTC" });
  });

  afterAll(() => {
    delete process.env.HEBI8_VAULT;
    delete process.env.HEBI8_DB;
    delete process.env.HEBI8_SECRETS;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    request.session = undefined;
    fs.writeFileSync(yamlFile, BASE_YAML);
    fs.rmSync(path.join(root, "users"), { recursive: true, force: true });
    const { getDb } = await import("@/lib/db");
    getDb().exec("DELETE FROM quotes");
    const { resetQuotes } = await import("@/lib/quotes");
    resetQuotes();
  });

  it("quoteKeys collects cross-symbol refs from columns and skips data: sources", async () => {
    const { quoteKeys } = await import("@/lib/quotes");
    const cfg = normalizeConfig({
      aliases: { BTC, DXY, GPU4090: GPU, PAIR: `=${ETH}/${DXY}` },
      groups: [{ name: "加密", symbols: ["BTC"] }],
      columns: [
        { id: "c1", label: "美元", formula: "close / close(DXY)" },
        { id: "c2", label: "合成", formula: "close(PAIR) + close(GPU4090)" },
      ],
    });
    expect(quoteKeys([cfg]).sort()).toEqual([BTC, ETH, DXY].sort());
  });

  it("computes multi-tf, multi-line, yearopen, macd, bench, cross-ref, non-finite and broken columns while sharing SQLite reads", async () => {
    const { overviewStats } = await import("@/lib/quotes");
    const { getDb } = await import("@/lib/db");
    const cfg = normalizeConfig({
      aliases: { BTC, ETH, DXY },
      groups: [
        {
          name: "加密",
          symbols: ["BTC", { key: "ETH", bench: "BTC" }, SPY],
        },
      ],
      columns: [
        { id: "multi", label: "多行", formula: "a = sma(close, 3)\n(close / a - 1) * 100", tf: "D", format: "pct" },
        { id: "vs_b", label: "对基准", formula: "close / close(bench)", tf: "D", format: "ratio" },
        { id: "vs_dxy", label: "对美元", formula: "close / close(DXY)", tf: "W", format: "number" },
        { id: "yopen", label: "年初至今", formula: "(close / yearopen - 1) * 100", tf: "Y", format: "pct" },
        { id: "inf", label: "除零", formula: "close / 0", tf: "D", format: "number" },
        { id: "broken", label: "坏列", formula: "close(UNKNOWN)", tf: "D", format: "number" },
      ],
    });

    const spy = vi.spyOn(getDb(), "prepare");
    const barReads = () => spy.mock.calls.filter(([sql]) => sql.includes("FROM bars")).length;
    const res = overviewStats("", cfg);
    // 4 distinct real keys read once each: BTC, ETH, SPY (empty), DXY (cross-symbol ref) — never re-read across 6 columns
    expect(barReads()).toBe(4);
    // second call hits cache with zero additional SQLite reads
    expect(overviewStats("", cfg)[BTC].stats).toBe(res[BTC].stats);
    expect(barReads()).toBe(4);
    spy.mockRestore();

    // BTC last 3 closes: 174, 176, 178 -> sma(3) = 176 -> (178/176 - 1)*100
    expect(res[BTC].stats.columns!.multi).toBeCloseTo((178 / 176 - 1) * 100, 6);
    // BTC has no bench -> null; ETH has bench BTC -> 89 / 178 = 0.5
    expect(res[BTC].stats.columns!.vs_b).toBeNull();
    expect(res[ETH].stats.columns!.vs_b).toBeCloseTo(89 / 178, 6);
    // DXY last close is 100 + (39 % 5) = 104 -> BTC/DXY = 178/104
    expect(res[BTC].stats.columns!.vs_dxy).toBeCloseTo(178 / 104, 6);
    // yearopen for 2024 is first bar open = 100 -> (178/100 - 1)*100 = 78
    expect(res[BTC].stats.columns!.yopen).toBeCloseTo(78, 6);
    // Infinity becomes null; broken column becomes null without breaking valid columns
    expect(res[BTC].stats.columns!.inf).toBeNull();
    expect(res[BTC].stats.columns!.broken).toBeNull();
    // SPY has no bars -> absent from overviewStats
    expect(res[SPY]).toBeUndefined();
  });

  it("invalidates overviewStats cache on column edits, bench changes, and cross-symbol quote/sync updates", async () => {
    const { overviewStats } = await import("@/lib/quotes");
    const { writeQuotes, markSynced, writeBars } = await import("@/lib/store");
    const cfg1 = normalizeConfig({
      aliases: { BTC, ETH, DXY },
      groups: [{ name: "加密", symbols: [{ key: "ETH", bench: "BTC" }] }],
      columns: [
        { id: "dxy", label: "对美元", formula: "close / close(DXY)", tf: "D", format: "number" },
        { id: "b", label: "对基准", formula: "close / close(bench)", tf: "D", format: "number" },
      ],
    });

    const r1 = overviewStats("", cfg1);
    expect(r1[ETH].stats.columns!.dxy).toBeCloseTo(89 / 104, 6);
    expect(r1[ETH].stats.columns!.b).toBeCloseTo(89 / 178, 6);

    // 1) Column formula edit invalidates cache immediately
    const cfg2 = { ...cfg1, columns: [{ ...cfg1.columns[0], formula: "close / close(DXY) * 2" }, cfg1.columns[1]] };
    const r2 = overviewStats("", cfg2);
    expect(r2[ETH].stats.columns!.dxy).toBeCloseTo((89 / 104) * 2, 6);

    // 2) Cross-symbol DXY intraday quote updates the live column immediately
    const quoteDay = T0 + 39 * DAY + 3600;
    writeQuotes([{ key: DXY, price: 200, time: quoteDay, session: "open", fetchedAt: Date.now() + 5000 }]);
    const r3 = overviewStats("", cfg1);
    expect(r3[ETH].stats.columns!.dxy).toBeCloseTo(89 / 200, 6);

    // 3) Changing bench on ETH invalidates cache immediately
    const cfgBench = normalizeConfig({
      aliases: { BTC, ETH, DXY },
      groups: [{ name: "加密", symbols: [{ key: "ETH", bench: "DXY" }] }],
      columns: cfg1.columns,
    });
    const r4 = overviewStats("", cfgBench);
    expect(r4[ETH].stats.columns!.b).toBeCloseTo(89 / 200, 6);

    // 4) Syncing DXY with new bars supersedes older quote and refreshes cache
    const dxyUpdated = Array.from({ length: 40 }, (_, i) => (i === 39 ? 110 : 100 + (i % 5)));
    writeBars(DXY, makeBars(dxyUpdated, { volume: () => 0 }), "replace");
    markSynced(DXY, { timezone: "UTC" });
    // ensure synced_at is newer than the quote's fetchedAt (+5000)
    const { getDb } = await import("@/lib/db");
    getDb().prepare("UPDATE symbols SET synced_at = ? WHERE key = ?").run(Date.now() + 10_000, DXY);
    const r5 = overviewStats("", cfg1);
    expect(r5[ETH].stats.columns!.dxy).toBeCloseTo(89 / 110, 6);

    // Restore DXY bars for subsequent tests
    const dxyOrig = Array.from({ length: 40 }, (_, i) => 100 + (i % 5));
    writeBars(DXY, makeBars(dxyOrig, { volume: () => 0 }), "replace");
    markSynced(DXY, { timezone: "UTC" });
  });

  it("writes columns back via ops preserving yaml comments, order and enforcing MAX_COLUMNS", async () => {
    const ops = await import("@/lib/ops");
    const { readConfig } = await import("@/lib/vault");
    const viewer = { vault: "", dir: root, login: "dreaife", avatarUrl: null, canWrite: true, isOwner: true, shared: true, owner: "Dreaife" };

    // Add a new column without explicit id -> auto-generates unique id
    const added = ops.saveColumn(viewer, { label: "量比", formula: "volume / sma(volume, 20)", tf: "W", format: "ratio" });
    expect(added.id).toMatch(/^c[a-z0-9]+$/);
    expect(readConfig(root).columns.map((c) => c.id)).toEqual(["dev3", "vs_b", added.id]);

    // Edit existing column in place
    const edited = ops.saveColumn(viewer, { id: "dev3", label: "乖离3", formula: "(close / sma(close, 3) - 1) * 100", tf: "W", format: "pct" });
    expect(edited).toEqual({ id: "dev3", label: "乖离3", formula: "(close / sma(close, 3) - 1) * 100", tf: "W", format: "pct" });

    // Reorder columns
    ops.reorderColumns(viewer, [added.id, "vs_b", "dev3"]);
    expect(readConfig(root).columns.map((c) => c.id)).toEqual([added.id, "vs_b", "dev3"]);

    // Comments and root key order survive
    const text = readYaml();
    expect(text).toContain("# 顶部注释");
    expect(text).toContain("# 公式列说明注释");
    expect(text).toContain("# 第一列注释");
    expect(text).toContain("# 第二列注释");
    expect(text.indexOf("groups:")).toBeLessThan(text.indexOf("columns:"));
    expect(text.indexOf("columns:")).toBeLessThan(text.indexOf("alerts:"));

    // Validation errors refuse write
    expect(() => ops.saveColumn(viewer, { label: "坏", formula: "close(" })).toThrow();
    expect(() => ops.saveColumn(viewer, { label: "未知", formula: "close(NOPE)" })).toThrow("未知别名");
    expect(() => ops.saveColumn(viewer, { label: "", formula: "close" })).toThrow("请填写列标题");

    // Enforces MAX_COLUMNS when creating, still allows editing existing
    ops.saveColumn(viewer, { id: "c4", label: "四", formula: "close" });
    ops.saveColumn(viewer, { id: "c5", label: "五", formula: "close" });
    ops.saveColumn(viewer, { id: "c6", label: "六", formula: "close" });
    expect(readConfig(root).columns).toHaveLength(MAX_COLUMNS);
    expect(() => ops.saveColumn(viewer, { label: "七", formula: "close" })).toThrow(`最多保留 ${MAX_COLUMNS} 个公式列`);
    expect(ops.saveColumn(viewer, { id: "c6", label: "六改", formula: "open" }).label).toBe("六改");

    // Delete column
    ops.deleteColumn(viewer, "vs_b");
    expect(readConfig(root).columns.map((c) => c.id)).not.toContain("vs_b");

    // Works when `columns:` is absent or `columns: []`, and round-trips multi-line formulas
    fs.writeFileSync(yamlFile, BASE_YAML.replace(/# 公式列说明注释\ncolumns:[\s\S]*?(?=alerts:)/, ""));
    const ml = ops.saveColumn(viewer, { id: "macd_h", label: "MACD柱", formula: "d = macd(close, 5, 10)\nd - ema(d, 3)", tf: "D", format: "number" });
    expect(readConfig(root).columns).toEqual([ml]);
    expect(readConfig(root).columns[0].formula).toBe("d = macd(close, 5, 10)\nd - ema(d, 3)");

    fs.writeFileSync(yamlFile, BASE_YAML.replace(/columns:[\s\S]*?(?=alerts:)/, "columns: []\n"));
    ops.saveColumn(viewer, { id: "r14", label: "RSI", formula: "rsi(close, 14)", tf: "D", format: "number" });
    expect(readYaml()).toContain("columns:\n  - {");
    expect(readConfig(root).columns.map((c) => c.id)).toEqual(["r14"]);
  });

  it("evaluates rsi, macd and corr formulas accurately in overviewStats", async () => {
    const { overviewStats } = await import("@/lib/quotes");
    const cfg = normalizeConfig({
      aliases: { BTC, DXY },
      groups: [{ name: "加密", symbols: ["BTC"] }],
      columns: [
        { id: "r14", label: "RSI", formula: "rsi(close, 14)", tf: "D", format: "number" },
        { id: "mh", label: "MACD柱", formula: "macdhist(close, 12, 26, 9)", tf: "D", format: "number" },
        { id: "cr", label: "相关", formula: "corr(close, close(DXY), 10)", tf: "D", format: "number" },
      ],
    });
    const cols = overviewStats("", cfg)[BTC].stats.columns!;
    // Strictly rising series -> RSI(14) = 100, macdhist finite, corr finite
    expect(cols.r14).toBeCloseTo(100, 6);
    expect(typeof cols.mh).toBe("number");
    expect(Number.isFinite(cols.mh)).toBe(true);
    expect(typeof cols.cr).toBe("number");
    expect(Number.isFinite(cols.cr)).toBe(true);
  });

  it("copies columns into a new user's vault and isolates subsequent edits", async () => {
    const { ensureUserVault, readConfig } = await import("@/lib/vault");
    const ops = await import("@/lib/ops");
    const aliceDir = ensureUserVault("alice");
    expect(readConfig(aliceDir).columns.map((c) => c.id)).toEqual(["dev3", "vs_b"]);

    const aliceViewer = { vault: "alice", dir: aliceDir, login: "alice", avatarUrl: null, canWrite: true, isOwner: false, shared: true, owner: "Dreaife" };
    ops.deleteColumn(aliceViewer, "vs_b");
    expect(readConfig(aliceDir).columns.map((c) => c.id)).toEqual(["dev3"]);
    expect(readConfig(root).columns.map((c) => c.id)).toEqual(["dev3", "vs_b"]);
  });

  it("exposes custom formula columns on MCP overview only when configured", async () => {
    const { createToken } = await import("@/lib/secrets");
    const { tokenViewer } = await import("@/lib/viewer");
    const { callTool } = await import("@/lib/mcp/tools");
    const viewer = tokenViewer(createToken({ name: "ro", login: "dreaife", write: false }))!;

    const withCols = JSON.parse((await callTool(viewer, "overview", {})).content[0].text);
    expect(withCols.columns).toEqual([
      { id: "dev3", label: "距3日", tf: "D", format: "pct", formula: "(close / sma(close, 3) - 1) * 100" },
      { id: "vs_b", label: "对基准", tf: "D", format: "ratio", formula: "close / close(bench)" },
    ]);
    const btcRow = withCols.groups[0].symbols.find((s: { key: string }) => s.key === BTC);
    const ethRow = withCols.groups[0].symbols.find((s: { key: string }) => s.key === ETH);
    const spyRow = withCols.groups[0].symbols.find((s: { key: string }) => s.key === SPY);
    expect(btcRow.columns.dev3).toBeCloseTo((178 / 176 - 1) * 100, 6);
    expect(btcRow.columns.vs_b).toBeNull();
    expect(ethRow.columns.vs_b).toBeCloseTo(89 / 178, 6);
    expect(spyRow.columns).toEqual({ dev3: null, vs_b: null });

    // Remove columns -> overview omits `columns` metadata and per-symbol `columns`
    fs.writeFileSync(yamlFile, BASE_YAML.replace(/columns:[\s\S]*?(?=alerts:)/, ""));
    const withoutCols = JSON.parse((await callTool(viewer, "overview", {})).content[0].text);
    expect(withoutCols.columns).toBeUndefined();
    expect(withoutCols.groups[0].symbols[0].columns).toBeUndefined();

    // Broken hand-edited column reports `error` on that column and returns null values without crashing
    fs.writeFileSync(yamlFile, BASE_YAML.replace('close / close(bench)', 'close(NOPE)'));
    const withBroken = JSON.parse((await callTool(viewer, "overview", {})).content[0].text);
    expect(withBroken.columns[0].error).toBeUndefined();
    expect(withBroken.columns[1].error).toContain("未知别名");
    expect(withBroken.groups[0].symbols[0].columns.vs_b).toBeNull();
    expect(withBroken.groups[0].symbols[0].columns.dev3).toBeCloseTo((178 / 176 - 1) * 100, 6);
  });

  it("lets visitors see owner's column values on Home while blocking Server Action writes", async () => {
    const { default: Home } = await import("@/app/page");
    const { saveColumn, deleteColumn, reorderColumns } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");

    // Visitor (unauthenticated) sees owner's columns and computed values, with readOnly: true
    request.session = undefined;
    const homeProps = (await Home()).props.data;
    expect(homeProps.readOnly).toBe(true);
    expect(homeProps.columns.map((c: { id: string }) => c.id)).toEqual(["dev3", "vs_b"]);
    const ethItem = homeProps.groups[0].items.find((i: { key: string }) => i.key === ETH);
    expect(ethItem.columns.vs_b).toBeCloseTo(89 / 178, 6);

    // Visitor cannot write
    const before = readYaml();
    expect(await saveColumn({ label: "黑客列", formula: "close" })).toEqual({ ok: false, error: "请先登录" });
    expect(await deleteColumn("dev3")).toEqual({ ok: false, error: "请先登录" });
    expect(await reorderColumns(["vs_b", "dev3"])).toEqual({ ok: false, error: "请先登录" });
    expect(readYaml()).toBe(before);

    // Logged-in owner can write to root vault
    request.session = sessions.owner;
    expect(await saveColumn({ id: "vol", label: "量比", formula: "volume / sma(volume, 5)", tf: "D", format: "ratio" })).toEqual({ ok: true });
    expect(readYaml()).toContain("id: vol");

    // Logged-in non-owner writes only to their own vault
    request.session = sessions.alice;
    expect(await saveColumn({ id: "alice_only", label: "爱丽丝", formula: "close", tf: "D", format: "number" })).toEqual({ ok: true });
    expect(readConfig(root).columns.map((c) => c.id)).not.toContain("alice_only");
    expect(readConfig(path.join(root, "users", "alice")).columns.map((c) => c.id)).toContain("alice_only");
  });
});
