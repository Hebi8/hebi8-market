/**
 * The geometry behind two of TradingView's gestures that KLineChart does differently: dragging
 * the time axis, and pressing inside a drawing's see-through area. Type-only imports, so it loads
 * without KLineChart (which needs a window).
 */
import type { Coordinate, OverlayFigure } from "klinecharts";

/**
 * The bar space while the time axis is dragged from `from` to `to` (px from the plot's left edge,
 * `width` the plot's width), TradingView's way: the right edge keeps its bar and the bar grabbed
 * stays under the pointer, so dragging left spreads the bars and dragging right packs them.
 */
export function timeAxisBarSpace(start: number, width: number, from: number, to: number, limit: { min: number; max: number }): number {
  const space = (start * Math.max(0, width - to)) / Math.max(1, width - from);
  return Math.min(limit.max, Math.max(limit.min, space));
}

const AREAS = new Set(["rect", "circle", "polygon"]);

function alphaOf(color: string): number {
  const m = /^rgba\(.*,\s*([\d.]+)\s*\)$/.exec(color);
  return m ? Number(m[1]) : 1;
}

/**
 * An area the chart shows through (a translucent fill, or only an outline), as opposed to a solid
 * mark (an arrow, a flag). KLineChart hit-tests rects, circles and polygons by their whole area,
 * outline or not. Without a colour of its own a figure takes the drawing's fill, which is
 * translucent. A handle is a circle too, and is told by its key (the templates find the handle
 * dragged by it).
 */
export function isSeeThrough(figure: OverlayFigure): boolean {
  if (!AREAS.has(figure.type) || figure.ignoreEvent === true || figure.key) return false;
  const styles = figure.styles as { style?: string; color?: string } | undefined;
  if (styles?.style === "stroke") return true;
  return !styles?.color || alphaOf(styles.color) < 1;
}

/** Whether the area has an outline drawn round it: a fill alone has no edge to take a drag. */
export const hasOutline = (figure: OverlayFigure) => (figure.styles as { style?: string } | undefined)?.style !== "fill";

const CIRCLE_STEPS = 72;

/** The outline of an area figure as closed polylines, one per shape in its `attrs`. */
export function outlineOf(figure: OverlayFigure): Coordinate[][] {
  const shapes = [figure.attrs].flat() as { x: number; y: number; width: number; height: number; r: number; coordinates: Coordinate[] }[];
  return shapes.map((a) => {
    if (figure.type === "rect") {
      const [x0, y0, x1, y1] = [a.x, a.y, a.x + a.width, a.y + a.height];
      return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
    }
    if (figure.type === "circle") return Array.from({ length: CIRCLE_STEPS + 1 }, (_, i) => ({ x: a.x + a.r * Math.cos((i / CIRCLE_STEPS) * 2 * Math.PI), y: a.y + a.r * Math.sin((i / CIRCLE_STEPS) * 2 * Math.PI) }));
    return [...a.coordinates, a.coordinates[0]];
  });
}
