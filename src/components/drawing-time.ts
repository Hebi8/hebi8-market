/** Daily positions outside the loaded bars; type-only imports keep the math usable without a chart. */
import type { KLineData } from "klinecharts";

const DAY = 86400000;

/** A weekend bar in the last sixty sessions means this series also trades on weekends. */
export function tradesWeekends(bars: Pick<KLineData, "timestamp">[]): boolean {
  return bars.slice(-60).some(({ timestamp }) => {
    const day = new Date(timestamp).getUTCDay();
    return day === 0 || day === 6;
  });
}

/** Integer offsets land on trading days; fractions interpolate between those days, as inside the data. */
export function tradingDayTimestamp(anchor: number, offset: number, weekends: boolean): number {
  if (weekends) return Math.round(anchor + offset * DAY);
  const weekday = (new Date(anchor).getUTCDay() + 6) % 7;
  const at = (n: number) => {
    const weeks = Math.floor(n / 5);
    const rest = n - weeks * 5;
    return anchor + (weeks * 7 + rest + (weekday + rest >= 5 ? 2 : 0)) * DAY;
  };
  const whole = Math.floor(offset);
  const start = at(whole);
  return Math.round(start + (offset - whole) * (at(whole + 1) - start));
}

/** The inverse, including the continuous space between Friday and Monday. */
export function tradingDayOffset(anchor: number, timestamp: number, weekends: boolean): number {
  if (weekends) return (timestamp - anchor) / DAY;
  const ordinal = (t: number) => {
    // Monday, 1970-01-05 is weekday zero; weekends belong to the preceding Friday.
    const days = Math.floor(t / DAY) - 4;
    const weeks = Math.floor(days / 7);
    return weeks * 5 + Math.min(days - weeks * 7, 4);
  };
  const whole = ordinal(timestamp) - ordinal(anchor);
  const start = tradingDayTimestamp(anchor, whole, false);
  const end = tradingDayTimestamp(anchor, whole + 1, false);
  return whole + (timestamp - start) / (end - start);
}
