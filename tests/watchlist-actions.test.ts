import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchlistOp } from "@/lib/watchlist";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const YAML = `# 我的自选
aliases:
  BTC: binance:BTCUSDT # 比特币
  GOLD: tv:TVC:GOLD
groups:
  - name: 美股 # 先看美股
    symbols:
      - yahoo:SPY
      - { key: yahoo:QQQ, name: 纳指 } # 科技
      - yahoo:NVDA
  - name: 宏观
    symbols: [GOLD]
  - name: 加密
    symbols: [BTC]
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-watchlist-"));
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

const order = async () => {
  const { readConfig } = await import("@/lib/vault");
  return readConfig(root).groups.map((g) => `${g.name}:${g.symbols.map((s) => s.key.split(":").at(-1)).join(",")}`);
};

const edit = async (op: WatchlistOp) => {
  const { editWatchlist } = await import("@/app/actions");
  return editWatchlist(op);
};
const moveSymbol = (key: string, group: string, index = Infinity) => edit({ type: "moveSymbol", key, group, index });
const moveGroup = (name: string, index: number) => edit({ type: "moveGroup", name, index });
const addGroup = (name: string) => edit({ type: "addGroup", name });
const renameGroup = (name: string, next: string) => edit({ type: "renameGroup", name, next });
const deleteGroup = (name: string) => edit({ type: "deleteGroup", name });

describe("watchlist Server Actions", () => {
  it("moves a symbol to a position, inside its group or into another, keeping comments and fields", async () => {
    expect(await moveSymbol("yahoo:NVDA", "美股", 0)).toEqual({ ok: true });
    expect(await order()).toEqual(["美股:NVDA,SPY,QQQ", "宏观:GOLD", "加密:BTCUSDT"]);
    expect(await moveSymbol("yahoo:QQQ", "加密", 0)).toEqual({ ok: true });
    expect(await order()).toEqual(["美股:NVDA,SPY", "宏观:GOLD", "加密:QQQ,BTCUSDT"]);
    expect(read()).toContain("{ key: yahoo:QQQ, name: 纳指 } # 科技");
    expect(read()).toContain("# 比特币");
    // past the end: to the end, as the row menu's「移到分组」does
    expect(await moveSymbol("yahoo:SPY", "宏观")).toEqual({ ok: true });
    expect(await order()).toEqual(["美股:NVDA", "宏观:GOLD,SPY", "加密:QQQ,BTCUSDT"]);
    expect(await moveSymbol("yahoo:AAPL", "宏观")).toEqual({ ok: false, error: "yahoo:AAPL 不在自选里" });
  });

  it("adds, renames, moves and deletes groups; a deleted group's symbols join its neighbour", async () => {
    expect(await addGroup("港 A")).toEqual({ ok: true });
    expect(await addGroup("港 A")).toEqual({ ok: false, error: "已经有「港 A」分组了" });
    expect(await renameGroup("美股", "美国")).toEqual({ ok: true });
    expect(read()).toContain("- name: 美国 # 先看美股");
    expect(await renameGroup("美国", "宏观")).toEqual({ ok: false, error: "已经有「宏观」分组了" });
    expect(await moveGroup("加密", 0)).toEqual({ ok: true });
    expect(await order()).toEqual(["加密:BTCUSDT", "美国:SPY,QQQ,NVDA", "宏观:GOLD", "港 A:"]);
    expect(await deleteGroup("宏观")).toEqual({ ok: true });
    expect(await order()).toEqual(["加密:BTCUSDT", "美国:SPY,QQQ,NVDA,GOLD", "港 A:"]);
    expect(await deleteGroup("加密")).toEqual({ ok: true });
    expect(await order()).toEqual(["美国:BTCUSDT,SPY,QQQ,NVDA,GOLD", "港 A:"]);
    expect(await deleteGroup("港 A")).toEqual({ ok: true });
    expect(await deleteGroup("美国")).toEqual({ ok: false, error: "这是唯一的分组，先移除里面的标的" });
    expect(await deleteGroup("nope")).toEqual({ ok: false, error: "没有「nope」这个分组" });
  });

  it("writes unnamed groups' shown names down before moving groups, so later actions find the same group", async () => {
    fs.writeFileSync(yamlFile, `groups:\n  - symbols: [yahoo:SPY] # 没写名字\n  - { name: 组 2, symbols: [yahoo:QQQ] }\n  - symbols: [yahoo:NVDA]\n`);
    // the page shows 组 1, 组 2, 组 3; the third one's「组 3」is free, the first one's「组 1」too
    expect(await moveGroup("组 1", 2)).toEqual({ ok: true });
    expect(await order()).toEqual(["组 2:QQQ", "组 3:NVDA", "组 1:SPY"]);
    expect(read()).toContain("- name: 组 1\n    symbols: [ yahoo:SPY ] # 没写名字");
    // the moved group is still「组 1」: renaming it does not touch the named「组 2」
    expect(await renameGroup("组 1", "观察")).toEqual({ ok: true });
    expect(await moveSymbol("yahoo:QQQ", "观察", 0)).toEqual({ ok: true });
    expect(await order()).toEqual(["组 2:", "组 3:NVDA", "观察:QQQ,SPY"]);
  });

  it("numbers a shown name that another group already has, and keeps it when the group moves", async () => {
    fs.writeFileSync(yamlFile, `groups:\n  - { name: 组 2, symbols: [yahoo:QQQ] }\n  - symbols: [yahoo:SPY]\n`);
    expect(await order()).toEqual(["组 2:QQQ", "组 2 (2):SPY"]);
    expect(await moveGroup("组 2", 1)).toEqual({ ok: true });
    expect(await order()).toEqual(["组 2 (2):SPY", "组 2:QQQ"]);
  });

  it("renames the one group named, when an unnamed one would be shown with the same name", async () => {
    fs.writeFileSync(yamlFile, `groups:\n  - { name: 组 2, symbols: [yahoo:QQQ] }\n  - symbols: [yahoo:SPY]\n`);
    expect(await renameGroup("组 2", "观察")).toEqual({ ok: true });
    // the unnamed one keeps the name it was shown with, now that「组 2」is free
    expect(await order()).toEqual(["观察:QQQ", "组 2 (2):SPY"]);
  });

  it("leaves groups and lists written as yaml aliases alone unless the edit changes them", async () => {
    fs.writeFileSync(yamlFile, ALIASED);
    expect(await order()).toEqual(["美股:QQQ,NVDA", "观察:SPY,IWM", "组 3:AAPL"]);
    expect(await moveGroup("组 3", 0)).toEqual({ ok: true });
    expect(await order()).toEqual(["组 3:AAPL", "美股:QQQ,NVDA", "观察:SPY,IWM"]);
    expect(read()).toContain("symbols: *watch");
    expect(read()).toContain("- *us");
    // an edit inside them gives the group a list of its own; the anchored one stays as written
    expect(await moveSymbol("yahoo:IWM", "美股", 0)).toEqual({ ok: true });
    expect(await moveSymbol("yahoo:NVDA", "观察")).toEqual({ ok: true });
    expect(await order()).toEqual(["组 3:AAPL", "美股:IWM,QQQ", "观察:SPY,NVDA"]);
    expect(read()).toContain("watch: &watch [ yahoo:SPY, yahoo:IWM ]");
    expect(read()).toContain("us: &us { name: 美股, symbols: [ yahoo:QQQ, yahoo:NVDA ] }");
  });
});

const ALIASED = `us: &us { name: 美股, symbols: [yahoo:QQQ, yahoo:NVDA] }
watch: &watch [yahoo:SPY, yahoo:IWM]
groups:
  - *us
  - { name: 观察, symbols: *watch }
  - symbols: [yahoo:AAPL]
`;

/** The watchlist as the page holds it, from the yaml as read. */
const shown = async () => {
  const { readConfig } = await import("@/lib/vault");
  return readConfig(root).groups.map((g) => ({ name: g.name, items: g.symbols.map((s) => ({ key: s.key })) }));
};

describe("the yaml ends up as the page shows an edit", () => {
  const LISTS = [
    YAML,
    // unnamed groups, one shown with a name another group has, and a name written twice
    `groups:\n  - symbols: [yahoo:SPY]\n  - { name: 组 1, symbols: [yahoo:QQQ] }\n  - symbols: [yahoo:NVDA, yahoo:AAPL]\n  - { name: 组 3 }\n  - { name: 美股, symbols: [yahoo:MSFT] }\n  - { name: 美股, symbols: [yahoo:TSLA] }\n`,
    // one group
    `groups:\n  - { name: 全部, symbols: [yahoo:SPY, yahoo:QQQ] }\n`,
    // groups and lists written as yaml aliases
    ALIASED,
  ];

  it.each(LISTS.map((yaml, i) => [i, yaml]))("list %i: every edit, valid or not, on both sides", async (_, yaml) => {
    fs.writeFileSync(yamlFile, yaml);
    const { applyOp, opError } = await import("@/lib/watchlist");
    const before = await shown();
    const names = [...before.map((g) => g.name), "新组", " 美股 ", ""];
    const keys = [...before.flatMap((g) => g.items.map((i) => i.key)), "yahoo:NOPE"];
    const ops: WatchlistOp[] = [
      ...keys.flatMap((key) => [{ type: "removeSymbol" as const, key }, ...names.flatMap((group) => [0, 1, 99, -1].map((index) => ({ type: "moveSymbol" as const, key, group, index })))]),
      ...names.flatMap((name) => [
        { type: "addGroup" as const, name },
        { type: "deleteGroup" as const, name },
        ...[0, 1, 99].map((index) => ({ type: "moveGroup" as const, name, index })),
        ...names.map((next) => ({ type: "renameGroup" as const, name, next })),
      ]),
    ];
    for (const op of ops) {
      fs.writeFileSync(yamlFile, yaml);
      const page = applyOp(before, op);
      const result = await edit(op);
      const error = opError(before, op);
      expect(result, JSON.stringify(op)).toEqual(error ? { ok: false, error } : { ok: true });
      expect(await shown(), JSON.stringify(op)).toEqual(page);
    }
  });
});
