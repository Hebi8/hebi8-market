"use server";

import { revalidatePath } from "next/cache";
import { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { CHART_STYLES, USAGE_LIMITS, resolveKey, type ChartPrefs, type FormulaDef, type UsageLimits } from "@/lib/config";
import * as ops from "@/lib/ops";
import type { AddSymbolInput, AlertInput } from "@/lib/ops";
import { CHANGE_PERIODS, MAX_PERIODS } from "@/lib/periods";
import { translateDescription } from "@/lib/profiles";
import type { Prices } from "@/lib/series";
import { getSymbol } from "@/lib/store";
import { isSynthetic, isTimeframe, isValidKey } from "@/lib/symbols";
import { parseSynth } from "@/lib/synth";
import { recomputeStats, syncAll, syncOne } from "@/lib/sync";
import {
  flowNode,
  groupName,
  groupNode,
  locateEntry,
  readConfig,
  setList,
  seqOf,
  setScalar,
  updateConfig,
  writeChartState,
  writeJournal,
  writeNote,
  type ChartState,
} from "@/lib/vault";
import { getViewer, requireWriter, type Viewer } from "@/lib/viewer";
import { isWeekId } from "@/lib/week";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Every action writes as the viewer, into the viewer's vault only; nobody else's directory is
 * reachable from here. The ones an agent can also reach through `/mcp` are shells around
 * `src/lib/ops.ts`: one implementation, the same checks.
 */
async function attempt(fn: (viewer: Viewer) => Promise<void> | void): Promise<ActionResult> {
  try {
    await fn(requireWriter(await getViewer()));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A plain `- SPY` entry becomes `{ key: SPY }` so fields can be attached without losing the alias. */
function entryAsMap(doc: Document, symbols: YAMLSeq, index: number): YAMLMap {
  const item = symbols.items[index];
  if (isMap(item)) return item;
  const ref = isScalar(item) ? String(item.value) : String(item);
  const node = flowNode(doc, { key: ref }) as YAMLMap;
  symbols.items[index] = node;
  return node;
}

/**
 * The `groups` list and where the group shown as `name` sits in it. Unnamed groups then get the
 * name they are shown with written down (a number added if another group has it), because moving
 * or deleting a group would otherwise renumber them and the page would point at the wrong one.
 */
function findGroup(doc: Document, name: string): { groups: YAMLSeq; index: number } {
  const groups = doc.get("groups");
  const index = isSeq(groups) ? groups.items.findIndex((g, i) => isMap(g) && groupName(g, i) === name) : -1;
  if (index < 0) throw new Error(`没有「${name}」这个分组`);
  const seq = groups as YAMLSeq;
  const taken = new Set(seq.items.map((g) => (isMap(g) ? String(g.get("name") ?? "").trim() : "")).filter(Boolean));
  seq.items.forEach((g, i) => {
    if (!isMap(g) || String(g.get("name") ?? "").trim()) return;
    let pinned = groupName(g, i);
    for (let n = 2; taken.has(pinned); n++) pinned = `${groupName(g, i)} (${n})`;
    taken.add(pinned);
    g.items.unshift(doc.createPair("name", pinned));
  });
  return { groups: seq, index };
}

/** A drop position from the page, inside 0..length. */
const position = (index: unknown, length: number) => (Number.isInteger(index) ? Math.min(Math.max(index as number, 0), length) : length);

export async function refresh(): Promise<ActionResult> {
  return attempt(async () => {
    await syncAll(true);
  });
}

export async function addSymbol(input: AddSymbolInput): Promise<ActionResult> {
  return attempt((viewer) => ops.addSymbol(viewer, input));
}

/**
 * Opening a symbol that is not in the list: fetch its daily bars into the cache so the chart has
 * something to show. Nothing is written to the yaml; adding it is a separate, explicit action.
 */
export async function loadSymbol(key: string): Promise<ActionResult> {
  return attempt(async ({ dir }) => {
    if (!isValidKey(key)) throw new Error(`无效的 key「${key}」`);
    const keys = isSynthetic(key) ? parseSynth(key.slice(1), readConfig(dir).aliases).keys : [key];
    for (const k of keys) {
      const outcome = await syncOne(k);
      if (!outcome.ok) throw new Error(`拉取 ${k} 失败：${outcome.error}`);
    }
  });
}

/**
 * 翻译 in the chart's 商品详情 panel: the symbol's description in Simplified Chinese, from the model,
 * kept in the cache for everyone (§2.8). Like every write it needs a viewer who may write, so a
 * visitor of a shared instance cannot spend the model's quota. The page is the only caller: an
 * agent reads the original and needs no translation made for it.
 */
export async function translateProfile(key: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    requireWriter(await getViewer());
    if (!isValidKey(key)) throw new Error(`无效的 key「${key}」`);
    const text = await translateDescription(key);
    revalidatePath("/", "layout");
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Into `group` (created when new) at `index`, counted without the moved entry; the end when omitted. */
export async function moveSymbol(key: string, group: string, index?: number): Promise<ActionResult> {
  return attempt(({ dir }) => {
    const target = str(group);
    if (!target) throw new Error("请选择分组");
    updateConfig(dir, (doc) => {
      const found = locateEntry(doc, key, readConfig(dir).aliases);
      if (!found) throw new Error(`${key} 不在自选里`);
      const [item] = found.symbols.items.splice(found.index, 1);
      const symbols = seqOf(groupNode(doc, target), "symbols", doc);
      // `[GOLD]` becomes a block list, so an entry with a comment stays on one line
      symbols.flow = false;
      symbols.items.splice(position(index, symbols.items.length), 0, item);
    });
  });
}

export async function moveGroup(name: string, index: number): Promise<ActionResult> {
  return attempt(({ dir }) => {
    updateConfig(dir, (doc) => {
      const { groups, index: from } = findGroup(doc, str(name));
      const [node] = groups.items.splice(from, 1);
      groups.items.splice(position(index, groups.items.length), 0, node);
    });
  });
}

export async function addGroup(name: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    const next = str(name);
    if (!next) throw new Error("分组名不能为空");
    if (readConfig(dir).groups.some((g) => g.name === next)) throw new Error(`已经有「${next}」分组了`);
    updateConfig(dir, (doc) => void groupNode(doc, next));
  });
}

export async function renameGroup(name: string, next: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    const to = str(next);
    if (!to) throw new Error("分组名不能为空");
    if (to === str(name)) return;
    if (readConfig(dir).groups.some((g) => g.name === to)) throw new Error(`已经有「${to}」分组了`);
    updateConfig(dir, (doc) => {
      const { index } = findGroup(doc, str(name));
      setScalar(doc, ["groups", index, "name"], to);
    });
  });
}

/** Like removing a section in TradingView: the group goes, its symbols join the group above (the one below for the first). */
export async function deleteGroup(name: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    updateConfig(dir, (doc) => {
      const { groups, index } = findGroup(doc, str(name));
      const symbols = (groups.items[index] as YAMLMap).get("symbols");
      const moving = isSeq(symbols) ? symbols.items : [];
      if (moving.length) {
        const neighbour = groups.items[index - 1] ?? groups.items[index + 1];
        if (!isMap(neighbour)) throw new Error("这是唯一的分组，先移除里面的标的");
        const into = seqOf(neighbour, "symbols", doc);
        into.flow = false;
        if (index > 0) into.items.push(...moving);
        else into.items.unshift(...moving);
      }
      groups.delete(index);
    });
  });
}

export async function renameSymbol(key: string, name: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    const next = str(name);
    updateConfig(dir, (doc) => {
      const found = locateEntry(doc, key, readConfig(dir).aliases);
      if (!found) throw new Error(`${key} 不在自选里`);
      const entry = entryAsMap(doc, found.symbols, found.index);
      if (next) entry.set("name", next);
      else entry.delete("name");
    });
  });
}

export async function setBench(key: string, bench: string | null): Promise<ActionResult> {
  return attempt(async ({ dir, vault }) => {
    const cfg = readConfig(dir);
    const benchRef = str(bench);
    const target = benchRef ? resolveKey(benchRef, cfg.aliases) : null;
    if (target) {
      if (!isValidKey(target)) throw new Error(`无效的基准「${benchRef}」`);
      if (target === key) throw new Error("基准不能是自己");
      if (!isSynthetic(target)) {
        const outcome = await syncOne(target);
        if (!outcome.ok) throw new Error(`拉取 ${target} 失败：${outcome.error}`);
      }
    }
    updateConfig(dir, (doc) => {
      const found = locateEntry(doc, key, cfg.aliases);
      if (!found) throw new Error(`${key} 不在自选里`);
      const entry = entryAsMap(doc, found.symbols, found.index);
      if (benchRef) entry.set("bench", benchRef);
      else entry.delete("bench");
    });
    recomputeStats(vault, readConfig(dir));
  });
}

export async function removeSymbol(key: string): Promise<ActionResult> {
  return attempt((viewer) => ops.removeSymbol(viewer, key));
}

export async function saveNote(key: string, body: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    if (!isValidKey(key)) throw new Error("无效的 key");
    writeNote(dir, key, String(body ?? ""));
  });
}

export async function saveJournal(week: string, body: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    if (!isWeekId(week)) throw new Error("无效的周");
    writeJournal(dir, week, String(body ?? ""));
  });
}

export async function saveIndicator(def: FormulaDef): Promise<ActionResult> {
  return attempt((viewer) => ops.saveIndicator(viewer, def));
}

export async function deleteIndicator(id: string): Promise<ActionResult> {
  return attempt((viewer) => ops.deleteIndicator(viewer, id));
}

export async function saveChartState(key: string, state: ChartState): Promise<ActionResult> {
  return attempt(async ({ dir }) => {
    if (!isValidKey(key)) throw new Error("无效的 key");
    const cfg = readConfig(dir);
    const compare = (Array.isArray(state.compare) ? state.compare : []).flatMap((c) => {
      const target = resolveKey(str(c.key), cfg.aliases);
      if (!isValidKey(target) || target === key) return [];
      return [{ key: target, mode: c.mode === "pane" ? ("pane" as const) : ("percent" as const), color: str(c.color) || "#e8891d" }];
    });
    const overlays = (Array.isArray(state.overlays) ? state.overlays : []).flatMap((o) => {
      if (typeof o?.name !== "string" || !Array.isArray(o.points)) return [];
      const points = o.points.filter((p) => Number.isFinite(p?.timestamp) && Number.isFinite(p?.value)).map((p) => ({ timestamp: p.timestamp, value: p.value }));
      return [{ name: o.name, points, ...(o.styles ? { styles: o.styles } : {}), ...(o.lock ? { lock: true } : {}), ...(o.hidden ? { hidden: true } : {}), ...(o.extendData !== undefined ? { extendData: o.extendData } : {}), ...(typeof o.tvId === "string" ? { tvId: o.tvId } : {}), ...(o.scale === "log" || o.scale === "linear" ? { scale: o.scale } : {}) }];
    });
    // compare targets must be in the cache before the chart asks for them
    for (const c of compare) {
      if (isSynthetic(c.key)) continue;
      if (!getSymbol(c.key)?.syncedAt) {
        const outcome = await syncOne(c.key, true);
        if (!outcome.ok) throw new Error(`拉取 ${c.key} 失败：${outcome.error}`);
      }
    }
    writeChartState(dir, key, { compare, overlays });
  });
}

export async function setChartPrefs(partial: Partial<Omit<ChartPrefs, "panes">> & { prices?: Prices; panes?: Record<string, "main" | "sub" | null> }): Promise<ActionResult> {
  return attempt(({ dir, vault }) => {
    const cfg = readConfig(dir);
    updateConfig(dir, (doc) => {
      if (partial.tf !== undefined) {
        if (!isTimeframe(partial.tf)) throw new Error("无效的周期");
        setScalar(doc, ["chart", "tf"], partial.tf);
      }
      if (partial.log !== undefined) setScalar(doc, ["chart", "log"], Boolean(partial.log));
      if (partial.style !== undefined) {
        if (!(partial.style in CHART_STYLES)) throw new Error("无效的样式");
        setScalar(doc, ["chart", "style"], partial.style);
      }
      if (partial.indicators !== undefined) setList(doc, ["chart", "indicators"], partial.indicators.map(String));
      if (partial.params !== undefined) {
        for (const [tf, byName] of Object.entries(partial.params)) {
          if (!isTimeframe(tf) || !byName) continue;
          for (const [name, values] of Object.entries(byName)) {
            const nums = (values ?? []).filter((n) => Number.isFinite(n) && n > 0);
            if (!nums.length) doc.deleteIn(["chart", "params", tf, name]);
            else if (doc.hasIn(["chart", "params", tf])) setList(doc, ["chart", "params", tf, name], nums);
            else doc.setIn(["chart", "params", tf], flowNode(doc, { [name]: nums }));
          }
        }
      }
      if (partial.panes !== undefined) {
        for (const [name, pane] of Object.entries(partial.panes)) {
          if (pane !== "main" && pane !== "sub") doc.deleteIn(["chart", "panes", name]);
          else if (doc.hasIn(["chart", "panes"])) setScalar(doc, ["chart", "panes", name], pane);
          else doc.setIn(["chart", "panes"], flowNode(doc, { [name]: pane }));
        }
      }
      if (partial.prices !== undefined) {
        if (partial.prices !== "split" && partial.prices !== "total") throw new Error("无效的价格模式");
        setScalar(doc, ["prices"], partial.prices);
      }
    });
    if (partial.prices !== undefined && partial.prices !== cfg.prices) recomputeStats(vault, readConfig(dir));
  });
}

export async function setPeriods(list: string[]): Promise<ActionResult> {
  return attempt(({ dir }) => {
    const valid = new Set<string>(CHANGE_PERIODS.map((p) => p.key));
    const periods = (Array.isArray(list) ? list : []).filter((p) => valid.has(p)).slice(0, MAX_PERIODS);
    if (!periods.length) throw new Error("至少选一个周期");
    updateConfig(dir, (doc) => setList(doc, ["periods"], periods));
  });
}

/** The owner's daily limits under `usage` in the root yaml (§1.7); null removes one, and an empty `usage` goes too. */
export async function setUsageLimits(limits: UsageLimits): Promise<ActionResult> {
  return attempt(({ dir, isOwner }) => {
    if (!isOwner) throw new Error("只有 owner 能改提醒阈值");
    updateConfig(dir, (doc) => {
      for (const k of Object.keys(USAGE_LIMITS) as (keyof UsageLimits)[]) {
        const v = limits?.[k] ?? null;
        if (v === null) doc.deleteIn(["usage", k]);
        else if (Number.isInteger(v) && v > 0) setScalar(doc, ["usage", k], v);
        else throw new Error(`${USAGE_LIMITS[k]}应为正整数`);
      }
      const usage = doc.get("usage");
      if (isMap(usage) && usage.items.length === 0) doc.delete("usage");
    });
  });
}

export async function setUpdown(mode: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    if (mode !== "green-up" && mode !== "red-up") throw new Error("无效的涨跌色");
    updateConfig(dir, (doc) => setScalar(doc, ["updown"], mode));
  });
}

export async function saveAlert(input: AlertInput): Promise<ActionResult> {
  return attempt(async (viewer) => void (await ops.saveAlert(viewer, input)));
}

export async function deleteAlert(id: string): Promise<ActionResult> {
  return attempt((viewer) => ops.deleteAlert(viewer, id));
}

/** 暂停 / 恢复 */
export async function setAlertEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  return attempt((viewer) => ops.setAlertEnabled(viewer, id, enabled));
}

/** 确认 an agent's draft (§2.5); 丢弃 is `deleteAlert`. */
export async function confirmAlert(id: string): Promise<ActionResult> {
  return attempt((viewer) => ops.confirmAlert(viewer, id));
}
