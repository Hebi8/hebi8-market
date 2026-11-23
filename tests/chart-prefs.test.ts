import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hebi8m_session" && request.session ? { name, value: request.session } : undefined) }),
}));
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
  request.session = undefined;
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

describe("saveFibTemplate / deleteFibTemplate", () => {
  const myTpl = {
    name: "我的扩展",
    levels: [
      { level: 0, color: "#787b86" },
      { level: 1, color: "#787b86" },
      { level: 1.75, color: "#2962ff" },
      { level: 2.333, color: "#089981", enabled: false },
    ],
    extendRight: true,
    transparency: 85,
  };

  it("saves, updates and deletes personal templates under chart.fibTemplates while keeping comments", async () => {
    const { deleteFibTemplate, saveFibTemplate } = await import("@/app/actions");
    const { readConfig } = await import("@/lib/vault");

    expect(await saveFibTemplate(myTpl)).toEqual({ ok: true });
    let text = read();
    expect(text).toContain("# 图表偏好");
    expect(text).toContain("tf: W # D | W | M | Q");
    expect(text).toContain("panes: { VOL: main } # 换过窗格的指标");
    expect(readConfig(root).chart.fibTemplates).toEqual([myTpl]);

    // Saving with the same name replaces in place
    const updated = { ...myTpl, reverse: true };
    expect(await saveFibTemplate(updated)).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates).toEqual([updated]);

    // Deleting the last template removes chart.fibTemplates cleanly
    expect(await deleteFibTemplate("我的扩展")).toEqual({ ok: true });
    text = read();
    expect(text).not.toContain("fibTemplates");
    expect(text).toContain("panes: { VOL: main } # 换过窗格的指标");
    expect(readConfig(root).chart.fibTemplates).toEqual([]);
  });

  it("rejects preset names, empty names and templates with zero enabled levels", async () => {
    const { saveFibTemplate } = await import("@/app/actions");
    expect(await saveFibTemplate({ ...myTpl, name: "Rule of 7" })).toEqual({ ok: false, error: "「Rule of 7」是内置预设，请换一个名称" });
    expect(await saveFibTemplate({ ...myTpl, name: "默认" })).toEqual({ ok: false, error: "「默认」是内置预设，请换一个名称" });
    expect(await saveFibTemplate({ name: " ", levels: [{ level: 0.5, color: "#4caf50" }] })).toMatchObject({ ok: false });
    expect(await saveFibTemplate({ name: "全关", levels: [{ level: 0.5, color: "#4caf50", enabled: false }] })).toMatchObject({ ok: false });
  });

  it("blocks read-only visitors on a shared instance and keeps each user's templates isolated", async () => {
    fs.writeFileSync(yamlFile, `owner: alice\n${YAML}`);
    const { createSession } = await import("@/lib/secrets");
    const { deleteFibTemplate, saveFibTemplate } = await import("@/app/actions");
    const { readConfig, userVaultDir } = await import("@/lib/vault");

    // Unauthenticated visitor cannot write yaml
    const before = read();
    expect(await saveFibTemplate(myTpl)).toEqual({ ok: false, error: "请先登录" });
    expect(await deleteFibTemplate("我的扩展")).toEqual({ ok: false, error: "请先登录" });
    expect(read()).toBe(before);

    // Owner writes to root vault; bob writes to users/bob without touching root
    const aliceSession = createSession({ login: "alice", avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
    const bobSession = createSession({ login: "bob", avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });

    request.session = aliceSession;
    expect(await saveFibTemplate(myTpl)).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates.map((t) => t.name)).toEqual(["我的扩展"]);

    request.session = bobSession;
    const bobTpl = { name: "Bob专属", levels: [{ level: 0.618, color: "#089981" }] };
    expect(await saveFibTemplate(bobTpl)).toEqual({ ok: true });
    expect(readConfig(userVaultDir("bob")).chart.fibTemplates.map((t) => t.name)).toEqual(["Bob专属"]);
    expect(readConfig(root).chart.fibTemplates.map((t) => t.name)).toEqual(["我的扩展"]);

    // Anonymous visitor on ChartPage does not receive owner's personal fibTemplates
    const { default: ChartPage } = await import("@/app/chart/[key]/page");
    request.session = undefined;
    const guestEl = await ChartPage({ params: Promise.resolve({ key: "yahoo%3ASPY" }) });
    expect((guestEl as { props: { prefs: { fibTemplates: unknown[] } } }).props.prefs.fibTemplates).toEqual([]);
    request.session = aliceSession;
    const ownerEl = await ChartPage({ params: Promise.resolve({ key: "yahoo%3ASPY" }) });
    expect((ownerEl as { props: { prefs: { fibTemplates: { name: string }[] } } }).props.prefs.fibTemplates.map((t) => t.name)).toEqual(["我的扩展"]);
  });

  it("handles YAML aliases in ensureUserVault, saveFibTemplate, deleteFibTemplate and keeps inline comments on overwrite", async () => {
    const { deleteFibTemplate, saveFibTemplate } = await import("@/app/actions");
    const { ensureUserVault, readConfig } = await import("@/lib/vault");

    // 1. ensureUserVault expands `chart: *prefs` alias before stripping fibTemplates
    fs.writeFileSync(
      yamlFile,
      `owner: alice
x-prefs: &prefs
  tf: D
  fibTemplates:
    - name: 私密模板
      levels:
        - { level: 0.5, color: "#4caf50" }
chart: *prefs
`,
    );
    const carolDir = ensureUserVault("carol");
    const carolCfg = readConfig(carolDir);
    expect(carolCfg.chart.tf).toBe("D");
    expect(carolCfg.chart.fibTemplates).toEqual([]);
    // Owner's template must also be purged from the anchored source map in Carol's yaml
    const carolYaml = fs.readFileSync(path.join(carolDir, "hebi8.yaml"), "utf8");
    expect(carolYaml).not.toContain("私密模板");
    expect(carolYaml).not.toContain("fibTemplates");
    expect(read()).toContain("私密模板");

    // 2. saveFibTemplate and deleteFibTemplate expand `chart.fibTemplates: *myList` alias without losing entries or fake-deleting
    fs.writeFileSync(
      yamlFile,
      `x-tpls: &myList
  - name: 已有模板 # 保留行内注释
    levels: # 常用档位
      - { level: 0, color: "#787b86" }
    extendRight: true # 默认延长
chart:
  tf: W
  fibTemplates: *myList
`,
    );
    expect(await saveFibTemplate({ name: "新增模板", levels: [{ level: 0.618, color: "#089981" }], dash: "solid" })).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates.map((t) => t.name)).toEqual(["已有模板", "新增模板"]);
    expect(readConfig(root).chart.fibTemplates[1].dash).toBe("solid");

    // Delete works on aliased origin and drops the remaining one cleanly
    expect(await deleteFibTemplate("已有模板")).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates.map((t) => t.name)).toEqual(["新增模板"]);
    expect(await deleteFibTemplate("新增模板")).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates).toEqual([]);

    // Direct delete on an untouched YAML alias must expand and truly remove it (not fake-succeed)
    fs.writeFileSync(
      yamlFile,
      `x-tpls: &onlyList
  - name: 别名模板
    levels:
      - { level: 0.5, color: "#4caf50" }
chart:
  tf: W
  fibTemplates: *onlyList
`,
    );
    expect(await deleteFibTemplate("别名模板")).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates).toEqual([]);
    expect(read()).toContain("x-tpls: &onlyList");

    // 3. Same-name overwrite updates in place, keeping inline comments
    fs.writeFileSync(
      yamlFile,
      `chart:
  tf: W
  fibTemplates:
    - name: 主力模板 # 我的主力
      levels: # 档位表
        - { level: 0, color: "#787b86" }
      extendRight: true # 向右延长
`,
    );
    expect(await saveFibTemplate({ name: "主力模板", levels: [{ level: 0.618, color: "#089981" }], extendRight: false, reverse: true })).toEqual({ ok: true });
    const text = read();
    expect(text).toContain("# 我的主力");
    expect(text).toContain("# 档位表");
    expect(text).toContain("# 向右延长");
    expect(readConfig(root).chart.fibTemplates).toEqual([
      { name: "主力模板", levels: [{ level: 0.618, color: "#089981" }], extendRight: false, reverse: true },
    ]);

    // 4. Overwriting a template whose level item carries an anchor referenced by another template keeps valid YAML
    fs.writeFileSync(
      yamlFile,
      `chart:
  tf: W
  fibTemplates:
    - name: 模板A
      levels:
        - &base { level: 0, color: "#787b86" }
        - { level: 0.618, color: "#089981" }
    - name: 模板B
      levels:
        - *base
        - { level: 0.5, color: "#4caf50" }
`,
    );
    expect(await saveFibTemplate({ name: "模板A", levels: [{ level: 1, color: "#2962ff" }] })).toEqual({ ok: true });
    expect(readConfig(root).chart.fibTemplates).toEqual([
      { name: "模板A", levels: [{ level: 1, color: "#2962ff" }] },
      { name: "模板B", levels: [{ level: 0, color: "#787b86" }, { level: 0.5, color: "#4caf50" }] },
    ]);
  });
});

describe("editChartState pane and timeframes persistence", () => {
  it("persists sub-pane pane keys and normalized timeframes, omitting all-timeframe lists", async () => {
    const { editChartState } = await import("@/app/actions");
    const { readChartState } = await import("@/lib/vault");

    expect(
      await editChartState("yahoo:SPY", {
        overlays: [
          { name: "segment", points: [{ timestamp: 1, value: 30 }, { timestamp: 2, value: 70 }], pane: "RSI", timeframes: ["Y", "W"] },
          { name: "horizontalStraightLine", points: [{ timestamp: 1, value: 500 }], timeframes: ["D", "3D", "W", "M", "Q", "Y"] },
        ],
      }),
    ).toEqual({ ok: true });

    expect(readChartState(root, "yahoo:SPY").overlays).toEqual([
      { name: "segment", points: [{ timestamp: 1, value: 30 }, { timestamp: 2, value: 70 }], pane: "RSI", timeframes: ["W", "Y"] },
      { name: "horizontalStraightLine", points: [{ timestamp: 1, value: 500 }] },
    ]);
  });
});
