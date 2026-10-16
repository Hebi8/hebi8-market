/**
 * An indicator's lines as the chart draws them once restyled (`chart.styles`, §5.2): KLineChart
 * takes line i of an indicator from `styles.lines[i % length]`, so the list covers every line.
 * Type-only imports, so it loads without KLineChart (which needs a window).
 */
import type { SmoothLineStyle } from "klinecharts";
import type { LineOverride } from "@/lib/config";
import { DASHES } from "./drawing-style";

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
