/** Shared by ChartView and KChart; kept free of klinecharts so the page can be server-rendered. */
import type { LineOverride } from "@/lib/config";
import type { LineDash } from "./drawing-style";

export interface IndicatorSpec {
  name: string;
  pane: "main" | "sub";
  /** Made for a pane of its own: on the main pane it keeps its own scale instead of the price axis */
  ownScale?: boolean;
  calcParams: number[];
  /** Hidden from the legend's eye toggle; the pane stays */
  hidden?: boolean;
  /** Decimals on the indicator's own axis, when KLineChart's default is too many */
  precision?: number;
  /** Its lines as restyled on the 样式 page (`chart.styles`) */
  lines?: LineOverride[];
}

/** One line of an indicator on its 样式 page, as KLineChart draws it by default. */
export interface IndicatorLine {
  title: string;
  color: string;
  size: number;
  dash: LineDash;
}

export interface CompareLegendEntry {
  key: string;
  value: number | null;
  /** Change since the base bar (the left edge of the visible range) */
  pct: number | null;
}

/** One value of an indicator at the crosshair, colored like its line. */
export interface LegendValue {
  title: string;
  text: string;
  color: string;
}

export interface LegendIndicator {
  /** Indicator name as created on the chart (built-in name or `F_<id>`) */
  name: string;
  paneId: string;
  params: number[];
  values: LegendValue[];
}

/** What the in-chart legend shows at the crosshair (or the last bar). */
export interface LegendSnapshot {
  /** Left edge of the plots in px (a left scale on the main pane pushes every pane right) */
  left: number;
  candle: { open: number; high: number; low: number; close: number; prevClose: number | null } | null;
  /** Top of each pane in px, relative to the chart container */
  paneTops: Record<string, number>;
  indicators: LegendIndicator[];
  compares: CompareLegendEntry[];
}

/** The chart as a picture: every pane with axes and drawings, plus what the legend showed. */
export interface ChartCapture {
  /** PNG data URL at the device pixel ratio */
  url: string;
  /** Size in CSS px */
  width: number;
  height: number;
  legend: LegendSnapshot;
}

/** Imperative handle the page uses for hotkeys and the bottom bar. */
export interface ChartControl {
  /** Scroll by a fraction of the visible width; negative = towards older bars */
  scroll: (fraction: number) => void;
  zoom: (scale: number) => void;
  /** Latest bar at the right edge, default zoom, auto y-scale */
  reset: () => void;
  /** TradingView's 自动: on fits the prices to the view, off keeps the range so the chart pans vertically */
  setAutoScale: (on: boolean) => void;
  /** Fit the last `years` (null = everything) into the view; false when the bars do not fit at 1px each */
  fitRange: (years: number | null) => boolean;
  /** A drawing's settings dialog is open (it lives in the chart, the page's own dialogs do not cover it) */
  dialogOpen: () => boolean;
  closeDialog: () => void;
  /** Remove the selected drawing; false when none is selected */
  deleteSelected: () => boolean;
  /** The chart for 拍快照; null before it exists */
  capture: () => ChartCapture | null;
  /** Ctrl+Z / Ctrl+Y on the drawings; false when there is nothing to undo or redo, or a drawing is half done */
  undo: () => boolean;
  redo: () => boolean;
  /** The lines of an indicator on the chart (by its KLineChart name; with `params`, the ones those would draw), or of one drawing `titles`; null when it is not on the chart and no titles are given */
  indicatorLines: (name: string, from?: { params?: number[]; titles?: string[] }) => IndicatorLine[] | null;
}

// Same stacks as globals.css; a canvas cannot read Tailwind's theme.
export const SANS = 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
export const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

/**
 * Readable in both themes and distinct from KLineChart's indicator palette (orange, purple,
 * blue, pink, teal); teal and rust come first so the usual one or two compares never share a
 * hue with the MA lines. Taken in order of addition.
 */
export const COMPARE_COLORS = ["#0e9aa7", "#c2410c", "#2f6fde", "#a21caf", "#65a30d", "#4b5563"];

export interface DrawTool {
  /** KLineChart overlay name (built in, or registered in chart-overlays.ts) */
  name: string;
  label: string;
  /** TradingView's default hotkey, shown in the tooltip */
  hotkey?: string;
  /** `KeyboardEvent.code` used with Alt */
  code?: string;
}

export interface DrawGroup {
  id: string;
  label: string;
  /** Sub-headings of the group's menu, as in TradingView */
  sections: { label: string; tools: DrawTool[] }[];
}

/** TradingView's left toolbar: one button per group, its menu split into sections. */
export const DRAW_GROUPS: DrawGroup[] = [
  {
    id: "lines",
    label: "趋势线工具",
    sections: [
      {
        label: "线条",
        tools: [
          { name: "segment", label: "趋势线", hotkey: "Alt+T", code: "KeyT" },
          { name: "rayLine", label: "射线" },
          { name: "infoLine", label: "信息线" },
          { name: "straightLine", label: "延长线" },
          { name: "trendAngle", label: "趋势角" },
          { name: "horizontalStraightLine", label: "水平线", hotkey: "Alt+H", code: "KeyH" },
          { name: "horizontalRayLine", label: "水平射线", hotkey: "Alt+J", code: "KeyJ" },
          { name: "verticalStraightLine", label: "垂直线", hotkey: "Alt+V", code: "KeyV" },
          { name: "crossLine", label: "十字线", hotkey: "Alt+C", code: "KeyC" },
        ],
      },
      {
        label: "通道",
        tools: [
          { name: "parallelChannel", label: "平行通道" },
          { name: "regressionTrend", label: "回归趋势" },
          { name: "priceChannelLine", label: "价格通道" },
        ],
      },
      { label: "叉", tools: [{ name: "pitchfork", label: "安德鲁音叉" }] },
    ],
  },
  {
    id: "fib",
    label: "江恩和斐波那契工具",
    sections: [
      {
        label: "斐波那契",
        tools: [
          { name: "fibonacciLine", label: "斐波那契回撤", hotkey: "Alt+F", code: "KeyF" },
          { name: "fibExtension", label: "基于趋势的斐波那契扩展" },
          { name: "fibChannel", label: "斐波那契通道" },
          { name: "fibTimeZone", label: "斐波那契时间周期" },
          { name: "fibFan", label: "斐波那契速度阻力扇" },
          { name: "fibCircles", label: "斐波那契圆环" },
          { name: "fibSpiral", label: "斐波那契螺旋" },
          { name: "fibArcs", label: "斐波那契速度阻力弧" },
        ],
      },
      {
        label: "江恩",
        tools: [
          { name: "gannBox", label: "江恩方箱" },
          { name: "gannFan", label: "江恩扇" },
        ],
      },
    ],
  },
  {
    id: "patterns",
    label: "形态",
    sections: [
      {
        label: "图表形态",
        tools: [
          { name: "xabcd", label: "XABCD 形态" },
          { name: "abcd", label: "ABCD 形态" },
          { name: "trianglePattern", label: "三角形态" },
          { name: "headShoulders", label: "头肩形态" },
        ],
      },
      {
        label: "艾略特波浪",
        tools: [
          { name: "elliottImpulse", label: "艾略特推动浪 (12345)" },
          { name: "elliottCorrection", label: "艾略特调整浪 (ABC)" },
          { name: "elliottTriangle", label: "艾略特三角浪 (ABCDE)" },
          { name: "elliottDoubleCombo", label: "艾略特双重组合浪 (WXY)" },
        ],
      },
    ],
  },
  {
    id: "forecast",
    label: "预测和测量工具",
    sections: [
      {
        label: "预测",
        tools: [
          { name: "longPosition", label: "多头持仓" },
          { name: "shortPosition", label: "空头持仓" },
        ],
      },
      {
        label: "测量",
        tools: [
          { name: "priceRange", label: "价格范围" },
          { name: "dateRange", label: "日期范围" },
          { name: "datePriceRange", label: "日期和价格范围" },
        ],
      },
    ],
  },
  {
    id: "shapes",
    label: "几何形状",
    sections: [
      { label: "画笔", tools: [{ name: "brush", label: "画笔" }] },
      {
        label: "形状",
        tools: [
          { name: "rect", label: "矩形" },
          { name: "path", label: "路径" },
          { name: "circle", label: "圆" },
          { name: "ellipse", label: "椭圆" },
          { name: "polyline", label: "折线" },
          { name: "triangle", label: "三角形" },
          { name: "arc", label: "弧形" },
          { name: "curve", label: "曲线" },
        ],
      },
    ],
  },
  {
    id: "annotation",
    label: "标注工具",
    sections: [
      {
        label: "文字和注释",
        tools: [
          { name: "text", label: "文本" },
          { name: "simpleAnnotation", label: "注释" },
          { name: "priceLabel", label: "价格标签" },
          { name: "flag", label: "旗帜标记" },
        ],
      },
      {
        label: "箭头",
        tools: [
          { name: "arrow", label: "箭头" },
          { name: "arrowMarkUp", label: "向上箭头" },
          { name: "arrowMarkDown", label: "向下箭头" },
        ],
      },
    ],
  },
];

export const DRAW_TOOLS: DrawTool[] = DRAW_GROUPS.flatMap((g) => g.sections.flatMap((s) => s.tools));

/**
 * TradingView's 测量 (Shift + click, or the ruler on the left toolbar): an overlay like the drawings
 * while it is up, but not one of them: never saved, selected or undone.
 */
export const MEASURE_TOOL = "measure";

/** Tools whose floating toolbar edits text (font size and the text) instead of line width and dash. */
export const TEXT_DRAWINGS = new Set(["text", "simpleAnnotation"]);

/** Tools drawn click by click until a double click, Enter or Esc. */
export const OPEN_DRAWINGS = new Set(["path", "polyline"]);

/**
 * Tools whose geometry depends on the price scale (lines through their points, parallels, levels):
 * they record the scale they were drawn on (`OverlaySpec.scale`) and keep to it on the other axis.
 * The rest are the same on either (horizontal / vertical lines, boxes, single points) or are pixel
 * figures (circles, spirals, arcs, the ellipse in its box).
 */
export const SCALED_DRAWINGS = new Set([
  "segment",
  "rayLine",
  "straightLine",
  "infoLine",
  "trendAngle",
  "parallelChannel",
  "regressionTrend",
  "priceChannelLine",
  "pitchfork",
  "fibonacciLine",
  "fibExtension",
  "fibChannel",
  "fibFan",
  "gannBox",
  "gannFan",
  "xabcd",
  "abcd",
  "trianglePattern",
  "headShoulders",
  "elliottImpulse",
  "elliottCorrection",
  "elliottTriangle",
  "elliottDoubleCombo",
  "triangle",
  "arc",
  "curve",
  "path",
  "polyline",
  "arrow",
]);

/** Date-range buttons under the chart; null = all history. */
export const RANGES: { label: string; years: number | null }[] = [
  { label: "1年", years: 1 },
  { label: "3年", years: 3 },
  { label: "5年", years: 5 },
  { label: "10年", years: 10 },
  { label: "全部", years: null },
];
