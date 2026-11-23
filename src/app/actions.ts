"use server";

import { revalidatePath } from "next/cache";
import { isMap, isScalar, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { CHART_STYLES, USAGE_LIMITS, parseLineStyles, resolveKey, type ChartPrefs, type LineOverride, type FormulaDef, type UsageLimits } from "@/lib/config";
import * as ops from "@/lib/ops";
import type { AddSymbolInput, AlertInput, ColumnInput } from "@/lib/ops";
import { CHANGE_PERIODS, MAX_PERIODS } from "@/lib/periods";
import type { Translation } from "@/lib/profile";
import { translateDescription } from "@/lib/profiles";
import type { Prices } from "@/lib/series";
import { getSymbol } from "@/lib/store";
import { isSynthetic, isTimeframe, isValidKey } from "@/lib/symbols";
import { operands } from "@/lib/synth";
import { syncAll, syncOne } from "@/lib/sync";
import {
  flowNode,
  locateEntry,
  readChartState,
  readConfig,
  setList,
  setScalar,
  updateConfig,
  writeChartState,
  writeJournal,
  writeNote,
  type CompareEntry,
  type OverlaySpec,
} from "@/lib/vault";
import { getViewer, requireWriter, type Viewer } from "@/lib/viewer";
import type { WatchlistOp } from "@/lib/watchlist";
import { isWeekId } from "@/lib/week";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Every action writes as the viewer, into the viewer's vault only; nobody else's directory is
 * reachable from here. The ones an agent can also reach through `/mcp` are shells around
 * `src/lib/ops.ts`: one implementation, the same checks.
 */
async function attempt(fn: (viewer: Viewer) => Promise<void> | void, revalidate = true): Promise<ActionResult> {
  try {
    await fn(requireWriter(await getViewer()));
    if (revalidate) revalidatePath("/", "layout");
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
    for (const k of operands(key, readConfig(dir).aliases)) {
      const outcome = await syncOne(k);
      if (!outcome.ok) throw new Error(`拉取 ${k} 失败：${outcome.error}`);
    }
  });
}

/**
 * 翻译 in the chart's 商品详情 panel: the symbol's description in Simplified Chinese, from the model,
 * kept in the cache for everyone (§2.8). Like every write it needs a viewer who may write, so a
 * visitor of a shared instance cannot spend the model's quota. The page is the only caller: an
 * agent reads the original and needs no translation made for it. The answer names the text it
 * translates, so a page still showing another description does not take it for its own.
 */
export async function translateProfile(key: string): Promise<({ ok: true } & Translation) | { ok: false; error: string }> {
  try {
    requireWriter(await getViewer());
    if (!isValidKey(key)) throw new Error(`无效的 key「${key}」`);
    const translation = await translateDescription(key);
    revalidatePath("/", "layout");
    return { ok: true, ...translation };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One edit of the groups and their order, with the rules the page shows it by (`applyOp`); see `ops.editWatchlist`. */
export async function editWatchlist(op: WatchlistOp): Promise<ActionResult> {
  return attempt((viewer) => ops.editWatchlist(viewer, op));
}

export async function renameSymbol(key: string, name: string): Promise<ActionResult> {
  return attempt(({ dir }) => {
    const next = str(name);
    updateConfig(dir, (doc, current) => {
      const found = locateEntry(doc, key, current.aliases);
      if (!found) throw new Error(`${key} 不在自选里`);
      const entry = entryAsMap(doc, found.symbols, found.index);
      if (next) entry.set("name", next);
      else entry.delete("name");
    });
  });
}

export async function setBench(key: string, bench: string | null): Promise<ActionResult> {
  return attempt(async ({ dir }) => {
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
    // the yaml as it is after the fetch
    updateConfig(dir, (doc, current) => {
      const found = locateEntry(doc, key, current.aliases);
      if (!found) throw new Error(`${key} 不在自选里`);
      if (target) ops.changedWhileFetching(benchRef, target, current.aliases);
      const entry = entryAsMap(doc, found.symbols, found.index);
      if (benchRef) entry.set("bench", benchRef);
      else entry.delete("bench");
    });
  });
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

export async function saveColumn(input: ColumnInput): Promise<ActionResult> {
  return attempt((viewer) => {
    ops.saveColumn(viewer, input);
  });
}

export async function deleteColumn(id: string): Promise<ActionResult> {
  return attempt((viewer) => ops.deleteColumn(viewer, id));
}

export async function reorderColumns(ids: string[]): Promise<ActionResult> {
  return attempt((viewer) => ops.reorderColumns(viewer, ids));
}

/**
 * One change to a chart's drawings and comparisons, applied to what the file has when it runs, so
 * changes sent one after another (Server Actions run in order) each build on the one before,
 * whatever the page had when it sent them. The page shows drawings and removals at once; an added
 * comparison it shows as saved (`added`), and only that change re-renders the page, for the
 * symbol's name after its first fetch. A removal goes by the key as saved, not through aliases.
 */
export type ChartChange = { overlays: OverlaySpec[] } | { addCompare: CompareEntry } | { removeCompare: string };

export async function editChartState(key: string, change: ChartChange): Promise<ActionResult & { added?: CompareEntry }> {
  const adding = "addCompare" in change;
  let added: CompareEntry | undefined;
  const result = await attempt(async ({ dir }) => {
    if (!isValidKey(key)) throw new Error("无效的 key");
    if ("overlays" in change) {
      const overlays = (Array.isArray(change.overlays) ? change.overlays : []).flatMap((o) => {
        if (typeof o?.name !== "string" || !Array.isArray(o.points)) return [];
        const points = o.points.filter((p) => Number.isFinite(p?.timestamp) && Number.isFinite(p?.value)).map((p) => ({ timestamp: p.timestamp, value: p.value }));
        return [{ name: o.name, points, ...(o.styles ? { styles: o.styles } : {}), ...(o.lock ? { lock: true } : {}), ...(o.hidden ? { hidden: true } : {}), ...(o.extendData !== undefined ? { extendData: o.extendData } : {}), ...(typeof o.tvId === "string" ? { tvId: o.tvId } : {}), ...(o.scale === "log" || o.scale === "linear" ? { scale: o.scale } : {}) }];
      });
      writeChartState(dir, key, { ...readChartState(dir, key), overlays });
      return;
    }
    if ("removeCompare" in change) {
      // the key as saved: the page shows what the file has, and an alias may point elsewhere by now
      const state = readChartState(dir, key);
      writeChartState(dir, key, { ...state, compare: state.compare.filter((c) => c.key !== change.removeCompare) });
      return;
    }
    const target = resolveKey(str(change.addCompare?.key), readConfig(dir).aliases);
    if (!isValidKey(target) || target === key) throw new Error(`无效的比较商品「${target}」`);
    // a comparison must be in the cache before the chart asks for it
    if (!isSynthetic(target) && !getSymbol(target)?.syncedAt) {
      const outcome = await syncOne(target, true);
      if (!outcome.ok) throw new Error(`拉取 ${target} 失败：${outcome.error}`);
    }
    // the file as it is after the fetch
    const state = readChartState(dir, key);
    added = state.compare.find((c) => c.key === target);
    if (added) return;
    added = { key: target, mode: change.addCompare.mode === "pane" ? "pane" : "percent", color: str(change.addCompare.color) || "#e8891d" };
    writeChartState(dir, key, { ...state, compare: [...state.compare, added] });
  }, adding);
  return result.ok && added ? { ...result, added } : result;
}

export async function setChartPrefs(
  partial: Partial<Omit<ChartPrefs, "panes" | "styles">> & { prices?: Prices; panes?: Record<string, "main" | "sub" | null>; styles?: Record<string, LineOverride[] | null> },
): Promise<ActionResult> {
  return attempt(({ dir }) => {
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
      if (partial.styles !== undefined) {
        // an indicator back at its defaults leaves, and so does an empty `styles`
        for (const [name, lines] of Object.entries(partial.styles)) {
          const parsed = parseLineStyles(lines);
          if (parsed.length) setList(doc, ["chart", "styles", name], parsed);
          else doc.deleteIn(["chart", "styles", name]);
        }
        const styles = doc.getIn(["chart", "styles"]);
        if (isMap(styles) && !styles.items.length) doc.deleteIn(["chart", "styles"]);
      }
      if (partial.prices !== undefined) {
        if (partial.prices !== "split" && partial.prices !== "total") throw new Error("无效的价格模式");
        setScalar(doc, ["prices"], partial.prices);
      }
    });
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
