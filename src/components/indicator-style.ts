/**
 * An indicator's lines as the chart draws them once restyled (`chart.styles`, §5.2): KLineChart
 * takes line i of an indicator from `styles.lines[i % length]`, so the list covers every line.
 * Type-only imports, so it loads without KLineChart (which needs a window).
 */
import type { IndicatorFigure, SmoothLineStyle } from "klinecharts";
import type { LineOverride } from "@/lib/config";
import type { IndicatorLine } from "./chart-types";
import { DASHES, dashOf } from "./drawing-style";

type Figures = { figures: Pick<IndicatorFigure, "key" | "title" | "type">[]; regenerateFigures?: ((params: number[]) => Pick<IndicatorFigure, "key" | "title" | "type">[]) | null };

/**
 * The 样式 page's rows: the lines an indicator draws, by their legend titles, in KLineChart's
 * default look. With `params` (typed on the 输入 tab, not saved yet) the lines it would draw with
 * them, as KLineChart regenerates them: MA with five periods has five.
 */
export function styleRows(defaults: SmoothLineStyle[], ind: Figures, params?: number[]): IndicatorLine[] {
  const figures = params && ind.regenerateFigures ? ind.regenerateFigures(params) : ind.figures;
  return figures
    .filter((f) => f.type === "line")
    .map((f, i) => {
      const base = defaults[i % defaults.length];
      return { title: String(f.title ?? f.key).replace(/:\s*$/, ""), color: base.color, size: base.size, dash: dashOf(base) };
    });
}

/** `styles.lines` for an indicator drawing `count` lines; null when none is restyled. */
export function indicatorLines(defaults: SmoothLineStyle[], own: LineOverride[] | undefined, count: number): SmoothLineStyle[] | null {
  if (!own?.length) return null;
  return Array.from({ length: Math.max(count, own.length) }, (_, i) => {
    const base = defaults[i % defaults.length];
    const { color, size, dash } = own[i] ?? {};
    return {
      ...base,
      ...(color ? { color } : {}),
      ...(size ? { size } : {}),
      ...(dash ? { style: dash === "solid" ? "solid" : "dashed", dashedValue: dash === "solid" ? base.dashedValue : DASHES[dash] } : {}),
    };
  });
}
