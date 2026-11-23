/** Daily positions outside the loaded bars; type-only imports keep the math usable without a chart. */
const DAY = 86400000;

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

/** Integer offsets land on UTC years from `anchor`; fractions interpolate across that year's real length. */
export function yearTimestamp(anchor: number, offset: number): number {
  const a = new Date(anchor);
  const [y0, m, day] = [a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()];
  const rem = anchor - Date.UTC(y0, m, day);
  const at = (n: number) => Date.UTC(y0 + n, m, day) + rem;
  const whole = Math.floor(offset);
  const start = at(whole);
  return Math.round(start + (offset - whole) * (at(whole + 1) - start));
}

/** The inverse, in UTC years from `anchor`. */
export function yearOffset(anchor: number, timestamp: number): number {
  const a = new Date(anchor);
  const [y0, m, day] = [a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()];
  const rem = anchor - Date.UTC(y0, m, day);
  const at = (n: number) => Date.UTC(y0 + n, m, day) + rem;
  let whole = new Date(timestamp).getUTCFullYear() - y0;
  if (timestamp < at(whole)) whole--;
  else if (timestamp >= at(whole + 1)) whole++;
  const start = at(whole);
  return whole + (timestamp - start) / (at(whole + 1) - start);
}
