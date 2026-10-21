/**
 * TradingView's drawing tools that KLineChart does not ship, as overlay templates. Every figure
 * takes its colour, width and dash from the drawing's `styles.line` (the floating toolbar edits
 * that), so one style model covers lines, fills and labels. Points are `{timestamp, value}` like
 * the built-in tools, so drawings persist and follow every timeframe the same way.
 */
import {
  getOverlayClass,
  registerOverlay,
  utils,
  type Chart,
  type Coordinate,
  type Overlay,
  type OverlayCreateFiguresCallbackParams,
  type OverlayEvent,
  type OverlayFigure,
  type OverlayPerformEventParams,
  type OverlayTemplate,
  type Point,
} from "klinecharts";
import { DRAW_DONE, MEASURE_TOOL, SCALED_DRAWINGS } from "./chart-types";
import { bendLine, bendPolygon, bendRect, fitLine, fromSpace, makeWarp, movePrices, toSpace, type PriceScale, type Warp } from "./drawing-scale";
import { lineOf, withAlpha } from "./drawing-style";
import { BOX_HANDLES, boxHandleAt, channelHandles, dragBoxBy, dragChannel, drawable, yAt, type ChannelHandle } from "./drawing-edit";
import { FIB_LEVELS, fibBands, fibPrice, fibSettingsOf, fibSpan } from "./fib";
import { hasOutline, isSeeThrough, outlineOf } from "./chart-gestures";
import { measureLines, pct, priceChangeText, volumeBetween } from "./measure";
import { tradingDayOffset, tradingDayTimestamp } from "./drawing-time";

type Params = OverlayCreateFiguresCallbackParams<unknown>;
type Figures = OverlayFigure[];
type C = Coordinate;

/** Up / down colours (they follow the green-up / red-up setting) and the plain text colour. */
const theme = { up: "#16a34a", down: "#dc2626", text: "#1c1b19" };
export function setOverlayTheme(next: typeof theme) {
  Object.assign(theme, next);
}

/** The chart the regression and position tools read bars from while they are drawn or dragged. */
let activeChart: Chart | null = null;
/** The scale each drawing was drawn on (KChart keeps it with the drawing); older drawings have none. */
let scaleOf: (id: string) => PriceScale | undefined = () => undefined;
/**
 * Whether the chart's symbol counts calendar days rather than weekdays past its daily and 3D bars:
 * the server's answer (`BarsResponse.weekends`), the way its 3D bars are grouped.
 */
let weekendsOf: () => boolean = () => false;
export function setOverlayChart(chart: Chart | null, scales: typeof scaleOf = () => undefined, weekends: typeof weekendsOf = () => false) {
  activeChart = chart;
  scaleOf = scales;
  weekendsOf = weekends;
  if (chart) patchDailyTime(chart);
}

const DASHED = { style: "dashed", dashedValue: [4, 4] } as const;
const fill = (p: Params, alpha = 0.12) => withAlpha(lineOf(p.chart, p.overlay).color, alpha);
const shapeStyles = (p: Params, alpha = 0.12) => {
  const l = lineOf(p.chart, p.overlay);
  return { style: "stroke_fill", color: withAlpha(l.color, alpha), borderColor: l.color, borderSize: l.size, borderStyle: l.style, borderDashedValue: l.dashedValue };
};
const fillOnly = (color: string) => ({ style: "fill", color, borderSize: 0 });

// ---------------------------------------------------------------------------- geometry

/** A far point on the line a→b, past the edge of any pane (the canvas clips it). */
function far(a: C, b: C): C {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = 1e4 / (Math.hypot(dx, dy) || 1);
  return { x: a.x + dx * k, y: a.y + dy * k };
}
const ray = (a: C, b: C): C[] => [a, far(a, b)];
const both = (a: C, b: C): C[] => [far(b, a), far(a, b)];
const add = (a: C, d: C): C => ({ x: a.x + d.x, y: a.y + d.y });
const mid = (a: C, b: C): C => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const line = (coordinates: C[], styles?: object, ignoreEvent?: boolean): OverlayFigure => ({ type: "line", attrs: { coordinates }, styles, ignoreEvent });

function quadratic(a: C, control: C, b: C, steps = 48): C[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * control.x + t * t * b.x, y: u * u * a.y + 2 * u * t * control.y + t * t * b.y };
  });
}

function arrowHead(from: C, to: C, size: number): C[] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const wing = (a: number) => ({ x: to.x - size * Math.cos(angle + a), y: to.y - size * Math.sin(angle + a) });
  return [wing(0.45), to, wing(-0.45)];
}

/** The point `d` px from a towards b. */
function toward(a: C, b: C, d: number): C {
  const k = d / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

// ---------------------------------------------------------------------------- price scale

const axisScale = (yAxis?: { name: string } | null): PriceScale => (yAxis?.name === "logarithm" ? "log" : "linear");
const mainScale = () => axisScale(activeChart?.getYAxes({ paneId: "candle_pane" })[0]);
/** The space a drawing's geometry is straight in: the scale it was drawn on, or for an older drawing the axis it is on. */
const spaceOf = (p: Params): PriceScale => scaleOf(p.overlay.id) ?? axisScale(p.yAxis);
const spaceById = (id: string): PriceScale => scaleOf(id) ?? mainScale();

/** Figures a template made in the axis' pixels (arrow heads, info boxes): not bent. */
const onScreen = new WeakSet<OverlayFigure>();
function screenFigures(figures: Figures): Figures {
  figures.forEach((f) => onScreen.add(f));
  return figures;
}
/** Where a point of the template's coordinates is on screen, for marks drawn in pixels. */
type Bent = Params & { screen?: (c: C) => C };
const screenOf = (p: Params) => (p as Bent).screen ?? ((c: C) => c);

/**
 * A tool whose geometry is straight in its drawing's scale. On an axis of the other scale its
 * figures are made in the drawing's own space (coordinates and y-axis) and bent onto the axis:
 * lines and outlines become curves, labels go with their anchor. Older drawings, and drawings on
 * an axis of their own scale, are drawn as they are.
 */
function scaled(t: Template): Template {
  const create = t.createPointFigures!;
  return {
    ...t,
    createPointFigures: (p) => {
      const scale = scaleOf(p.overlay.id);
      const yAxis = p.yAxis;
      const values = p.overlay.points.flatMap((pt) => (pt.value === undefined ? [] : [pt.value]));
      const axis = axisScale(yAxis);
      if (!scale || !yAxis || scale === axis || !values.length) return create(p);
      // KLineChart rounds its pixels, which shows on a curve; its inverse does not, and the axis is linear in its own space
      const { height } = p.bounding;
      const [top, bottom] = [0, height].map((y) => toSpace(axis, yAxis.convertFromPixel(y)));
      const toPixel = (v: number) => (height * (toSpace(axis, v) - top)) / (bottom - top);
      const warp = makeWarp(scale, { scale: axis, toPixel, fromPixel: (y) => yAxis.convertFromPixel(y), width: p.bounding.width, height }, values);
      if (!warp) return create(p);
      const own: Bent = {
        ...p,
        coordinates: p.coordinates.map((c, i) => ({ x: c.x, y: warp.toY(p.overlay.points[i]?.value ?? 0) })),
        yAxis: Object.assign(Object.create(yAxis), { convertToPixel: warp.toY, convertFromPixel: warp.fromY }),
        screen: (c) => warp.point(c) ?? c,
      };
      return [create(own)].flat().flatMap((f) => (onScreen.has(f) ? [f] : bendFigure(f, warp)));
    },
  };
}

function bendFigure(f: OverlayFigure, warp: Warp): Figures {
  const list = [f.attrs].flat() as { x: number; y: number; height: number; coordinates: C[] }[];
  let attrs: object[];
  if (f.type === "line") attrs = list.flatMap((a) => bendLine(a.coordinates, warp).map((coordinates) => ({ coordinates })));
  else if (f.type === "polygon") attrs = list.map((a) => ({ coordinates: bendPolygon(a.coordinates, warp) })).filter((a) => a.coordinates.length > 2);
  else if (f.type === "rect") attrs = list.flatMap((a) => bendRect(a, warp) ?? []);
  // texts, circles and arcs go with their anchor
  else
    attrs = list.flatMap((a) => {
      const at = warp.point({ x: a.x, y: a.y });
      return at ? [{ ...a, y: at.y }] : [];
    });
  return attrs.length ? [{ ...f, attrs }] : [];
}

// ---------------------------------------------------------------------------- see-through areas

/**
 * TradingView: a drag that starts inside a drawing's see-through area (a rectangle's or a
 * channel's fill, the inside of a circle, a position's zones) moves the chart until the drawing is
 * selected; its outline and handles take a drag as always, and a click inside selects it. While the
 * drawing is not selected the area passes presses on (hovering it still highlights the drawing),
 * and an invisible line along its outline takes them instead. A fill alone has no outline (a
 * channel's ends, an arc's chord): the lines drawn with it are its edges.
 */
function seeThrough(t: Template): Template {
  const create = t.createPointFigures!;
  return {
    ...t,
    createPointFigures: (p) => {
      const figures = [create(p)].flat();
      // a drawing in progress takes no events, and a selected one is dragged from anywhere
      if (p.overlay.currentStep !== DRAW_DONE || storeOf(p.chart).getClickOverlayInfo().overlay?.id === p.overlay.id) return figures;
      return figures.flatMap((f) => {
        if (!isSeeThrough(f)) return [f];
        const area: OverlayFigure = { ...f, ignoreEvent: ["onPressedMoveStart"] };
        return hasOutline(f) ? [area, { type: "line", attrs: outlineOf(f).map((coordinates) => ({ coordinates })), styles: { color: "transparent" } }] : [area];
      });
    },
  };
}

// ---------------------------------------------------------------------------- labels and numbers

const precisionOf = (chart: Chart) => chart.getSymbol()?.pricePrecision ?? 2;
const fmt = (chart: Chart, v: number) => v.toLocaleString("en-US", { minimumFractionDigits: precisionOf(chart), maximumFractionDigits: precisionOf(chart) });

function fontOf(chart: Chart) {
  return chart.getStyles().overlay.text.family;
}

/** A small text in the drawing's colour with no box (TradingView's level labels). */
function plain(p: Params, x: number, y: number, text: string, align: CanvasTextAlign = "left", baseline: CanvasTextBaseline = "bottom", color?: string): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline },
    styles: { color: color ?? lineOf(p.chart, p.overlay).color, backgroundColor: "transparent", borderSize: 0, size: 11, family: fontOf(p.chart), paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
    ignoreEvent: true,
  };
}

/** A filled label box (white text on the drawing's colour, or on `color`). */
function tag(p: Params, x: number, y: number, text: string, align: CanvasTextAlign = "center", baseline: CanvasTextBaseline = "middle", color?: string): OverlayFigure {
  const bg = color ?? lineOf(p.chart, p.overlay).color;
  return {
    type: "text",
    attrs: { x, y, text, align, baseline },
    styles: { color: "#ffffff", backgroundColor: bg, borderColor: bg, borderSize: 0, borderRadius: 3, size: 11, family: fontOf(p.chart), paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3 },
    ignoreEvent: true,
  };
}

const INFO_LINE = 16;
const infoBoxHeight = (lines: number) => lines * INFO_LINE + 6;

/** Several lines in one box, centred on x; `top` is the box's top edge. `inside` keeps the whole box on the pane. */
function infoBox(p: Params, at: number, y: number, lines: string[], color?: string, inside = false): Figures {
  const size = 11;
  const family = fontOf(p.chart);
  const width = Math.max(...lines.map((t) => utils.calcTextWidth(t, size, "normal", family))) + 12;
  const lineHeight = INFO_LINE;
  const height = infoBoxHeight(lines.length);
  const within = (v: number, min: number, max: number) => (inside ? Math.max(min, Math.min(v, max)) : v);
  const x = within(at, width / 2 + 4, p.bounding.width - width / 2 - 4);
  const top = within(y, 4, p.bounding.height - height - 4);
  const bg = color ?? lineOf(p.chart, p.overlay).color;
  return [
    { type: "rect", attrs: { x: x - width / 2, y: top, width, height }, styles: { style: "fill", color: withAlpha(bg, 0.9), borderRadius: 4 }, ignoreEvent: true },
    ...lines.map((text, i) => ({
      type: "text",
      attrs: { x, y: top + 3 + i * lineHeight + lineHeight / 2, text, align: "center", baseline: "middle" },
      styles: { color: "#ffffff", backgroundColor: "transparent", borderSize: 0, size, family, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
      ignoreEvent: true,
    })),
  ];
}

// ---------------------------------------------------------------------------- bars

/**
 * KLineChart's own placing of a timestamp (the store behind the chart, not on its public type): the
 * bar at or before it, and past either end the period's calendar (trading days for daily bars),
 * so the counts here match where the chart draws the points.
 */
interface ChartStore {
  timestampToDataIndex: (timestamp: number) => number;
  dataIndexToTimestamp: (dataIndex: number) => number | null;
  timestampToFloatIndex: (timestamp: number) => number;
  floatIndexToTimestamp: (floatIndex: number) => number | null;
  getHoverOverlayInfo: () => { overlay: Overlay | null; figureType: string; figure: OverlayFigure | null };
  getClickOverlayInfo: () => { overlay: Overlay | null; figureType: string };
}
const storeOf = (chart: Chart) => (chart as unknown as { getChartStore: () => ChartStore }).getChartStore();

/** Patch the store itself so drawings, the time axis and crosshair share the same daily calendar. */
function patchDailyTime(chart: Chart) {
  const store = storeOf(chart);
  const anchorAt = (value: number, time: boolean) => {
    const period = chart.getPeriod();
    const bars = chart.getDataList();
    if (period?.type !== "day" || !bars.length) return null;
    const last = bars.length - 1;
    const index = value < (time ? bars[0].timestamp : 0) ? 0 : value > (time ? bars[last].timestamp : last) ? last : null;
    return index === null ? null : { index, timestamp: bars[index].timestamp, span: period.span, weekends: weekendsOf() };
  };
  for (const method of ["timestampToDataIndex", "timestampToFloatIndex"] as const) {
    const original = store[method];
    store[method] = (timestamp) => {
      const anchor = anchorAt(timestamp, true);
      if (!anchor) return original.call(store, timestamp);
      const offset = tradingDayOffset(anchor.timestamp, timestamp, anchor.weekends) / anchor.span;
      return anchor.index + (method === "timestampToDataIndex" ? Math.floor(offset) : offset);
    };
  }
  for (const method of ["dataIndexToTimestamp", "floatIndexToTimestamp"] as const) {
    const original = store[method];
    store[method] = (index) => {
      const anchor = anchorAt(index, false);
      if (!anchor) return original.call(store, index);
      return tradingDayTimestamp(anchor.timestamp, (index - anchor.index) * anchor.span, anchor.weekends);
    };
  }
}

const dataIndexOf = (chart: Chart, timestamp: number): number => storeOf(chart).timestampToDataIndex(timestamp);

const timestampOf = (chart: Chart, index: number): number => storeOf(chart).dataIndexToTimestamp(index) ?? 0;

/** The time of the bar a timestamp falls in on the chart's period, also past the last bar. */
export const snapToBar = (chart: Chart, timestamp: number): number => timestampOf(chart, dataIndexOf(chart, timestamp));

/** "12 根 K 线 · 84 天" between two points. */
function span(p: Params, a: Partial<Point>, b: Partial<Point>): string {
  const bars = dataIndexOf(p.chart, b.timestamp ?? 0) - dataIndexOf(p.chart, a.timestamp ?? 0);
  const days = Math.round(((b.timestamp ?? 0) - (a.timestamp ?? 0)) / 86400000);
  return `${bars} 根K线 · ${days} 天`;
}

const priceChange = (p: Params, from: number, to: number) => priceChangeText(from, to, precisionOf(p.chart));

// ---------------------------------------------------------------------------- handles

/**
 * Handles besides the stored points, drawn like KLineChart's own point handles and, like them,
 * only while the drawing is hovered or selected. Dragging one moves the whole drawing at first
 * (KLineChart knows no other figure drags); the template's `onPressedMoving` then puts the points
 * where that handle says.
 */
function handleFigures(p: Params, at: { key: string; c: C }[]): Figures {
  const store = storeOf(p.chart);
  const hover = store.getHoverOverlayInfo();
  const click = store.getClickOverlayInfo();
  const on = (info: { overlay: Overlay | null; figureType: string }) => info.overlay?.id === p.overlay.id && info.figureType !== "none";
  if (!on(hover) && !on(click)) return [];
  const s = { ...p.chart.getStyles().overlay.point, ...(p.overlay.styles?.point ?? {}) };
  return at.flatMap(({ key, c }) => {
    const active = hover.overlay?.id === p.overlay.id && hover.figure?.key === key;
    const [r, color, border, borderSize] = active ? [s.activeRadius, s.activeColor, s.activeBorderColor, s.activeBorderSize] : [s.radius, s.color, s.borderColor, s.borderSize];
    return [
      { key, type: "circle", attrs: { x: c.x, y: c.y, r: r + borderSize }, styles: { style: "fill", color: border } },
      { type: "circle", attrs: { x: c.x, y: c.y, r }, styles: { style: "fill", color }, ignoreEvent: true },
    ];
  });
}

/**
 * The drawing's points and the pointer (px and price) when a drag began, for the handles'
 * `onPressedMoving`, and the last points a handle put on it that could be drawn.
 */
let pressed: { id: string; points: Partial<Point>[]; at: C; value: number; last: Partial<Point>[] } | null = null;
const pointerValue = (e: OverlayEvent<unknown>) => (e.chart.convertFromPixel([{ y: e.y ?? 0 }], { paneId: e.overlay.paneId }) as Partial<Point>[])[0]?.value ?? NaN;
const onPress = (e: OverlayEvent<unknown>) => {
  const points = e.overlay.points.map((pt) => ({ ...pt }));
  pressed = { id: e.overlay.id, points, at: { x: e.x ?? 0, y: e.y ?? 0 }, value: pointerValue(e), last: points };
};
/**
 * A handle's result goes on the drawing when every price of it can be drawn (above zero where the
 * drawing or the axis is log), with `derived` the prices it implies without storing them (a
 * channel's second line ends where its width says); otherwise the drawing stays where the handle
 * last put it.
 */
function settle(e: OverlayEvent<unknown>, next: Partial<Point>[], derived: Partial<Point>[] = []) {
  if (!pressed) return;
  if (drawable([...next, ...derived], spaceById(e.overlay.id) === "log" || mainScale() === "log")) pressed.last = next;
  e.overlay.points = pressed.last.map((pt) => ({ ...pt }));
}
/** The handle being dragged (a stored point's own handle is `p0`, `p1`…), with the points when the drag began. */
function dragged(e: OverlayEvent<unknown>): { key: string; prev: Partial<Point>[] } | null {
  const key = e.figure?.key ?? "";
  if (pressed?.id !== e.overlay.id) return null;
  const point = /point_(\d+)$/.exec(key);
  return { key: point ? `p${point[1]}` : key, prev: pressed.points };
}

/**
 * A parallel channel's points as x in px and y in its drawing's price space (log prices for a log
 * drawing), where its two lines are straight and parallel whatever the axis; the handles' geometry
 * (`dragChannel`) is worked out there.
 */
function channelSpace(chart: Chart, id: string, paneId: string) {
  const scale = spaceById(id);
  const filter = { paneId };
  const price = (u: number) => fromSpace(scale, u);
  return {
    price,
    of: (pt: Partial<Point>): C => ({ x: (chart.convertToPixel({ timestamp: pt.timestamp }, filter) as Partial<C>).x ?? 0, y: toSpace(scale, pt.value ?? 0) }),
    pointer: (x: number, y: number): C => ({ x, y: toSpace(scale, (chart.convertFromPixel([{ y }], filter) as Partial<Point>[])[0].value ?? NaN) }),
    point: (c: C): Partial<Point> => ({ timestamp: (chart.convertFromPixel([{ x: c.x }], filter) as Partial<Point>[])[0].timestamp, value: price(c.y) }),
  };
}

/** TradingView's eight box handles: the two stored corners, the other two and the middle of each side. */
const boxHandles = {
  onPressedMoveStart: onPress,
  onPressedMoving: (e: OverlayEvent<unknown>) => {
    const d = dragged(e);
    const h = BOX_HANDLES.find((b) => b.key === d?.key);
    if (d && h && pressed) settle(e, dragBoxBy(d.prev, e.overlay.points, h, pressed.value, pointerValue(e), spaceById(e.overlay.id)));
  },
} satisfies Partial<Template>;
const boxHandleFigures = (p: Params): Figures => handleFigures(p, BOX_HANDLES.map((h) => ({ key: h.key, c: boxHandleAt(p.coordinates, h) })));

// ---------------------------------------------------------------------------- templates

type Template = OverlayTemplate<unknown>;
const base = { needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true } as const;

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const lines: Template[] = [
  // KLineChart's own straight lines, again here so they follow their drawing's scale
  { name: "segment", totalStep: 3, ...base, createPointFigures: ({ coordinates: [a, b] }) => (b ? [line([a, b])] : []) },
  { name: "rayLine", totalStep: 3, ...base, createPointFigures: ({ coordinates: [a, b] }) => (b ? [line(ray(a, b))] : []) },
  { name: "straightLine", totalStep: 3, ...base, createPointFigures: ({ coordinates: [a, b] }) => (b ? [line(both(a, b))] : []) },
  {
    name: "priceChannelLine",
    totalStep: 4,
    ...base,
    // the line, its parallel through the third point and one more as far on the other side
    createPointFigures: ({ coordinates: [a, b, c] }) => {
      if (!b) return [];
      const dy = c ? c.y - yAt(a, b, c.x) : 0;
      return (c ? [0, dy, -dy] : [0]).map((d) => line(both(add(a, { x: 0, y: d }), add(b, { x: 0, y: d }))));
    },
  },
  {
    name: "infoLine",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const [pa, pb] = p.overlay.points;
      // the angle and the box go by where the ends are on screen
      const s = screenOf(p);
      const [sa, sb] = [s(a), s(b)];
      const deg = (Math.atan2(sa.y - sb.y, sb.x - sa.x) * 180) / Math.PI;
      const below = sb.y >= sa.y;
      return [
        line([a, b]),
        ...screenFigures(infoBox(p, sb.x, below ? sb.y + 12 : sb.y - 12 - 54, [priceChange(p, pa.value ?? 0, pb.value ?? 0), span(p, pa, pb), `${deg.toFixed(1)}°`])),
      ];
    },
  },
  {
    name: "trendAngle",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      // the angle on screen where the line starts
      const s = screenOf(p);
      const sa = s(a);
      const next = s(toward(a, b, 10));
      const angle = Math.atan2(next.y - sa.y, next.x - sa.x);
      const deg = (-angle * 180) / Math.PI;
      const r = 36;
      return [
        line([a, b]),
        ...screenFigures([
          line([sa, { x: sa.x + r + 24, y: sa.y }], DASHED, true),
          { type: "arc", attrs: { x: sa.x, y: sa.y, r, startAngle: Math.min(0, angle), endAngle: Math.max(0, angle) }, ignoreEvent: true },
          plain(p, sa.x + r + 6, sa.y + (angle < 0 ? -4 : 14), `${deg.toFixed(1)}°`),
        ]),
      ];
    },
  },
  {
    name: "crossLine",
    totalStep: 2,
    ...base,
    createPointFigures: ({ coordinates: [a], bounding }) => [
      line([{ x: 0, y: a.y }, { x: bounding.width, y: a.y }]),
      line([{ x: a.x, y: 0 }, { x: a.x, y: bounding.height }]),
    ],
  },
  {
    name: "parallelChannel",
    totalStep: 4,
    ...base,
    // the third click sets the width; the point then sits at the start of the second line, like TradingView's
    performEventMoveForDrawing: function (this: Overlay, { points, performPointIndex }: OverlayPerformEventParams) {
      const [a, , c] = points;
      if (performPointIndex !== 2 || !activeChart || !c || a?.timestamp === undefined) return;
      const space = channelSpace(activeChart, this.id, "candle_pane");
      const [sa, sb, sc] = points.map(space.of);
      points[2] = { timestamp: a.timestamp, value: space.price(sa.y + sc.y - yAt(sa, sb, sc.x)) };
    },
    onPressedMoveStart: onPress,
    onPressedMoving: (e) => {
      const d = dragged(e);
      if (!d || !pressed || !["p0", "p1", "p2", "a2", "b2", "mid1", "mid2"].includes(d.key)) return;
      const handle = d.key as ChannelHandle;
      const space = channelSpace(e.chart, e.overlay.id, e.overlay.paneId);
      const prev = d.prev.map(space.of);
      // a stored point is where KLineChart put it (magnet included); the others moved with the pointer
      const stored = /^p\d$/.test(handle) ? space.of(e.overlay.points[Number(handle[1])]) : null;
      const from = stored ?? channelHandles(prev)[handle as Exclude<ChannelHandle, "p0" | "p1" | "p2">];
      const [now, then] = [space.pointer(e.x ?? 0, e.y ?? 0), space.pointer(pressed.at.x, pressed.at.y)];
      const to = stored ?? { x: from.x + now.x - then.x, y: from.y + now.y - then.y };
      const next = dragChannel(prev, handle, to);
      // points that did not move keep their exact values; a pointer where the drawing's scale has no
      // price, or an end pushed to one the axis cannot show, leaves the last channel that could be drawn
      settle(
        e,
        next.map((c, i) => (c.x === prev[i].x && c.y === prev[i].y ? d.prev[i] : space.point(c))),
        [space.point(channelHandles(next).b2)],
      );
    },
    createPointFigures: (p) => {
      const [a, b, c] = p.coordinates;
      if (!b) return [];
      if (!c) return [line([a, b])];
      const d = { x: 0, y: c.y - yAt(a, b, c.x) };
      const a2 = add(a, d);
      const b2 = add(b, d);
      const h = channelHandles(p.coordinates);
      return [
        { type: "polygon", attrs: { coordinates: [a, b, b2, a2] }, styles: fillOnly(fill(p, 0.1)) },
        line([a, b]),
        line([a2, b2]),
        line([mid(a, a2), mid(b, b2)], DASHED, true),
        // a channel saved before the third point was pinned to the second line's start shows that start too
        ...handleFigures(p, [
          ...(c.x !== a.x ? [{ key: "a2", c: h.a2 }] : []),
          { key: "b2", c: h.b2 },
          { key: "mid1", c: h.mid1 },
          { key: "mid2", c: h.mid2 },
        ]),
      ];
    },
  },
  {
    name: "regressionTrend",
    totalStep: 3,
    ...base,
    // the handles sit on the regression line, like TradingView's (KLineChart calls these on the overlay)
    performEventMoveForDrawing: function (this: Overlay, e: OverlayPerformEventParams) {
      snapToRegression(this.id, e);
    },
    performEventPressedMove: function (this: Overlay, e: OverlayPerformEventParams) {
      snapToRegression(this.id, e);
    },
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      const [pa, pb] = p.overlay.points;
      if (!b || pa.timestamp === undefined || pb.timestamp === undefined || !p.yAxis) return [];
      const fit = regression(p.chart, pa.timestamp, pb.timestamp, spaceOf(p));
      if (!fit) return [line([a, b])];
      const y = (i: number, k: number) => p.yAxis!.convertToPixel(fit.price(i, k));
      const [i0, i1] = pa.timestamp <= pb.timestamp ? [fit.i0, fit.i1] : [fit.i1, fit.i0];
      const pts = (k: number) => [
        { x: a.x, y: y(i0, k) },
        { x: b.x, y: y(i1, k) },
      ];
      const up = pts(2);
      const down = pts(-2);
      return [
        { type: "polygon", attrs: { coordinates: [up[0], up[1], down[1], down[0]] }, styles: fillOnly(fill(p, 0.1)) },
        line(pts(0), DASHED),
        line(up),
        line(down),
      ];
    },
  },
  {
    name: "pitchfork",
    totalStep: 4,
    ...base,
    createPointFigures: (p) => {
      const [a, b, c] = p.coordinates;
      if (!b) return [];
      if (!c) return [line([a, b])];
      const m = mid(b, c);
      const d = { x: m.x - a.x, y: m.y - a.y };
      return [
        { type: "polygon", attrs: { coordinates: [b, far(b, add(b, d)), far(c, add(c, d)), c] }, styles: fillOnly(fill(p, 0.08)) },
        line(ray(a, m)),
        line(ray(b, add(b, d))),
        line(ray(c, add(c, d))),
        line([b, c]),
      ];
    },
  },
];

/** The closes between two times fitted in the scale's space (log closes for a log drawing), ±k deviations there. */
function regression(chart: Chart, t0: number, t1: number, scale: PriceScale) {
  const list = chart.getDataList();
  const [i0, i1] = [Math.max(0, dataIndexOf(chart, Math.min(t0, t1))), Math.min(list.length - 1, dataIndexOf(chart, Math.max(t0, t1)))];
  const fit = fitLine(list.slice(i0, i1 + 1).map((d) => d.close), scale);
  return fit && { i0, i1, price: (i: number, k = 0) => fit.price(i - i0, k) };
}

function snapToRegression(id: string, { points }: OverlayPerformEventParams) {
  const [a, b] = points;
  if (!activeChart || a?.timestamp === undefined || b?.timestamp === undefined) return;
  const fit = regression(activeChart, a.timestamp, b.timestamp, spaceById(id));
  if (!fit) return;
  const [ia, ib] = a.timestamp <= b.timestamp ? [fit.i0, fit.i1] : [fit.i1, fit.i0];
  a.value = fit.price(ia);
  b.value = fit.price(ib);
}

/**
 * TradingView's levels of a retracement or an extension, between the x of two of its points (on to
 * the pane's edge where its settings extend them): a line and a "0.618 (123.45)" label per level, in
 * the level's colour or all in the drawing's own, over the bands between them. The labels sit left
 * of the lines, off the fill; on lines extended to the left edge they sit on the lines there. The
 * drawing is picked and dragged by its lines and labels; the bands let the pointer through.
 */
function fibLevels(p: Params, xa: number, xb: number, prices: number[]): Figures {
  const s = fibSettingsOf(p.overlay.extendData);
  const own = lineOf(p.chart, p.overlay).color;
  const [x0, x1] = fibSpan(xa, xb, s, p.bounding.width);
  const levels = FIB_LEVELS.map(({ level, color }) => {
    const value = fibPrice(spaceOf(p), prices, level, s.reverse);
    return { level, value, y: p.yAxis!.convertToPixel(value), color: s.oneColor ? own : color };
  });
  return [
    ...(s.background
      ? fibBands(levels).map(({ y, height, color }) => ({ type: "rect", attrs: { x: x0, y, width: x1 - x0, height }, styles: fillOnly(withAlpha(color, 1 - s.transparency / 100)), ignoreEvent: true }))
      : []),
    ...levels.flatMap(({ level, value, y, color }) => {
      const text = `${level} (${fmt(p.chart, value)})`;
      const label = s.extendLeft ? plain(p, 2, y, text, "left", "bottom", color) : plain(p, x0 - 4, y, text, "right", "middle", color);
      return [line([{ x: x0, y }, { x: x1, y }], { color }), { ...label, ignoreEvent: false }];
    }),
  ];
}

const fib: Template[] = [
  // KLineChart's own retracement, as TradingView draws it: level 0 at the second point, 1 at the
  // first and on past it (the other way round when reversed), every level a share of the move in
  // the drawing's scale
  {
    name: "fibonacciLine",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      const [pa, pb] = p.overlay.points;
      if (!b || pa.value === undefined || pb.value === undefined || !p.yAxis) return [];
      return [...fibLevels(p, a.x, b.x, [pa.value, pb.value]), line([a, b], DASHED)];
    },
  },
  {
    name: "fibExtension",
    totalStep: 4,
    ...base,
    createPointFigures: (p) => {
      const [a, b, c] = p.coordinates;
      const [pa, pb, pc] = p.overlay.points;
      if (!b) return [];
      const guide = line(c ? [a, b, c] : [a, b], DASHED);
      if (!c || !p.yAxis) return [guide];
      // the move from the first point to the second, counted from the third; the levels span the last two
      return [...fibLevels(p, b.x, c.x, [pa.value ?? 0, pb.value ?? 0, pc.value ?? 0]), guide];
    },
  },
  {
    name: "fibChannel",
    totalStep: 4,
    ...base,
    createPointFigures: (p) => {
      const [a, b, c] = p.coordinates;
      if (!b) return [];
      if (!c) return [line([a, b])];
      const dy = c.y - yAt(a, b, c.x);
      return FIB.flatMap((level) => {
        const d = { x: 0, y: dy * level };
        const from = add(a, d);
        return [line(ray(from, add(b, d))), plain(p, from.x, from.y, `${level}`, "right", "middle")];
      });
    },
  },
  {
    name: "fibTimeZone",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [line([{ x: a.x, y: 0 }, { x: a.x, y: p.bounding.height }])];
      const dx = b.x - a.x;
      const seq = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
      return seq.flatMap((n) => {
        const x = a.x + dx * n;
        if (x < -10 || x > p.bounding.width + 10) return [];
        return [line([{ x, y: 0 }, { x, y: p.bounding.height }]), plain(p, x + 2, p.bounding.height - 4, `${n}`)];
      });
    },
  },
  {
    name: "fibFan",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const levels = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
      return [
        line([a, b], DASHED, true),
        ...levels.flatMap((level) => {
          const t = { x: b.x, y: b.y + (a.y - b.y) * level };
          return [line(ray(a, t)), plain(p, b.x, t.y, `${level}`, "left", "middle")];
        }),
      ];
    },
  },
  {
    name: "fibCircles",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const c = mid(a, b);
      const r = Math.hypot(b.x - a.x, b.y - a.y) / 2;
      const levels = [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
      return [
        line([a, b], DASHED, true),
        ...levels.map((level) => ({ type: "circle", attrs: { x: c.x, y: c.y, r: r * level }, styles: { style: "stroke", borderColor: lineOf(p.chart, p.overlay).color, borderSize: lineOf(p.chart, p.overlay).size } })),
      ];
    },
  },
  {
    name: "fibSpiral",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const r0 = Math.hypot(b.x - a.x, b.y - a.y);
      const t0 = Math.atan2(b.y - a.y, b.x - a.x);
      const phi = (1 + Math.sqrt(5)) / 2;
      const turns = Array.from({ length: 321 }, (_, i) => -4 * Math.PI + (i / 320) * 6 * Math.PI);
      const curve = turns.map((t) => {
        const r = r0 * phi ** ((2 * t) / Math.PI);
        return { x: a.x + r * Math.cos(t0 + t), y: a.y + r * Math.sin(t0 + t) };
      });
      return [line([a, b], DASHED, true), line(curve)];
    },
  },
  {
    name: "fibArcs",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      // half circles around the second point, opening towards the first
      const [start, end] = a.y < b.y ? [Math.PI, 2 * Math.PI] : [0, Math.PI];
      return [
        line([a, b], DASHED, true),
        ...[0.382, 0.5, 0.618, 1].flatMap((level) => [
          { type: "arc", attrs: { x: b.x, y: b.y, r: r * level, startAngle: start, endAngle: end } },
          plain(p, b.x, b.y + (a.y < b.y ? -r * level : r * level), `${level}`, "center", a.y < b.y ? "bottom" : "top"),
        ]),
      ];
    },
  },
  {
    name: "gannBox",
    totalStep: 3,
    ...base,
    ...boxHandles,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const levels = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
      const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
      return [
        { type: "rect", attrs: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, styles: fillOnly(fill(p, 0.08)) },
        ...levels.flatMap((l) => {
          const x = x0 + (x1 - x0) * l;
          const y = y0 + (y1 - y0) * l;
          return [line([{ x, y: y0 }, { x, y: y1 }]), line([{ x: x0, y }, { x: x1, y }]), plain(p, x, y1 + 2, `${l}`, "center", "top"), plain(p, x0 - 2, y, `${l}`, "right", "middle")];
        }),
        ...boxHandleFigures(p),
      ];
    },
  },
  {
    name: "gannFan",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // price × time: 1/8 … 1/1 … 8/1, the 1/1 line through the second point
      const fans: [string, number, number][] = [
        ["1/8", 8, 1],
        ["1/4", 4, 1],
        ["1/3", 3, 1],
        ["1/2", 2, 1],
        ["1/1", 1, 1],
        ["2/1", 1, 2],
        ["3/1", 1, 3],
        ["4/1", 1, 4],
        ["8/1", 1, 8],
      ];
      return fans.flatMap(([text, tx, ty]) => {
        const t = { x: a.x + dx * tx, y: a.y + dy * ty };
        const at = { x: a.x + dx, y: a.y + (dy * ty) / tx };
        return [line(ray(a, t)), plain(p, at.x + 2, at.y, text, "left", "middle")];
      });
    },
  },
];

// ---------------------------------------------------------------------------- patterns

/** Point labels go above a local high and below a local low. */
function pointLabels(p: Params, labels: string[]): Figures {
  const cs = p.coordinates;
  return cs.flatMap((c, i) => {
    const text = labels[i];
    if (!text) return [];
    const high = [cs[i - 1], cs[i + 1]].every((n) => !n || c.y <= n.y);
    return [plain(p, c.x, high ? c.y - 6 : c.y + 6, text, "center", high ? "bottom" : "top")];
  });
}

const ratio = (p: Params, i: number, j: number, k: number, l: number) => {
  const v = p.overlay.points.map((pt) => pt.value ?? 0);
  const den = Math.abs(v[j] - v[i]);
  return den ? (Math.abs(v[l] - v[k]) / den).toFixed(3) : "";
};

function ratioLine(p: Params, i: number, j: number, text: string): Figures {
  const a = p.coordinates[i];
  const b = p.coordinates[j];
  if (!a || !b || !text) return [];
  const m = mid(a, b);
  return [line([a, b], DASHED, true), tag(p, m.x, m.y, text)];
}

function pattern(name: string, labels: string[], extra?: (p: Params) => Figures): Template {
  return {
    name,
    totalStep: labels.length + 1,
    ...base,
    createPointFigures: (p) => [...(extra?.(p) ?? []), ...(p.coordinates.length > 1 ? [line(p.coordinates)] : []), ...pointLabels(p, labels)],
  };
}

const patterns: Template[] = [
  pattern("xabcd", ["X", "A", "B", "C", "D"], (p) => {
    const [x, a, b, c, d] = p.coordinates;
    return [
      ...(b ? [{ type: "polygon", attrs: { coordinates: [x, a, b] }, styles: fillOnly(fill(p)) }] : []),
      ...(d ? [{ type: "polygon", attrs: { coordinates: [b, c, d] }, styles: fillOnly(fill(p)) }] : []),
      ...(b ? ratioLine(p, 0, 2, ratio(p, 0, 1, 1, 2)) : []),
      ...(c ? ratioLine(p, 1, 3, ratio(p, 1, 2, 2, 3)) : []),
      ...(d ? [...ratioLine(p, 2, 4, ratio(p, 2, 3, 3, 4)), ...ratioLine(p, 0, 4, ratio(p, 0, 1, 1, 4))] : []),
    ];
  }),
  pattern("abcd", ["A", "B", "C", "D"], (p) => [
    ...(p.coordinates[2] ? ratioLine(p, 0, 2, ratio(p, 0, 1, 1, 2)) : []),
    ...(p.coordinates[3] ? ratioLine(p, 1, 3, ratio(p, 1, 2, 2, 3)) : []),
  ]),
  pattern("trianglePattern", ["A", "B", "C", "D"], (p) => {
    const [a, b, c, d] = p.coordinates;
    return [
      ...(d ? [{ type: "polygon", attrs: { coordinates: [a, b, d, c] }, styles: fillOnly(fill(p, 0.1)) }] : []),
      ...(c ? [line(ray(a, c), DASHED, true)] : []),
      ...(d ? [line(ray(b, d), DASHED, true)] : []),
    ];
  }),
  pattern("headShoulders", ["", "左肩", "", "头", "", "右肩", ""], (p) => {
    const [, , n1, , n2] = p.coordinates;
    return n2 ? [line(both(n1, n2), DASHED, true), tag(p, mid(n1, n2).x, mid(n1, n2).y, "颈线")] : [];
  }),
  pattern("elliottImpulse", ["0", "(1)", "(2)", "(3)", "(4)", "(5)"]),
  pattern("elliottCorrection", ["0", "(A)", "(B)", "(C)"]),
  pattern("elliottTriangle", ["0", "(A)", "(B)", "(C)", "(D)", "(E)"]),
  pattern("elliottDoubleCombo", ["0", "(W)", "(X)", "(Y)"]),
];

// ---------------------------------------------------------------------------- prediction and measurement

/** Entry, target and stop; the last two share the right edge. One click places it at a size that fits the view. */
function position(name: string, long: boolean): Template {
  const sync = ({ points, performPointIndex }: OverlayPerformEventParams) => {
    const [, target, stop] = points;
    if (!target || !stop) return;
    if (performPointIndex === 1) stop.timestamp = target.timestamp;
    if (performPointIndex === 2) target.timestamp = stop.timestamp;
  };
  return {
    name,
    totalStep: 2,
    ...base,
    needDefaultXAxisFigure: false,
    performEventMoveForDrawing: ({ points }) => {
      const entry = points[0];
      if (!activeChart || entry?.timestamp === undefined || entry.value === undefined) return;
      const { from, to } = activeChart.getVisibleRange();
      const list = activeChart.getDataList().slice(from, to);
      const high = Math.max(...list.map((d) => d.high));
      const low = Math.min(...list.map((d) => d.low));
      const room = Number.isFinite(high - low) && high > low ? high - low : Math.abs(entry.value) * 0.1;
      const end = timestampOf(activeChart, dataIndexOf(activeChart, entry.timestamp) + Math.max(5, Math.round((to - from) * 0.15)));
      const dir = long ? 1 : -1;
      points[1] = { timestamp: end, value: entry.value + dir * room * 0.12 };
      points[2] = { timestamp: end, value: entry.value - dir * room * 0.06 };
    },
    performEventPressedMove: sync,
    createPointFigures: (p) => {
      const [e, t, s] = p.coordinates;
      const [pe, pt, ps] = p.overlay.points;
      if (!t || !s) return [];
      const entry = pe.value ?? 0;
      const reward = Math.abs((pt.value ?? 0) - entry);
      const risk = Math.abs(entry - (ps.value ?? 0));
      const x0 = Math.min(e.x, t.x);
      const width = Math.abs(t.x - e.x);
      const box = (y1: number, y2: number, color: string): OverlayFigure => ({
        type: "rect",
        attrs: { x: x0, y: Math.min(y1, y2), width, height: Math.abs(y2 - y1) },
        styles: { style: "fill", color: withAlpha(color, 0.18) },
      });
      const cx = x0 + width / 2;
      const up = t.y < s.y;
      // the entry may have been dragged past the target or the stop
      const top = Math.min(e.y, t.y, s.y);
      const bottom = Math.max(e.y, t.y, s.y);
      return [
        box(e.y, t.y, theme.up),
        box(e.y, s.y, theme.down),
        // the zones' outer edges, not drawn: they take a drag while the zones let one through to the chart
        line([{ x: x0, y: top }, { x: x0 + width, y: top }, { x: x0 + width, y: bottom }, { x: x0, y: bottom }, { x: x0, y: top }], { color: "transparent" }),
        line([{ x: x0, y: e.y }, { x: x0 + width, y: e.y }], { color: theme.text, size: 1 }),
        tag(p, cx, t.y + (up ? -4 : 4), `目标 ${fmt(p.chart, pt.value ?? 0)} (${pct(entry, pt.value ?? 0).toFixed(2)}%)`, "center", up ? "bottom" : "top", theme.up),
        tag(p, cx, s.y + (up ? 4 : -4), `止损 ${fmt(p.chart, ps.value ?? 0)} (${pct(entry, ps.value ?? 0).toFixed(2)}%)`, "center", up ? "top" : "bottom", theme.down),
        tag(p, cx, e.y, `盈亏比 ${risk ? (reward / risk).toFixed(2) : "—"}`, "center", "middle", "#64748b"),
      ];
    },
  };
}

/** Every figure of a mark that is only looked at: the pointer goes through it. */
const inert = (figures: Figures): Figures => figures.map((f) => ({ ...f, ignoreEvent: true }));

const measure: Template[] = [
  // TradingView's 测量 (Shift + click): a ruler from the first click to the pointer, in the up or
  // down colour by where the price went. KChart puts it up and takes it down; it is never saved.
  {
    name: MEASURE_TOOL,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const [pa, pb] = p.overlay.points;
      const [from, to] = [pa.value ?? 0, pb.value ?? 0];
      const color = to >= from ? theme.up : theme.down;
      const [ia, ib] = [dataIndexOf(p.chart, pa.timestamp ?? 0), dataIndexOf(p.chart, pb.timestamp ?? 0)];
      const lines = measureLines(
        {
          from,
          to,
          bars: ib - ia,
          days: Math.round(((pb.timestamp ?? 0) - (pa.timestamp ?? 0)) / 86400000),
          volume: volumeBetween(p.chart.getDataList().map((d) => d.volume), ia, ib),
        },
        precisionOf(p.chart),
      );
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const stroke = { color, size: 1, style: "solid" };
      // the box goes past the end the price went to: above a rise, below a fall
      const top = b.y <= a.y ? Math.min(a.y, b.y) - 8 - infoBoxHeight(lines.length) : Math.max(a.y, b.y) + 8;
      return inert([
        { type: "rect", attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, styles: fillOnly(withAlpha(color, 0.18)) },
        line([{ x: cx, y: a.y }, { x: cx, y: b.y }], stroke),
        line(arrowHead({ x: cx, y: a.y }, { x: cx, y: b.y }, 8), stroke),
        line([{ x: a.x, y: cy }, { x: b.x, y: cy }], stroke),
        line(arrowHead({ x: a.x, y: cy }, { x: b.x, y: cy }, 8), stroke),
        ...infoBox(p, cx, top, lines, color, true),
      ]);
    },
  },
  position("longPosition", true),
  position("shortPosition", false),
  {
    name: "priceRange",
    totalStep: 3,
    ...base,
    ...boxHandles,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const [pa, pb] = p.overlay.points;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const cx = (x0 + x1) / 2;
      const head = { x: cx, y: b.y };
      return [
        { type: "rect", attrs: { x: x0, y: Math.min(a.y, b.y), width: x1 - x0, height: Math.abs(b.y - a.y) }, styles: fillOnly(fill(p)) },
        line([{ x: x0, y: a.y }, { x: x1, y: a.y }]),
        line([{ x: x0, y: b.y }, { x: x1, y: b.y }]),
        line([{ x: cx, y: a.y }, head]),
        line(arrowHead({ x: cx, y: a.y }, head, 8)),
        ...infoBox(p, cx, b.y < a.y ? b.y - 30 : b.y + 8, [priceChange(p, pa.value ?? 0, pb.value ?? 0)]),
        ...boxHandleFigures(p),
      ];
    },
  },
  {
    name: "dateRange",
    totalStep: 3,
    ...base,
    ...boxHandles,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const [pa, pb] = p.overlay.points;
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      const cy = (y0 + y1) / 2;
      const head = { x: b.x, y: cy };
      return [
        { type: "rect", attrs: { x: Math.min(a.x, b.x), y: y0, width: Math.abs(b.x - a.x), height: y1 - y0 }, styles: fillOnly(fill(p)) },
        line([{ x: a.x, y: y0 }, { x: a.x, y: y1 }]),
        line([{ x: b.x, y: y0 }, { x: b.x, y: y1 }]),
        line([{ x: a.x, y: cy }, head]),
        line(arrowHead({ x: a.x, y: cy }, head, 8)),
        ...infoBox(p, (a.x + b.x) / 2, y1 + 8, [span(p, pa, pb)]),
        ...boxHandleFigures(p),
      ];
    },
  },
  {
    name: "datePriceRange",
    totalStep: 3,
    ...base,
    ...boxHandles,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const [pa, pb] = p.overlay.points;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      return [
        { type: "rect", attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, styles: fillOnly(fill(p)) },
        line([{ x: cx, y: a.y }, { x: cx, y: b.y }]),
        line(arrowHead({ x: cx, y: a.y }, { x: cx, y: b.y }, 8)),
        line([{ x: a.x, y: cy }, { x: b.x, y: cy }]),
        line(arrowHead({ x: a.x, y: cy }, { x: b.x, y: cy }, 8)),
        ...infoBox(p, cx, Math.max(a.y, b.y) + 8, [priceChange(p, pa.value ?? 0, pb.value ?? 0), span(p, pa, pb)]),
        ...boxHandleFigures(p),
      ];
    },
  },
];

// ---------------------------------------------------------------------------- shapes

/** Paths and polylines (OPEN_DRAWINGS) take up to this many clicks; KChart finishes them earlier. */
const OPEN_STEPS = 200;

const shapes: Template[] = [
  {
    name: "rect",
    totalStep: 3,
    ...base,
    ...boxHandles,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      return [{ type: "rect", attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, styles: shapeStyles(p) }, ...boxHandleFigures(p)];
    },
  },
  {
    name: "circle",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      return [{ type: "circle", attrs: { x: a.x, y: a.y, r: Math.hypot(b.x - a.x, b.y - a.y) }, styles: shapeStyles(p) }];
    },
  },
  {
    name: "ellipse",
    totalStep: 3,
    ...base,
    ...boxHandles,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const c = mid(a, b);
      const rx = Math.abs(b.x - a.x) / 2;
      const ry = Math.abs(b.y - a.y) / 2;
      const coordinates = Array.from({ length: 72 }, (_, i) => ({ x: c.x + rx * Math.cos((i / 72) * 2 * Math.PI), y: c.y + ry * Math.sin((i / 72) * 2 * Math.PI) }));
      return [{ type: "polygon", attrs: { coordinates }, styles: shapeStyles(p) }, ...boxHandleFigures(p)];
    },
  },
  {
    name: "triangle",
    totalStep: 4,
    ...base,
    createPointFigures: (p) => (p.coordinates.length < 3 ? [line(p.coordinates)] : [{ type: "polygon", attrs: { coordinates: p.coordinates }, styles: shapeStyles(p) }]),
  },
  {
    name: "arc",
    totalStep: 4,
    ...base,
    // start, end, then the bulge
    createPointFigures: (p) => {
      const [a, b, c] = p.coordinates;
      if (!b) return [];
      if (!c) return [line([a, b])];
      const curve = quadratic(a, { x: 2 * c.x - (a.x + b.x) / 2, y: 2 * c.y - (a.y + b.y) / 2 }, b);
      return [{ type: "polygon", attrs: { coordinates: curve }, styles: fillOnly(fill(p)) }, line(curve)];
    },
  },
  {
    name: "curve",
    totalStep: 4,
    ...base,
    createPointFigures: (p) => {
      const [a, b, c] = p.coordinates;
      if (!b) return [];
      if (!c) return [line([a, b])];
      return [line(quadratic(a, { x: 2 * c.x - (a.x + b.x) / 2, y: 2 * c.y - (a.y + b.y) / 2 }, b))];
    },
  },
  {
    name: "path",
    totalStep: OPEN_STEPS,
    ...base,
    createPointFigures: (p) => {
      const cs = p.coordinates;
      if (cs.length < 2) return [];
      const s = screenOf(p);
      const [prev, last] = cs.slice(-2);
      return [line(cs), ...screenFigures([line(arrowHead(s(toward(last, prev, 10)), s(last), 10))])];
    },
  },
  {
    name: "polyline",
    totalStep: OPEN_STEPS,
    ...base,
    createPointFigures: (p) => (p.coordinates.length < 2 ? [] : [line(p.coordinates)]),
  },
];

// ---------------------------------------------------------------------------- annotation

export const DEFAULT_TEXT_SIZE = 14;
export const textOf = (o: Pick<Overlay, "extendData">) => (typeof o.extendData === "string" ? o.extendData : "");
export const textSizeOf = (o: Pick<Overlay, "styles">) => (o.styles?.text?.size as number | undefined) ?? DEFAULT_TEXT_SIZE;

const annotation: Template[] = [
  {
    name: "text",
    totalStep: 2,
    ...base,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: (p) => {
      const [a] = p.coordinates;
      const size = textSizeOf(p.overlay);
      const color = lineOf(p.chart, p.overlay).color;
      return textOf(p.overlay)
        .split("\n")
        .map((text, i) => ({
          type: "text",
          attrs: { x: a.x, y: a.y + i * Math.round(size * 1.35), text: text || " ", align: "left", baseline: "top" },
          styles: { color, size, family: fontOf(p.chart), backgroundColor: "transparent", borderSize: 0, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
        }));
    },
  },
  // KLineChart's own 注释 only reacts on its anchor point; this one can be picked and dragged by its text
  {
    name: "simpleAnnotation",
    totalStep: 2,
    needDefaultPointFigure: true,
    createPointFigures: (p) => {
      const [a] = p.coordinates;
      const top = a.y - 6;
      const end = top - 50;
      const color = lineOf(p.chart, p.overlay).color;
      return [
        line([{ x: a.x, y: top }, { x: a.x, y: end }], DASHED, true),
        { type: "polygon", attrs: { coordinates: [{ x: a.x, y: end }, { x: a.x - 4, y: end - 5 }, { x: a.x + 4, y: end - 5 }] }, styles: fillOnly(color), ignoreEvent: true },
        { type: "text", attrs: { x: a.x, y: end - 5, text: textOf(p.overlay) || " ", align: "center", baseline: "bottom" }, styles: { size: textSizeOf(p.overlay), backgroundColor: color, borderColor: color, color: "#ffffff" } },
      ];
    },
  },
  {
    name: "priceLabel",
    totalStep: 2,
    ...base,
    needDefaultXAxisFigure: false,
    createPointFigures: (p) => {
      const [a] = p.coordinates;
      const color = lineOf(p.chart, p.overlay).color;
      return [
        { type: "polygon", attrs: { coordinates: [a, { x: a.x - 5, y: a.y - 8 }, { x: a.x + 5, y: a.y - 8 }] }, styles: fillOnly(color) },
        { ...tag(p, a.x, a.y - 8, fmt(p.chart, p.overlay.points[0]?.value ?? 0), "center", "bottom"), ignoreEvent: false },
      ];
    },
  },
  {
    name: "arrow",
    totalStep: 3,
    ...base,
    createPointFigures: (p) => {
      const [a, b] = p.coordinates;
      if (!b) return [];
      const s = screenOf(p);
      return [line([a, b]), ...screenFigures([line(arrowHead(s(toward(b, a, 10)), s(b), 12))])];
    },
  },
  arrowMark("arrowMarkUp", true),
  arrowMark("arrowMarkDown", false),
  {
    name: "flag",
    totalStep: 2,
    ...base,
    needDefaultXAxisFigure: false,
    createPointFigures: (p) => {
      const [a] = p.coordinates;
      const color = lineOf(p.chart, p.overlay).color;
      return [
        line([a, { x: a.x, y: a.y - 28 }], { color, size: 2, style: "solid" }),
        { type: "polygon", attrs: { coordinates: [{ x: a.x, y: a.y - 28 }, { x: a.x + 18, y: a.y - 23 }, { x: a.x, y: a.y - 17 }] }, styles: fillOnly(color) },
      ];
    },
  },
];

/** TradingView's 向上 / 向下箭头: a fat arrow under (over) the point, green (red). */
function arrowMark(name: string, up: boolean): Template {
  return {
    name,
    totalStep: 2,
    ...base,
    needDefaultXAxisFigure: false,
    createPointFigures: (p) => {
      const [a] = p.coordinates;
      const s = up ? 1 : -1;
      const tip = { x: a.x, y: a.y + 4 * s };
      const shape = [tip, { x: a.x + 9, y: tip.y + 10 * s }, { x: a.x + 4, y: tip.y + 10 * s }, { x: a.x + 4, y: tip.y + 24 * s }, { x: a.x - 4, y: tip.y + 24 * s }, { x: a.x - 4, y: tip.y + 10 * s }, { x: a.x - 9, y: tip.y + 10 * s }];
      return [{ type: "polygon", attrs: { coordinates: shape }, styles: fillOnly(up ? theme.up : theme.down) }];
    },
  };
}

/**
 * KLineChart drags a whole drawing by adding the price difference to every point, which bends it
 * on a log axis and can push it to zero and below. Move it in its own space instead (by the ratio
 * in a log one), never to a price that cannot be drawn; a point of a log drawing dragged on its own
 * keeps its price while the pointer is at zero or below.
 */
function patchMoves() {
  type Moving = Overlay & {
    _prevPressedPoint: Partial<Point> | null;
    _prevPressedPoints: Partial<Point>[];
    eventPressedOtherMove: (point: Partial<Point>, store: unknown) => void;
    eventPressedPointMove: (point: Partial<Point>, index: number) => void;
  };
  const proto = Object.getPrototypeOf(getOverlayClass("segment")!.prototype) as Moving;
  const moveAll = proto.eventPressedOtherMove;
  proto.eventPressedOtherMove = function (this: Moving, point, store) {
    const before = this.points;
    moveAll.call(this, point, store);
    const from = this._prevPressedPoint?.value;
    if (from === undefined || point.value === undefined) return;
    const space = spaceById(this.id);
    const values = movePrices(
      this._prevPressedPoints.map((pt) => pt.value),
      from,
      point.value,
      space,
      space === "log" || mainScale() === "log",
    );
    this.points.forEach((pt, i) => (pt.value = values ? values[i] : before[i]?.value));
    // a regression's handles go back onto the fit of its new bars
    this.performEventPressedMove?.({ currentStep: this.currentStep, mode: this.mode, points: this.points, performPointIndex: 0, performPoint: this.points[0] });
  };
  const moveOne = proto.eventPressedPointMove;
  proto.eventPressedPointMove = function (this: Moving, point, index) {
    const stay = spaceById(this.id) === "log" && point.value !== undefined && point.value <= 0;
    moveOne.call(this, stay ? { ...point, value: undefined } : point, index);
  };
}

let registered = false;
export function registerDrawingTemplates() {
  if (registered) return;
  registered = true;
  for (const t of [...lines, ...fib, ...patterns, ...measure, ...shapes, ...annotation]) registerOverlay(seeThrough(SCALED_DRAWINGS.has(t.name) ? scaled(t) : t));
  patchMoves();
}
