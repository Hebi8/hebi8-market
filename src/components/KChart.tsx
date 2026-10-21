"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  dispose,
  init,
  registerIndicator,
  registerOverlay,
  registerYAxis,
  type Chart,
  type Coordinate,
  type Crosshair,
  type DeepPartial,
  type Indicator,
  type IndicatorStyle,
  type IndicatorTemplate,
  type KLineData,
  type AxisRange,
  type Overlay,
  type OverlayCreate,
  type OverlayFigure,
  type PaneOptions,
  type Point,
  type Styles,
  type YAxisOverride,
} from "klinecharts";
import { customIndicators } from "@/indicators/custom";
import type { RefSeries } from "@/indicators/formula";
import type { BarsTail, ChartBar } from "@/lib/api-types";
import type { ChartStyle, LineOverride } from "@/lib/config";
import { barCloseAt, fmtCountdown, type SessionClock } from "@/lib/session";
import type { Timeframe } from "@/lib/symbols";
import type { CompareEntry, OverlaySpec } from "@/lib/vault";
import { ChartLegend, createLegendStore, type ChartLegendProps } from "./ChartLegend";
import { indicatorLines, styleRows } from "./indicator-style";
import { IconAlarm } from "./chart-icons";
import { timeAxisBarSpace } from "./chart-gestures";
import { registerDrawingTemplates, setOverlayChart, setOverlayTheme, snapToBar, textOf, textSizeOf } from "./chart-overlays";
import { LOG_AXIS } from "./log-axis";
import { extensionOf, historyOf, record, redo, TREND_LINES, undo, withExtension, type History } from "./drawing-edit";
import { drawingOf, specOf, type DrawingFlags } from "./drawing-spec";
import { dashOf, drawingStyles, lineOf, withAlpha } from "./drawing-style";
import { FIB_DRAWINGS, fibSettingsOf } from "./fib";
import { COMPARE_COLORS, DRAW_DONE, MEASURE_TOOL, MONO, OPEN_DRAWINGS, SANS, SCALED_DRAWINGS, TEXT_DRAWINGS, type ChartControl, type IndicatorLine, type IndicatorSpec, type LegendValue } from "./chart-types";
import { DrawingSettings, DrawingToolbar, TextEditor, type DrawingChange, type DrawingInfo } from "./DrawingToolbar";

export interface DrawingModes {
  magnet: boolean;
  locked: boolean;
  hidden: boolean;
}

interface KChartProps {
  symbolKey: string;
  tf: Timeframe;
  bars: ChartBar[] | null;
  /** Whether the symbol counts calendar days rather than weekdays (its 3D bars, drawings past the bars) */
  weekends: boolean;
  /** The last bar after a quote round: it replaces the chart's last one (or follows it on a new day) without loading the bars again */
  tail: BarsTail | null;
  /** What the countdown under the last price needs: the quote's session and the exchange's hours */
  clock: SessionClock;
  pricePrecision: number;
  log: boolean;
  /** The user's % axis; compares in percent mode force it on regardless */
  percentAxis: boolean;
  chartStyle: ChartStyle;
  indicators: IndicatorSpec[];
  /** Formula templates, re-registered on every change so edits swap in */
  templates: IndicatorTemplate<Record<string, number | undefined>>[];
  compare: (CompareEntry & { hidden?: boolean })[];
  refs: Record<string, RefSeries>;
  overlays: OverlaySpec[];
  onOverlaysChange: (overlays: OverlaySpec[]) => void;
  /** Overlay name of the active drawing tool (or `MEASURE_TOOL`), null when not drawing */
  drawTool: string | null;
  /** A drawing finished or was abandoned, so the toolbar can go back to the cursor */
  onDrawDone: () => void;
  clearSeq: number;
  /** Bumped by 显示所有绘图: drawings hidden one by one come back too */
  revealSeq: number;
  /** Bumped when `overlays` was read again from the server (the page came back into view): drawings that differ are put back */
  reloadSeq: number;
  drawing: DrawingModes;
  /** Filled with the imperative handle for hotkeys and the bottom bar */
  controlRef: RefObject<ChartControl | null>;
  /** The price axis went to manual scale (dragged) or back to auto */
  onAutoScaleChange: (auto: boolean) => void;
  /** Everything the in-chart legend needs besides the live values */
  legend: Omit<ChartLegendProps, "store" | "onMainHeight" | "pricePrecision" | "compare">;
  /** This symbol's price alert levels: dashed lines with an alarm label on the price axis, never saved as drawings */
  alertLines: { id: string; price: number }[];
  /** 添加警报 at a price: right click on the main pane, or the alarm on a selected horizontal line */
  onAddAlert: (price: number) => void;
  /** The alarm label of an alert line was clicked */
  onEditAlert: (id: string) => void;
}

/** Alert lines live in their own overlay group, apart from the drawings. */
const ALERT_GROUP = "price_alerts";
/** ...and so does the ruler of 测量, which is on the chart only until the next click. */
const MEASURE_GROUP = "measure";
/** An overlay that is one of the user's drawings. */
const isDrawing = (o: Overlay) => o.groupId !== ALERT_GROUP && o.groupId !== MEASURE_GROUP;
/** Drawings whose floating toolbar offers 添加警报 (the line's price is copied). */
const PRICE_LINES = new Set(["horizontalStraightLine", "horizontalRayLine", "crossLine"]);

/** The y-axis object behind `getYAxes`; KLineChart keeps these methods off its public type. */
interface AxisImpl {
  id: string;
  name: string;
  getRange: () => AxisRange;
  setRange: (range: AxisRange) => void;
  getAutoCalcTickFlag: () => boolean;
  setAutoCalcTickFlag: (flag: boolean) => void;
}

/** KLineChart's event dispatcher (`chart._chartEvent`, off its public type): it asks this for the pane and axis under every event. */
interface WidgetHit {
  pane: unknown;
  widget: unknown;
}
interface ChartEvents {
  _findWidgetByEvent: (e: Coordinate) => WidgetHit;
  pinchStartEvent: () => boolean;
}

const PERIODS = {
  D: { type: "day", span: 1 },
  "3D": { type: "day", span: 3 },
  W: { type: "week", span: 1 },
  M: { type: "month", span: 1 },
  Q: { type: "month", span: 3 },
} as const;

/** How many bars the initial view should fit: ~2 years of days, ~3 years of 3D bars, ~5 years of weeks, all months. */
const INITIAL_BARS: Record<Timeframe, number> = { D: 500, "3D": 250, W: 260, M: Infinity, Q: Infinity };

function initialBarSpace(width: number, tf: Timeframe, total: number): number {
  const plotWidth = Math.max(200, width - 80); // minus the y-axis
  return Math.min(12, Math.max(1.5, plotWidth / Math.min(total, INITIAL_BARS[tf])));
}

const CANDLE_PANE = "candle_pane";
const X_AXIS_PANE = "x_axis_pane";
/** The main pane keeps at least this share of the chart; sub panes are 100px, all shrunk alike when they do not fit. */
const MAIN_PANE_SHARE = 0.45;
const SUB_PANE_HEIGHT = 100;
const SUB_PANE_MIN_HEIGHT = 60;
const MIN_BAR_SPACE = 1;
const MAX_BAR_SPACE = 50;
const BOTTOM_GAP = 0.1;
const MAX_COMPARE = COMPARE_COLORS.length;
/**
 * Volume moved onto the main pane, as TradingView overlays it: no scale of its own on screen, the
 * bars in the bottom quarter (the range is stretched to four times the volumes).
 */
const VOLUME_AXIS: YAxisOverride = {
  needWidget: false,
  gap: { top: 0, bottom: 0 },
  createRange: ({ defaultRange: r }) => {
    const to = r.from + r.range * 4;
    return { ...r, to, range: to - r.from, realTo: to, realRange: to - r.realFrom, displayTo: to, displayRange: to - r.displayFrom };
  },
};
/** Ids of the saved drawings put on a chart (KLineChart makes up the rest). */
let drawingSeq = 0;
const compareName = (slot: number) => `CMP${slot}`;
const comparePane = (slot: number) => `pane_cmp_${slot}`;
const isCompare = (name: string) => name.startsWith("CMP");
/** Aligned closes per compare slot; templates read them by slot so overrides never merge data. */
const compareSeries: ((number | null)[] | undefined)[] = [];

let registered = false;
function registerTemplates() {
  if (registered) return;
  registered = true;
  registerDrawingTemplates();
  // the built-in log axis turns prices below 1 negative on the way back out of log space
  registerYAxis(LOG_AXIS);
  // TradingView's alert line: dashed across the pane, ⏰ and the price on the axis (clicking it edits)
  registerOverlay<{ id: string }>({
    name: "priceAlert",
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding }) => ({
      type: "line",
      attrs: { coordinates: [{ x: 0, y: coordinates[0].y }, { x: bounding.width, y: coordinates[0].y }] },
      ignoreEvent: true,
    }),
    // the label starts at the axis' left edge; the clock is drawn, not an emoji, so every font shows it
    createYAxisFigures: ({ chart, overlay, coordinates }) => {
      const y = coordinates[0].y;
      const value = overlay.points[0]?.value ?? 0;
      const precision = chart.getSymbol()?.pricePrecision ?? 2;
      const still: OverlayFigure["ignoreEvent"] = ["onPressedMoveStart", "onPressedMoving", "onPressedMoveEnd", "onRightClick", "onDoubleClick"];
      const ink = { color: "#ffffff", size: 1 };
      return [
        { type: "text", attrs: { x: 0, y, text: fmtValue(value, precision, false), align: "left", baseline: "middle" }, ignoreEvent: still },
        { type: "circle", attrs: { x: 10, y, r: 4 }, styles: { style: "stroke", borderColor: "#ffffff", borderSize: 1 }, ignoreEvent: true },
        { type: "line", attrs: { coordinates: [{ x: 10, y: y - 2.5 }, { x: 10, y }, { x: 12, y: y + 1 }] }, styles: ink, ignoreEvent: true },
      ];
    },
  });
  customIndicators.forEach((template) => registerIndicator(template as Parameters<typeof registerIndicator>[0]));
  for (let slot = 0; slot < MAX_COMPARE; slot++) {
    registerIndicator<{ v?: number }, number>({
      name: compareName(slot),
      shortName: "对比",
      series: "price",
      // [base index, raw flag]: rebased to the main close at `base`, or the raw close in its own pane
      calcParams: [0, 0],
      figures: [{ key: "v", title: "", type: "line" }],
      calc: (dataList, indicator) => {
        const closes = compareSeries[slot] ?? [];
        const [base, raw] = indicator.calcParams;
        const mainBase = dataList[base]?.close;
        const cmpBase = closes[base];
        return dataList.map((_, i) => {
          const c = closes[i];
          if (c == null) return {};
          if (raw) return { v: c };
          return mainBase && cmpBase ? { v: (mainBase * c) / cmpBase } : {};
        });
      },
    });
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applyTheme(chart: Chart, style: ChartStyle) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const up = cssVar("--up");
  const down = cssVar("--down");
  const muted = cssVar("--muted");
  const line = cssVar("--line");
  const accent = cssVar("--accent");
  const axis = { axisLine: { color: line }, tickLine: { color: line }, tickText: { color: muted, family: MONO, size: 11 } };
  const overrides: DeepPartial<Styles> = {
    grid: { horizontal: { color: cssVar("--chart-grid") }, vertical: { show: false } },
    candle: {
      type: style,
      area: {
        lineColor: accent,
        lineSize: 1.5,
        backgroundColor: [
          { offset: 0, color: withAlpha(accent, 0.01) },
          { offset: 1, color: withAlpha(accent, 0.16) },
        ],
      },
      bar: {
        upColor: up,
        downColor: down,
        noChangeColor: muted,
        upBorderColor: up,
        downBorderColor: down,
        noChangeBorderColor: muted,
        upWickColor: up,
        downWickColor: down,
        noChangeWickColor: muted,
      },
      priceMark: {
        high: { textFamily: MONO },
        low: { textFamily: MONO },
        last: {
          upColor: up,
          downColor: down,
          noChangeColor: muted,
          text: { family: MONO },
          // TradingView's countdown to the bar's close, joined to the price label; the text comes from `formatExtendText`
          extendTexts: [
            {
              show: true,
              style: "fill",
              position: "below_price",
              updateInterval: 1000,
              size: 11,
              family: MONO,
              weight: "normal",
              color: "#ffffff",
              paddingLeft: 4,
              paddingTop: 0,
              paddingRight: 4,
              paddingBottom: 4,
              borderStyle: "solid",
              borderColor: "transparent",
              borderSize: 0,
              borderDashedValue: [2, 2],
              borderRadius: 2,
            },
          ],
        },
      },
      // the React legend (ChartLegend) shows OHLC, indicator and compare values, TradingView style
      tooltip: { showRule: "none" },
    },
    indicator: {
      bars: [{ upColor: withAlpha(up, 0.55), downColor: withAlpha(down, 0.55), noChangeColor: muted }],
      tooltip: { showRule: "none" },
      lastValueMark: { text: { family: MONO } },
    },
    crosshair: { horizontal: { text: { family: MONO } }, vertical: { text: { family: MONO } } },
    overlay: {
      line: { color: accent },
      point: { color: accent, borderColor: withAlpha(accent, 0.35), activeColor: accent, activeBorderColor: withAlpha(accent, 0.35) },
      rect: { color: withAlpha(accent, 0.12), borderColor: accent },
      polygon: { color: withAlpha(accent, 0.12), borderColor: accent },
      circle: { color: withAlpha(accent, 0.12), borderColor: accent },
      arc: { color: accent },
      text: { family: SANS, backgroundColor: accent, borderColor: accent },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: line },
  };
  chart.setStyles(dark ? "dark" : "light");
  chart.setStyles(overrides);
  setOverlayTheme({ up, down, text: cssVar("--fg") });
}

/** The other symbols' values at bar `at`, written into the aligned columns the formula and compare lines read. */
function patchRefs(refs: Record<string, RefSeries>, at: number, points: BarsTail["refs"]): void {
  for (const [key, point] of Object.entries(points)) {
    const series = refs[key];
    if (!series) continue;
    for (const field of ["o", "h", "l", "c", "v"] as const) {
      const column = series[field];
      if (column) column[at] = point[field];
    }
  }
}

/** Points without repeats in a row (two clicks on one spot). */
function distinctPoints(points: Partial<Point>[]): Partial<Point>[] {
  return points.filter((p, i) => i === 0 || p.timestamp !== points[i - 1].timestamp || p.value !== points[i - 1].value);
}

/** Finished drawings on the main pane; `except` is one being removed right now. */
function serializeOverlays(chart: Chart, flags: Map<string, DrawingFlags>, except?: string): OverlaySpec[] {
  return chart.getOverlays().flatMap((o) => {
    if (o.paneId !== CANDLE_PANE || o.id === except || !isDrawing(o) || o.currentStep !== DRAW_DONE) return [];
    const spec = specOf(o, flags);
    return spec ? [spec] : [];
  });
}

function fmtValue(value: number, precision: number, big: boolean): string {
  const abs = Math.abs(value);
  if (big && abs >= 1e3) {
    const [div, unit] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    return `${(value / div).toFixed(2)}${unit}`;
  }
  return value.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

/** The 样式 page's lines over KLineChart's own; the figures, and so the number of lines, exist once it is created. */
function restyleLines(chart: Chart, id: string | null, own: LineOverride[] | undefined) {
  const ind = id ? chart.getIndicators({ id })[0] : undefined;
  if (!ind) return;
  const lines = indicatorLines(chart.getStyles().indicator.lines, own, ind.figures.filter((f) => f.type === "line").length);
  if (lines) chart.overrideIndicator({ name: ind.name, paneId: ind.paneId, styles: { lines } });
}

/** The 样式 page's rows of an indicator on the chart (with `params`: the lines those would draw), or of one drawing `titles`. */
function defaultLines(chart: Chart, name: string, from: { params?: number[]; titles?: string[] }): IndicatorLine[] | null {
  const ind = from.titles ? { figures: from.titles.map((title) => ({ key: title, title, type: "line" })) } : chart.getIndicators({ name }).find((i) => !isCompare(i.name));
  return ind ? styleRows(chart.getStyles().indicator.lines, ind as Parameters<typeof styleRows>[1], from.params) : null;
}

/** Values at `idx` as KLineChart's own tooltip would show them: one per titled figure, in the figure's color. */
function indicatorValues(chart: Chart, ind: Indicator, idx: number, pricePrecision: number, bar: ChartBar | undefined): LegendValue[] {
  const defaults = chart.getStyles().indicator;
  const own = (ind.styles ?? {}) as Partial<IndicatorStyle>;
  const lists = {
    line: own.lines ?? defaults.lines,
    bar: own.bars ?? defaults.bars,
    circle: own.circles ?? defaults.circles,
    text: own.texts ?? defaults.texts,
  };
  const counts = { line: 0, bar: 0, circle: 0, text: 0 };
  const result = ind.result as (Record<string, unknown> | undefined)[];
  const data = result[idx] ?? {};
  const values: LegendValue[] = [];
  for (const figure of ind.figures) {
    const type = figure.type as keyof typeof lists | undefined;
    if (!type) continue;
    const kind = (type in counts ? type : "line") as keyof typeof counts;
    const list = lists[kind];
    const base = list[counts[kind]++ % list.length] as { color?: string; noChangeColor?: string };
    let color = (type === "bar" || type === "circle" ? base.noChangeColor : base.color) ?? "";
    const dynamic = figure.styles?.({
      data: { prev: result[idx - 1], current: result[idx], next: result[idx + 1] },
      indicator: ind,
      barSpace: chart.getBarSpace(),
      defaultStyles: defaults,
    } as Parameters<NonNullable<typeof figure.styles>>[0]);
    if (dynamic && typeof dynamic.color === "string") color = dynamic.color;
    if (typeof figure.title !== "string") continue;
    // KLineChart's VOL counts a bar without volume (an index, today's bar from a quote) as 0
    const v = ind.name === "VOL" && figure.key === "volume" && bar?.volume == null ? undefined : data[figure.key];
    // price-scale lines follow the symbol; oscillators get two decimals unless the values are tiny
    const precision = ind.series === "price" ? pricePrecision : typeof v === "number" && Math.abs(v) >= 1 ? Math.min(ind.precision, 2) : ind.precision;
    values.push({
      title: figure.title.replace(/:\s*$/, ""),
      text: typeof v === "number" && Number.isFinite(v) ? fmtValue(v, precision, ind.shouldFormatBigNumber) : "—",
      color,
    });
  }
  return values;
}

export function KChart({
  symbolKey,
  tf,
  bars,
  weekends,
  pricePrecision,
  log,
  percentAxis,
  chartStyle,
  indicators,
  templates,
  compare,
  refs,
  tail,
  clock,
  overlays,
  onOverlaysChange,
  drawTool,
  onDrawDone,
  clearSeq,
  revealSeq,
  reloadSeq,
  drawing,
  controlRef,
  onAutoScaleChange,
  legend,
  alertLines,
  onAddAlert,
  onEditAlert,
}: KChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const barsRef = useRef<ChartBar[]>([]);
  /** KLineChart's own way in for one bar: the same timestamp replaces the last bar, a later one is appended */
  const pushBarRef = useRef<((bar: KLineData) => void) | null>(null);
  const clockRef = useRef(clock);
  const tfRef = useRef(tf);
  const weekendsRef = useRef(weekends);
  const precisionRef = useRef(pricePrecision);
  const styleRef = useRef(chartStyle);
  const compareRef = useRef(compare);
  const basesRef = useRef<number[]>([]);
  /** Where the pointer is, not the bar under it: scrolling and zooming move the bars under a still pointer */
  const crosshairRef = useRef<{ x: number; paneId?: string } | null>(null);
  const overlaysRef = useRef(overlays);
  const drawingModesRef = useRef(drawing);
  const restoringRef = useRef(false);
  /** The saved drawings are on the chart (once per mount: another symbol mounts a new chart) */
  const restoredRef = useRef(false);
  const flagsRef = useRef(new Map<string, DrawingFlags>());
  /** The saved drawings, for undo and redo on this page (another symbol mounts a new chart) */
  const historyRef = useRef<History<OverlaySpec[]>>(historyOf([]));
  const selectedRef = useRef<string | null>(null);
  const drawingRef = useRef<{ tool: string; id: string; overlay: Overlay | null; extendData?: unknown } | null>(null);
  /** The ruler of 测量 while it is on the chart (the live object: its step tells whether it is still following the pointer) */
  const measureRef = useRef<Overlay | null>(null);
  const onOverlaysChangeRef = useRef(onOverlaysChange);
  const onDrawDoneRef = useRef(onDrawDone);
  const onAutoScaleRef = useRef(onAutoScaleChange);
  const legendFrame = useRef(0);
  const [store] = useState(createLegendStore);
  const [legendHeight, setLegendHeight] = useState(24);
  /** A drawing's menu (设置 / 锁定 / 隐藏 / 删除), or the chart's own (在 X 添加警报) */
  const [menu, setMenu] = useState<({ kind: "overlay"; id: string; locked: boolean } | { kind: "chart"; price: number }) & { x: number; y: number } | null>(null);
  /** The selected drawing, for its floating toolbar */
  const [selected, setSelected] = useState<{ id: string; info: DrawingInfo } | null>(null);
  /** The 设置 dialog of a drawing */
  const [settings, setSettings] = useState<{ id: string; info: DrawingInfo } | null>(null);
  const settingsOpenRef = useRef(false);
  /** A text drawing being typed in place (absolute px in the chart box) */
  const [editor, setEditor] = useState<{ id: string; x: number; y: number; center: boolean; size: number; color: string; text: string; isNew: boolean } | null>(null);
  const overlayMenuRef = useRef(false);
  const onAddAlertRef = useRef(onAddAlert);
  const onEditAlertRef = useRef(onEditAlert);
  // Latest props for the chart callbacks; declared first so later effects see the new values.
  useEffect(() => {
    onOverlaysChangeRef.current = onOverlaysChange;
    onDrawDoneRef.current = onDrawDone;
    onAddAlertRef.current = onAddAlert;
    onEditAlertRef.current = onEditAlert;
    onAutoScaleRef.current = onAutoScaleChange;
    compareRef.current = compare;
    overlaysRef.current = overlays;
    precisionRef.current = pricePrecision;
    clockRef.current = clock;
    settingsOpenRef.current = settings !== null;
  }, [settings, onOverlaysChange, onDrawDone, onAutoScaleChange, compare, overlays, pricePrecision, clock, onAddAlert, onEditAlert]);

  const computeLegend = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const bars = barsRef.current;
    const pointer = crosshairRef.current;
    const at = pointer ? (chart.convertFromPixel([{ x: pointer.x }], { paneId: pointer.paneId }) as Partial<Point>[])[0]?.dataIndex : undefined;
    const idx = Math.max(0, Math.min(at ?? bars.length - 1, bars.length - 1));
    const bar = bars[idx];
    const prev = bars[idx - 1];
    const paneTops: Record<string, number> = {};
    const indicators = chart.getIndicators().flatMap((ind) => {
      if (!(ind.paneId in paneTops)) paneTops[ind.paneId] = chart.getSize(ind.paneId)?.top ?? 0;
      if (isCompare(ind.name)) return [];
      return [{ name: ind.name, paneId: ind.paneId, params: ind.calcParams as number[], values: indicatorValues(chart, ind, idx, precisionRef.current, bar) }];
    });
    syncGap();
    store.set({
      left: chart.getSize(CANDLE_PANE, "main")?.left ?? 0,
      candle: bar ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close, prevClose: prev?.close ?? null } : null,
      paneTops,
      indicators,
      compares: compareRef.current.map((c, slot) => {
        const closes = compareSeries[slot];
        const value = closes?.[idx] ?? null;
        const base = closes?.[basesRef.current[slot] ?? 0];
        return { key: c.key, value, pct: value != null && base ? value / base - 1 : null };
      }),
    });
  };
  /** Indicator results and pane layout settle after KLineChart's own frame, so read them on the next one. */
  const scheduleLegend = () => {
    cancelAnimationFrame(legendFrame.current);
    legendFrame.current = requestAnimationFrame(computeLegend);
  };

  /** Rebase every compare line to the left edge of the visible range (percent lines on the chart, pane lines in the legend). */
  const updateBases = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const { realFrom } = chart.getVisibleRange();
    const bars = barsRef.current;
    compareRef.current.forEach((c, slot) => {
      const closes = compareSeries[slot];
      if (!closes) return;
      let base = Math.max(0, Math.min(realFrom, bars.length - 1));
      while (base < closes.length && closes[base] == null) base++;
      if (basesRef.current[slot] !== base) {
        basesRef.current[slot] = base;
        if (c.mode === "percent") chart.overrideIndicator({ name: compareName(slot), paneId: CANDLE_PANE, calcParams: [base, 0] });
      }
    });
    scheduleLegend();
  };

  const persistOverlays = (except?: string) => {
    const chart = chartRef.current;
    if (!chart || restoringRef.current) return;
    const specs = serializeOverlays(chart, flagsRef.current, except);
    historyRef.current = record(historyRef.current, specs);
    onOverlaysChangeRef.current(specs);
  };

  /** Undo or redo: the drawings go back to that state and are saved; not while a drawing is half done. */
  const applyHistory = (h: History<OverlaySpec[]> | null): boolean => {
    const chart = chartRef.current;
    const d = drawingRef.current;
    if (!chart || !h || (d?.overlay && d.overlay.currentStep > 1)) return false;
    historyRef.current = h;
    restoringRef.current = true;
    select(null);
    setSettings(null);
    setMenu(null);
    for (const o of chart.getOverlays({ paneId: CANDLE_PANE })) {
      if (isDrawing(o) && o.currentStep === DRAW_DONE) chart.removeOverlay({ id: o.id });
    }
    flagsRef.current = createDrawings(chart, h.present).flags;
    restoringRef.current = false;
    onOverlaysChangeRef.current(h.present);
    return true;
  };

  /** Drop the drawing in progress (if any) and start the same tool again. */
  const restartDrawing = () => {
    const chart = chartRef.current;
    const d = drawingRef.current;
    if (!chart || !d) return;
    drawingRef.current = null;
    chart.removeOverlay({ id: d.id });
    startDrawing(d.tool, d.extendData);
  };

  const overlayModes = (flags: DrawingFlags = {}): Partial<OverlayCreate> => {
    const m = drawingModesRef.current;
    return { mode: m.magnet ? "weak_magnet" : "normal", lock: Boolean(flags.lock) || m.locked, visible: !flags.hidden && !m.hidden };
  };
  const modesOf = (id: string) => overlayModes(flagsRef.current.get(id));

  /** Saved drawings onto the chart; their flags by the new ids. */
  const createDrawings = (chart: Chart, specs: OverlaySpec[]): { ids: string[]; flags: Map<string, DrawingFlags> } => {
    const flags = new Map<string, DrawingFlags>();
    if (!specs.length) return { ids: [], flags };
    // the ids up front, so the flags are there while KLineChart creates them: a regression snaps
    // its points to the fit as it is created, in its own scale
    const ids = specs.map(() => `drawing_${++drawingSeq}`);
    specs.forEach(({ lock, hidden, tvId, scale }, i) => {
      if (lock || hidden || tvId || scale) flags.set(ids[i], { lock, hidden, tvId, scale });
    });
    for (const [id, f] of flags) flagsRef.current.set(id, f);
    chart.createOverlay(
      specs.map((o, i) => ({
        id: ids[i],
        ...drawingOf(o),
        paneId: CANDLE_PANE,
        ...overlayModes({ lock: o.lock, hidden: o.hidden }),
        ...overlayHandlers(),
      })),
    );
    return { ids, flags };
  };

  /** A finished drawing keeps the scale of the axis it was drawn on (a % axis is linear), if its tool depends on one. */
  const keepScale = (id: string, tool: string) => {
    if (SCALED_DRAWINGS.has(tool)) flagsRef.current.set(id, { ...flagsRef.current.get(id), scale: candleAxis()?.name === "logarithm" ? "log" : "linear" });
  };

  const overlayHandlers = (): Partial<OverlayCreate> => ({
    onDrawEnd: (e) => {
      if (e.overlay.paneId !== CANDLE_PANE) {
        // drawn on a sub pane: discard it, the click listener below restarts the tool
        e.chart.removeOverlay({ id: e.overlay.id });
        return;
      }
      keepScale(e.overlay.id, e.overlay.name);
      // drawn while "lock all" is on: lock it like the rest once it is finished
      if (drawingModesRef.current.locked) e.chart.overrideOverlay({ id: e.overlay.id, lock: true });
      // KLineChart finishes a path on a double click, keeping the click and the cursor point on the same spot
      if (OPEN_DRAWINGS.has(e.overlay.name)) {
        const points = distinctPoints(e.overlay.points);
        if (points.length < 2) e.chart.removeOverlay({ id: e.overlay.id });
        else if (points.length < e.overlay.points.length) e.chart.overrideOverlay({ id: e.overlay.id, points });
      }
      // TradingView: place the text first, then type it in place (saved when it is committed)
      if (TEXT_DRAWINGS.has(e.overlay.name)) openEditor(e.overlay, true);
      else persistOverlays();
      if (drawingRef.current?.id === e.overlay.id) {
        drawingRef.current = null;
        onDrawDoneRef.current();
      }
    },
    // TradingView: double click edits a text in place and opens the settings of anything else
    onDoubleClick: (e) => {
      if (TEXT_DRAWINGS.has(e.overlay.name) && !e.overlay.lock) openEditor(e.overlay, false);
      else openSettings(e.overlay.id);
    },
    onPressedMoveEnd: () => persistOverlays(),
    // KLineChart calls this before the overlay leaves its list, so it is excluded by id
    onRemoved: (e) => {
      if (selectedRef.current === e.overlay.id) select(null);
      persistOverlays(e.overlay.id);
    },
    // a path still being drawn reports itself selected on every click; only finished drawings get the toolbar
    onSelected: (e) => select(e.overlay.currentStep === DRAW_DONE ? e.overlay : null),
    // KLineChart only reports a selection when it moves to another drawing, so a drawing hidden while
    // selected and shown again would not get its toolbar back: every click on a drawing selects it
    onClick: (e) => select(e.overlay),
    onDeselected: (e) => {
      if (selectedRef.current === e.overlay.id) select(null);
    },
    // TradingView: right click opens a menu instead of deleting
    onRightClick: (e) => {
      e.preventDefault?.();
      // the chart's own menu (添加警报) must not open on top of this one
      overlayMenuRef.current = true;
      if (drawingRef.current?.id === e.overlay.id) return;
      select(e.overlay);
      setMenu({ kind: "overlay", id: e.overlay.id, locked: Boolean(flagsRef.current.get(e.overlay.id)?.lock), x: (e.pageX ?? 0) - window.scrollX, y: (e.pageY ?? 0) - window.scrollY });
    },
  });

  const infoOf = (chart: Chart, o: Overlay): DrawingInfo => {
    const line = lineOf(chart, o);
    return {
      name: o.name,
      color: line.color,
      size: line.size,
      dash: dashOf(line),
      textSize: textSizeOf(o),
      text: textOf(o),
      locked: Boolean(flagsRef.current.get(o.id)?.lock),
      values: o.points.map((p) => p.value ?? 0),
      scale: flagsRef.current.get(o.id)?.scale,
      timestamps: o.points.map((p) => p.timestamp ?? 0),
      extend: TREND_LINES.has(o.name) ? extensionOf(o.name, o.points) : null,
      fib: FIB_DRAWINGS.has(o.name) ? fibSettingsOf(o.extendData) : null,
    };
  };
  const overlayById = (id: string) => chartRef.current?.getOverlays({ id })[0];

  const select = (o: Overlay | null) => {
    selectedRef.current = o?.id ?? null;
    const chart = chartRef.current;
    setSelected(o && chart ? { id: o.id, info: infoOf(chart, o) } : null);
  };
  /** Re-read the selected drawing after the toolbar changed it. */
  const refreshSelected = (id: string) => {
    const o = overlayById(id);
    if (o && selectedRef.current === id) select(o);
  };

  const openSettings = (id: string) => {
    const chart = chartRef.current;
    const o = overlayById(id);
    if (chart && o) setSettings({ id, info: infoOf(chart, o) });
  };

  /** Style, text, point prices and dates, a trend line's extension and a Fibonacci drawing's settings from the floating toolbar or the settings dialog. */
  const changeDrawing = (id: string, change: DrawingChange) => {
    const chart = chartRef.current;
    const o = overlayById(id);
    if (!chart || !o) return;
    const line = lineOf(chart, o);
    const styles = drawingStyles(change.color ?? line.color, change.size ?? line.size, change.dash ?? dashOf(line));
    if (TEXT_DRAWINGS.has(o.name)) styles.text = { ...styles.text, size: change.textSize ?? textSizeOf(o) };
    // a colour picked on the toolbar is the one colour of a Fibonacci drawing's levels (TradingView's 使用单一颜色)
    const was = FIB_DRAWINGS.has(o.name) ? fibSettingsOf(o.extendData) : null;
    const fib = was && (change.fib ?? (change.color ? { ...was, oneColor: true } : was));
    const extendData = change.text ?? (fib && JSON.stringify(fib) !== JSON.stringify(was) ? fib : undefined);
    // before the override, which redraws it (new styles always do)
    if (change.scale) flagsRef.current.set(id, { ...flagsRef.current.get(id), scale: change.scale });
    // a date lands on the bar it falls in on this timeframe, in the empty space past the last bar too
    let points = o.points.map((p, i) => ({
      ...p,
      value: change.values?.[i] ?? p.value,
      ...(change.timestamps?.[i] !== undefined ? { timestamp: snapToBar(chart, change.timestamps[i]) } : {}),
    }));
    let name = o.name;
    if (change.extend && TREND_LINES.has(o.name)) ({ name, points } = withExtension(points, change.extend));
    // another scale moves a regression's points onto its fit there: KLineChart re-snaps them when it is given points
    const moved = Boolean(change.values || change.timestamps || change.extend || change.scale);
    if (name === o.name) {
      chart.overrideOverlay({ id, styles, ...(extendData !== undefined ? { extendData } : {}), ...(moved ? { points } : {}) });
      persistOverlays();
      return refreshSelected(id);
    }
    // another tool (趋势线, 射线, 延长线): KLineChart cannot rename an overlay, so it is drawn again
    // the way saved drawings are put back, keeping its flags (scale, tvId, lock, hidden)
    const spec = specOf(o, flagsRef.current);
    if (!spec) return;
    const wasSelected = selectedRef.current === id;
    restoringRef.current = true;
    chart.removeOverlay({ id });
    flagsRef.current.delete(id);
    const [next] = createDrawings(chart, [{ ...spec, name, styles, points: points.map((p) => ({ timestamp: p.timestamp!, value: p.value! })) }]).ids;
    restoringRef.current = false;
    persistOverlays();
    if (wasSelected) select(overlayById(next) ?? null);
  };

  const setFlag = (id: string, flag: keyof DrawingFlags, on: boolean) => {
    flagsRef.current.set(id, { ...flagsRef.current.get(id), [flag]: on });
    chartRef.current?.overrideOverlay({ id, ...modesOf(id) });
    persistOverlays();
  };
  const toggleLock = (id: string) => {
    setFlag(id, "lock", !flagsRef.current.get(id)?.lock);
    refreshSelected(id);
  };
  const hideDrawing = (id: string) => {
    setFlag(id, "hidden", true);
    select(null);
  };
  const removeDrawing = (id: string) => {
    chartRef.current?.removeOverlay({ id });
    select(null);
  };

  /** Where a text drawing's box goes, in px of the chart box (a 注释's label sits 61px above its point). */
  const editorAt = (id: string): { x: number; y: number } => {
    const o = overlayById(id);
    const point = o?.points[0];
    const chart = chartRef.current;
    const at = (point ? chart?.convertToPixel({ timestamp: point.timestamp, value: point.value }, { paneId: CANDLE_PANE, absolute: true }) : {}) as Partial<Coordinate>;
    // `absolute` only adds the pane's top: x is still from the plot's left edge, after any left scale
    const left = chart?.getSize(CANDLE_PANE, "main")?.left ?? 0;
    return { x: left + (at.x ?? 0), y: (at.y ?? 0) - (o?.name === "simpleAnnotation" ? 61 : 0) };
  };

  /** Type a text drawing in place; the canvas text hides meanwhile so it is not drawn twice. */
  const openEditor = (o: Overlay, isNew: boolean) => {
    const chart = chartRef.current;
    if (!chart || !o.points[0]) return;
    const note = o.name === "simpleAnnotation";
    chart.overrideOverlay({ id: o.id, visible: false });
    setEditor({
      id: o.id,
      ...editorAt(o.id),
      center: note,
      size: textSizeOf(o),
      color: note ? cssVar("--fg") : lineOf(chart, o).color,
      text: textOf(o),
      isNew,
    });
  };
  const closeEditor = (text: string | null) => {
    const chart = chartRef.current;
    const ed = editor;
    setEditor(null);
    if (!chart || !ed) return;
    const value = text?.replace(/\s+$/, "") ?? "";
    // an empty text is no drawing, as in TradingView
    if (text !== null && !value.trim()) return chart.removeOverlay({ id: ed.id });
    if (text === null && ed.isNew) return chart.removeOverlay({ id: ed.id });
    chart.overrideOverlay({ id: ed.id, ...(text !== null ? { extendData: value } : {}), visible: modesOf(ed.id).visible });
    persistOverlays();
    refreshSelected(ed.id);
  };

  const startDrawing = (tool: string, extendData?: unknown) => {
    const chart = chartRef.current;
    if (!chart) return;
    const id = chart.createOverlay({ name: tool, paneId: CANDLE_PANE, extendData, ...overlayModes(), lock: false, ...overlayHandlers() });
    // the live object: its points and step show how far the drawing has got
    if (typeof id === "string") drawingRef.current = { tool, id, overlay: chart.getOverlays({ id })[0] ?? null, extendData };
  };

  /**
   * Finish a path or polyline at the points clicked so far (Enter, Esc or picking another
   * tool); fewer than two points is no drawing. False when no such drawing is in progress.
   */
  const finishOpenDrawing = (notify: boolean): boolean => {
    const chart = chartRef.current;
    const d = drawingRef.current;
    if (!chart || !d || !OPEN_DRAWINGS.has(d.tool)) return false;
    const o = d.overlay;
    const points = distinctPoints(o ? o.points.slice(0, Math.max(0, o.currentStep - 1)) : []);
    drawingRef.current = null;
    chart.removeOverlay({ id: d.id });
    if (points.length >= 2) {
      const id = chart.createOverlay({ name: d.tool, paneId: CANDLE_PANE, points, ...overlayModes(), ...overlayHandlers() });
      if (typeof id === "string") keepScale(id, d.tool);
      persistOverlays();
    }
    if (notify) onDrawDoneRef.current();
    return true;
  };

  const cancelDrawing = () => {
    const d = drawingRef.current;
    if (!d || finishOpenDrawing(false)) return;
    drawingRef.current = null;
    chartRef.current?.removeOverlay({ id: d.id });
  };

  const clearMeasure = () => {
    const m = measureRef.current;
    measureRef.current = null;
    if (m) chartRef.current?.removeOverlay({ id: m.id });
  };
  /**
   * TradingView's 测量: the next click on the main pane starts the ruler, it follows the pointer,
   * and a second click fixes it until the click or Esc after that. Not a drawing: no handlers that
   * save or select, and lock all and hide all do not apply to it.
   */
  const startMeasure = () => {
    const chart = chartRef.current;
    if (!chart) return;
    clearMeasure();
    const id = chart.createOverlay({
      name: MEASURE_TOOL,
      groupId: MEASURE_GROUP,
      paneId: CANDLE_PANE,
      mode: overlayModes().mode,
      onDrawEnd: (e) => {
        if (e.overlay.paneId !== CANDLE_PANE) clearMeasure();
        onDrawDoneRef.current();
      },
    });
    if (typeof id === "string") measureRef.current = chart.getOverlays({ id })[0] ?? null;
  };

  /** Each sub pane's height as created or last dragged, before `paneScaleRef` shrinks it to fit a short chart. */
  const paneHeightsRef = useRef(new Map<string, number>());
  const paneScaleRef = useRef(1);
  /** The symbol in each compare slot: a removed compare moves the next one into its slot, so heights go by symbol. */
  const compareKeysRef = useRef<string[]>([]);
  const heightKey = (paneId: string) => {
    const slot = compareKeysRef.current.findIndex((_, i) => comparePane(i) === paneId);
    return slot < 0 ? paneId : `cmp:${compareKeysRef.current[slot]}`;
  };
  const subPanes = (chart: Chart) => (chart.getPaneOptions() as PaneOptions[]).filter((p) => p.id !== CANDLE_PANE && p.id !== X_AXIS_PANE);
  const sizePanes = () => {
    const chart = chartRef.current;
    const el = containerRef.current;
    if (!chart || !el) return;
    const main = Math.round(el.clientHeight * MAIN_PANE_SHARE);
    chart.setPaneOptions({ id: CANDLE_PANE, minHeight: main });
    // like TradingView on a short window: the sub panes shrink in proportion instead of squeezing the main pane
    const panes = subPanes(chart);
    const wanted = panes.map((p) => paneHeightsRef.current.get(heightKey(p.id)) ?? SUB_PANE_HEIGHT);
    const room = el.clientHeight - main - (chart.getSize(X_AXIS_PANE)?.height ?? 0) - panes.length * chart.getStyles().separator.size;
    paneScaleRef.current = Math.min(1, room / wanted.reduce((a, b) => a + b, 0));
    // the drag floor shrinks too, or a separator between two shrunk panes could not move
    const minHeight = Math.round(SUB_PANE_MIN_HEIGHT * paneScaleRef.current);
    panes.forEach((p, i) => {
      const height = Math.floor(wanted[i] * paneScaleRef.current);
      if (height !== p.height || minHeight !== p.minHeight) chart.setPaneOptions({ id: p.id, height, minHeight });
    });
  };
  /** A dragged separator sets the heights the panes go back to on a taller chart. */
  const keepPaneHeights = () => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const p of subPanes(chart)) paneHeightsRef.current.set(heightKey(p.id), p.height / paneScaleRef.current);
  };

  const candleAxis = () => chartRef.current?.getYAxes({ paneId: CANDLE_PANE })[0] as unknown as AxisImpl | undefined;
  const yAxisAuto = (): boolean => candleAxis()?.getAutoCalcTickFlag() ?? true;

  /** The price axis' range when the current drag began (the base KLineChart scales and pans from). */
  const gestureRef = useRef<AxisRange | null>(null);
  const patchedAxes = useRef(new WeakSet<AxisImpl>());
  /**
   * KLineChart pans and zooms a log axis in price space, so dragging the chart up and down
   * rescales it and the axis can even go negative. Replay the same move in log space: the
   * library's new range, as a fraction of the old one, is applied to the log range instead.
   */
  const patchLogAxis = () => {
    const axis = candleAxis();
    if (!axis || axis.name !== "logarithm" || patchedAxes.current.has(axis)) return;
    patchedAxes.current.add(axis);
    const setRange = axis.setRange.bind(axis);
    axis.setRange = (next) => {
      // a drag scales from the range it started with, a wheel on the price axis from the current one
      const base = gestureRef.current ?? axis.getRange();
      if (!base.range) return setRange(next);
      const realFrom = base.realFrom + ((next.from - base.from) / base.range) * base.realRange;
      const realTo = base.realTo + ((next.to - base.to) / base.range) * base.realRange;
      const from = 10 ** realFrom;
      const to = 10 ** realTo;
      setRange({ from, to, range: to - from, realFrom, realTo, realRange: realTo - realFrom, displayFrom: from, displayTo: to, displayRange: to - from });
    };
  };

  const percent = compare.some((c) => c.mode === "percent" && !c.hidden) || percentAxis;
  const headroom = legendHeight + 12;
  const yAxisRef = useRef({ percent, log, headroom });
  const gapRef = useRef(0);
  /**
   * KLineChart grows the value range by `top × range` (a pixel `top` is divided by the pane height
   * first), so the free band ends up smaller than asked; solve for the rate that leaves `headroom` px.
   */
  const topGap = () => {
    const px = yAxisRef.current.headroom;
    const height = chartRef.current?.getSize(CANDLE_PANE, "main")?.height ?? 0;
    return height > px * 2 ? (px * (1 + BOTTOM_GAP)) / (height - px) : px;
  };
  const applyYAxis = () => {
    const chart = chartRef.current;
    const { percent, log } = yAxisRef.current;
    gapRef.current = topGap();
    const gap = { top: gapRef.current, bottom: BOTTOM_GAP };
    // overriding the axis also puts it back on auto scale; by id, so the own scales of indicators
    // moved onto the main pane keep their kind (the left ones keep the legend's band free too)
    chart?.overrideYAxis({ paneId: CANDLE_PANE, id: candleAxis()?.id, name: percent ? "percentage" : log ? "logarithm" : "normal", gap });
    for (const axis of chart?.getYAxes({ paneId: CANDLE_PANE }).slice(1) ?? []) {
      if (axis.position === "left") chart?.overrideYAxis({ paneId: CANDLE_PANE, id: axis.id, gap });
    }
    patchLogAxis();
    onAutoScaleRef.current(true);
  };
  /** TradingView's 自动 toggle: off keeps the current price range, so the chart pans up and down. */
  const setAutoScale = (on: boolean) => {
    if (on) return applyYAxis();
    candleAxis()?.setAutoCalcTickFlag(false);
    onAutoScaleRef.current(false);
  };
  /** Pane heights change with sub panes and resizes; keep the legend's band free while on auto scale. */
  const syncGap = () => {
    if (Math.abs(topGap() - gapRef.current) > 0.01 && yAxisAuto()) applyYAxis();
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    registerTemplates();
    const chart = init(el, {
      locale: "zh-CN",
      timezone: "UTC",
      layout: { pane: { height: SUB_PANE_HEIGHT, minHeight: SUB_PANE_MIN_HEIGHT }, barSpaceLimit: { min: MIN_BAR_SPACE, max: MAX_BAR_SPACE } },
    });
    if (!chart) return;
    chartRef.current = chart;
    setOverlayChart(chart, (id) => flagsRef.current.get(id)?.scale, () => weekendsRef.current);
    applyTheme(chart, styleRef.current);
    sizePanes();
    // The full history arrives in one response, so there is never more to load.
    chart.setDataLoader({
      getBars: ({ type, callback }) => callback(type === "init" ? (barsRef.current as KLineData[]) : [], false),
      subscribeBar: ({ callback }) => {
        pushBarRef.current = callback;
      },
      unsubscribeBar: () => {
        pushBarRef.current = null;
      },
    });
    chart.setFormatter({
      formatExtendText: () => {
        const now = Date.now();
        const close = barCloseAt(tfRef.current, now, clockRef.current, weekendsRef.current);
        return close === null ? "" : fmtCountdown(close - now);
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    chart.subscribeAction("onVisibleRangeChange", () => {
      // a still pointer is over another bar now
      scheduleLegend();
      clearTimeout(timer);
      timer = setTimeout(updateBases, 80);
    });
    // KLineChart 10 hands this only the pointer ({ x, y, paneId }), not the bar under it, and stays
    // silent when the crosshair goes away: the legend finds the bar from x, and leaving the chart is heard below
    chart.subscribeAction("onCrosshairChange", (data) => {
      const { x, paneId } = data as Crosshair;
      crosshairRef.current = x === undefined ? null : { x, paneId };
      scheduleLegend();
    });
    // TradingView: off the chart, the legend goes back to the latest bar
    const onLeave = () => {
      crosshairRef.current = null;
      scheduleLegend();
    };
    el.addEventListener("mouseleave", onLeave);
    chart.subscribeAction("onPaneDrag", () => {
      keepPaneHeights();
      scheduleLegend();
    });
    // Drawing follows the mouse into sub panes; a click there is thrown away and the tool restarts on the main pane.
    // A tap too: KLineChart takes it on the touchend and stops the click a browser would make of it.
    const onClick = () =>
      setTimeout(() => {
        const d = drawingRef.current;
        if (d?.overlay && d.overlay.paneId !== CANDLE_PANE) restartDrawing();
        const m = measureRef.current;
        if (m && m.currentStep !== DRAW_DONE && m.paneId !== CANDLE_PANE) startMeasure();
      }, 0);
    el.addEventListener("click", onClick, true);
    el.addEventListener("touchend", onClick, { capture: true, passive: true });
    // a path or polyline ends on Enter; KLineChart itself finishes it on a double click
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.defaultPrevented && finishOpenDrawing(true)) e.preventDefault();
      if (e.key === "Escape") clearMeasure();
    };
    window.addEventListener("keydown", onKey);
    /** Where a pointer is in the chart box, when it is over the main pane's plot. */
    const onMainPane = (e: { clientX: number; clientY: number }): Coordinate | null => {
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const pane = chart.getSize(CANDLE_PANE, "main");
      return pane && x >= pane.left && x <= pane.left + pane.width && y >= pane.top && y <= pane.top + pane.height ? { x, y } : null;
    };
    // TradingView's 测量: a press takes a fixed ruler away, and Shift + click on the main pane starts
    // one (not in the middle of a drawing); KLineChart's own click then places its first point.
    // A pointer event, which a touch sends once: the mouse events a browser makes up after a tap
    // would take away the ruler that tap had just fixed
    const onMeasurePress = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const m = measureRef.current;
      if (m && m.currentStep !== DRAW_DONE) return;
      clearMeasure();
      if (e.shiftKey && !drawingRef.current && onMainPane(e)) startMeasure();
    };
    el.addEventListener("pointerdown", onMeasurePress, true);
    // TradingView: a drag stays with what it started on (the time axis, the price axis, the chart, a
    // drawing) until it is let go, wherever the pointer goes. KLineChart looks up the pane and axis
    // under the pointer on every move and drops the drag once that is another one, so the one
    // pressed answers every lookup until the release, which also ends a drawing's drag outside the chart
    const events = (chart as unknown as { _chartEvent: ChartEvents })._chartEvent;
    const findWidget = events._findWidgetByEvent.bind(events);
    let held: WidgetHit | null = null;
    events._findWidgetByEvent = (e) => held ?? findWidget(e);
    // TradingView's time axis drag: the right edge keeps its bar and the bar grabbed follows the
    // pointer (KLineChart zooms about the point pressed, by how far the pointer is from the page's edge)
    chart.overrideXAxis({ scrollZoomEnabled: false });
    // ...which also takes the axis' resize cursor away
    chart.getDom(X_AXIS_PANE, "main")!.style.cursor = "ew-resize";
    let axisDrag: { from: number; space: number } | null = null;
    /** The pointer that pressed: other fingers neither start nor end its drag. */
    let press: { id: number; mouse: boolean } | null = null;
    const plotX = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left - (chart.getSize(CANDLE_PANE, "main")?.left ?? 0);
    // a pointer event comes before the mouse or touch event KLineChart takes the press from
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.isPrimary) return;
      press = { id: e.pointerId, mouse: e.pointerType === "mouse" };
      // the base of a price-axis drag or a vertical pan
      const range = candleAxis()?.getRange();
      gestureRef.current = range ? { ...range } : null;
      const box = el.getBoundingClientRect();
      const at = { x: e.clientX - box.left, y: e.clientY - box.top };
      const hit = findWidget(at);
      held = hit.widget ? hit : null;
      const axis = chart.getSize(X_AXIS_PANE, "main");
      const onAxis = axis && at.x >= axis.left && at.x <= axis.left + axis.width && at.y >= axis.top && at.y <= axis.top + axis.height;
      axisDrag = onAxis ? { from: plotX(e), space: chart.getBarSpace().bar } : null;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== press?.id || !axisDrag) return;
      const width = chart.getSize(CANDLE_PANE, "main")?.width ?? 0;
      chart.setBarSpace(timeAxisBarSpace(axisDrag.space, width, axisDrag.from, plotX(e), { min: MIN_BAR_SPACE, max: MAX_BAR_SPACE }));
    };
    const release = () => {
      press = null;
      axisDrag = null;
    };
    // the press is let go on the mouse or touch release that follows, after KLineChart had its turn
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId === press?.id) release();
    };
    // a cancelled touch gets no release
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== press?.id) return;
      release();
      held = null;
      gestureRef.current = null;
    };
    // a second finger turns the drag into KLineChart's pinch (it decides when), about the point between the two
    const pinchStart = events.pinchStartEvent.bind(events);
    events.pinchStartEvent = () => {
      held = null;
      axisDrag = null;
      return pinchStart();
    };
    el.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    // the browser menu is no use on a canvas; drawings bring their own (onRightClick), the main pane offers 添加警报
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (overlayMenuRef.current) {
        overlayMenuRef.current = false;
        return;
      }
      const at = onMainPane(e);
      if (!at) return;
      const point = chart.convertFromPixel([at], { paneId: CANDLE_PANE, absolute: true }) as Partial<{ value: number }>[];
      const price = point[0]?.value;
      if (typeof price === "number" && Number.isFinite(price)) setMenu({ kind: "chart", price, x: e.clientX, y: e.clientY });
    };
    el.addEventListener("contextmenu", onContextMenu);
    // dragging or double-clicking the price axis switches its auto scale; report it for the 自动 button
    // (a drag may end outside the chart, so releases are heard on the window)
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    const checkAuto = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => onAutoScaleRef.current(yAxisAuto()), 30);
    };
    // KLineChart hears a release on the page before the window does; another finger lifted keeps the press.
    // A mouse press ends with its left button, before any other held with it is let go (and the pointerup)
    const onUp = (e: MouseEvent | TouchEvent) => {
      if (press?.mouse && e.type === "mouseup" && (e as MouseEvent).button === 0) release();
      if (!press) {
        held = null;
        gestureRef.current = null;
      }
      checkAuto();
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
    el.addEventListener("dblclick", checkAuto);
    // a wheel over the price axis zooms it and so switches auto scale off
    el.addEventListener("wheel", checkAuto, { passive: true });

    const retheme = () => applyTheme(chart, styleRef.current);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", retheme);
    const resize = new ResizeObserver(() => {
      sizePanes();
      chart.resize();
      scheduleLegend();
    });
    resize.observe(el);

    return () => {
      clearTimeout(timer);
      clearTimeout(checkTimer);
      cancelAnimationFrame(legendFrame.current);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("touchend", onClick, true);
      el.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onMeasurePress, true);
      el.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
      el.removeEventListener("dblclick", checkAuto);
      el.removeEventListener("wheel", checkAuto);
      media.removeEventListener("change", retheme);
      resize.disconnect();
      dispose(el);
      chartRef.current = null;
      measureRef.current = null;
      setOverlayChart(null);
      // the drawings went with the chart: a chart made again (React's StrictMode mounts twice in dev) restores them
      restoredRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chart lives for the component's lifetime
  }, []);

  // the imperative handle for the page's hotkeys and bottom bar
  useEffect(() => {
    const plotWidth = () => {
      const chart = chartRef.current;
      return chart?.getSize(CANDLE_PANE, "main")?.width ?? Math.max(200, (containerRef.current?.clientWidth ?? 1000) - 80);
    };
    controlRef.current = {
      scroll: (fraction) => chartRef.current?.scrollByDistance(-fraction * plotWidth(), 150),
      zoom: (scale) => chartRef.current?.zoomAtCoordinate(scale, undefined, 150),
      reset: () => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.setBarSpace(initialBarSpace(containerRef.current?.clientWidth ?? 1000, tfRef.current, barsRef.current.length));
        chart.scrollToRealTime();
        applyYAxis();
      },
      setAutoScale,
      fitRange: (years) => {
        const chart = chartRef.current;
        const bars = barsRef.current;
        if (!chart || bars.length === 0) return true;
        let from = 0;
        if (years !== null) {
          const cutoff = bars[bars.length - 1].timestamp - years * 365.25 * 86400000;
          from = bars.findIndex((b) => b.timestamp >= cutoff);
          if (from < 0) from = 0;
        }
        const count = bars.length - from;
        const space = (plotWidth() - chart.getOffsetRightDistance()) / count;
        chart.setBarSpace(Math.min(MAX_BAR_SPACE, Math.max(MIN_BAR_SPACE, space)));
        chart.scrollToRealTime();
        return space >= MIN_BAR_SPACE;
      },
      indicatorLines: (name, from = {}) => (chartRef.current ? defaultLines(chartRef.current, name, from) : null),
      undo: () => applyHistory(undo(historyRef.current)),
      redo: () => applyHistory(redo(historyRef.current)),
      dialogOpen: () => settingsOpenRef.current,
      closeDialog: () => setSettings(null),
      deleteSelected: () => {
        const id = selectedRef.current;
        if (!id || !chartRef.current) return false;
        chartRef.current.removeOverlay({ id });
        select(null);
        return true;
      },
      capture: () => {
        const chart = chartRef.current;
        const el = containerRef.current;
        if (!chart || !el) return null;
        return { url: chart.getConvertPictureUrl(true, "png", cssVar("--card")), width: el.clientWidth, height: el.clientHeight, legend: store.get() };
      },
    };
    return () => {
      controlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handle reads refs
  }, [controlRef]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars) return;
    barsRef.current = bars;
    tfRef.current = tf;
    weekendsRef.current = weekends;
    chart.setBarSpace(initialBarSpace(containerRef.current?.clientWidth ?? 1000, tf, bars.length));
    // Both calls reset the data and pull it from barsRef through the loader above.
    chart.setSymbol({ ticker: symbolKey, pricePrecision, volumePrecision: 0 });
    chart.setPeriod(PERIODS[tf]);
    // ...and put the price axis back on auto scale
    onAutoScaleRef.current(true);
    // Drawings are stored by timestamp, so they land on the nearest bar of any timeframe. They are
    // restored once; when the bars reload (another timeframe or ADJ) they stay as they are, with
    // the selection, a drawing half done and a text being typed (its box moves with it).
    if (restoredRef.current) {
      // the text box follows its drawing to where it sits on the new bars
      setEditor((ed) => (ed ? { ...ed, ...editorAt(ed.id) } : ed));
      crosshairRef.current = null;
      scheduleLegend();
      return;
    }
    restoredRef.current = true;
    restoringRef.current = true;
    flagsRef.current = createDrawings(chart, overlaysRef.current).flags;
    restoringRef.current = false;
    historyRef.current = historyOf(serializeOverlays(chart, flagsRef.current));
    crosshairRef.current = null;
    scheduleLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are stable refs
  }, [bars, weekends, symbolKey, tf, pricePrecision]);

  // A quote round moved the last bar. The chart's list is the `bars` array itself and the formula
  // and compare lines read `refs`, so both are updated in place: a new `bars` would reset the view.
  useEffect(() => {
    const list = barsRef.current;
    const last = list.at(-1);
    if (!tail || !last || !pushBarRef.current || tail.bar.timestamp < last.timestamp) return;
    patchRefs(refs, tail.bar.timestamp > last.timestamp ? list.length : list.length - 1, tail.refs);
    pushBarRef.current(tail.bar as KLineData);
    scheduleLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new tail moves the bar; refs belong to the bars it follows
  }, [tail]);

  useEffect(() => {
    styleRef.current = chartStyle;
    if (chartRef.current) applyTheme(chartRef.current, chartStyle);
  }, [chartStyle]);

  const indicatorKey = JSON.stringify(indicators);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Re-registering under the same name swaps in the edited formula.
    const available = new Set<string>();
    for (const template of templates) {
      registerIndicator(template as Parameters<typeof registerIndicator>[0]);
      available.add(template.name);
    }
    for (const ind of chart.getIndicators()) if (!isCompare(ind.name)) chart.removeIndicator({ id: ind.id });
    let order = 0;
    for (const spec of JSON.parse(indicatorKey) as IndicatorSpec[]) {
      if (spec.name.startsWith("F_") && !available.has(spec.name)) continue;
      const visible = !spec.hidden;
      if (spec.pane === "main") {
        // moved up from a pane of its own: its own scale, on the left like TradingView's, or none for volume
        const yAxisId = spec.ownScale ? `axis_${spec.name}` : undefined;
        if (yAxisId) chart.createYAxis({ id: yAxisId, paneId: CANDLE_PANE, ...(spec.name === "VOL" ? VOLUME_AXIS : { position: "left", gap: { top: gapRef.current, bottom: BOTTOM_GAP } }) });
        const id = chart.createIndicator(
          { name: spec.name, calcParams: spec.calcParams, paneId: CANDLE_PANE, visible, ...(yAxisId ? { yAxisId } : {}), ...(spec.precision !== undefined ? { precision: spec.precision } : {}) },
          true,
        );
        restyleLines(chart, id, spec.lines);
      } else {
        const paneId = `pane_${spec.name}`;
        restyleLines(chart, chart.createIndicator({ name: spec.name, calcParams: spec.calcParams, paneId, visible, ...(spec.precision !== undefined ? { precision: spec.precision } : {}) }), spec.lines);
        // indicator panes stay above compare panes however often either is re-created
        chart.setPaneOptions({ id: paneId, order: 10 + order++ });
      }
    }
    sizePanes();
    scheduleLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scheduleLegend reads refs
  }, [indicatorKey, templates]);

  const compareKey = JSON.stringify(compare);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars) return;
    for (let slot = 0; slot < MAX_COMPARE; slot++) chart.removeIndicator({ name: compareName(slot) });
    basesRef.current = [];
    const entries = JSON.parse(compareKey) as KChartProps["compare"];
    compareKeysRef.current = entries.slice(0, MAX_COMPARE).map((c) => c.key);
    entries.slice(0, MAX_COMPARE).forEach((c, slot) => {
      compareSeries[slot] = refs[c.key]?.c;
      if (!compareSeries[slot]) return;
      const pane = c.mode === "percent";
      chart.createIndicator(
        {
          name: compareName(slot),
          paneId: pane ? CANDLE_PANE : comparePane(slot),
          series: pane ? "price" : "normal",
          shortName: c.key,
          calcParams: [0, pane ? 0 : 1],
          visible: !c.hidden,
          styles: { lines: [{ color: c.color, size: 2 }] },
        },
        true,
      );
      if (!pane) chart.setPaneOptions({ id: comparePane(slot), order: 100 + slot });
    });
    for (let slot = entries.length; slot < MAX_COMPARE; slot++) compareSeries[slot] = undefined;
    sizePanes();
    updateBases();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateBases reads refs
  }, [compareKey, bars, refs]);

  useEffect(() => {
    yAxisRef.current = { percent, log, headroom };
    applyYAxis();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyYAxis reads the ref set here
  }, [log, percent, headroom]);

  // magnet, lock all and hide all apply to every drawing and to the ones drawn next
  const drawingKey = `${drawing.magnet}|${drawing.locked}|${drawing.hidden}`;
  useEffect(() => {
    drawingModesRef.current = drawing;
    const chart = chartRef.current;
    if (!chart) return;
    for (const o of chart.getOverlays({ paneId: CANDLE_PANE })) {
      if (o.id === drawingRef.current?.id || !isDrawing(o)) continue;
      chart.overrideOverlay({ id: o.id, ...modesOf(o.id) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the three flags
  }, [drawingKey]);

  // 显示所有绘图 also brings back the drawings hidden one by one
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || revealSeq === 0) return;
    for (const [id, f] of flagsRef.current) {
      if (!f.hidden) continue;
      flagsRef.current.set(id, { ...f, hidden: false });
      chart.overrideOverlay({ id, ...modesOf(id) });
    }
    persistOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per reveal
  }, [revealSeq]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    cancelDrawing();
    // a ruler that is fixed stays up when its tool is done; one still following the pointer goes with its tool
    if (drawTool || measureRef.current?.currentStep !== DRAW_DONE) clearMeasure();
    if (drawTool === MEASURE_TOOL) startMeasure();
    else if (drawTool) startDrawing(drawTool);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one overlay per tool selection
  }, [drawTool]);

  /**
   * The saved drawings changed on the server (imported in another tab): take them over unless they
   * are what the chart has. The drawing being drawn and the text being typed stay as they are.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || reloadSeq === 0 || !restoredRef.current) return;
    const specs = overlaysRef.current;
    if (JSON.stringify(serializeOverlays(chart, flagsRef.current)) === JSON.stringify(specs)) return;
    const typing = editor ? chart.getOverlays({ id: editor.id })[0] : undefined;
    let typed = typing ? JSON.stringify(specOf(typing, flagsRef.current)) : null;
    restoringRef.current = true;
    setMenu(null);
    setSettings(null);
    for (const o of chart.getOverlays({ paneId: CANDLE_PANE })) {
      if (isDrawing(o) && o.currentStep === DRAW_DONE && o.id !== typing?.id) chart.removeOverlay({ id: o.id });
    }
    // the text being typed is already on the chart
    const rest = specs.filter((s) => {
      if (typed === null || JSON.stringify(s) !== typed) return true;
      typed = null;
      return false;
    });
    const { flags } = createDrawings(chart, rest);
    const typingFlags = typing && flagsRef.current.get(typing.id);
    if (typing && typingFlags) flags.set(typing.id, typingFlags);
    flagsRef.current = flags;
    restoringRef.current = false;
    // what was undone before is not what is on the server now
    historyRef.current = historyOf(serializeOverlays(chart, flagsRef.current));
    scheduleLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per reload
  }, [reloadSeq]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || clearSeq === 0) return;
    restoringRef.current = true;
    drawingRef.current = null;
    select(null);
    // every drawing, not the alert lines
    for (const o of chart.getOverlays({ paneId: CANDLE_PANE })) if (isDrawing(o)) chart.removeOverlay({ id: o.id });
    flagsRef.current = new Map();
    restoringRef.current = false;
    historyRef.current = record(historyRef.current, []);
    onOverlaysChangeRef.current([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per clear
  }, [clearSeq]);

  // alert lines: after the bars effect above, which clears every overlay when the data changes
  const alertKey = JSON.stringify(alertLines);
  useEffect(() => {
    const chart = chartRef.current;
    const last = bars?.at(-1);
    if (!chart || !last) return;
    chart.removeOverlay({ groupId: ALERT_GROUP });
    const accent = cssVar("--accent");
    for (const line of JSON.parse(alertKey) as KChartProps["alertLines"]) {
      chart.createOverlay({
        name: "priceAlert",
        groupId: ALERT_GROUP,
        paneId: CANDLE_PANE,
        points: [{ timestamp: last.timestamp, value: line.price }],
        extendData: { id: line.id },
        styles: {
          line: { style: "dashed", dashedValue: [4, 3], size: 1, color: accent },
          text: { color: "#ffffff", backgroundColor: accent, borderColor: accent, borderRadius: 2, size: 11, family: MONO, paddingLeft: 18, paddingRight: 4, paddingTop: 2, paddingBottom: 2 },
        },
        onClick: (e) => onEditAlertRef.current((e.overlay.extendData as { id: string }).id),
      });
    }
  }, [alertKey, bars, symbolKey, tf, clearSeq]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // the right-button mousedown that opened the menu is still bubbling, so listen from the next task
    const timer = setTimeout(() => window.addEventListener("mousedown", close));
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <ChartLegend
        {...legend}
        store={store}
        pricePrecision={pricePrecision}
        compare={compare}
        onMainHeight={(h) => setLegendHeight((prev) => (Math.abs(prev - h) > 2 ? h : prev))}
      />
      {editor && (
        <TextEditor
          key={`editor:${editor.id}`}
          x={editor.x}
          y={editor.y}
          center={editor.center}
          size={editor.size}
          color={editor.color}
          initial={editor.text}
          onCommit={(text) => closeEditor(text)}
          onCancel={() => closeEditor(null)}
        />
      )}
      {selected && !menu && !editor && (
        <DrawingToolbar
          key={`toolbar:${selected.id}`}
          info={selected.info}
          canAlert={PRICE_LINES.has(selected.info.name)}
          onChange={(change) => changeDrawing(selected.id, change)}
          onEditText={() => {
            const o = overlayById(selected.id);
            if (o) openEditor(o, false);
          }}
          onSettings={() => openSettings(selected.id)}
          // read from the chart: the line may have been dragged since it was selected
          onAlert={() => {
            const value = overlayById(selected.id)?.points[0]?.value;
            if (value !== undefined) onAddAlertRef.current(value);
          }}
          onLock={() => toggleLock(selected.id)}
          onHide={() => hideDrawing(selected.id)}
          onDelete={() => removeDrawing(selected.id)}
        />
      )}
      {settings && (
        <DrawingSettings
          key={`settings:${settings.id}`}
          info={settings.info}
          precision={pricePrecision}
          onApply={(change) => {
            changeDrawing(settings.id, change);
            setSettings(null);
          }}
          onClose={() => setSettings(null)}
        />
      )}
      {menu && (
        <div
          role="menu"
          className="menu fixed min-w-[8rem]"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - (menu.kind === "overlay" ? 150 : 50)), right: "auto" }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.kind === "overlay" ? (
            <>
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  openSettings(menu.id);
                  setMenu(null);
                }}
              >
                设置…
              </button>
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  toggleLock(menu.id);
                  setMenu(null);
                }}
              >
                {menu.locked ? "解锁" : "锁定"}
              </button>
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  hideDrawing(menu.id);
                  setMenu(null);
                }}
              >
                隐藏
              </button>
              <button
                role="menuitem"
                className="menu-item flex items-center justify-between gap-4"
                onClick={() => {
                  removeDrawing(menu.id);
                  setMenu(null);
                }}
              >
                删除 <span className="text-[11px] text-muted">Del</span>
              </button>
            </>
          ) : (
            <button
              role="menuitem"
              className="menu-item flex items-center gap-2"
              onClick={() => {
                onAddAlertRef.current(menu.price);
                setMenu(null);
              }}
            >
              <IconAlarm size={16} />
              在 {fmtValue(menu.price, pricePrecision, false)} 添加警报
              <span className="ml-auto pl-3 text-[11px] text-muted">Alt+A</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
