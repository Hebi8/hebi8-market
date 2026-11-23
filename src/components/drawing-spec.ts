/**
 * A drawing as saved (`OverlaySpec`) and back, plus pure helpers for timeframe visibility,
 * sub-pane availability and merging live mounted drawings with parked off-chart specs so edits on
 * one timeframe or indicator setup never drop drawings belonging to another. KLineChart keeps the
 * point objects it is given and merges new styles into the ones it has, so neither way shares an
 * object with the chart: a saved state (the undo history among them) never changes under a later
 * drag or style. Type-only KLineChart imports, so it loads without KLineChart.
 */
import type { Chart, Overlay, OverlayCreate } from "klinecharts";
import { TIMEFRAMES, type Timeframe } from "@/lib/symbols";
import type { OverlaySpec } from "@/lib/vault";
import type { PriceScale } from "./drawing-scale";

/**
 * Per-drawing metadata kept beside KLineChart, which has no field for it: single-drawing lock and
 * hide ("lock all" and "hide all" are UI modes applied on top), the TradingView drawing an
 * imported one came from, the price scale it was drawn on, the sub-pane identifier (omitted on
 * the main pane), and the timeframes it is visible on (omitted = all timeframes).
 */
export type DrawingFlags = {
  lock?: boolean;
  hidden?: boolean;
  tvId?: string;
  scale?: PriceScale;
  pane?: string;
  timeframes?: Timeframe[];
};

/**
 * Normalize a timeframe visibility list against the supported timeframes: deduplicates, preserves
 * canonical `TIMEFRAMES` order, and returns `undefined` (visible on every timeframe, including
 * future intraday ones) when empty or when every supported timeframe is included.
 */
export function normalizeTimeframes(tfs: readonly string[] | undefined, all: readonly Timeframe[] = TIMEFRAMES): Timeframe[] | undefined {
  if (!tfs || tfs.length === 0) return undefined;
  const set = new Set(tfs);
  const filtered = all.filter((tf) => set.has(tf));
  if (filtered.length === 0 || filtered.length === all.length) return undefined;
  return filtered;
}

/** Whether a drawing should be visible on timeframe `tf`. Omitted / empty means all timeframes. */
export function isVisibleOnTimeframe(spec: Pick<OverlaySpec, "timeframes">, tf: Timeframe): boolean {
  return !spec.timeframes || spec.timeframes.length === 0 || spec.timeframes.includes(tf);
}

/** Whether a drawing's pane is currently available on the chart (main pane is always available). */
export function isPaneAvailable(spec: Pick<OverlaySpec, "pane">, activePanes: ReadonlyMap<string, string> | ReadonlySet<string>): boolean {
  return !spec.pane || activePanes.has(spec.pane);
}

/** Whether a drawing should be mounted on the chart for the given timeframe and open sub-panes. */
export function shouldRenderOverlay(
  spec: Pick<OverlaySpec, "pane" | "timeframes">,
  tf: Timeframe,
  activePanes: ReadonlyMap<string, string> | ReadonlySet<string>,
): boolean {
  return isVisibleOnTimeframe(spec, tf) && isPaneAvailable(spec, activePanes);
}

/** How many saved drawings are currently parked off-chart (hidden on another timeframe or a closed sub-pane). */
export function countParkedOverlays(
  overlays: readonly Pick<OverlaySpec, "pane" | "timeframes">[],
  tf: Timeframe,
  activePanes: ReadonlyMap<string, string> | ReadonlySet<string>,
): number {
  return overlays.filter((o) => !shouldRenderOverlay(o, tf, activePanes)).length;
}

/**
 * Fill missing `timestamp` on a `horizontalStraightLine` (which KLineChart leaves undefined when a
 * user clicks or drags on the right Y-axis) with `fallbackTimestamp`. Returns null when no change is needed.
 */
export function patchHorizontalPoints<T extends { timestamp?: number; value?: number }>(
  name: string,
  points: readonly T[],
  fallbackTimestamp: number | undefined,
): T[] | null {
  if (name !== "horizontalStraightLine" || typeof fallbackTimestamp !== "number" || !Number.isFinite(fallbackTimestamp)) return null;
  let changed = false;
  const next = points.map((p) => {
    if ((typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp)) && typeof p.value === "number" && Number.isFinite(p.value)) {
      changed = true;
      return { ...p, timestamp: fallbackTimestamp };
    }
    return p;
  });
  return changed ? next : null;
}

/** Whether every point in `points` has a finite numeric timestamp and value (and there is at least one). */
export function hasValidDrawingPoints(points: readonly { timestamp?: number; value?: number }[]): boolean {
  return (
    points.length > 0 &&
    points.every((p) => typeof p.timestamp === "number" && Number.isFinite(p.timestamp) && typeof p.value === "number" && Number.isFinite(p.value))
  );
}

/** Deep copy of a saved spec so mutations never leak into undo history or parked entries. */
export function cloneSpec(spec: OverlaySpec): OverlaySpec {
  const timeframes = normalizeTimeframes(spec.timeframes);
  return {
    name: spec.name,
    points: spec.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
    ...(spec.styles ? { styles: structuredClone(spec.styles) } : {}),
    ...(spec.lock ? { lock: true } : {}),
    ...(spec.hidden ? { hidden: true } : {}),
    ...(spec.extendData !== undefined ? { extendData: structuredClone(spec.extendData) } : {}),
    ...(spec.tvId ? { tvId: spec.tvId } : {}),
    ...(spec.scale ? { scale: spec.scale } : {}),
    ...(spec.pane ? { pane: spec.pane } : {}),
    ...(timeframes ? { timeframes } : {}),
  };
}

/**
 * One entry in the symbol's ordered drawing list: either live on KLineChart (`mounted: true`, read
 * from the chart by `id`) or parked off-chart (`mounted: false`, preserved untouched because its
 * `timeframes` excludes the current timeframe or its `pane` is not currently open).
 */
export type DrawingSlot = { mounted: true; id: string } | { mounted: false; spec: OverlaySpec };

/**
 * Merge live mounted overlays (`liveById`) with parked slots in original order, dropping deleted
 * mounted overlays and appending newly drawn ones. Parked drawings (on other timeframes or closed
 * sub-panes) are always preserved intact.
 */
export function mergeSlots(
  slots: readonly DrawingSlot[],
  liveById: ReadonlyMap<string, OverlaySpec>,
): { specs: OverlaySpec[]; slots: DrawingSlot[] } {
  const specs: OverlaySpec[] = [];
  const nextSlots: DrawingSlot[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (!slot.mounted) {
      const copy = cloneSpec(slot.spec);
      specs.push(copy);
      nextSlots.push({ mounted: false, spec: copy });
      continue;
    }
    const live = liveById.get(slot.id);
    if (!live) continue;
    seen.add(slot.id);
    specs.push(live);
    nextSlots.push(slot);
  }
  for (const [id, live] of liveById) {
    if (seen.has(id)) continue;
    specs.push(live);
    nextSlots.push({ mounted: true, id });
  }
  return { specs, slots: nextSlots };
}

/** A finished drawing as saved; null for one without valid points. */
export function specOf(
  o: Pick<Overlay, "id" | "name" | "points" | "styles" | "extendData">,
  flags: Map<string, DrawingFlags>,
  fallbackTimestamp?: number,
): OverlaySpec | null {
  const source = patchHorizontalPoints(o.name, o.points, fallbackTimestamp) ?? o.points;
  const points = source
    .filter((p) => typeof p.timestamp === "number" && Number.isFinite(p.timestamp) && typeof p.value === "number" && Number.isFinite(p.value))
    .map((p) => ({ timestamp: p.timestamp!, value: p.value! }));
  if (points.length === 0) return null;
  const spec: OverlaySpec = { name: o.name, points };
  if (o.styles) spec.styles = structuredClone(o.styles);
  // "lock all" and "hide all" are UI modes, not properties of each drawing
  const f = flags.get(o.id);
  if (f?.lock) spec.lock = true;
  if (f?.hidden) spec.hidden = true;
  if (o.extendData !== undefined && o.extendData !== null && typeof o.extendData !== "function") spec.extendData = structuredClone(o.extendData);
  if (f?.tvId) spec.tvId = f.tvId;
  if (f?.scale) spec.scale = f.scale;
  if (f?.pane) spec.pane = f.pane;
  const timeframes = normalizeTimeframes(f?.timeframes);
  if (timeframes) spec.timeframes = timeframes;
  return spec;
}

/** What KLineChart is given to draw a saved drawing: copies, never the spec's own objects. */
export function drawingOf(spec: OverlaySpec): OverlayCreate {
  return {
    name: spec.name,
    points: spec.points.map((p) => ({ ...p })),
    extendData: structuredClone(spec.extendData),
    ...(spec.styles ? { styles: structuredClone(spec.styles) as OverlayCreate["styles"] } : {}),
  };
}

/**
 * Restore an overlay's pre-preview `styles` and `extendData` cleanly. KLineChart's `override()`
 * ignores null/undefined `styles` and deep-merges objects/arrays, so we reset both fields first and
 * nudge `zLevel` back and forth when neither was originally set so KLineChart still repaints.
 */
export function restoreOverlaySnapshot(
  chart: Pick<Chart, "overrideOverlay">,
  o: Overlay,
  original: { styles: Overlay["styles"]; extendData: unknown },
): void {
  const mut = o as unknown as { styles: Overlay["styles"]; extendData: unknown };
  mut.styles = null;
  mut.extendData = undefined;
  const repainted = chart.overrideOverlay({
    id: o.id,
    ...(original.styles ? { styles: structuredClone(original.styles) } : {}),
    ...(original.extendData !== undefined ? { extendData: structuredClone(original.extendData) } : {}),
  });
  if (!repainted) {
    const z = o.zLevel;
    chart.overrideOverlay({ id: o.id, zLevel: z + 1 });
    chart.overrideOverlay({ id: o.id, zLevel: z });
  }
}
