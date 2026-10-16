import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigError, normalizeConfig, syncKeys } from "@/lib/config";
import { fileKey, hash6 } from "@/lib/symbols";
import {
  flowNode,
  readChartState,
  readConfig,
  readJournal,
  readNote,
  setList,
  setScalar,
  updateConfig,
  writeChartState,
  writeJournal,
  writeNote,
} from "@/lib/vault";

const EXAMPLE = path.join(process.cwd(), "vault.example", "hebi8.yaml");

describe("fileKey", () => {
  it("sanitizes keys and prefixes synthetic ones", () => {
    expect(fileKey("tv:TVC:US10Y")).toBe("tv_TVC_US10Y");
    expect(fileKey("yahoo:0700.HK")).toBe("yahoo_0700.HK");
    expect(fileKey("yahoo:^GSPC")).toBe("yahoo__GSPC");
    expect(fileKey("=BTC/GOLD")).toBe("expr_BTC_GOLD");
    expect(fileKey("=yahoo:AAPL/yahoo:^GSPC")).toBe("expr_yahoo_AAPL_yahoo__GSPC");
    expect(fileKey('="yahoo:BRK-B"*2')).toBe("expr__yahoo_BRK-B__2");
    expect(hash6("=BTC/GOLD")).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe("normalizeConfig", () => {
  const example = () => normalizeConfig(parse(fs.readFileSync(EXAMPLE, "utf8")));

  it("resolves aliases in groups and benchmarks", () => {
    const cfg = example();
    expect(cfg.groups.map((g) => g.name)).toEqual(["美股", "宏观", "加密", "港 A", "比价"]);
    expect(cfg.groups[2].symbols).toEqual([
      { key: "binance:BTCUSDT", name: "比特币", bench: null, group: "加密" },
      { key: "binance:ETHUSDT", name: "以太坊", bench: "binance:BTCUSDT", group: "加密" },
    ]);
    expect(cfg.aliases).toMatchObject({ ETH: "binance:ETHUSDT", NVDA: "yahoo:NVDA", US10Y: "tv:TVC:US10Y", DXY: "tv:TVC:DXY", HSTECH: "tv:HSI:HSTECH" });
    expect(cfg.groups[1].symbols.map((s) => s.name)).toEqual(["黄金", "美债 10 年", "美元指数"]);
    expect(cfg.groups[3].symbols[1]).toEqual({ key: "yahoo:600519.SS", name: "贵州茅台", bench: "tv:SSE:000300", group: "港 A" });
    expect(cfg.groups[4].symbols[0].key).toBe("=BTC/GOLD");
    expect(cfg.periods).toEqual(["1W", "1M", "1Y"]);
    expect(cfg.chart).toEqual({ tf: "W", log: true, style: "candle_solid", indicators: ["MA", "VOL"], params: { W: { MA: [10, 40, 200] } }, panes: {}, styles: {} });
    // nothing is assigned: alerts are each person's own
    expect(cfg.alerts).toEqual([]);
  });

  it("lists every real key that needs syncing, synthetic operands included", () => {
    const keys = syncKeys(example(), ["yahoo:QQQ", "=BTC/GOLD", "tv:HSI:HSTECH"]);
    expect(keys).toContain("tv:TVC:GOLD");
    expect(keys).toContain("yahoo:^HSI");
    expect(keys).toContain("tv:HSI:HSTECH");
    expect(keys.some((k) => k.startsWith("="))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fills defaults for an empty file", () => {
    const cfg = normalizeConfig(null);
    expect(cfg.sync.at).toEqual(["07:30", "17:30"]);
    expect(cfg.prices).toBe("split");
    expect(cfg.groups).toEqual([]);
    expect(cfg.chart.indicators).toEqual(["MA", "VOL"]);
  });

  it("keeps only main or sub for moved indicators", () => {
    const cfg = normalizeConfig({ chart: { panes: { VOL: "main", MA: "sub", RSI: "left" } } });
    expect(cfg.chart.panes).toEqual({ VOL: "main", MA: "sub" });
  });

  it("keeps each line's valid color, width and dash by its index, dropping the rest", () => {
    const cfg = normalizeConfig({
      chart: {
        styles: {
          MA: [{ color: "#F23645", size: 2 }, null, { size: 9, dash: "dotted", color: "red" }, {}],
          F_x: [{ color: "#abc", dash: "wavy" }],
          EMA: [{}, { size: 0 }],
          RSI: "thick",
        },
      },
    });
    expect(cfg.chart.styles).toEqual({ MA: [{ color: "#f23645", size: 2 }, {}, { dash: "dotted" }], F_x: [{ color: "#aabbcc" }] });
  });

  it.each([
    [{ prices: "nope" }, "prices 应为"],
    [{ groups: [{ name: "a", symbols: ["foo"] }] }, "无效的 key"],
    [{ groups: [{ name: "a", symbols: ["=BTC/GOLD"] }] }, "未知别名"],
    [{ groups: [{ name: "a", symbols: ["yahoo:SPY"] }, { name: "b", symbols: ["yahoo:SPY"] }] }, "只能出现在一个组"],
    [{ sync: { tz: "Mars/Olympus" } }, "无效的时区"],
    [{ indicators: [{ id: "bad id", formula: "close" }] }, "只能用字母"],
    [{ chart: { style: "fancy" } }, "未知样式"],
  ])("rejects %j", (raw, message) => {
    expect(() => normalizeConfig(raw)).toThrow(ConfigError);
    expect(() => normalizeConfig(raw)).toThrow(message);
  });
});

describe("vault files", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-vault-"));
    process.env.HEBI8_VAULT = dir;
    fs.copyFileSync(EXAMPLE, path.join(dir, "hebi8.yaml"));
  });
  afterAll(() => {
    delete process.env.HEBI8_VAULT;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes yaml back with comments, order and flow style intact", () => {
    updateConfig(dir, (doc) => {
      setScalar(doc, ["chart", "tf"], "M");
      setList(doc, ["periods"], ["1M", "YTD"]);
      setList(doc, ["chart", "params", "D", "MA"], [20, 50]);
      doc.setIn(["indicators", 2], flowNode(doc, { id: "x", label: "x", pane: "sub", formula: "close" }));
    });
    const text = fs.readFileSync(path.join(dir, "hebi8.yaml"), "utf8");
    expect(text).toContain("tf: M # D | 3D | W | M | Q");
    expect(text).toContain("periods: [ 1M, YTD ] # 总览显示的涨跌周期");
    expect(text).toContain("# bench：相对强弱、close(bench) 的默认基准");
    expect(text).toContain("# 按周期覆盖指标参数");
    expect(text).toContain("W: { MA: [ 10, 40, 200 ] }");
    expect(text).toContain("MA: [ 20, 50 ]");
    expect(text).toContain("{ id: x, label: x, pane: sub, formula: close }");
    expect(text.indexOf("sync:")).toBeLessThan(text.indexOf("aliases:"));
    expect(text.indexOf("aliases:")).toBeLessThan(text.indexOf("groups:"));
    const cfg = readConfig(dir);
    expect(cfg.chart.tf).toBe("M");
    expect(cfg.periods).toEqual(["1M", "YTD"]);
    expect(cfg.chart.params.D).toEqual({ MA: [20, 50] });
    expect(cfg.indicators.map((d) => d.id)).toEqual(["dev40", "vs_bench", "x"]);
  });

  it("refuses to write an invalid document", () => {
    expect(() => updateConfig(dir, (doc) => setScalar(doc, ["prices"], "nope"))).toThrow(ConfigError);
    expect(readConfig(dir).prices).toBe("split");
  });

  it("stores notes under the key's file name with the key as frontmatter", () => {
    writeNote(dir, "tv:TVC:US10Y", "# 为什么看\n利率顶");
    expect(fs.readFileSync(path.join(dir, "notes", "tv_TVC_US10Y.md"), "utf8")).toBe("---\nkey: tv:TVC:US10Y\n---\n# 为什么看\n利率顶\n");
    expect(readNote(dir, "tv:TVC:US10Y")).toBe("# 为什么看\n利率顶\n");
    expect(readNote(dir, "yahoo:SPY")).toBeNull();
    writeNote(dir, "tv:TVC:US10Y", "  ");
    expect(readNote(dir, "tv:TVC:US10Y")).toBeNull();
  });

  it("gives colliding keys a hashed file name and trusts the frontmatter", () => {
    writeNote(dir, "yahoo:A_B", "first");
    writeNote(dir, "yahoo:A/B", "second");
    expect(readNote(dir, "yahoo:A_B")).toBe("first\n");
    expect(readNote(dir, "yahoo:A/B")).toBe("second\n");
    expect(fs.existsSync(path.join(dir, "notes", `yahoo_A_B_${hash6("yahoo:A/B")}.md`))).toBe(true);
  });

  it("round-trips journals and chart state", () => {
    writeJournal(dir, "2026-W41", "## 市场\n平静");
    expect(readJournal(dir, "2026-W41")).toBe("## 市场\n平静\n");
    expect(() => writeJournal(dir, "nope", "x")).toThrow("无效的周");
    const state = { compare: [{ key: "yahoo:QQQ", mode: "percent" as const, color: "#e8891d" }], overlays: [{ name: "horizontalStraightLine", points: [{ timestamp: 1, value: 2 }] }] };
    writeChartState(dir, "=BTC/GOLD", state);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "charts", "expr_BTC_GOLD.json"), "utf8")).key).toBe("=BTC/GOLD");
    expect(readChartState(dir, "=BTC/GOLD")).toEqual(state);
    expect(readChartState(dir, "yahoo:SPY")).toEqual({ compare: [], overlays: [] });
  });
});
