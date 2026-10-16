/**
 * When the unfinished bar of a timeframe closes, for the countdown under the last price (design
 * §5.2), TradingView's way. Pure, shared by the server's tests and the chart.
 */
import { bucketStart } from "./series";
import type { QuoteSession } from "./sources/types";
import type { Timeframe } from "./symbols";
import { dayOf, partsIn, zonedToUtc, type Parts } from "./tz";

/** The quote poller's round (src/lib/quotes.ts); pre-market, after-hours and closed markets are asked hourly. */
export const QUOTE_ROUND_MS = 5 * 60 * 1000;
export const QUOTE_SLOW_MS = 60 * 60 * 1000;

/** Whether polling still keeps a quote current: three rounds for open markets and crypto, an hour and two rounds otherwise. */
export function quoteIsCurrent(session: QuoteSession, fetchedAt: number, now: number): boolean {
  return now - fetchedAt < (session === "open" || session === "always" ? 3 * QUOTE_ROUND_MS : QUOTE_SLOW_MS + 2 * QUOTE_ROUND_MS);
}

/**
 * When an instrument trades, as its source describes it (TradingView's notation, kept as it comes):
 * the regular session on the exchange's clock, the days without trading and the days with other
 * hours. Everything may be missing; what is known is used.
 */
export interface TradingCalendar {
  /**
   * `0930-1600`, `24x7`, or more: several sessions a day (`,`, `S` or `U` between them, the last
   * one closes the day), auction windows after `A` and `E`, other hours for some days after `|`,
   * each with its days after `:` (1 = Sunday; Monday to Friday when left out), and earlier
   * versions of all that before `#YYYYMMDD/` (the hours until that day).
   */
  hours: string | null;
  timezone: string | null;
  /** Days without trading: `20261126,20261225` */
  holidays: string | null;
  /** Days with other hours, which win over the holidays: `0930-1300:20261127,20261224;dayoff:20250109` */
  corrections: string | null;
}

export interface SessionClock extends TradingCalendar {
  /** The last quote's session while it is current, and when that quote was taken (ms) */
  session: QuoteSession | null;
  quotedAt: number | null;
}

const weekday = (p: Parts) => new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
const ymd = (p: Parts) => `${p.y}${String(p.m).padStart(2, "0")}${String(p.d).padStart(2, "0")}`;
const sameOrAfter = (a: Parts, b: Parts) => ymd(a) >= ymd(b);

/**
 * The sessions of one day (`0930-1600`, `0930-1130,1300-1500`), or null when there is no trading:
 * a correction for that date first (`dayoff` shuts it), then the holidays, then the regular hours
 * for its weekday, where hours that name the day win over the ones that cover it by default.
 */
export function sessionsOn({ hours, holidays, corrections }: TradingCalendar, day: Parts): string | null {
  if (hours === "24x7") return hours;
  const date = ymd(day);
  for (const entry of corrections ? corrections.split(";") : []) {
    const at = entry.lastIndexOf(":");
    if (entry.slice(at + 1).split(",").includes(date)) return entry.startsWith("dayoff") ? null : entry.slice(0, at);
  }
  if (!hours || holidays?.split(",").includes(date)) return null;
  // `A#20260803/B`: A until that day, B from it on
  const versions = hours.split("/");
  const version = versions.find((v) => (/#(\d{8})$/.exec(v)?.[1] ?? "99999999") > date) ?? versions[versions.length - 1];
  const dow = weekday(day);
  const parts = version.replace(/#\d{8}$/, "").split("|").map((part) => ({ part: part.replace(/:\d+$/, ""), days: /:(\d+)$/.exec(part)?.[1] }));
  return (parts.find((p) => p.days?.includes(String(dow + 1))) ?? parts.find((p) => !p.days && dow >= 1 && dow <= 5))?.part ?? null;
}

/**
 * Whether the market has sessions on Saturday or Sunday by its current hours (around the clock, or
 * a day named in them), or null while its hours are not known. Holidays and earlier hours do not count.
 */
export function weekendTrading({ hours }: TradingCalendar): boolean | null {
  if (!hours) return null;
  if (hours === "24x7") return true;
  // the last version is the current one; `:` names days, 1 = Sunday and 7 = Saturday
  return hours.split("/").at(-1)!.split("|").some((part) => /:\d*[17]\d*$/.test(part));
}

/** The clock time a day's last session ends, or null when the day has no trading (or hours that do not parse). */
export function closeOn(calendar: TradingCalendar, day: Parts): { hh: number; mm: number } | null {
  const m = /^\d{4}(?:F\d*)?-(\d{2})(\d{2})/.exec(sessionsOn(calendar, day)?.split(/[,SU]/).at(-1) ?? "");
  return m ? { hh: Number(m[1]), mm: Number(m[2]) } : null;
}

/** The start of the next UTC day, three days, week (Monday), month or quarter after `now`. */
function nextUtcBucket(now: number, tf: Timeframe): number {
  const d = new Date(now);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  if (tf === "D") return Date.UTC(y, m, day + 1);
  if (tf === "3D") return (bucketStart(Date.UTC(y, m, day) / 1000, tf, true) + 3 * 86400) * 1000;
  if (tf === "W") return Date.UTC(y, m, day + 7 - ((d.getUTCDay() + 6) % 7));
  return tf === "M" ? Date.UTC(y, m + 1, 1) : Date.UTC(y, Math.floor(m / 3) * 3 + 3, 1);
}

/** Unix seconds at UTC midnight of a day. */
const secondsOf = (p: Parts) => Date.UTC(p.y, p.m - 1, p.d) / 1000;

/** The last day of the 3D bar (three weekdays, the weekend after a Friday with it) a day is in. */
function lastOfThreeDays(day: Parts): Parts {
  const start = bucketStart(secondsOf(day), "3D");
  let last = day;
  while (bucketStart(secondsOf(dayOf(last, 1)), "3D") === start) last = dayOf(last, 1);
  return last;
}

/** The last day with trading in the 3D bar, week (Monday to Sunday), month or quarter a trading day is in: holidays and weekends at the end are stepped over. */
function lastTradingDay(calendar: TradingCalendar, day: Parts, tf: Timeframe): Parts {
  if (tf === "D") return day;
  const endMonth = tf === "M" ? day.m : Math.floor((day.m - 1) / 3) * 3 + 3;
  // day 0 of the next month is the last day of this one
  let last = tf === "3D" ? lastOfThreeDays(day) : tf === "W" ? dayOf(day, (7 - weekday(day)) % 7) : dayOf({ ...day, m: endMonth + 1, d: 0 });
  while (!sameOrAfter(day, last) && !closeOn(calendar, last)) last = dayOf(last, -1);
  return last;
}

/** How far ahead the next trading day is looked for: longer than any run of holidays. */
const LOOKAHEAD_DAYS = 14;

/**
 * When the bar of `tf` that is forming now closes (ms), or null when there is nothing to count
 * down to: no quote that is still current, the market is not in its regular session, or its hours
 * are unknown. Around the clock (crypto) bars end with the UTC day, three days, week, month or
 * quarter. An exchange's daily bar ends at the first close after the quote, at the earlier time on
 * a half day; a 3D, weekly, monthly or quarterly one at the close of the period's last day with
 * trading.
 * Without holidays and corrections every weekday counts as a full trading day.
 */
export function barCloseAt(tf: Timeframe, now: number, clock: SessionClock): number | null {
  const { session, quotedAt, hours, timezone } = clock;
  // judged here too, not only by the server: a page that cannot reach it stops counting on its own
  if (session === null || quotedAt === null || !quoteIsCurrent(session, quotedAt, now)) return null;
  if (session === "always" || (session === "open" && hours === "24x7")) return nextUtcBucket(now, tf);
  if (session !== "open" || !hours || !timezone) return null;
  const closeAt = (day: Parts) => {
    const end = closeOn(clock, day);
    return end ? zonedToUtc({ ...day, ...end }, timezone) : null;
  };
  // the session is the quote's: counted from when it was taken, so a close that has passed since ends the countdown
  let day = dayOf(partsIn(new Date(quotedAt), timezone));
  for (let i = 0; (closeAt(day) ?? 0) <= quotedAt; i++, day = dayOf(day, 1)) if (i === LOOKAHEAD_DAYS) return null;
  // the sessions that close on `day` may be an earlier day's bar (from two evenings back after a
  // holiday): when that day is in an earlier 3D bar, week, month or quarter, they end it
  const sameBar = bucketStart(secondsOf(barDayOf(clock, day)), tf) === bucketStart(secondsOf(day), tf);
  const close = closeAt(sameBar ? lastTradingDay(clock, day, tf) : day)!;
  return close > now ? close : null;
}

/**
 * When the daily bar of trading day `t` (unix seconds at UTC midnight) is complete (ms): the end
 * of the UTC day around the clock, the close of that day's session at an exchange (the earlier one
 * on a half day), and the end of the day on the exchange's calendar while its hours are not known.
 * A bar on a day the calendar calls a holiday did trade: its regular hours count.
 */
export function dayCloseAt(t: number, calendar: TradingCalendar): number {
  if (calendar.hours === "24x7") return (t + 86400) * 1000;
  const day = dayOf(partsIn(new Date(t * 1000), "UTC"));
  const end = closeOn(calendar, day) ?? closeOn({ ...calendar, holidays: null, corrections: null }, day);
  return zonedToUtc(end ? { ...day, ...end } : dayOf(day, 1), calendar.timezone ?? "UTC");
}

/**
 * When a day's sessions begin on the evening before (`1700-1600`, `1700-1700`, a start marked `F`):
 * that clock time, and how many days before (`1700F2-…` after a holiday: two).
 */
function eveningStart(sessions: string | null): { hh: number; mm: number; back: number } | null {
  const m = /^(\d{2})(\d{2})(F\d*)?-(\d{4})/.exec(sessions ?? "");
  return m && (m[3] !== undefined || m[1] + m[2] >= m[4]) ? { hh: Number(m[1]), mm: Number(m[2]), back: Number(m[3]?.slice(1) || 1) } : null;
}

/**
 * The session to assume when a source's quote does not say: open on a day with trading, closed on
 * a weekend or a holiday. The day is the trading day by the exchange's clock: an overnight session
 * counts for the day it ends on, from the evening it starts (Sunday evening is Monday's, the
 * evening of a holiday the next day's) until its close (Friday evening is nobody's). A day
 * session keeps its whole calendar day. Without known hours weekdays count as trading.
 */
export function scheduledSession(now: number, calendar: TradingCalendar): QuoteSession {
  const timezone = calendar.timezone ?? "UTC";
  const today = dayOf(partsIn(new Date(now), timezone));
  if (!calendar.hours) return weekday(today) >= 1 && weekday(today) <= 5 ? "open" : "closed";
  const passed = (clock: { hh: number; mm: number } | null) => clock !== null && zonedToUtc({ ...today, ...clock }, timezone) <= now;
  if (passed(eveningStart(sessionsOn(calendar, dayOf(today, 1))))) return "open";
  const sessions = sessionsOn(calendar, today);
  if (sessions === null || (eveningStart(sessions) && passed(closeOn(calendar, today)))) return "closed";
  return "open";
}

/** The trading day whose bar a day's sessions make: that day, or the one before when they start two evenings back (`1700F2`). */
function barDayOf(calendar: TradingCalendar, day: Parts): Parts {
  return dayOf(day, 1 - (eveningStart(sessionsOn(calendar, day))?.back ?? 1));
}

/**
 * The day of the daily bar a trade at `at` (ms) belongs to, on the exchange's calendar. An
 * overnight session counts for the day it ends on: the trade is in the nearest coming day's
 * sessions that have begun, the evening before or, across a holiday, days before. So is one on a
 * day of the week without sessions (Sunday, a little before the stated start). When no coming
 * session has begun, the trade is a late print after the close and stays where it is (Friday
 * evening, the evening before a holiday). A day session keeps its calendar day.
 *
 * The bar is stored under the day after the evening it starts on (`tradingDay()` of its time), which
 * across a holiday is not the day the sessions end on: Tuesday's `1800F2-1430F1,1800-1700` after a
 * Monday holiday is one bar from Sunday evening, stored as Monday.
 */
export function tradingDayAt(at: number, calendar: TradingCalendar): Parts {
  const timezone = calendar.timezone ?? "UTC";
  const today = dayOf(partsIn(new Date(at), timezone));
  const startOf = (day: Parts) => eveningStart(sessionsOn(calendar, day));
  const barDay = (day: Parts) => barDayOf(calendar, day);
  // `F6` is as far back as a start goes
  for (let ahead = 1; ahead <= 6; ahead++) {
    const day = dayOf(today, ahead);
    const start = startOf(day);
    if (start && zonedToUtc({ ...dayOf(day, -start.back), hh: start.hh, mm: start.mm }, timezone) <= at) return barDay(day);
  }
  // by the week's hours alone: a bar on a day the calendar calls a holiday did trade
  const idle = sessionsOn({ ...calendar, holidays: null, corrections: null }, today) === null;
  return barDay(idle && startOf(dayOf(today, 1)) ? dayOf(today, 1) : today);
}

/** TradingView's countdown: `2d 5h` from a day up, `05:12:09` from an hour up, else `12:09`. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  const rest = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return s >= 3600 ? `${two(Math.floor(s / 3600))}:${rest}` : rest;
}
