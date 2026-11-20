"use server";

/**
 * Importing from TradingView (design §5.5): the watchlist from its exported `.txt`, drawings from a
 * layout. Like every action, the viewer must be allowed to write and only their vault is touched.
 */
import { revalidatePath } from "next/cache";
import { isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { findItem, type Config } from "@/lib/config";
import { getSymbol, readDaily } from "@/lib/store";
import { syncAll, syncOne } from "@/lib/sync";
import { convertDrawings, importedIds, layoutId, sessionMinutes, tickOf, normalizeDrawing, type DrawingContext, type TvDrawing } from "@/lib/tv-drawings";
import { isTvSymbol, parseTvList, planTvImport, tvIdentity, tvKey, watchedByIdentity, type ImportMode } from "@/lib/tv-import";
import { fetchLayoutDrawings, fetchLayouts, type DrawingOrigin, type TvLayout } from "@/lib/tv-layout";
import { entryKey, flowNode, groupNode, readChartState, readConfig, seqOf, updateConfig, writeChartState } from "@/lib/vault";
import { getViewer, requireWriter, type Viewer } from "@/lib/viewer";
import { wellKnownName } from "@/lib/wellknown";

export type TvResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function run<T>(fn: (viewer: Viewer) => Promise<T> | T): Promise<TvResult<T>> {
  try {
    const result = await fn(requireWriter(await getViewer()));
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const watchedGroups = (cfg: Config) => cfg.groups.map((g) => ({ name: g.name, keys: g.symbols.map((s) => s.key) }));

/** A new entry as `addSymbol` writes it: the dictionary's Chinese name when there is one. */
function entryNode(doc: Document, key: string) {
  const name = wellKnownName(key);
  return name ? flowNode(doc, { key, name }) : doc.createNode(key);
}

/** Fetch what was added, then stats and alerts like a scheduled run; the page shows each symbol's sync error. */
function syncInBackground() {
  syncAll().catch((err) => console.warn(`[hebi8m] sync after import failed: ${err instanceof Error ? err.message : String(err)}`));
}

// ---------------------------------------------------------------------------- watchlist

export interface TvListInput {
  text: string;
  /** Section name for symbols before the first `###` (the file name) */
  fallback: string;
  mode: ImportMode;
}

/**
 * Write an exported TradingView list into the watchlist. Merge: new symbols go to the group of
 * the section's name (created at the end); symbols already watched stay where they are. Replace:
 * `groups` becomes the file's sections, a symbol already watched keeping its entry (name, bench).
 * The plan is worked out again here from the current yaml, the same way the page previewed it.
 */
export async function importTvList(input: TvListInput): Promise<TvResult<{ added: number; groups: number }>> {
  return run(({ dir }) => {
    const cfg = readConfig(dir);
    const plan = planTvImport(parseTvList(String(input.text ?? ""), String(input.fallback ?? "").trim() || "TradingView"), watchedGroups(cfg), input.mode);
    const added = plan.flatMap((g) => g.rows.filter((r) => r.status === "new")).length;
    if (!plan.length) throw new Error("文件里没有标的");
    if (input.mode === "merge" && !added) throw new Error("文件里的标的都已经在自选里了");

    updateConfig(dir, (doc) => {
      if (input.mode === "merge") {
        for (const g of plan) {
          const rows = g.rows.filter((r) => r.status === "new");
          if (!rows.length) continue;
          const symbols = seqOf(groupNode(doc, g.name), "symbols", doc);
          for (const r of rows) symbols.add(entryNode(doc, r.key));
        }
        return;
      }
      // replace: the entries as written, by key, so what is kept keeps its alias, name, bench and comments
      const entries = new Map<string, unknown>();
      const groups = doc.get("groups");
      if (isSeq(groups)) {
        for (const g of groups.items) {
          const symbols = isMap(g) ? g.get("symbols") : null;
          if (!isSeq(symbols)) continue;
          for (const item of symbols.items) {
            const key = entryKey(item, cfg.aliases);
            if (key) entries.set(key, item);
          }
        }
      }
      const next = doc.createNode([]) as YAMLSeq;
      for (const g of plan) {
        const rows = g.rows.filter((r) => r.status !== "duplicate");
        if (!rows.length) continue;
        const node = doc.createNode({ name: g.name, symbols: [] }) as YAMLMap;
        seqOf(node, "symbols", doc).items = rows.map((r) => (r.status === "exists" ? entries.get(r.key) : entryNode(doc, r.key)));
        next.items.push(node);
      }
      doc.set("groups", next);
    });
    revalidatePath("/", "layout");
    if (added) syncInBackground();
    return { added, groups: plan.length };
  });
}

// ---------------------------------------------------------------------------- drawings

export type DrawingsSource = { layout: string; sessionid: string; sign: string } | { drawings: unknown[] };

export interface SymbolDrawings {
  /** TradingView's `EXCH:SYM` */
  symbol: string;
  /** The watched key it maps to; null when it is not watched */
  key: string | null;
  group: string | null;
  /** Unwatched and the same listing as an earlier row (`BATS:NVDA` after `NASDAQ:NVDA`): it follows that row's choice */
  sameAs?: string;
  /** An expression of several symbols (`1/FX:USDJPY*TVC:DXY`): nothing to put its drawings on */
  expression?: boolean;
  total: number;
  /** Would be imported now (for an unwatched symbol: once it is added, from what is cached) */
  ready: number;
  /** Imported before */
  already: number;
  skipped: Record<string, number>;
}

export interface DrawingsPreview {
  /** Normalized, to be sent back with the confirmation */
  drawings: TvDrawing[];
  symbols: SymbolDrawings[];
  /** Layout fetches: drawings found per place they are stored, against TradingView's own count */
  origins?: DrawingOrigin[];
}

/** What the drawings of a TradingView symbol are lined up against: the cached bars of its key, their timezone and price step. */
function contextOf(key: string, symbol: string): DrawingContext {
  const bars = readDaily(key);
  return {
    days: bars.map((b) => b.t),
    timeZone: getSymbol(key)?.timezone ?? "UTC",
    sessionMinutes: sessionMinutes(symbol),
    tick: tickOf(bars.slice(-50).map((b) => b.c)),
  };
}

function bySymbol(drawings: TvDrawing[]): Map<string, TvDrawing[]> {
  const out = new Map<string, TvDrawing[]>();
  for (const d of drawings) out.set(d.symbol, [...(out.get(d.symbol) ?? []), d]);
  return out;
}

const EXPRESSION = "表达式标的，没有对应的图表";

function summarize(dir: string, cfg: Config, drawings: TvDrawing[]): SymbolDrawings[] {
  const watched = watchedByIdentity(watchedGroups(cfg));
  const unwatched = new Map<string, string>();
  return [...bySymbol(drawings)].map(([symbol, list]): SymbolDrawings => {
    if (!isTvSymbol(symbol)) return { symbol, key: null, group: null, expression: true, total: list.length, ready: 0, already: 0, skipped: { [EXPRESSION]: list.length } };
    const id = tvIdentity(symbol);
    const hit = watched.get(id);
    const first = hit ? undefined : unwatched.get(id);
    if (!hit && !first) unwatched.set(id, symbol);
    const key = hit?.key ?? tvKey(first ?? symbol);
    const imported = hit ? importedIds(readChartState(dir, key).overlays) : new Set<string>();
    const conv = convertDrawings(list, contextOf(key, symbol), imported);
    return { symbol, key: hit?.key ?? null, group: hit?.group ?? null, ...(first ? { sameAs: first } : {}), total: list.length, ready: conv.overlays.length, already: conv.already, skipped: conv.skipped };
  });
}

/** The two cookies as typed, for this request only. */
function sessionOf(input: { sessionid: string; sign: string }) {
  const session = String(input.sessionid ?? "").trim();
  const sign = String(input.sign ?? "").trim();
  if (!session || !sign) throw new Error("sessionid 和 sessionid_sign 都要填");
  return { session, sign };
}

/** The account's layouts, last modified first, to pick the one to fetch; the cookies are used for this request only. */
export async function listTvLayouts(input: { sessionid: string; sign: string }): Promise<TvResult<{ layouts: TvLayout[] }>> {
  return run(async () => {
    const { session, sign } = sessionOf(input);
    return { layouts: await fetchLayouts(session, sign) };
  });
}

const normalizeAll = (list: unknown[]) => (Array.isArray(list) ? list : []).map(normalizeDrawing).filter((d): d is TvDrawing => d !== null);

/**
 * What an import of these drawings does, per symbol. From a layout the cookies are used for this
 * request only; from pasted JSON the page has already parsed it.
 */
export async function previewTvDrawings(source: DrawingsSource): Promise<TvResult<DrawingsPreview>> {
  return run(async ({ dir }) => {
    let drawings: TvDrawing[];
    let origins: DrawingsPreview["origins"];
    if ("layout" in source) {
      const layout = layoutId(String(source.layout ?? ""));
      if (!layout) throw new Error("看不出布局 ID：填 https://www.tradingview.com/chart/<ID>/ 或 ID 本身");
      const { session, sign } = sessionOf(source);
      ({ drawings, origins } = await fetchLayoutDrawings(layout, session, sign));
    } else drawings = normalizeAll(source.drawings);
    if (!drawings.length) throw new Error("没有找到画线");
    return { drawings, symbols: summarize(dir, readConfig(dir), drawings), ...(origins ? { origins } : {}) };
  });
}

export interface DrawingsImportInput {
  drawings: unknown[];
  /** Unwatched TradingView symbols to add as `tv:EXCH:SYM`, and the group each goes to; the others are skipped */
  add: Record<string, string>;
}

export interface DrawingsImported {
  symbols: { symbol: string; key: string; imported: number; already: number; skipped: Record<string, number> }[];
  /** Symbols that could not be added (their first fetch failed) */
  failed: { symbol: string; error: string }[];
}

/**
 * Append the drawings to each symbol's `charts/<fileKey>.json`; the drawings and comparisons there
 * stay, and the TradingView ids are remembered so a second import adds nothing.
 */
export async function importTvDrawings(input: DrawingsImportInput): Promise<TvResult<DrawingsImported>> {
  return run(async ({ dir }) => {
    const drawings = normalizeAll(input.drawings);
    const groups = bySymbol(drawings);
    const failed: DrawingsImported["failed"] = [];

    // unwatched symbols the user chose to add: fetched first (it doubles as validation), like addSymbol
    const adding: [string, string, string][] = [];
    const watched = watchedByIdentity(watchedGroups(readConfig(dir)));
    for (const [symbol, group] of Object.entries(input.add ?? {})) {
      const target = String(group ?? "").trim();
      if (!groups.has(symbol) || !target || !isTvSymbol(symbol) || watched.has(tvIdentity(symbol))) continue;
      const key = tvKey(symbol);
      const outcome = await syncOne(key, true);
      if (outcome.ok) {
        adding.push([symbol, key, target]);
        // an equivalent symbol later in the batch goes with this one
        watched.set(tvIdentity(symbol), { key, group: target });
      } else failed.push({ symbol, error: outcome.error ?? "拉取失败" });
    }
    if (adding.length) {
      updateConfig(dir, (doc) => {
        for (const [, key, group] of adding) seqOf(groupNode(doc, group), "symbols", doc).add(entryNode(doc, key));
      });
    }

    const cfg = readConfig(dir);
    const byId = watchedByIdentity(watchedGroups(cfg));
    const symbols: DrawingsImported["symbols"] = [];
    for (const [symbol, list] of groups) {
      const key = byId.get(tvIdentity(symbol))?.key;
      if (!key || !findItem(cfg, key)) continue;
      const state = readChartState(dir, key);
      const conv = convertDrawings(list, contextOf(key, symbol), importedIds(state.overlays));
      if (conv.overlays.length) writeChartState(dir, key, { ...state, overlays: [...state.overlays, ...conv.overlays] });
      symbols.push({ symbol, key, imported: conv.overlays.length, already: conv.already, skipped: conv.skipped });
    }
    revalidatePath("/", "layout");
    return { symbols, failed };
  });
}

