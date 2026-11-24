/**
 * TradingView drawings → this app's overlay records (design §5.5, §1.3). TradingView has no export
 * for drawings; they come from its chart storage (`charts-storage/get/layout/<id>/sources`), fetched
 * with the user's cookies or pasted from the browser's developer tools. Pure, so it is tested
 * without the network.
 */
import { normalizeTimeframes } from "@/components/drawing-spec";
import { drawingStyles, type LineDash } from "@/components/drawing-style";
import { FIB_DEFAULTS, FIB_DRAWINGS, FIB_LEVELS, isDefaultFibLevels, type FibLevelItem, type FibSettings } from "@/components/fib";
import { TIMEFRAMES, hash6, type Timeframe } from "./symbols";
import { DAY, localDay } from "./time";
import type { OverlaySpec } from "./vault";

export interface TvPoint {
  /** Unix seconds: the bar the point is on, at the resolution it was drawn on */
  time_t: number;
  price: number;
  /** Bars right of `time_t`'s bar, for a point past the last bar */
  offset?: number;
  /** Resolution of `offset` when TradingView records it (`1D`, `1W`, `60`…) */
  interval?: string;
}

/** A drawing reduced to what the conversion reads, small enough to send back with the confirmation. */
export interface TvDrawing {
  id: string;
  /** `EXCH:SYM` */
  symbol: string;
  /** `LineToolTrendLine`… */
  type: string;
  points: TvPoint[];
  state: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** State fields the conversion reads; the rest (fonts, chart-specific UI flags) stays behind. */
const STATE_KEYS = [
  "linecolor",
  "color",
  "textcolor",
  "textColor",
  "backgroundColor",
  "markerColor",
  "bordercolor",
  "borderColor",
  "flagColor",
  "linewidth",
  "linestyle",
  "text",
  "fontsize",
  "extendLeft",
  "extendRight",
  "extendLines",
  "extendLinesLeft",
  "fillBackground",
  "transparency",
  "reverse",
  "levelsStyle",
  "visible",
  "frozen",
  "stopLevel",
  "profitLevel",
  "trendline",
  "intervalsVisibilities",
];

const TV_FIB_TYPES = new Set(["LineToolFibRetracement", "LineToolTrendBasedFibExtension"]);
const TV_FIB_LEVEL_KEYS = Array.from({ length: 24 }, (_, i) => `level${i + 1}`);

/** `={"symbol":"NASDAQ:NVDA","adjustment":"splits"}` is how TradingView writes a symbol with options. */
function symbolOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (!s.startsWith("=")) return s.toUpperCase();
  try {
    const inner = (JSON.parse(s.slice(1)) as { symbol?: unknown }).symbol;
    return typeof inner === "string" ? inner.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * One drawing as stored (`{ id, symbol, state: { type, points, state: {…styles} } }`) or as the
 * library returns it (the outer `state` spread over the drawing); null when it is not a drawing.
 */
export function normalizeDrawing(raw: unknown): TvDrawing | null {
  if (!isObj(raw)) return null;
  const flat = isObj(raw.state) && typeof raw.state.type === "string" ? { ...raw, ...raw.state } : raw;
  const type = flat.type;
  const symbol = symbolOf(flat.symbol ?? raw.symbol);
  if (typeof type !== "string" || !type.startsWith("LineTool") || !symbol || !Array.isArray(flat.points)) return null;
  const styles = isObj(flat.state) ? flat.state : {};
  // the drawing's own interval stands in for a point that does not say
  const interval = typeof styles.interval === "string" ? styles.interval : undefined;
  const points = flat.points.filter(isObj).map((p) => ({
    time_t: Number(p.time_t),
    price: Number(p.price),
    ...(Number(p.offset) ? { offset: Number(p.offset) } : {}),
    ...(typeof p.interval === "string" ? { interval: p.interval } : interval ? { interval } : {}),
  }));
  const keys = TV_FIB_TYPES.has(type) ? [...STATE_KEYS, ...TV_FIB_LEVEL_KEYS] : STATE_KEYS;
  const state = Object.fromEntries(keys.filter((k) => styles[k] !== undefined).map((k) => [k, styles[k]]));
  const id = typeof flat.id === "string" || typeof flat.id === "number" ? String(flat.id) : `h${hash6(type + symbol + JSON.stringify(points))}`;
  return { id, symbol, type, points, state };
}

/**
 * Drawings from pasted JSON: the `sources` response (`{ payload: { sources } }`), its `sources`
 * object, a list of drawings, or one drawing. Throws on text that is not JSON.
 */
export function parseTvSources(text: string): TvDrawing[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("不是 JSON：请粘贴 sources 接口的完整响应");
  }
  if (isObj(data) && isObj(data.payload)) data = data.payload;
  if (isObj(data) && isObj(data.sources)) data = data.sources;
  const single = normalizeDrawing(data);
  if (single) return [single];
  const list = Array.isArray(data) ? data : isObj(data) ? Object.values(data) : [];
  return dedupeDrawings(list.map(normalizeDrawing).filter((d): d is TvDrawing => d !== null));
}

/** A drawing pasted twice counts once. */
function dedupeDrawings(list: TvDrawing[]): TvDrawing[] {
  const seen = new Set<string>();
  return list.filter((d) => !seen.has(d.id) && seen.add(d.id));
}

// ---------------------------------------------------------------------------- time

export interface DrawingContext {
  /** The symbol's trading days as stored (unix seconds at UTC midnight), ascending; may be empty */
  days: number[];
  /** The exchange's timezone, as the source reported it */
  timeZone: string;
  /** Trading minutes in a day (`sessionMinutes`), for turning an intraday offset into days */
  sessionMinutes: number;
  /** Smallest price step (`tickOf` the cached closes), for a position's levels counted in ticks; null without bars */
  tick: number | null;
}

/** Trading minutes per day of the exchanges that close overnight; the rest (crypto, FX, futures, CFDs) trade around the clock. */
const SESSIONS: [RegExp, number][] = [
  [/^(NASDAQ|NYSE|AMEX|NYSEARCA|ARCA|BATS|CBOE|OTC|SP|DJ):/, 390],
  [/^(SSE|SZSE):/, 240],
  [/^(HKEX|HSI):/, 330],
  [/^TSE:/, 300],
  [/^(LSE|XETR|EURONEXT|SIX):/, 510],
];

/** About how many minutes a day the exchange of a TradingView symbol trades. */
export function sessionMinutes(symbol: string): number {
  return SESSIONS.find(([re]) => re.test(symbol))?.[1] ?? 1440;
}

/**
 * The price step the closes are quoted in: the fewest decimals that write every one of them (up
 * to 8). Yahoo's prices are float32 (186.5800018…), so a thousandth of a step is close enough.
 */
export function tickOf(closes: number[]): number | null {
  if (!closes.length) return null;
  for (let d = 0; d <= 8; d++) {
    const f = 10 ** d;
    if (closes.every((c) => Math.abs(c * f - Math.round(c * f)) < 1e-3)) return 1 / f;
  }
  return 1e-8;
}

const UTC_ZONE = /^(Etc\/)?(UTC|GMT|Universal|Zulu)$/i;

/**
 * The trading day a point's time falls on, as unix seconds at UTC midnight (the `bars.t` rule).
 * TradingView stamps daily bars at the session open: US stocks 09:30 New York, Asia at its open,
 * FX / futures / TVC on the previous evening (17:00 / 18:00 New York). A point drawn on an
 * intraday bar carries that bar's time. So the day is the local date, except from 17:00 on in a
 * zone that is not UTC, which is the next day's session (crypto runs on UTC days).
 */
export function pointDay(timeSec: number, timeZone: string): number {
  const local = localDay(timeSec, timeZone);
  if (UTC_ZONE.test(timeZone)) return local;
  return localDay(timeSec + 7 * 3600, timeZone) > local ? local + DAY : local;
}

/** Index of the last day ≤ `day`, −1 before the first. */
function floorIndex(days: number[], day: number): number {
  let lo = 0;
  let hi = days.length - 1;
  let found = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (days[m] <= day) {
      found = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return found;
}

/** A day inside the history lands on its bar (a holiday on the bar before, as the chart does); outside it stays. */
function snap(days: number[], day: number): number {
  if (!days.length || day < days[0] || day > days[days.length - 1]) return day;
  return days[floorIndex(days, day)];
}

/** `1D`, `D`, `2W`, `M`, `12M`: the unit and count of one bar; `60`, `240`: minutes; null for anything else (seconds, ticks). */
function intervalUnit(interval: string | undefined): { unit: "D" | "W" | "M" | "min"; n: number } | null {
  const s = interval ?? "D";
  if (/^\d+$/.test(s)) return { unit: "min", n: Number(s) };
  const m = /^(\d*)([DWM])$/i.exec(s);
  return m ? { unit: m[2].toUpperCase() as "D" | "W" | "M", n: Number(m[1] || 1) } : null;
}

/**
 * The day `offset` bars after the bar on `day`. Daily bars are counted on the stored trading
 * days; past the last one each bar is a calendar day, which is how the chart places points in
 * the empty area on the right (so is an anchor already past the cache, which can be behind
 * TradingView). Months end on the target month's last day when it is shorter, as KLineChart
 * counts them. Null when it cannot be worked out.
 */
function offsetDay(days: number[], day: number, offset: number, interval: string | undefined, sessionMinutes: number): number | null {
  const step = intervalUnit(interval);
  if (!step) return null;
  // intraday bars, roughly: as many trading days as the minutes fill, a started day counting
  const bars = step.unit === "min" ? Math.ceil((offset * step.n) / sessionMinutes) : offset * step.n;
  if (step.unit === "W") return day + bars * 7 * DAY;
  if (step.unit === "M") {
    const d = new Date(day * 1000);
    const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + bars + 1, 0)).getUTCDate();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + bars, Math.min(d.getUTCDate(), lastOfMonth)) / 1000;
  }
  const last = days.length - 1;
  if (last < 0) return null;
  // outside the cache on either side (left of its first bar TradingView anchors on that bar with a negative offset)
  if (day > days[last] || day < days[0]) return day + bars * DAY;
  const target = floorIndex(days, day) + bars;
  if (target < 0) return days[0] + target * DAY;
  return target <= last ? days[target] : days[last] + (target - last) * DAY;
}

type Pt = { timestamp: number; value: number };

const REASON_POINTS = "点的数据不全";
const REASON_OFFSET = "点在最后一根 K 线右边，换算不了";

function convertPoint(p: TvPoint, ctx: DrawingContext): Pt | string {
  if (!Number.isFinite(p.time_t) || !Number.isFinite(p.price)) return REASON_POINTS;
  let day = snap(ctx.days, pointDay(p.time_t, ctx.timeZone));
  if (p.offset) {
    const moved = offsetDay(ctx.days, day, p.offset, p.interval, ctx.sessionMinutes);
    if (moved === null) return REASON_OFFSET;
    day = moved;
  }
  return { timestamp: day * 1000, value: p.price };
}

// ---------------------------------------------------------------------------- styles

/** `#2962FF`, `#29f`, `#2962FFCC`, `rgba(41, 98, 255, 0.5)` → `#2962ff`; the alpha goes (the app keeps one colour). */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    return h.length === 3 ? `#${[...h].map((c) => c + c).join("")}` : `#${h.slice(0, 6)}`;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(s);
  if (!rgb) return null;
  return `#${rgb
    .slice(1, 4)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** TradingView's line styles: 0 solid, 1 dotted, 2 dashed, 3 large dashed, 4 sparse dotted. */
function dashOf(style: unknown): LineDash {
  return style === 1 || style === 4 ? "dotted" : style === 2 || style === 3 ? "dashed" : "solid";
}

/** Where each kind of drawing keeps the colour the app draws it with. */
const LINE_COLORS = ["linecolor", "color", "trendline"];
const TEXT_COLORS = ["color", "textcolor", "textColor", "linecolor"];
const LABEL_COLORS = ["backgroundColor", "markerColor", "bordercolor", "borderColor", "linecolor", "color"];

function stylesOf(state: Record<string, unknown>, colorKeys: string[], textSize: boolean, levels: boolean): OverlaySpec["styles"] | undefined {
  const trend = isObj(state.trendline) ? state.trendline : {};
  // a Fibonacci drawing's width and dash are those of its level lines; its trend line only gives the colour
  const stroke = !levels ? trend : isObj(state.levelsStyle) ? state.levelsStyle : {};
  let color: string | null = null;
  for (const k of colorKeys) {
    color = hexColor(k === "trendline" ? trend.color : state[k]);
    if (color) break;
  }
  if (!color) return undefined;
  const width = Number(state.linewidth ?? stroke.linewidth ?? 1);
  const styles = drawingStyles(color, Math.min(4, Math.max(1, Math.round(Number.isFinite(width) ? width : 1))), dashOf(state.linestyle ?? stroke.linestyle));
  const size = Number(state.fontsize);
  if (textSize && Number.isFinite(size) && size > 0) styles.text = { ...styles.text, size };
  return styles;
}

/**
 * TradingView's 24 standard Fibonacci slots (`level1..level24`): the first 11 match `FIB_LEVELS`
 * and start visible; slots 12..24 start hidden with TradingView's standard extension ratios.
 */
const TV_FIB_DEFAULTS: readonly { level: number; color: string; visible: boolean }[] = [
  ...FIB_LEVELS.map((l) => ({ level: l.level, color: l.color, visible: true })),
  { level: 1.272, color: "#ff9800", visible: false },
  { level: 1.414, color: "#f23645", visible: false },
  { level: 2.272, color: "#ff9800", visible: false },
  { level: 2.414, color: "#4caf50", visible: false },
  { level: 2, color: "#089981", visible: false },
  { level: 3, color: "#00bcd4", visible: false },
  { level: 3.272, color: "#808080", visible: false },
  { level: 3.414, color: "#2962ff", visible: false },
  { level: 4, color: "#f23645", visible: false },
  { level: 4.272, color: "#9c27b0", visible: false },
  { level: 4.414, color: "#e91e63", visible: false },
  { level: 4.618, color: "#ff9800", visible: false },
  { level: 4.764, color: "#089981", visible: false },
];

const REASON_NO_FIB_LEVELS = "无可见斐波档位";
const REASON_INTRADAY_ONLY = "仅日内周期可见";
const REASON_UNSUPPORTED_TIMEFRAMES = "不在支持的周期范围内";

/**
 * Merge TradingView's `level1..level24` (`{ coeff, color, visible }`) slot-by-slot over
 * `TV_FIB_DEFAULTS`. Handles both full 24-slot tables and sparse diffs (including toggling a
 * hidden slot like `level24` without resending `coeff`). Returns an error reason when every slot
 * ends up hidden, or `levels: undefined` when no slot changed / the visible set equals `FIB_LEVELS`.
 */
function fibLevelsFromTv(state: Record<string, unknown>): { ok: true; levels: FibLevelItem[] | undefined } | { ok: false; reason: string } {
  let touched = false;
  const slots = TV_FIB_DEFAULTS.map((d) => ({ ...d }));
  for (let i = 0; i < slots.length; i++) {
    const raw = state[`level${i + 1}`];
    if (!isObj(raw)) continue;
    touched = true;
    const slot = slots[i];
    if (typeof raw.coeff === "number" && Number.isFinite(raw.coeff)) slot.level = raw.coeff;
    const color = hexColor(raw.color);
    if (color) slot.color = color;
    if (typeof raw.visible === "boolean") slot.visible = raw.visible;
  }
  if (!touched) return { ok: true, levels: undefined };
  const visible: FibLevelItem[] = slots.filter((s) => s.visible).map(({ level, color }) => ({ level, color }));
  if (!visible.length) return { ok: false, reason: REASON_NO_FIB_LEVELS };
  return { ok: true, levels: isDefaultFibLevels(visible) ? undefined : visible };
}

/**
 * A Fibonacci retracement's or extension's background, extension, direction and custom levels, where
 * TradingView recorded them (it keeps only what was changed from its defaults, which are this app's
 * too): `extendLines` is to the right. Returns an error when all levels were turned off.
 */
function fibOf(state: Record<string, unknown>): { ok: true; fib: FibSettings | undefined } | { ok: false; reason: string } {
  const { fillBackground, transparency, extendLines, extendLinesLeft, reverse } = state;
  const parsed = fibLevelsFromTv(state);
  if (!parsed.ok) return parsed;
  const changed: Partial<FibSettings> = {
    ...(typeof fillBackground === "boolean" ? { background: fillBackground } : {}),
    ...(typeof transparency === "number" && transparency >= 0 && transparency <= 100 ? { transparency } : {}),
    ...(typeof extendLinesLeft === "boolean" ? { extendLeft: extendLinesLeft } : {}),
    ...(typeof extendLines === "boolean" ? { extendRight: extendLines } : {}),
    ...(typeof reverse === "boolean" ? { reverse } : {}),
    ...(parsed.levels ? { levels: parsed.levels } : {}),
  };
  return { ok: true, fib: Object.keys(changed).length ? { ...FIB_DEFAULTS, ...changed } : undefined };
}

const TV_INTERVAL_MAP: Record<Timeframe, { unit: "days" | "weeks" | "months"; n: number; max: number }> = {
  D: { unit: "days", n: 1, max: 366 },
  "3D": { unit: "days", n: 3, max: 366 },
  W: { unit: "weeks", n: 1, max: 52 },
  M: { unit: "months", n: 1, max: 12 },
  Q: { unit: "months", n: 3, max: 12 },
  Y: { unit: "months", n: 12, max: 12 },
};

/**
 * Map TradingView's `intervalsVisibilities` (`days`/`weeks`/`months` and their From/To bounds) to
 * this app's timeframes. Returns `undefined` when all supported timeframes are visible (or the
 * field is absent), a non-empty subset when restricted, and `[]` when no supported timeframe
 * matches (e.g. an intraday-only drawing).
 */
export function timeframesFromTv(raw: unknown): Timeframe[] | undefined {
  if (!isObj(raw)) return undefined;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const visible = TIMEFRAMES.filter((tf) => {
    const { unit, n, max } = TV_INTERVAL_MAP[tf];
    if (raw[unit] === false) return false;
    const from = num(raw[`${unit}From`], 1);
    const to = num(raw[`${unit}To`], max);
    return n >= from && n <= to;
  });
  if (visible.length === 0) return [];
  return normalizeTimeframes(visible);
}

// ---------------------------------------------------------------------------- types

type Kind = "line" | "text" | "label";

interface Mapping {
  name: string;
  /** Points used; `many` takes them all (at least 2) */
  points: number | "many";
  kind?: Kind;
  colors?: string[];
}

const m = (name: string, points: number | "many", kind: Kind = "line", colors?: string[]): Mapping => ({ name, points, kind, colors });

/**
 * TradingView tool → this app's tool (`DRAW_GROUPS`). Trend lines (by their extend flags),
 * horizontal rays, ellipses, curves and positions need more than a rename and are handled apart.
 */
export const TV_TOOLS: Record<string, Mapping> = {
  LineToolRay: m("rayLine", 2),
  LineToolExtended: m("straightLine", 2),
  LineToolInfoLine: m("infoLine", 2),
  LineToolTrendAngle: m("trendAngle", 2),
  LineToolHorzLine: m("horizontalStraightLine", 1),
  LineToolVertLine: m("verticalStraightLine", 1),
  LineToolCrossLine: m("crossLine", 1),
  LineToolParallelChannel: m("parallelChannel", 3),
  LineToolRegressionTrend: m("regressionTrend", 2),
  LineToolPitchfork: m("pitchfork", 3),
  LineToolFibRetracement: m("fibonacciLine", 2),
  LineToolTrendBasedFibExtension: m("fibExtension", 3),
  LineToolFibChannel: m("fibChannel", 3),
  LineToolFibTimeZone: m("fibTimeZone", 2),
  LineToolFibSpeedResistanceFan: m("fibFan", 2),
  LineToolFibCircles: m("fibCircles", 2),
  LineToolFibSpiral: m("fibSpiral", 2),
  LineToolFibSpeedResistanceArcs: m("fibArcs", 2),
  LineToolGannComplex: m("gannBox", 2),
  LineToolGannSquare: m("gannBox", 2),
  LineToolGannFan: m("gannFan", 2),
  LineTool5PointsPattern: m("xabcd", 5),
  LineToolABCD: m("abcd", 4),
  LineToolTrianglePattern: m("trianglePattern", 4),
  LineToolHeadAndShoulders: m("headShoulders", 7),
  LineToolElliottImpulse: m("elliottImpulse", 6),
  LineToolElliottCorrection: m("elliottCorrection", 4),
  LineToolElliottTriangle: m("elliottTriangle", 6),
  LineToolElliottDoubleCombo: m("elliottDoubleCombo", 4),
  LineToolPriceRange: m("priceRange", 2),
  LineToolDateRange: m("dateRange", 2),
  LineToolDateAndPriceRange: m("datePriceRange", 2),
  LineToolBrush: m("brush", "many"),
  LineToolHighlighter: m("brush", "many"),
  LineToolRectangle: m("rect", 2),
  LineToolCircle: m("circle", 2),
  LineToolTriangle: m("triangle", 3),
  LineToolPath: m("path", "many"),
  LineToolPolyline: m("polyline", "many"),
  LineToolArc: m("arc", 3),
  LineToolText: m("text", 1, "text", TEXT_COLORS),
  LineToolNote: m("simpleAnnotation", 1, "text", LABEL_COLORS),
  LineToolComment: m("simpleAnnotation", 1, "text", LABEL_COLORS),
  LineToolCallout: m("simpleAnnotation", 1, "text", LABEL_COLORS),
  LineToolBalloon: m("simpleAnnotation", 1, "text", LABEL_COLORS),
  LineToolSignpost: m("simpleAnnotation", 1, "text", LABEL_COLORS),
  LineToolPriceLabel: m("priceLabel", 1, "label", LABEL_COLORS),
  LineToolPriceNote: m("priceLabel", 1, "label", LABEL_COLORS),
  LineToolFlagMark: m("flag", 1, "label", ["flagColor", ...LABEL_COLORS]),
  LineToolArrow: m("arrow", 2),
  LineToolArrowMarker: m("arrow", 2, "line", ["backgroundColor", ...LINE_COLORS]),
  LineToolArrowMarkUp: m("arrowMarkUp", 1),
  LineToolArrowMarkDown: m("arrowMarkDown", 1),
};

/** Handled in `shape()`; listed so a preview can tell them from tools that have no counterpart. */
const SPECIAL = new Set(["LineToolTrendLine", "LineToolHorzRay", "LineToolEllipse", "LineToolBezierQuadro", "LineToolRiskRewardLong", "LineToolRiskRewardShort"]);

export const isSupportedTool = (type: string) => type in TV_TOOLS || SPECIAL.has(type);

/** The skip reason for a tool this app does not have; reports count them per type. */
export const unsupported = (type: string) => `没有对应的工具：${type}`;

export type Converted = { ok: true; overlay: OverlaySpec } | { ok: false; reason: string };

const mid = (a: Pt, b: Pt): Pt => ({ timestamp: (a.timestamp + b.timestamp) / 2, value: (a.value + b.value) / 2 });

/** The app's name and points for a drawing whose points are already converted; a string is why not. */
function shape(d: TvDrawing, pts: Pt[], ctx: DrawingContext): { name: string; points: Pt[] } | string {
  const need = (n: number) => (pts.length >= n ? null : `点不够（${d.type} 要 ${n} 个）`);
  switch (d.type) {
    case "LineToolTrendLine": {
      const short = need(2);
      if (short) return short;
      const [a, b] = pts;
      const left = d.state.extendLeft === true;
      const right = d.state.extendRight === true;
      if (left && right) return { name: "straightLine", points: [a, b] };
      if (right) return { name: "rayLine", points: [a, b] };
      if (left) return { name: "rayLine", points: [b, a] };
      return { name: "segment", points: [a, b] };
    }
    case "LineToolHorzRay": {
      const short = need(1);
      if (short) return short;
      // KLineChart's ray takes its direction from a second point; 100 days is a later bar on every timeframe
      return { name: "horizontalRayLine", points: [pts[0], { timestamp: pts[0].timestamp + 100 * DAY * 1000, value: pts[0].value }] };
    }
    case "LineToolEllipse": {
      const short = need(2);
      if (short) return short;
      if (pts.length === 2) return { name: "ellipse", points: pts.slice(0, 2) };
      // two ends of one axis and a point on the other: its bounding box, upright
      const [a, b, c] = pts;
      const center = mid(a, b);
      const half = Math.abs(b.timestamp - a.timestamp) / 2;
      const ry = Math.abs(c.value - center.value);
      return {
        name: "ellipse",
        points: [
          { timestamp: center.timestamp - half, value: center.value + ry },
          { timestamp: center.timestamp + half, value: center.value - ry },
        ],
      };
    }
    case "LineToolBezierQuadro": {
      const short = need(3);
      if (short) return short;
      // TradingView's third point is the control point; the app's is the middle of the curve
      const [a, b, control] = pts;
      return { name: "curve", points: [a, b, mid(control, mid(a, b))] };
    }
    case "LineToolRiskRewardLong":
    case "LineToolRiskRewardShort": {
      const short = need(1);
      if (short) return short;
      // TradingView keeps the target and the stop as distances in ticks from the entry
      const profit = Number(d.state.profitLevel);
      const loss = Number(d.state.stopLevel);
      if (!Number.isFinite(profit) || !Number.isFinite(loss)) return "多空持仓缺少止盈 / 止损";
      if (ctx.tick === null) return "没有 K 线，算不出最小变动价位";
      const [entry, edge] = pts;
      const dir = d.type === "LineToolRiskRewardLong" ? 1 : -1;
      const target = entry.value + dir * profit * ctx.tick;
      const stop = entry.value - dir * loss * ctx.tick;
      const end = edge && edge.timestamp > entry.timestamp ? edge.timestamp : entry.timestamp + 20 * DAY * 1000;
      return {
        name: d.type === "LineToolRiskRewardLong" ? "longPosition" : "shortPosition",
        points: [entry, { timestamp: end, value: target }, { timestamp: end, value: stop }],
      };
    }
  }
  const map = TV_TOOLS[d.type];
  if (map.points === "many") {
    // a brush stroke on intraday bars collapses onto days; repeats are dropped like the chart does
    const distinct = pts.filter((p, i) => i === 0 || p.timestamp !== pts[i - 1].timestamp || p.value !== pts[i - 1].value);
    return distinct.length >= 2 ? { name: map.name, points: distinct } : "点不够";
  }
  return need(map.points) ?? { name: map.name, points: pts.slice(0, map.points) };
}

/** Day the middle points of a curve or ellipse are snapped to, so every point sits on a bar. */
const toDay = (p: Pt, days: number[]): Pt => ({ timestamp: snap(days, Math.floor(p.timestamp / 1000 / DAY) * DAY) * 1000, value: p.value });

/** One TradingView drawing as an overlay record of `charts/<fileKey>.json`. */
export function convertDrawing(d: TvDrawing, ctx: DrawingContext): Converted {
  if (!isSupportedTool(d.type)) return { ok: false, reason: unsupported(d.type) };
  const map = TV_TOOLS[d.type] as Mapping | undefined;
  const kind = map?.kind ?? "line";
  const text = typeof d.state.text === "string" ? d.state.text : "";
  if (kind === "text" && !text.trim()) return { ok: false, reason: "文字为空" };

  const pts: Pt[] = [];
  for (const p of d.points) {
    const r = convertPoint(p, ctx);
    if (typeof r === "string") return { ok: false, reason: r };
    pts.push(r);
  }
  const s = shape(d, pts, ctx);
  if (typeof s === "string") return { ok: false, reason: s };

  const overlay: OverlaySpec = { name: s.name, points: s.points.map((p) => (p.timestamp % (DAY * 1000) ? toDay(p, ctx.days) : p)) };
  const styles = stylesOf(d.state, map?.colors ?? LINE_COLORS, kind === "text", FIB_DRAWINGS.has(s.name));
  if (styles) overlay.styles = styles;
  if (d.state.frozen === true) overlay.lock = true;
  if (d.state.visible === false) overlay.hidden = true;
  if (kind === "text") overlay.extendData = text;
  if (FIB_DRAWINGS.has(s.name)) {
    const fib = fibOf(d.state);
    if (!fib.ok) return fib;
    if (fib.fib) overlay.extendData = fib.fib;
  }
  const timeframes = timeframesFromTv(d.state.intervalsVisibilities);
  if (timeframes && timeframes.length === 0) {
    const vis = isObj(d.state.intervalsVisibilities) ? d.state.intervalsVisibilities : {};
    return { ok: false, reason: vis.days === false && vis.weeks === false && vis.months === false ? REASON_INTRADAY_ONLY : REASON_UNSUPPORTED_TIMEFRAMES };
  }
  if (timeframes) overlay.timeframes = timeframes;
  return { ok: true, overlay };
}

/** TradingView ids of the imported drawings still on a chart; one deleted there comes back with the next import. */
export const importedIds = (overlays: OverlaySpec[]) => new Set(overlays.flatMap((o) => (o.tvId ? [o.tvId] : [])));

export interface Conversion {
  /** Each with the `tvId` of its drawing */
  overlays: OverlaySpec[];
  /** Imported before (a drawing in the chart file has their id) */
  already: number;
  /** Why the rest were left out, with counts */
  skipped: Record<string, number>;
}

/** The drawings of one symbol, minus those imported before (`importedIds` of its chart). */
export function convertDrawings(drawings: TvDrawing[], ctx: DrawingContext, imported: ReadonlySet<string>): Conversion {
  const out: Conversion = { overlays: [], already: 0, skipped: {} };
  for (const d of drawings) {
    if (imported.has(d.id)) {
      out.already++;
      continue;
    }
    const r = convertDrawing(d, ctx);
    if (r.ok) out.overlays.push({ ...r.overlay, tvId: d.id });
    else out.skipped[r.reason] = (out.skipped[r.reason] ?? 0) + 1;
  }
  return out;
}

/** A layout link (`https://www.tradingview.com/chart/AbCd1234/`) or a bare layout id; null when it is neither. */
export function layoutId(input: string): string | null {
  const s = input.trim();
  const url = /tradingview\.com\/chart\/([A-Za-z0-9]+)/.exec(s);
  if (url) return url[1];
  return /^[A-Za-z0-9]{4,16}$/.test(s) ? s : null;
}
