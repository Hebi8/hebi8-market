import type { IndicatorTemplate } from "klinecharts";
import type { FormulaDef } from "@/lib/config";
import { compile, evaluate, FormulaError, type CompileOptions, type Program, type RefSeries } from "./formula";

const PREFIX = "F_";
export const formulaIndicatorName = (id: string) => `${PREFIX}${id}`;
export const isFormulaIndicator = (name: string) => name.startsWith(PREFIX);

export function newFormulaId(): string {
  return `f${Math.random().toString(36).slice(2, 8)}`;
}

export function describeError(err: unknown): string {
  if (err instanceof FormulaError) return err.pos === undefined ? err.message : `${err.message}（第 ${err.pos + 1} 个字符）`;
  return err instanceof Error ? err.message : String(err);
}

export function compileFormula(source: string, opts: CompileOptions): { program: Program; error: null } | { program: null; error: string } {
  try {
    return { program: compile(source, opts), error: null };
  } catch (err) {
    return { program: null, error: describeError(err) };
  }
}

type Point = Record<string, number | undefined>;

/** KLineChart template for a compiled formula; `refs` are the aligned symbols it reads. */
export function formulaTemplate(
  def: FormulaDef,
  program: Program,
  refs: Record<string, RefSeries>,
  yearOpens?: Record<number, number>,
): IndicatorTemplate<Point> {
  return {
    name: formulaIndicatorName(def.id),
    shortName: def.label,
    // overlays share the price axis and its precision; sub-pane values are usually ratios
    series: def.pane === "main" ? "price" : "normal",
    precision: 2,
    calcParams: [],
    figures: program.outputs.map((title, i) => ({ key: `v${i}`, title: `${title}: `, type: "line" })),
    calc: (dataList) => {
      const lines = evaluate(program, { bars: dataList, refs, yearOpens });
      return dataList.map((_, i) => {
        const point: Point = {};
        lines.forEach((line, j) => {
          point[`v${j}`] = Number.isFinite(line[i]) ? line[i] : undefined;
        });
        return point;
      });
    },
  };
}

export const FORMULA_EXAMPLES: Omit<FormulaDef, "id">[] = [
  { label: "均线乖离", formula: "(close / sma(close, 40) - 1) * 100", pane: "sub" },
  { label: "双 EMA", formula: "fast = ema(close, 10)\nslow = ema(close, 40)", pane: "main" },
  { label: "对基准比价", formula: "close / close(bench)", pane: "sub" },
  { label: "唐奇安通道", formula: "upper = highest(high, 20)\nlower = lowest(low, 20)", pane: "main" },
  { label: "趋势", formula: "close > sma(close, 40) and sma(close, 10) > sma(close, 40)", pane: "sub" },
];
