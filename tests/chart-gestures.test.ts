import { describe, expect, it } from "vitest";
import type { OverlayFigure } from "klinecharts";
import { hasOutline, isSeeThrough, outlineOf, timeAxisBarSpace } from "@/components/chart-gestures";
import { withAlpha } from "@/components/drawing-style";

const limit = { min: 1, max: 50 };

describe("time axis drag", () => {
  it("keeps the bar grabbed under the pointer, measured from the right edge", () => {
    // grabbed 400px from the right edge of a 1000px plot, dragged to 200px from it: twice as packed
    expect(timeAxisBarSpace(8, 1000, 600, 800, limit)).toBe(4);
    // dragged left to 800px from the right edge: twice as spread
    expect(timeAxisBarSpace(8, 1000, 600, 200, limit)).toBe(16);
    expect(timeAxisBarSpace(8, 1000, 600, 600, limit)).toBe(8);
  });

  it("stays within the chart's bar space limits, past either edge too", () => {
    expect(timeAxisBarSpace(8, 1000, 600, 1200, limit)).toBe(1);
    expect(timeAxisBarSpace(8, 1000, 900, -2000, limit)).toBe(50);
    expect(timeAxisBarSpace(8, 1000, 1000, 400, limit)).toBe(50);
  });
});

const rect = (styles?: object, ignoreEvent?: boolean): OverlayFigure => ({ type: "rect", attrs: { x: 10, y: 20, width: 30, height: 40 }, styles, ignoreEvent });

describe("see-through areas", () => {
  it("tells a translucent fill or a bare outline from a solid mark", () => {
    expect(isSeeThrough(rect({ style: "stroke_fill", color: withAlpha("#2962ff", 0.12) }))).toBe(true);
    expect(isSeeThrough(rect({ style: "fill", color: withAlpha("#2962ff", 0.1) }))).toBe(true);
    expect(isSeeThrough({ type: "circle", attrs: { x: 0, y: 0, r: 5 }, styles: { style: "stroke", borderColor: "#2962ff" } })).toBe(true);
    expect(isSeeThrough(rect())).toBe(true);
    expect(isSeeThrough({ type: "polygon", attrs: { coordinates: [] }, styles: { style: "fill", color: "#16a34a" } })).toBe(false);
    expect(isSeeThrough(rect({ style: "fill", color: withAlpha("#2962ff", 0.2) }, true))).toBe(false);
    expect(isSeeThrough({ type: "line", attrs: { coordinates: [] } })).toBe(false);
  });

  it("outlines only what draws a border", () => {
    expect(hasOutline(rect({ style: "stroke_fill" }))).toBe(true);
    expect(hasOutline(rect())).toBe(true);
    expect(hasOutline(rect({ style: "fill" }))).toBe(false);
  });

  it("leaves a handle alone, however see-through its ring", () => {
    expect(isSeeThrough({ key: "handle:x0", type: "circle", attrs: { x: 0, y: 0, r: 6 }, styles: { style: "fill", color: withAlpha("#2962ff", 0.35) } })).toBe(false);
  });

  it("closes the outline of each shape", () => {
    expect(outlineOf(rect())).toEqual([
      [
        { x: 10, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 60 },
        { x: 10, y: 60 },
        { x: 10, y: 20 },
      ],
    ]);
    const tri = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 3 },
    ];
    expect(outlineOf({ type: "polygon", attrs: [{ coordinates: tri }, { coordinates: tri }] })).toEqual([[...tri, tri[0]], [...tri, tri[0]]]);
    const [ring] = outlineOf({ type: "circle", attrs: { x: 5, y: 5, r: 2 } });
    for (const c of ring) expect(Math.hypot(c.x - 5, c.y - 5)).toBeCloseTo(2);
    expect(ring[0].x).toBeCloseTo(ring.at(-1)!.x);
  });
});
