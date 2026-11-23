/**
 * TradingView's Fibonacci retracement and trend-based extension: default and custom levels,
 * built-in presets (including Rule of 7), personal templates, the settings a drawing keeps in its
 * `extendData` (design §1.3), and where the level lines and the bands between them run. Pure, so
 * it is tested and loaded on the server without a chart.
 */
import { levelPrice, type PriceScale } from "./drawing-scale";
import type { LineDash } from "./drawing-style";

export interface FibLevel {
  level: number;
  color: string;
}

export interface FibLevelItem extends FibLevel {
  /** Shown on the chart; omitted means true */
  enabled?: boolean;
}

export const DEFAULT_FIB_COLOR = "#787b86";

/** TradingView's default levels and their colours, the same for both tools. */
export const FIB_LEVELS: FibLevel[] = [
  { level: 0, color: "#787b86" },
  { level: 0.236, color: "#f23645" },
  { level: 0.382, color: "#ff9800" },
  { level: 0.5, color: "#4caf50" },
  { level: 0.618, color: "#089981" },
  { level: 0.786, color: "#00bcd4" },
  { level: 1, color: "#787b86" },
  { level: 1.618, color: "#2962ff" },
  { level: 2.618, color: "#f23645" },
  { level: 3.618, color: "#9c27b0" },
  { level: 4.236, color: "#e91e63" },
];

export const FIB_DRAWINGS = new Set(["fibonacciLine", "fibExtension"]);

export interface FibSettings {
  /** The bands between the levels are filled */
  background: boolean;
  /** Of the fill, in percent as TradingView counts it: 80 is an alpha of 0.2 */
  transparency: number;
  extendLeft: boolean;
  extendRight: boolean;
  /** TradingView's 使用单一颜色: every level in the drawing's own colour instead of one each */
  oneColor: boolean;
  /** TradingView's 反向: the levels run the other way, the points stay */
  reverse: boolean;
  /** Custom levels; omitted means `FIB_LEVELS` */
  levels?: FibLevelItem[];
}

export interface FibTemplate {
  name: string;
  levels: FibLevelItem[];
  background?: boolean;
  transparency?: number;
  extendLeft?: boolean;
  extendRight?: boolean;
  oneColor?: boolean;
  reverse?: boolean;
  color?: string;
  size?: number;
  dash?: LineDash;
}

export const FIB_DEFAULTS: FibSettings = { background: true, transparency: 80, extendLeft: false, extendRight: false, oneColor: false, reverse: false };

/** Built-in presets available to every user out of the box (Rule of 7 targets: 7/4, 7/3, 7/2, 7/1). */
export const FIB_PRESETS: FibTemplate[] = [
  {
    name: "默认",
    levels: FIB_LEVELS.map((l) => ({ ...l })),
  },
  {
    name: "精简回撤",
    levels: [
      { level: 0, color: "#787b86" },
      { level: 0.382, color: "#ff9800" },
      { level: 0.5, color: "#4caf50" },
      { level: 0.618, color: "#089981" },
      { level: 0.786, color: "#00bcd4" },
      { level: 1, color: "#787b86" },
      { level: 1.618, color: "#2962ff" },
    ],
  },
  {
    name: "Rule of 7",
    levels: [
      { level: 0, color: "#787b86" },
      { level: 1, color: "#787b86" },
      { level: 1.75, color: "#2962ff" },
      { level: 2.333, color: "#089981" },
      { level: 3.5, color: "#ff9800" },
      { level: 7, color: "#f23645" },
    ],
  },
];

export const isPresetFibTemplate = (name: string): boolean => FIB_PRESETS.some((p) => p.name === name);

/** `#abc` or `#aabbcc`, as lower-case `#aabbcc`; anything else is null. */
export function normalizeHex(v: unknown): string | null {
  const m = typeof v === "string" ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

/** Validate and normalize a list of custom Fibonacci levels, dropping non-finite entries. */
export function normalizeFibLevels(raw: unknown): FibLevelItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FibLevelItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    const level = typeof d.level === "number" ? d.level : Number(d.level);
    if (!Number.isFinite(level)) continue;
    const color = normalizeHex(d.color) ?? DEFAULT_FIB_COLOR;
    out.push(d.enabled === false ? { level, color, enabled: false } : { level, color });
  }
  return out;
}

/** Whether a custom level list is indistinguishable from `FIB_LEVELS` (all enabled, same order, values and colours). */
export function isDefaultFibLevels(levels: readonly FibLevelItem[] | undefined): boolean {
  if (!levels) return true;
  if (levels.length !== FIB_LEVELS.length) return false;
  return levels.every(
    (l, i) => l.enabled !== false && l.level === FIB_LEVELS[i].level && (normalizeHex(l.color) ?? DEFAULT_FIB_COLOR) === FIB_LEVELS[i].color,
  );
}

/** Levels as shown in the settings dialog (always a fresh copy). */
export function fibLevelsOf(settings: Pick<FibSettings, "levels">): FibLevelItem[] {
  const list: readonly FibLevelItem[] = settings.levels && settings.levels.length > 0 ? settings.levels : FIB_LEVELS;
  return list.map((l) => ({ level: l.level, color: l.color, enabled: l.enabled !== false }));
}

/** Enabled levels to draw, sorted ascending by value so bands always sit between neighbouring levels. */
export function activeFibLevels(settings: Pick<FibSettings, "levels">): FibLevel[] {
  const source: readonly FibLevelItem[] = settings.levels && settings.levels.length > 0 ? settings.levels : FIB_LEVELS;
  const active = source.filter((l) => l.enabled !== false && Number.isFinite(l.level)).map(({ level, color }) => ({ level, color }));
  if (active.length === 0) return FIB_LEVELS;
  return active.sort((a, b) => a.level - b.level);
}

/** Normalize a settings object for saving: omit `levels` when equal to defaults, clamp transparency. */
export function cleanFibSettings(settings: FibSettings): FibSettings {
  const levels = settings.levels ? normalizeFibLevels(settings.levels) : undefined;
  const hasEnabled = Boolean(levels?.some((l) => l.enabled !== false));
  const transparency = Number.isFinite(settings.transparency) ? Math.min(100, Math.max(0, Math.round(settings.transparency))) : FIB_DEFAULTS.transparency;
  return {
    background: Boolean(settings.background),
    transparency,
    extendLeft: Boolean(settings.extendLeft),
    extendRight: Boolean(settings.extendRight),
    oneColor: Boolean(settings.oneColor),
    reverse: Boolean(settings.reverse),
    ...(levels && hasEnabled && !isDefaultFibLevels(levels) ? { levels } : {}),
  };
}

/** A drawing's settings from its `extendData`; one that has none (never changed, or saved before these existed) has the defaults. */
export function fibSettingsOf(extendData: unknown): FibSettings {
  const raw = extendData && typeof extendData === "object" && !Array.isArray(extendData) ? (extendData as Partial<FibSettings>) : undefined;
  const merged: FibSettings = { ...FIB_DEFAULTS, ...raw };
  if (raw?.levels !== undefined) {
    const levels = normalizeFibLevels(raw.levels);
    if (levels.some((l) => l.enabled !== false)) merged.levels = levels;
    else delete merged.levels;
  }
  return merged;
}

/** Apply a preset or personal template to produce a drawing's `FibSettings`. */
export function applyFibTemplate(tpl: FibTemplate): FibSettings {
  const levels = normalizeFibLevels(tpl.levels);
  return cleanFibSettings({
    background: tpl.background ?? FIB_DEFAULTS.background,
    transparency: tpl.transparency ?? FIB_DEFAULTS.transparency,
    extendLeft: tpl.extendLeft ?? FIB_DEFAULTS.extendLeft,
    extendRight: tpl.extendRight ?? FIB_DEFAULTS.extendRight,
    oneColor: tpl.oneColor ?? FIB_DEFAULTS.oneColor,
    reverse: tpl.reverse ?? FIB_DEFAULTS.reverse,
    levels,
  });
}

/** Capture the current Fib settings (and optional drawing line style) as a personal template. */
export function fibTemplateFrom(
  name: string,
  settings: FibSettings,
  style?: { color?: string; size?: number; dash?: LineDash },
): FibTemplate {
  const clean = cleanFibSettings(settings);
  const source: readonly FibLevelItem[] = clean.levels ?? FIB_LEVELS;
  const levels = source.map((l) => (l.enabled === false ? { level: l.level, color: l.color, enabled: false } : { level: l.level, color: l.color }));
  const color = normalizeHex(style?.color) ?? undefined;
  return {
    name: name.trim(),
    levels,
    ...(clean.background !== FIB_DEFAULTS.background ? { background: clean.background } : {}),
    ...(clean.transparency !== FIB_DEFAULTS.transparency ? { transparency: clean.transparency } : {}),
    ...(clean.extendLeft !== FIB_DEFAULTS.extendLeft ? { extendLeft: clean.extendLeft } : {}),
    ...(clean.extendRight !== FIB_DEFAULTS.extendRight ? { extendRight: clean.extendRight } : {}),
    ...(clean.oneColor !== FIB_DEFAULTS.oneColor ? { oneColor: clean.oneColor } : {}),
    ...(clean.reverse !== FIB_DEFAULTS.reverse ? { reverse: clean.reverse } : {}),
    ...(color ? { color } : {}),
    ...(style?.size !== undefined ? { size: style.size } : {}),
    ...(style?.dash !== undefined && style.dash !== "solid" ? { dash: style.dash } : {}),
  };
}

/**
 * The price of a level, a share of a move in the drawing's scale. A retracement (two prices) has 0
 * at its second point and 1 at its first, and runs on past the first; reversed, 0 is at the first
 * and it runs on past the second. An extension (three) is the move from the first point to the
 * second counted from the third; reversed, that move the other way from the third.
 */
export function fibPrice(scale: PriceScale, [a, b, c]: number[], level: number, reverse: boolean): number {
  const forward = c === undefined ? reverse : !reverse;
  const [from, to] = forward ? [a, b] : [b, a];
  return levelPrice(scale, from, to, level, c ?? from);
}

/** Where the level lines run: between the two x, and on to the pane's edge on a side that is extended. */
export function fibSpan(xa: number, xb: number, s: Pick<FibSettings, "extendLeft" | "extendRight">, width: number): [number, number] {
  const [x0, x1] = [Math.min(xa, xb), Math.max(xa, xb)];
  return [s.extendLeft ? Math.min(0, x0) : x0, s.extendRight ? Math.max(width, x1) : x1];
}

/**
 * The band between each two neighbouring levels (given in order, `y` in px), in the colour of the
 * one further along, as TradingView fills them.
 */
export function fibBands(levels: { y: number; color: string }[]): { y: number; height: number; color: string }[] {
  return levels.slice(1).map((l, i) => ({ y: Math.min(l.y, levels[i].y), height: Math.abs(l.y - levels[i].y), color: l.color }));
}
