/**
 * TradingView's price alert conditions (design §2.6), on daily bars whose last one may be today's
 * unfinished bar built from the latest quote. Pure, so the chart's alert dialog uses it too.
 */
import type { Bar } from "./series";

export const ALERT_CONDS = {
  crossing: { label: "穿过", kind: "event", value: "price" },
  crossing_up: { label: "上穿", kind: "event", value: "price" },
  crossing_down: { label: "下穿", kind: "event", value: "price" },
  greater: { label: "大于", kind: "state", value: "price" },
  less: { label: "小于", kind: "state", value: "price" },
  entering: { label: "进入通道", kind: "event", value: "channel" },
  exiting: { label: "离开通道", kind: "event", value: "channel" },
  inside: { label: "在通道内", kind: "state", value: "channel" },
  outside: { label: "在通道外", kind: "state", value: "channel" },
  moving_up_pct: { label: "上涨 %", kind: "state", value: "move" },
  moving_down_pct: { label: "下跌 %", kind: "state", value: "move" },
} as const;

export type AlertCond = keyof typeof ALERT_CONDS;
type CondsWith<V> = { [C in AlertCond]: (typeof ALERT_CONDS)[C]["value"] extends V ? C : never }[AlertCond];

export type AlertCondition =
  | { cond: CondsWith<"price">; value: number }
  | { cond: CondsWith<"channel">; value: [number, number] }
  | { cond: CondsWith<"move">; value: { pct: number; bars: number } };

export const isAlertCond = (v: unknown): v is AlertCond => typeof v === "string" && v in ALERT_CONDS;

/** What an alert without a key covers: every watched symbol. */
export const WATCHLIST = "全部自选";

/** The alerts panel's order: the open chart's alerts first, then the others (the whole watchlist's among them), each in yaml order. */
export function currentFirst<T extends { key: string | null }>(alerts: T[], current: string): T[] {
  return [...alerts.filter((a) => a.key === current), ...alerts.filter((a) => a.key !== current)];
}

/** `once` disables the alert after it fires; `bar` fires at most once per daily bar. */
export type AlertTrigger = "once" | "bar";

/** When an alert is judged: on the live price after every quote round, or on closed daily bars after a daily sync. */
export type AlertCheck = "price" | "close";
export const ALERT_CHECKS: Record<AlertCheck, string> = { price: "盘中价格", close: "日线收盘" };
/** What an alert does when its `check` is left out: one on a symbol follows the price, one on the whole watchlist waits for the close. */
export const defaultCheck = (key: string | null): AlertCheck => (key ? "price" : "close");

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The yaml's `cond` + `value`, checked; throws with a message that names what is wrong. */
export function parseCondition(cond: unknown, value: unknown): AlertCondition {
  if (!isAlertCond(cond)) throw new Error(`未知的条件「${String(cond)}」`);
  switch (ALERT_CONDS[cond].value) {
    case "price": {
      const v = finite(value);
      if (v === null) throw new Error(`${cond} 的 value 应是一个价格`);
      return { cond, value: v } as AlertCondition;
    }
    case "channel": {
      const [a, b] = Array.isArray(value) && value.length === 2 ? value.map(finite) : [null, null];
      if (a === null || b === null) throw new Error(`${cond} 的 value 应是 [低, 高]`);
      return { cond, value: [Math.min(a, b), Math.max(a, b)] } as AlertCondition;
    }
    case "move": {
      const m = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const pct = finite(m.pct);
      const bars = finite(m.bars);
      if (pct === null || pct <= 0 || bars === null || bars < 1 || !Number.isInteger(bars)) throw new Error(`${cond} 的 value 应是 { pct: 正数, bars: 正整数 }`);
      return { cond, value: { pct, bars } } as AlertCondition;
    }
  }
}

export const fmtNumber = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 8 });

/** 「上穿 130,000」, 「进入通道 500 ~ 520」, 「5 根 K 线内上涨 3%」 */
export function describeCondition(c: AlertCondition): string {
  const label = ALERT_CONDS[c.cond].label;
  if (c.cond === "moving_up_pct" || c.cond === "moving_down_pct") {
    return `${c.value.bars} 根 K 线内${c.cond === "moving_up_pct" ? "上涨" : "下跌"} ${fmtNumber(c.value.pct)}%`;
  }
  if (Array.isArray(c.value)) return `${label} ${fmtNumber(c.value[0])} ~ ${fmtNumber(c.value[1])}`;
  return `${label} ${fmtNumber(c.value as number)}`;
}

/** The price levels to draw on the chart: one line, two for a channel, none for a move. */
export function conditionLevels(c: AlertCondition): number[] {
  if (Array.isArray(c.value)) return c.value;
  return typeof c.value === "number" ? [c.value] : [];
}

/**
 * What one check sees. Events record a position, compared with the previous check's: for a line
 * -1 below, 0 on it, 1 above; for a channel -1 outside, 0 on an edge, 1 strictly inside. States
 * record whether they hold (0/1). Null when there is no data.
 */
export function observe(c: AlertCondition, bars: Bar[]): number | null {
  const last = bars.at(-1);
  if (!last) return null;
  const p = last.c;
  const bit = (b: boolean) => (b ? 1 : 0);
  switch (c.cond) {
    case "crossing":
    case "crossing_up":
    case "crossing_down":
      return Math.sign(p - c.value);
    case "entering":
    case "exiting": {
      const [lo, hi] = c.value;
      return p > lo && p < hi ? 1 : p === lo || p === hi ? 0 : -1;
    }
    case "greater":
      return bit(p > c.value);
    case "less":
      return bit(p < c.value);
    case "inside":
      return bit(p >= c.value[0] && p <= c.value[1]);
    case "outside":
      return bit(p < c.value[0] || p > c.value[1]);
    case "moving_up_pct":
    case "moving_down_pct": {
      const base = bars.at(-1 - c.value.bars)?.c;
      if (!base) return null;
      // rounded so 100 → 110 is exactly 10%, not 9.999…
      const change = Math.round((p / base - 1) * 1e10) / 1e8;
      return bit(c.cond === "moving_up_pct" ? change >= c.value.pct : change <= -c.value.pct);
    }
  }
}

/**
 * For events, the same strict rule as the formula's `cross()`: 上穿 is above the line now and on or
 * below it before, 下穿 the reverse, 穿过 either. 进入通道 is strictly inside now and not before;
 * 离开通道 strictly outside now and not before. Sitting on a line or an edge fires nothing.
 */
export function crossed(cond: AlertCond, prev: number, now: number): boolean {
  switch (cond) {
    case "crossing":
      return (now > 0 && prev <= 0) || (now < 0 && prev >= 0);
    case "crossing_up":
      return now > 0 && prev <= 0;
    case "crossing_down":
      return now < 0 && prev >= 0;
    case "entering":
      return now > 0 && prev <= 0;
    case "exiting":
      return now < 0 && prev >= 0;
    default:
      return false;
  }
}
