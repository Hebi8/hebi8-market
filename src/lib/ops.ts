/**
 * The write operations the page and the MCP endpoint share (§6): each takes the viewer, checks its
 * input and writes into that viewer's vault only. The Server Actions in `src/app/actions.ts` and
 * the tools in `src/lib/mcp/tools.ts` are thin shells around them, and both refuse a viewer that
 * may not write before calling in. Errors are thrown with the message the person reads.
 */
import { isAlias, isMap, isNode, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { compile } from "@/indicators/formula";
import { describeError } from "@/indicators/formula-indicators";
import { defaultCheck, type AlertCheck, type AlertCond, type AlertCondition, type AlertTrigger } from "./alert-conds";
import { adoptConditionState, alertIndex, editAlerts, forgetAlerts, runAlerts, serializeAlerts, setAlertsEnabled } from "./alerts";
import { COLUMN_ID, MAX_COLUMNS, RESERVED_COLUMN_IDS, isColumnFormat, newColumnId, type ColumnDef, type ColumnFormat } from "./columns";
import { aliasOf, findItem, parseAlert, parseColumn, resolveKey, type FormulaDef } from "./config";
import { liveReader } from "./quotes";
import { isCJK } from "./search";
import { isTimeframe, isValidKey, type Timeframe } from "./symbols";
import { syncOne } from "./sync";
import { operands } from "./synth";
import { JOURNAL_TEMPLATE, editGroups, flowNode, groupNode, own, readConfig, readJournal, readNote, seqOf, setList, unshare, updateConfig, writeJournal, writeNote } from "./vault";
import type { Viewer } from "./viewer";
import type { WatchlistOp } from "./watchlist";
import { isWeekId } from "./week";
import { wellKnownName } from "./wellknown";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// ---------------------------------------------------------------------------- watchlist

export interface AddSymbolInput {
  key: string;
  group: string;
  name?: string;
  bench?: string;
  /** The search text that led here (e.g.「腾讯」); remembered as an alias for the key */
  alias?: string;
}

/** An alias that now points elsewhere than the key fetched for it: the write would watch something unfetched. */
export function changedWhileFetching(ref: string, fetched: string, aliases: Record<string, string>): void {
  const now = resolveKey(ref, aliases);
  if (now !== fetched) throw new Error(`「${ref}」在拉取期间改成了 ${now}，请重试`);
}

/** Add a symbol to a group (created when new). The first fetch doubles as validation; nothing is written unless it succeeds. */
export async function addSymbol({ dir }: Viewer, input: AddSymbolInput): Promise<void> {
  const cfg = readConfig(dir);
  const ref = str(input.key);
  const key = resolveKey(ref, cfg.aliases);
  const group = str(input.group);
  if (!isValidKey(key)) throw new Error(`无效的 key「${key}」，应为 source:ticker 或 =表达式`);
  if (!group) throw new Error("请选择分组");
  const existing = findItem(cfg, key);
  if (existing) throw new Error(`${key} 已经在「${existing.group}」组里`);
  const benchRef = str(input.bench);
  const bench = benchRef ? resolveKey(benchRef, cfg.aliases) : null;
  if (bench && !isValidKey(bench)) throw new Error(`无效的基准「${bench}」`);

  for (const k of operands(key, cfg.aliases)) {
    const outcome = await syncOne(k);
    if (!outcome.ok) throw new Error(`拉取 ${k} 失败：${outcome.error}`);
  }
  if (bench) await syncOne(bench);

  const name = str(input.name) || wellKnownName(key) || "";
  const alias = str(input.alias);
  // the yaml as it is now: another add may have finished while this one fetched
  updateConfig(dir, (doc, current) => {
    const added = findItem(current, key);
    if (added) throw new Error(`${key} 已经在「${added.group}」组里`);
    changedWhileFetching(ref, key, current.aliases);
    if (benchRef) changedWhileFetching(benchRef, bench!, current.aliases);
    // a Chinese search term that found this key is worth keeping as an alias
    const keepAlias = alias && isCJK(alias) && !alias.includes(":") && !current.aliases[alias] && alias !== name;
    const symbols = seqOf(groupNode(doc, group), "symbols", doc);
    const entry: Record<string, string> = { key: ref };
    if (name) entry.name = name;
    if (benchRef) entry.bench = benchRef;
    symbols.add(name || benchRef ? flowNode(doc, entry) : doc.createNode(ref));
    if (keepAlias) {
      const aliases = doc.get("aliases");
      if (isMap(aliases)) aliases.set(alias, key);
      else doc.set("aliases", doc.createNode({ [alias]: key }));
    }
  });
}

/**
 * One edit of the watchlist's groups (move or remove a symbol; add, move, rename or delete a
 * group), by the rules the page shows it with at once (`applyOp`), so the yaml ends up as shown.
 * Keys are resolved by the caller; removing one that is not there leaves the list alone.
 */
export function editWatchlist({ dir }: Viewer, op: WatchlistOp): void {
  updateConfig(dir, (doc, current) => editGroups(doc, op, current.aliases));
}

// ---------------------------------------------------------------------------- notes and journal

/** The text after what is there, a blank line between; the first text of a note starts it. */
const appended = (body: string | null, text: string) => (body?.trim() ? `${body.replace(/\s+$/, "")}\n\n${text}` : text);

/**
 * Add to the end of a symbol's note. An agent never replaces the whole note: the page autosaves
 * it, and a whole body sent from elsewhere would undo what is being typed.
 */
export function appendNote({ dir }: Viewer, key: string, text: string): void {
  if (!isValidKey(key)) throw new Error("无效的 key");
  const add = str(text);
  if (!add) throw new Error("内容为空");
  writeNote(dir, key, appended(readNote(dir, key), add));
}

/** Add to the end of a week's journal; a week nobody has written yet starts from the page's template. */
export function appendJournal({ dir }: Viewer, week: string, text: string): void {
  if (!isWeekId(week)) throw new Error("无效的周");
  const add = str(text);
  if (!add) throw new Error("内容为空");
  writeJournal(dir, week, appended(readJournal(dir, week) ?? JOURNAL_TEMPLATE, add));
}

// ---------------------------------------------------------------------------- formula indicators

function checkFormula(dir: string, def: { id: unknown; label: unknown; formula: unknown }): { id: string; label: string; formula: string } {
  const id = str(def.id);
  const label = str(def.label) || id;
  const formula = str(def.formula);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new Error("id 只能用字母、数字、下划线");
  if (!formula) throw new Error("公式为空");
  try {
    compile(formula, { aliases: readConfig(dir).aliases });
  } catch (err) {
    throw new Error(describeError(err));
  }
  return { id, label, formula };
}

/** Create or replace a formula indicator; a new one is switched on in the chart. */
export function saveIndicator({ dir }: Viewer, def: FormulaDef): void {
  const { id, label, formula } = checkFormula(dir, def);
  const pane = def.pane === "main" ? "main" : "sub";
  updateConfig(dir, (doc, current) => {
    const seq = seqOf(doc.contents as YAMLMap, "indicators", doc);
    const index = seq.items.findIndex((item) => isMap(item) && item.get("id") === id);
    const node = flowNode(doc, { id, label, pane, formula });
    if (index >= 0) seq.items[index] = node;
    else seq.add(node);
    const enabled = current.chart.indicators;
    if (!current.indicators.some((d) => d.id === id) && !enabled.includes(id)) setList(doc, ["chart", "indicators"], [...enabled, id]);
  });
}

export function deleteIndicator({ dir }: Viewer, id: string): void {
  const target = str(id);
  updateConfig(dir, (doc) => {
    const seq = doc.get("indicators");
    if (!isSeq(seq)) return;
    const index = seq.items.findIndex((item) => isMap(item) && item.get("id") === target);
    if (index >= 0) seq.delete(index);
    const enabled = doc.getIn(["chart", "indicators"]);
    if (isSeq(enabled)) {
      const i = enabled.items.findIndex((item) => (isScalar(item) ? item.value : item) === target);
      if (i >= 0) enabled.delete(i);
    }
  });
}

// ---------------------------------------------------------------------------- overview columns

export interface ColumnInput {
  /** Existing column id when editing; omit to create a new column with an auto-generated unique id */
  id?: string;
  label: string;
  formula: string;
  tf?: Timeframe;
  format?: ColumnFormat;
}

/** Resolve `columns` as its own YAML sequence node (materializing any YAML alias or shared anchor). */
function ownColumns(doc: Document, create: boolean): YAMLSeq | null {
  if (!isMap(doc.contents)) {
    if (!create) return null;
    const seq = doc.createNode([]) as YAMLSeq;
    seq.flow = false;
    doc.set("columns", seq);
    return seq;
  }
  const existing = own(doc, doc.contents, "columns");
  if (isSeq(existing)) return existing;
  if (!create) return null;
  const seq = doc.createNode([]) as YAMLSeq;
  seq.flow = false;
  doc.contents.set("columns", seq);
  return seq;
}

function columnNodeId(doc: Document, item: unknown, index: number): string | null {
  const resolved = isAlias(item) ? item.resolve(doc) : item;
  try {
    const value = isNode(resolved) ? resolved.toJS(doc) : resolved;
    return parseColumn(value, index).id;
  } catch {
    return null;
  }
}

function columnIndex(doc: Document, seq: YAMLSeq, id: string): number {
  const active = Math.min(seq.items.length, MAX_COLUMNS);
  for (let i = 0; i < active; i++) {
    if (columnNodeId(doc, seq.items[i], i) === id) return i;
  }
  return -1;
}

/**
 * Create (when `id` is omitted) or edit (when `id` is provided) an overview formula column in the
 * viewer's yaml, keeping comments and order. Editing a column that omitted `id` in yaml persists
 * its matched id so future edits and sorting stay stable; editing a column that no longer exists
 * throws instead of resurrecting it.
 */
export function saveColumn({ dir }: Viewer, input: ColumnInput): ColumnDef {
  const label = str(input.label);
  const formula = str(input.formula);
  const tf = input.tf ?? "D";
  const format = input.format ?? "number";
  if (!label) throw new Error("请填写列标题");
  if (label.length > 40) throw new Error("列标题最多 40 个字符");
  if (!formula) throw new Error("公式为空");
  if (!isTimeframe(tf)) throw new Error("无效的周期");
  if (!isColumnFormat(format)) throw new Error("无效的展示格式");
  const isEdit = input.id !== undefined;
  const rawId = str(input.id);
  if (isEdit) {
    if (!rawId || !COLUMN_ID.test(rawId)) throw new Error("id 只能用字母、数字、下划线、横线");
    if (RESERVED_COLUMN_IDS.has(rawId)) throw new Error(`id「${rawId}」为保留名称，请换一个`);
  }

  let saved: ColumnDef | null = null;
  updateConfig(dir, (doc, current) => {
    try {
      compile(formula, { aliases: current.aliases });
    } catch (err) {
      throw new Error(describeError(err));
    }
    if (isEdit) {
      const seq = ownColumns(doc, false);
      const index = seq ? columnIndex(doc, seq, rawId) : -1;
      if (!seq || index < 0) throw new Error("这个公式列已经不在 hebi8.yaml 里了");
      const node = own(doc, seq, index);
      if (isMap(node)) {
        if (!node.has("id")) node.items.unshift(doc.createPair("id", rawId));
        setField(doc, node, "label", label);
        setField(doc, node, "formula", formula);
        setField(doc, node, "tf", tf);
        setField(doc, node, "format", format);
        saved = parseColumn(node.toJS(doc), index);
      } else {
        const entry: ColumnDef = { id: rawId, label, formula, tf, format };
        seq.items[index] = flowNode(doc, entry);
        saved = entry;
      }
      return;
    }
    if (current.columns.length >= MAX_COLUMNS) throw new Error(`最多保留 ${MAX_COLUMNS} 个公式列`);
    const seq = ownColumns(doc, true)!;
    seq.flow = false;
    const id = newColumnId(current.columns.map((c) => c.id));
    const entry: ColumnDef = { id, label, formula, tf, format };
    seq.add(flowNode(doc, entry));
    saved = entry;
  });
  return saved!;
}

export function deleteColumn({ dir }: Viewer, id: string): void {
  const target = str(id);
  if (!target) return;
  updateConfig(dir, (doc) => {
    const seq = ownColumns(doc, false);
    if (!seq) return;
    const index = columnIndex(doc, seq, target);
    if (index < 0) return;
    own(doc, seq, index);
    seq.delete(index);
  });
}

export function reorderColumns({ dir }: Viewer, ids: string[]): void {
  const order = (Array.isArray(ids) ? ids : []).map(str).filter(Boolean);
  updateConfig(dir, (doc) => {
    const seq = ownColumns(doc, false);
    if (!seq) return;
    const activeCount = Math.min(seq.items.length, MAX_COLUMNS);
    if (activeCount < 2) return;
    for (let i = 0; i < activeCount; i++) {
      const node = seq.items[i];
      if (isNode(node)) unshare(doc, node);
    }
    const head = seq.items.slice(0, activeCount);
    const tail = seq.items.slice(activeCount);
    const entries = head.map((node, i) => ({ id: columnNodeId(doc, node, i), node }));
    const byId = new Map(entries.filter((e): e is { id: string; node: unknown } => e.id !== null).map((e) => [e.id, e.node]));
    const next: unknown[] = [];
    const placed = new Set<unknown>();
    for (const id of order) {
      const node = byId.get(id);
      if (node && !placed.has(node)) {
        placed.add(node);
        next.push(node);
      }
    }
    for (const { node } of entries) {
      if (!placed.has(node)) next.push(node);
    }
    seq.items = [...next, ...tail];
  });
}

// ---------------------------------------------------------------------------- alerts

export interface AlertInput {
  /** The alert being edited; absent for a new one */
  id?: string;
  /** Null: every watched symbol */
  key: string | null;
  /** A TradingView condition, or `formula` for a custom formula in `when` */
  cond: AlertCond | "formula";
  value?: AlertCondition["value"];
  when?: string;
  /** A formula's timeframe; D when absent */
  tf?: Timeframe;
  /** Ignored for the whole watchlist, which fires each symbol at most once per bar */
  trigger: AlertTrigger;
  /** 判断时机; absent for what an alert of its kind does by default */
  check?: AlertCheck;
  /** Empty for the generated name */
  label?: string;
  /** Undoing a delete puts a paused alert back paused */
  enabled?: boolean;
  /** False: shown on the overview, never pushed */
  notify?: boolean;
  /** Undoing a delete puts a draft back a draft, and an agent's alert back as the agent's; an agent's own save does not go by these */
  draft?: boolean;
  by?: "agent" | null;
}

/** Who is saving: the person on the page, or an agent through `/mcp`, which may not put an alert on the whole watchlist into effect (§2.5). */
export type AlertOrigin = "page" | "agent";

const AGENT_EDITS_WATCHLIST = "这条对全部自选的警报不是草稿，agent 不能改：不带 id 另存一条新的（会存成草稿），旧的继续生效，用户确认新的之后再删旧的";

/** Set one field of a yaml map; a scalar is changed in place so the comment on its line stays. */
function setField(doc: Document, map: YAMLMap, field: string, value: unknown): void {
  const old = map.get(field, true);
  if (isScalar(old) && (value === null || typeof value !== "object")) {
    old.value = value;
    return;
  }
  const node = flowNode(doc, value);
  if (old && typeof old === "object" && "comment" in old) node.comment = old.comment;
  map.set(field, node);
}

/**
 * Create or edit an alert in the viewer's yaml; an edited alert starts over (TradingView restarts it
 * too). One on the whole watchlist is judged right away (on the live bars, or the closed daily
 * ones for `check: close`), so the overview shows where it holds without waiting for the next sync.
 *
 * From an agent the entry is marked `by: agent`, and one on the whole watchlist is written as a
 * draft: it is judged only after the person confirms it on the page. An agent may edit its draft,
 * but not an alert on the whole watchlist that is not one: that would take a watch the person
 * confirmed out of effect until they confirm again, so the agent leaves it running and saves a new
 * draft beside it. An edit on the page leaves both marks as they are.
 */
export async function saveAlert({ dir, vault }: Viewer, input: AlertInput, origin: AlertOrigin = "page"): Promise<{ id: string; draft: boolean }> {
  const saved = await serializeAlerts(() => {
    const cfg = readConfig(dir);
    // the old conditions' state follows them before the yaml moves them
    adoptConditionState(vault, cfg);
    const key = input.key == null ? null : resolveKey(str(input.key), cfg.aliases);
    if (key !== null && !isValidKey(key)) throw new Error("无效的 key");
    if (origin === "agent" && cfg.alerts.some((a) => a.id === input.id && !a.key && !a.draft)) throw new Error(AGENT_EDITS_WATCHLIST);
    // written the way a person would: the alias when there is one
    const entry: Record<string, unknown> = key ? { key: aliasOf(cfg.aliases, key) ?? key } : {};
    if (input.cond === "formula") {
      const when = str(input.when);
      if (!when) throw new Error("公式为空");
      try {
        // on the whole watchlist `bench` is each symbol's own, checked when it is judged
        compile(when, { aliases: cfg.aliases, bench: key ? (findItem(cfg, key)?.bench ?? null) : undefined });
      } catch (err) {
        throw new Error(describeError(err));
      }
      entry.when = when;
      if (isTimeframe(input.tf) && input.tf !== "D") entry.tf = input.tf;
    } else {
      entry.cond = input.cond;
      entry.value = input.value;
    }
    if (key) entry.trigger = input.trigger === "bar" ? "bar" : "once";
    // the default is left out, so alerts written before stay as they are
    if ((input.check === "price" || input.check === "close") && input.check !== defaultCheck(key)) entry.check = input.check;
    const label = str(input.label);
    if (label) entry.label = label;
    if (input.enabled === false) entry.enabled = false;
    if (input.notify === false) entry.notify = false;
    const marks: { by?: "agent"; draft?: true } = origin === "agent" ? { by: "agent", ...(key ? {} : { draft: true }) } : { ...(input.by === "agent" ? { by: "agent" } : {}), ...(input.draft ? { draft: true } : {}) };
    let id: string;
    try {
      const parsed = parseAlert(entry, 0, cfg.aliases);
      id = parsed.id;
      // a channel is written low first, however it was typed
      if (parsed.condition) entry.value = parsed.condition.value;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message.replace(/^alerts\[0\]：/, "") : String(err));
    }
    let draft = marks.draft === true;
    editAlerts(dir, (doc, seq) => {
      if (!input.id) {
        seq.add(flowNode(doc, { ...entry, ...marks }));
        return;
      }
      const index = alertIndex(doc, input.id, cfg.aliases);
      if (index < 0) throw new Error("这条警报已经不在 hebi8.yaml 里了");
      // field by field on the entry as written, so what the dialog does not offer (an explicit id,
      // anything else) and the comments on fields stay
      const node = seq.items[index] as YAMLMap;
      const written = node.get("key");
      if (!key) node.delete("key");
      else if (typeof written !== "string" || resolveKey(written, cfg.aliases) !== key) setField(doc, node, "key", entry.key);
      for (const field of ["cond", "value", "when", "tf", "trigger", "check", "label", "enabled", "notify"]) {
        if (field in entry) setField(doc, node, field, entry[field]);
        else node.delete(field);
      }
      if (origin === "agent") {
        setField(doc, node, "by", "agent");
        if (marks.draft) setField(doc, node, "draft", true);
        else node.delete("draft");
      }
      const parsed = parseAlert(node.toJSON(), index, cfg.aliases);
      id = parsed.id;
      draft = parsed.draft;
    });
    forgetAlerts(vault, input.id ? [input.id, id] : [id]);
    return { id, draft, watchlist: key === null };
  });
  if (saved.watchlist && !saved.draft) await runAlerts({ id: vault, dir }, () => readConfig(dir), "watchlist", liveReader());
  return { id: saved.id, draft: saved.draft };
}

export function deleteAlert({ dir, vault }: Viewer, id: string): Promise<void> {
  return serializeAlerts(() => {
    const cfg = readConfig(dir);
    adoptConditionState(vault, cfg);
    const aliases = cfg.aliases;
    editAlerts(dir, (doc) => {
      const index = alertIndex(doc, str(id), aliases);
      if (index >= 0) doc.deleteIn(["alerts", index]);
    });
    forgetAlerts(vault, [str(id)]);
  });
}

/**
 * 暂停 / 恢复; a resumed alert starts over, and one on the whole watchlist is judged right away.
 * An agent may pause anything but resume only an alert on one symbol.
 */
export async function setAlertEnabled({ dir, vault }: Viewer, id: string, enabled: boolean, origin: AlertOrigin = "page"): Promise<void> {
  const target = str(id);
  const on = Boolean(enabled);
  await serializeAlerts(() => {
    const cfg = readConfig(dir);
    if (on && origin === "agent" && cfg.alerts.some((a) => a.id === target && !a.key)) throw new Error("对全部自选的警报只能由用户在页面上恢复");
    adoptConditionState(vault, cfg);
    setAlertsEnabled(dir, [target], on);
    if (on) forgetAlerts(vault, [target]);
  });
  if (on && readConfig(dir).alerts.some((a) => a.id === target && !a.key)) await runAlerts({ id: vault, dir }, () => readConfig(dir), "watchlist", liveReader());
}

/**
 * 确认 a draft, on the page only: it becomes an ordinary alert that is switched on and starts
 * over, and one on the whole watchlist is judged right away like a new one.
 */
export async function confirmAlert({ dir, vault }: Viewer, id: string): Promise<void> {
  const target = str(id);
  await serializeAlerts(() => {
    const cfg = readConfig(dir);
    adoptConditionState(vault, cfg);
    editAlerts(dir, (doc) => {
      const index = alertIndex(doc, target, cfg.aliases);
      if (index < 0) throw new Error("这条警报已经不在 hebi8.yaml 里了");
      doc.deleteIn(["alerts", index, "draft"]);
      doc.deleteIn(["alerts", index, "enabled"]);
    });
    forgetAlerts(vault, [target]);
  });
  if (readConfig(dir).alerts.some((a) => a.id === target && !a.key)) await runAlerts({ id: vault, dir }, () => readConfig(dir), "watchlist", liveReader());
}
