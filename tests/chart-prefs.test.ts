import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const YAML = `chart: # 图表偏好
  tf: W # D | W | M | Q
  indicators: [MA, VOL]
  panes: { VOL: main } # 换过窗格的指标
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-chart-prefs-"));
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
});

describe("setChartPrefs styles", () => {
  it("writes each indicator's lines under chart.styles, keeping the comments", async () => {
    const { setChartPrefs } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");
    expect(await setChartPrefs({ styles: { MA: [{ color: "#f23645", size: 2 }, {}, { dash: "dashed" }] } })).toEqual({ ok: true });
    expect(await setChartPrefs({ styles: { x1: [{ size: 3 }] } })).toEqual({ ok: true });
    const text = read();
    expect(text).toContain("# 图表偏好");
    expect(text).toContain("tf: W # D | W | M | Q");
    expect(text).toContain("panes: { VOL: main } # 换过窗格的指标");
    expect(text).toContain(`MA: [ { color: "#f23645", size: 2 }, {}, { dash: dashed } ]`);
    expect(text).toContain("x1: [ { size: 3 } ]");
    expect(readConfig(root).chart.styles).toEqual({ MA: [{ color: "#f23645", size: 2 }, {}, { dash: "dashed" }], x1: [{ size: 3 }] });
  });

  it("drops invalid values and trailing default lines before writing", async () => {
    const { setChartPrefs } = await import("@/app/actions");
    await setChartPrefs({ styles: { MA: [{ color: "#F23645", size: 7 }, { dash: "wavy" } as never, {}] } });
    expect(read()).toContain(`MA: [ { color: "#f23645" } ]`);
  });

  it("removes an indicator back to its defaults, and chart.styles with the last one", async () => {
    const { setChartPrefs } = await import("@/app/actions");
    await setChartPrefs({ styles: { MA: [{ size: 2 }], RSI: [{ size: 3 }] } });
    await setChartPrefs({ styles: { MA: null } });
    expect(read()).not.toContain("MA: [");
    expect(read()).toContain("RSI: [ { size: 3 } ]");
    await setChartPrefs({ styles: { RSI: [{}] } });
    expect(read()).not.toContain("styles");
    expect(read()).toContain("panes: { VOL: main } # 换过窗格的指标");
  });
});
