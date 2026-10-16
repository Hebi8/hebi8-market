import type { Timeframe } from "@/lib/symbols";

export interface IndicatorDef {
  /** KLineChart indicator name, built-in or registered in ./custom.ts */
  name: string;
  label: string;
  pane: "main" | "sub";
  /** Default calcParams per timeframe, tuned for long-term viewing */
  params: Record<Timeframe, number[]>;
  needsBenchmark?: boolean;
  /** The params may be left empty (and are by default), so the settings dialog still offers the input */
  optionalParams?: boolean;
  hint: string;
  /** Decimals on the indicator's axis and legend, overriding KLineChart's default */
  precision?: number;
}

const same = (p: number[]): Record<Timeframe, number[]> => ({ D: p, "3D": p, W: p, M: p, Q: p });

export const INDICATORS: IndicatorDef[] = [
  {
    name: "MA",
    label: "均线",
    pane: "main",
    // 10/40 weeks ≈ 50/200 days; 200 weeks is the classic BTC cycle line
    params: { D: [20, 50, 200], "3D": [20, 50, 200], W: [10, 40, 200], M: [10, 20], Q: [4, 12] },
    hint: "简单移动平均",
  },
  { name: "EMA", label: "EMA", pane: "main", params: { D: [21, 55], "3D": [21, 55], W: [21, 55], M: [12, 24], Q: [8, 20] }, hint: "指数移动平均" },
  { name: "BOLL", label: "布林", pane: "main", params: same([20, 2]), hint: "周期, 标准差倍数" },
  // TradingView's Volume has no moving average until one is asked for in its settings
  { name: "VOL", label: "成交量", pane: "sub", params: same([]), optionalParams: true, hint: "成交量均线周期（如 20），留空不画均线" },
  { name: "MACD", label: "MACD", pane: "sub", params: same([12, 26, 9]), hint: "快线, 慢线, 信号线" },
  { name: "RSI", label: "RSI", pane: "sub", params: same([14]), hint: "周期", precision: 2 },
  { name: "DD", label: "回撤", pane: "sub", params: same([]), hint: "距历史最高收盘价的跌幅（无参数）" },
  {
    name: "RS",
    label: "相对强弱",
    pane: "sub",
    params: { D: [50], "3D": [50], W: [26], M: [12], Q: [8] },
    needsBenchmark: true,
    hint: "相对基准的强弱线，参数为均线周期",
  },
];

export function findIndicator(name: string): IndicatorDef | undefined {
  return INDICATORS.find((d) => d.name === name);
}
