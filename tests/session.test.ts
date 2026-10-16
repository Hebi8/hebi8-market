import { describe, expect, it } from "vitest";
import { barCloseAt, closeOn, weekendTrading, dayCloseAt, fmtCountdown, quoteIsCurrent, scheduledSession, sessionsOn, tradingDayAt, type SessionClock, type TradingCalendar } from "@/lib/session";

const utc = (s: string) => Date.parse(`${s}Z`);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 16));
const day = (y: number, m: number, d: number) => ({ y, m, d, hh: 0, mm: 0 });
/** Hours alone: no holidays or half days known. */
const plain = (hours: string | null, timezone: string | null): TradingCalendar => ({ hours, timezone, holidays: null, corrections: null });
/** The end of a day's last session with nothing but the hours known, by weekday (2026-10-04 is a Sunday). */
const sessionEnd = (hours: string, weekday: number) => closeOn(plain(hours, null), day(2026, 10, 4 + weekday));

// As TradingView's symbol info had them on 2026-10-10, cut to 2025 and later like `calendarOf` does.
const US_HOLIDAYS =
  "20250101,20250120,20250217,20250418,20250526,20250619,20250704,20250901,20251127,20251225,20260101,20260119,20260216,20260403,20260525,20260619,20260703,20260907,20261126,20261225,20270101,20270118,20270215,20270326,20270531,20270618,20270705,20270906,20271125,20271224";
const NASDAQ: TradingCalendar = { hours: "0930-1600", timezone: "America/New_York", holidays: US_HOLIDAYS, corrections: "0930-1300:20250703,20251128,20251224,20261127,20261224,20271126,20271223;dayoff:20250109" };
const ES: TradingCalendar = {
  hours: "1700-1600",
  timezone: "America/Chicago",
  holidays: US_HOLIDAYS,
  corrections:
    "1700-0815:20260403;1700-0830:20250109;1700-1215:20250703,20251224,20261224;1700F2-1200F1,1700-1215:20251128,20261127;1700F2-1200F1,1700-1600:20250121,20250218,20250527,20250620,20250902,20260120,20260217,20260526,20260908;1700F4-1200F3,1700-1600:20250707,20260622,20260706",
};
const DXY: TradingCalendar = {
  hours: "1900-1900:3456|1700F-1900:2",
  timezone: "America/New_York",
  holidays: US_HOLIDAYS,
  corrections: "1700F-1900:20250120,20250217,20250526,20250901,20260119,20260216,20260525,20260907;1900-1900:20250619,20250704,20251127,20260403,20260619,20260703,20261126",
};
const HKEX: TradingCalendar = {
  hours: "0930-1200A0900E0920-1206U1300-1600E1300-1611",
  timezone: "Asia/Hong_Kong",
  holidays: "20260101,20260217,20260218,20260219,20260403,20260406,20260407,20260501,20260525,20260619,20260701,20261001,20261019,20261225",
  corrections: "",
};
const open = (calendar: TradingCalendar, at: string): SessionClock => ({ ...calendar, session: "open", quotedAt: utc(at) });

describe("the countdown to the bar's close", () => {
  it("around the clock, bars end with the UTC day, the week on Monday, the month and the quarter", () => {
    const now = utc("2026-10-07T13:20:00"); // a Wednesday
    const crypto: SessionClock = { ...plain("24x7", "UTC"), session: "always", quotedAt: now - 60_000 };
    expect(iso(barCloseAt("D", now, crypto))).toBe("2026-10-08T00:00");
    expect(iso(barCloseAt("W", now, crypto))).toBe("2026-10-12T00:00");
    expect(iso(barCloseAt("M", now, crypto))).toBe("2026-11-01T00:00");
    expect(iso(barCloseAt("Q", now, crypto))).toBe("2027-01-01T00:00");
    // three calendar days from Monday 1970-01-05: this one runs from Monday 10-05 to Wednesday 10-07
    expect(iso(barCloseAt("3D", now, crypto))).toBe("2026-10-08T00:00");
    expect(iso(barCloseAt("3D", utc("2026-10-08T00:00:01"), { ...crypto, quotedAt: utc("2026-10-08T00:00:00") }))).toBe("2026-10-11T00:00");
    // TradingView's 24x7 symbols report an ordinary open session
    expect(iso(barCloseAt("D", now, { ...plain("24x7", "Etc/UTC"), session: "open", quotedAt: now }))).toBe("2026-10-08T00:00");
  });

  it("an exchange's bar ends at its close: today, on Friday, on the last weekday of the month or quarter", () => {
    const now = utc("2026-10-07T15:00:00"); // Wednesday 11:00 in New York
    const nyse: SessionClock = { ...plain("0930-1600", "America/New_York"), session: "open", quotedAt: now - 120_000 };
    expect(iso(barCloseAt("D", now, nyse))).toBe("2026-10-07T20:00");
    expect(iso(barCloseAt("W", now, nyse))).toBe("2026-10-09T20:00");
    expect(iso(barCloseAt("M", now, nyse))).toBe("2026-10-30T20:00"); // Oct 31 is a Saturday
    // winter time by then: 16:00 in New York is 21:00 UTC
    expect(iso(barCloseAt("Q", now, nyse))).toBe("2026-12-31T21:00");
    // three weekdays from Monday 1970-01-05: Monday 10-05 to Wednesday 10-07, then Thursday to Monday 10-12
    expect(iso(barCloseAt("3D", now, nyse))).toBe("2026-10-07T20:00");
    const friday = { ...nyse, quotedAt: utc("2026-10-09T15:00:00") };
    expect(iso(barCloseAt("3D", utc("2026-10-09T15:01:00"), friday))).toBe("2026-10-12T20:00");
    // a lunch break: the last session closes the day
    const sse: SessionClock = { ...plain("0930-1130,1300-1500", "Asia/Shanghai"), session: "open", quotedAt: utc("2026-10-09T02:00:00") };
    expect(iso(barCloseAt("D", utc("2026-10-09T02:01:00"), sse))).toBe("2026-10-09T07:00");
  });

  it("an overnight session closes on the trading day it belongs to", () => {
    // Sunday 18:30 in Chicago: Monday's session of a future that trades 17:00 to 16:00
    const now = utc("2026-10-04T23:30:00");
    const cme: SessionClock = { ...plain("1700-1600", "America/Chicago"), session: "open", quotedAt: now };
    expect(iso(barCloseAt("D", now, cme))).toBe("2026-10-05T21:00");
    expect(iso(barCloseAt("W", now, cme))).toBe("2026-10-09T21:00");
  });

  it("shows nothing outside the regular session, without a current quote, without hours, or once the close has passed", () => {
    const now = utc("2026-10-07T15:00:00");
    const nyse: SessionClock = { ...plain("0930-1600", "America/New_York"), session: "open", quotedAt: now };
    for (const session of ["pre", "post", "closed", null] as const) expect(barCloseAt("D", now, { ...nyse, session })).toBeNull();
    expect(barCloseAt("D", now, { ...nyse, hours: null })).toBeNull();
    expect(barCloseAt("D", now, { ...nyse, timezone: null })).toBeNull();
    // the last quote said open at 15:58; at 16:01 the bar is done, not counting to tomorrow's close
    expect(barCloseAt("D", utc("2026-10-07T20:01:00"), { ...nyse, quotedAt: utc("2026-10-07T19:58:00") })).toBeNull();
  });

  it("stops on its own once the quote is no longer current, whatever the page last heard", () => {
    const now = utc("2026-10-07T15:00:00");
    const nyse: SessionClock = { ...plain("0930-1600", "America/New_York"), session: "open", quotedAt: now };
    const crypto: SessionClock = { ...plain("24x7", "UTC"), session: "always", quotedAt: now };
    for (const tf of ["D", "W", "M", "Q"] as const) {
      for (const clock of [nyse, crypto]) {
        expect(barCloseAt(tf, now + 14 * 60_000, clock)).not.toBeNull();
        expect(barCloseAt(tf, now + 16 * 60_000, clock)).toBeNull();
      }
    }
    expect(quoteIsCurrent("closed", now, now + 69 * 60_000)).toBe(true);
    expect(quoteIsCurrent("post", now, now + 71 * 60_000)).toBe(false);
  });

  it("takes the hours a session string gives for the weekday", () => {
    // a future that stops an hour early on Fridays (TradingView counts days from Sunday = 1)
    const cme = "1700-1600:2345|1700-1500:6";
    const at = (iso: string): SessionClock => open(plain(cme, "America/Chicago"), iso);
    // Thursday 10:00 in Chicago: today at 16:00; the week ends on Friday at 15:00
    expect(iso(barCloseAt("D", utc("2026-10-08T15:00:00"), at("2026-10-08T15:00:00")))).toBe("2026-10-08T21:00");
    expect(iso(barCloseAt("W", utc("2026-10-08T15:00:00"), at("2026-10-08T15:00:00")))).toBe("2026-10-09T20:00");
    // Thursday evening is Friday's session
    expect(iso(barCloseAt("D", utc("2026-10-08T23:00:00"), at("2026-10-08T23:00:00")))).toBe("2026-10-09T20:00");
    // the dollar index: Monday's session is spelled out apart from the other days'
    const dxy = "1900-1900:3456|1700F-1900:2";
    expect(sessionEnd(dxy, 1)).toEqual({ hh: 19, mm: 0 });
    expect(sessionEnd(dxy, 3)).toEqual({ hh: 19, mm: 0 });
    expect(sessionEnd(cme, 5)).toEqual({ hh: 15, mm: 0 });
    expect(sessionEnd(cme, 4)).toEqual({ hh: 16, mm: 0 });
    // a day by name wins over the hours that cover it by default
    expect(sessionEnd("0930-1600|0930-1300:6", 5)).toEqual({ hh: 13, mm: 0 });
    expect(sessionEnd("0930-1600|0930-1300:6", 2)).toEqual({ hh: 16, mm: 0 });
  });

  it("knows from the hours whether a market trades on weekends", () => {
    expect(weekendTrading(plain("24x7", "UTC"))).toBe(true);
    expect(weekendTrading(plain("0930-1600", "America/New_York"))).toBe(false);
    expect(weekendTrading(DXY)).toBe(false);
    // Sunday to Thursday, until it moved to Monday to Friday
    expect(weekendTrading(plain("0959-1725:12345", "Asia/Jerusalem"))).toBe(true);
    expect(weekendTrading(plain("0959-1725:12345#20260105/0959-1725", "Asia/Jerusalem"))).toBe(false);
    expect(weekendTrading(plain(null, null))).toBeNull();
  });

  it("reads the closing time of TradingView's session strings", () => {
    expect(sessionEnd("0930-1600", 3)).toEqual({ hh: 16, mm: 0 });
    expect(sessionEnd("0930-1130,1300-1500", 3)).toEqual({ hh: 15, mm: 0 });
    expect(sessionEnd("0930-1130E0925-1131S1300-1500E1300-1501", 3)).toEqual({ hh: 15, mm: 0 });
    expect(sessionEnd(HKEX.hours!, 3)).toEqual({ hh: 16, mm: 0 });
    expect(sessionEnd("0215-0826,0830-1516", 3)).toEqual({ hh: 15, mm: 16 });
    expect(sessionEnd("24x7", 3)).toBeNull();
    // no trading at the weekend unless the hours name the day
    expect(sessionEnd("0930-1600", 6)).toBeNull();
    expect(sessionEnd("0930-1600:1234567", 6)).toEqual({ hh: 16, mm: 0 });
    // earlier versions of the hours end on a date: NSE's close as TradingView has it around 2026-08-03
    const nse = plain("0915-1530#20260803/0915-1515", "Asia/Kolkata");
    expect(closeOn(nse, day(2026, 7, 31))).toEqual({ hh: 15, mm: 30 });
    expect(closeOn(nse, day(2026, 8, 3))).toEqual({ hh: 15, mm: 15 });
    // Brent in London time moves an hour while only one side of the Atlantic is on summer time
    const brent = plain("0100-2300|2300F-2300:2#20261026/0000-2200|2200F-2200:2#20261102/0100-2300|2300F-2300:2#20270315/0000-2200|2200F-2200:2", "Europe/London");
    expect(closeOn(brent, day(2026, 10, 23))).toEqual({ hh: 23, mm: 0 });
    expect(closeOn(brent, day(2026, 10, 27))).toEqual({ hh: 22, mm: 0 });
    expect(closeOn(brent, day(2026, 11, 3))).toEqual({ hh: 23, mm: 0 });
  });

  it("reads holidays and half days: a correction for the date first, then the holidays, then the weekday's hours", () => {
    // Thanksgiving, the half day after it, an ordinary Monday
    expect(sessionsOn(NASDAQ, day(2026, 11, 26))).toBeNull();
    expect(sessionsOn(NASDAQ, day(2026, 11, 27))).toBe("0930-1300");
    expect(closeOn(NASDAQ, day(2026, 11, 27))).toEqual({ hh: 13, mm: 0 });
    expect(closeOn(NASDAQ, day(2026, 11, 30))).toEqual({ hh: 16, mm: 0 });
    // a day off that is no holiday (the day of mourning in 2025)
    expect(sessionsOn(NASDAQ, day(2025, 1, 9))).toBeNull();
    // futures trade through most holidays: the correction wins, with its own close (Good Friday 08:15, the Friday after Thanksgiving 12:15)
    expect(closeOn(ES, day(2026, 4, 3))).toEqual({ hh: 8, mm: 15 });
    expect(closeOn(ES, day(2026, 11, 27))).toEqual({ hh: 12, mm: 15 });
    expect(sessionsOn(ES, day(2026, 11, 26))).toBeNull();
    // a session that started days before (`F2`) still ends on its own day
    expect(closeOn(ES, day(2026, 1, 20))).toEqual({ hh: 16, mm: 0 });
    // the dollar index on a holiday Monday: listed as a holiday, corrected to Monday-like hours
    expect(sessionsOn(DXY, day(2026, 1, 19))).toBe("1700F-1900");
    // Hong Kong: holidays only, no half days in the source
    expect(sessionsOn(HKEX, day(2026, 10, 19))).toBeNull();
    expect(closeOn(HKEX, day(2026, 12, 24))).toEqual({ hh: 16, mm: 0 });
  });

  it("a half day counts down to its early close, and the day's bar is complete then", () => {
    // Friday 2026-11-27, 10:00 in New York (15:00 UTC): closes at 13:00
    const friday = open(NASDAQ, "2026-11-27T15:00:00");
    expect(iso(barCloseAt("D", utc("2026-11-27T15:01:00"), friday))).toBe("2026-11-27T18:00");
    expect(iso(barCloseAt("W", utc("2026-11-27T15:01:00"), friday))).toBe("2026-11-27T18:00");
    const t = Date.UTC(2026, 10, 27) / 1000;
    expect(iso(dayCloseAt(t, NASDAQ))).toBe("2026-11-27T18:00");
    expect(iso(dayCloseAt(t, plain("0930-1600", "America/New_York")))).toBe("2026-11-27T21:00");
    // a bar on a day the calendar calls a holiday did trade: its regular hours count
    expect(iso(dayCloseAt(Date.UTC(2026, 10, 26) / 1000, NASDAQ))).toBe("2026-11-26T21:00");
  });

  it("a week, month or quarter ends on its last day with trading", () => {
    // Monday 2026-11-23: the week ends on the half day after Thanksgiving
    const monday = open(NASDAQ, "2026-11-23T15:00:00");
    expect(iso(barCloseAt("W", utc("2026-11-23T15:01:00"), monday))).toBe("2026-11-27T18:00");
    // ES on the Friday after Thanksgiving: its session from Wednesday evening is Thursday's bar, so
    // the 3D bar of Tuesday to Thursday closes with it at 12:15 in Chicago, not with Tuesday's
    expect(iso(barCloseAt("3D", utc("2026-11-27T16:01:00"), open(ES, "2026-11-27T16:00:00")))).toBe("2026-11-27T18:15");
    // the 3D bar of Tuesday to Thursday ends on Wednesday: Thanksgiving is a holiday
    expect(iso(barCloseAt("3D", utc("2026-11-24T15:01:00"), open(NASDAQ, "2026-11-24T15:00:00")))).toBe("2026-11-25T21:00");
    // Monday 2026-03-30: Good Friday is a holiday, so the week ends on Thursday April 2 (summer time: 20:00 UTC)
    const beforeEaster = open(NASDAQ, "2026-03-30T15:00:00");
    expect(iso(barCloseAt("W", utc("2026-03-30T15:01:00"), beforeEaster))).toBe("2026-04-02T20:00");
    // Christmas week: Thursday the 24th is a half day, Friday the 25th a holiday
    const christmas = open(NASDAQ, "2026-12-21T15:00:00");
    expect(iso(barCloseAt("W", utc("2026-12-21T15:01:00"), christmas))).toBe("2026-12-24T18:00");
    // across the year: December and the fourth quarter end on Thursday the 31st, a full day
    expect(iso(barCloseAt("M", utc("2026-12-21T15:01:00"), christmas))).toBe("2026-12-31T21:00");
    expect(iso(barCloseAt("Q", utc("2026-12-21T15:01:00"), christmas))).toBe("2026-12-31T21:00");
    // December 2027: the 31st is a Friday and trades, the 24th is the holiday
    expect(iso(barCloseAt("M", utc("2027-12-20T15:01:00"), open(NASDAQ, "2027-12-20T15:00:00")))).toBe("2027-12-31T21:00");
    // Hong Kong, the week of Monday 2026-10-19 (Chung Yeung): unaffected at the end, Friday 16:00 local
    expect(iso(barCloseAt("W", utc("2026-10-20T02:01:00"), open(HKEX, "2026-10-20T02:00:00")))).toBe("2026-10-23T08:00");
    // a month whose last weekday is a holiday: Friday 2026-12-25 for a calendar that ended the year there
    const yearEnd = { ...HKEX, holidays: `${HKEX.holidays},20261228,20261229,20261230,20261231` };
    expect(iso(barCloseAt("M", utc("2026-12-21T02:01:00"), open(yearEnd, "2026-12-21T02:00:00")))).toBe("2026-12-24T08:00");
    expect(iso(barCloseAt("Q", utc("2026-12-21T02:01:00"), open(yearEnd, "2026-12-21T02:00:00")))).toBe("2026-12-24T08:00");
  });

  it("the next session after a holiday: an overnight quote on New Year's Eve counts down past January 1", () => {
    // Thursday 2026-12-31, 18:00 in Chicago: the next trading day of the future is Monday January 4 (the 1st is a holiday)
    const eve = open(ES, "2027-01-01T00:00:00");
    expect(iso(barCloseAt("D", utc("2027-01-01T00:01:00"), eve))).toBe("2027-01-04T22:00");
    expect(iso(barCloseAt("W", utc("2027-01-01T00:01:00"), eve))).toBe("2027-01-08T22:00");
    // nothing to count to when no day in the next two weeks has trading
    const shut = { ...open(NASDAQ, "2026-10-07T15:00:00"), holidays: Array.from({ length: 31 }, (_, i) => `202610${String(i + 1).padStart(2, "0")}`).join(",") };
    expect(barCloseAt("D", utc("2026-10-07T15:01:00"), shut)).toBeNull();
  });

  it("without a calendar every weekday is a full trading day, as before", () => {
    const bare = plain("0930-1600", "America/New_York");
    expect(iso(barCloseAt("D", utc("2026-11-27T15:01:00"), open(bare, "2026-11-27T15:00:00")))).toBe("2026-11-27T21:00");
    expect(iso(barCloseAt("W", utc("2026-03-30T15:01:00"), open(bare, "2026-03-30T15:00:00")))).toBe("2026-04-03T20:00");
    expect(iso(barCloseAt("M", utc("2026-10-07T15:01:00"), open(bare, "2026-10-07T15:00:00")))).toBe("2026-10-30T20:00");
  });

  it("a source that does not report the session: open on a trading day of the calendar, closed on holidays and weekends", () => {
    // Thanksgiving 2026, noon in New York
    expect(scheduledSession(utc("2026-11-26T17:00:00"), NASDAQ)).toBe("closed");
    expect(scheduledSession(utc("2026-11-27T17:00:00"), NASDAQ)).toBe("open");
    expect(scheduledSession(utc("2026-11-28T17:00:00"), NASDAQ)).toBe("closed");
    // the date is the exchange's: Friday evening UTC is already Saturday in Hong Kong
    expect(scheduledSession(utc("2026-10-09T17:00:00"), HKEX)).toBe("closed");
    // nothing known: weekdays, by the UTC date as before
    expect(scheduledSession(utc("2026-11-26T17:00:00"), plain(null, null))).toBe("open");
    expect(scheduledSession(utc("2026-11-28T17:00:00"), plain(null, null))).toBe("closed");
    // around the clock: every day, the weekend too
    expect(scheduledSession(utc("2026-10-10T12:00:00"), plain("24x7", "Etc/UTC"))).toBe("open");
    expect(sessionsOn(plain("24x7", "Etc/UTC"), day(2026, 10, 11))).toBe("24x7");
  });

  it("an overnight session counts for the day it ends on from the evening it starts", () => {
    // Sunday 2026-10-04 in Chicago: nothing at 10:00, Monday's session from 17:00
    expect(scheduledSession(utc("2026-10-04T15:00:00"), ES)).toBe("closed");
    expect(scheduledSession(utc("2026-10-04T23:00:00"), ES)).toBe("open");
    // Martin Luther King Day, Monday 2026-01-19, a holiday: at 18:00 Tuesday's session is on
    expect(scheduledSession(utc("2026-01-19T16:00:00"), ES)).toBe("closed");
    expect(scheduledSession(utc("2026-01-20T00:00:00"), ES)).toBe("open");
    // an evening that starts no session: New Year's Eve 18:00 (January 1 has none) and Friday 18:00, after the day's close at 16:00
    expect(scheduledSession(utc("2026-01-01T00:00:00"), ES)).toBe("closed");
    expect(scheduledSession(utc("2026-01-01T16:00:00"), ES)).toBe("closed");
    expect(scheduledSession(utc("2026-10-09T20:00:00"), ES)).toBe("open"); // Friday 15:00
    expect(scheduledSession(utc("2026-10-09T23:00:00"), ES)).toBe("closed");
    // currencies, 17:00 to 17:00 in New York: Sunday 17:30 is Monday's
    const fx = { ...plain("1700-1700", "America/New_York"), holidays: "20261225" };
    expect(scheduledSession(utc("2026-10-04T20:00:00"), fx)).toBe("closed");
    expect(scheduledSession(utc("2026-10-04T21:30:00"), fx)).toBe("open");
    // Thursday 18:00 before Christmas Day: Thursday's session is over, the 25th has none
    expect(scheduledSession(utc("2026-12-24T23:00:00"), fx)).toBe("closed");
    expect(scheduledSession(utc("2026-12-24T20:00:00"), fx)).toBe("open");
    // an ordinary day session never reaches into the next day
    expect(scheduledSession(utc("2026-11-25T23:00:00"), NASDAQ)).toBe("open");
    expect(scheduledSession(utc("2026-11-26T03:00:00"), NASDAQ)).toBe("open"); // 22:00 on Wednesday in New York
  });

  it("knows the day of the daily bar a trade belongs to: an evening session is the next day's, a late print stays where it is", () => {
    const on = (at: string, calendar: TradingCalendar) => {
      const d = tradingDayAt(utc(at), calendar);
      return `${d.m}-${d.d}`;
    };
    const gold = plain("1800-1700", "America/New_York");
    // Monday 2026-10-05 in New York: the afternoon is Monday's, from 18:00 it is Tuesday's
    expect(on("2026-10-05T19:00:00", gold)).toBe("10-5");
    expect(on("2026-10-05T22:00:00", gold)).toBe("10-6");
    // Sunday is Monday's, also a little before the stated start
    expect(on("2026-10-04T22:00:00", gold)).toBe("10-5");
    expect(on("2026-10-04T21:00:00", gold)).toBe("10-5");
    // Friday 19:23, after the close: Saturday has no session, the print is Friday's
    expect(on("2026-10-09T23:23:18", gold)).toBe("10-9");
    // the dollar index: Monday starts on Sunday at 17:00 and runs until 19:00, the other days from 19:00
    expect(on("2026-10-04T21:30:00", DXY)).toBe("10-5");
    expect(on("2026-10-05T22:00:00", DXY)).toBe("10-5"); // Monday 18:00
    expect(on("2026-10-05T23:30:00", DXY)).toBe("10-6"); // Monday 19:30
    // Brent keeps London's calendar day, except Sunday 23:00, which opens Monday; an hour earlier while the clocks differ
    const brent = plain("0100-2300|2300F-2300:2#20261026/0000-2200|2200F-2200:2#20261102/0100-2300|2300F-2300:2", "Europe/London");
    expect(on("2026-10-08T20:00:00", brent)).toBe("10-8"); // Thursday 21:00
    expect(on("2026-10-09T21:59:59", brent)).toBe("10-9"); // Friday 22:59
    expect(on("2026-10-11T22:30:00", brent)).toBe("10-12"); // Sunday 23:30
    expect(on("2026-10-25T22:30:00", brent)).toBe("10-26"); // Sunday 22:30, winter time in London already
    // the evening before a holiday without trading starts nothing
    expect(on("2026-01-01T00:00:00", ES)).toBe("12-31"); // New Year's Eve 18:00 in Chicago
    // Martin Luther King Day, Monday 2026-01-19: the future trades until noon as part of Tuesday (`1700F2-1200F1,1700-1600`),
    // one daily bar from Sunday 17:00 to Tuesday 16:00, which TradingView stamps Sunday evening: stored as Monday
    expect(on("2026-01-16T23:00:00", ES)).toBe("1-16"); // Friday 17:00, after the close
    expect(on("2026-01-19T00:00:00", ES)).toBe("1-19"); // Sunday 18:00
    expect(on("2026-01-19T16:00:00", ES)).toBe("1-19"); // Monday 10:00
    expect(on("2026-01-20T00:00:00", ES)).toBe("1-19"); // Monday 18:00
    expect(on("2026-01-20T16:00:00", ES)).toBe("1-19"); // Tuesday 10:00
    expect(on("2026-01-20T23:30:00", ES)).toBe("1-21"); // Tuesday 17:30
    // Independence Day observed on Friday 2026-07-03: Monday's bar starts on Thursday evening (`1700F4-1200F3,1700-1600`), stored as Friday
    expect(on("2026-07-02T21:30:00", ES)).toBe("7-2"); // Thursday 16:30, after the close
    expect(on("2026-07-02T23:00:00", ES)).toBe("7-3"); // Thursday 18:00
    expect(on("2026-07-03T15:00:00", ES)).toBe("7-3"); // Friday 10:00
    expect(on("2026-07-05T23:00:00", ES)).toBe("7-3"); // Sunday 18:00
    expect(on("2026-07-06T15:00:00", ES)).toBe("7-3"); // Monday 10:00
    expect(on("2026-07-06T22:30:00", ES)).toBe("7-7"); // Monday 17:30
    // day sessions and markets around the clock keep the calendar day
    expect(on("2026-10-08T23:59:00", NASDAQ)).toBe("10-8");
    expect(on("2026-10-10T23:59:00", plain("24x7", "Etc/UTC"))).toBe("10-10");
  });

  it("knows when a trading day's bar is complete", () => {
    const friday = Date.UTC(2026, 9, 9) / 1000;
    // around the clock: with the UTC day
    expect(iso(dayCloseAt(friday, plain("24x7", "UTC")))).toBe("2026-10-10T00:00");
    // an exchange: at its close on that day, by its own clock and the day's own hours
    expect(iso(dayCloseAt(friday, plain("0930-1600", "America/New_York")))).toBe("2026-10-09T20:00");
    expect(iso(dayCloseAt(friday, plain("0930-1500", "Asia/Shanghai")))).toBe("2026-10-09T07:00");
    expect(iso(dayCloseAt(friday, plain("1700-1600:2345|1700-1500:6", "America/Chicago")))).toBe("2026-10-09T20:00");
    // hours not synced yet: once the day is over on the exchange's calendar
    expect(iso(dayCloseAt(friday, plain(null, "America/New_York")))).toBe("2026-10-10T04:00");
    expect(iso(dayCloseAt(friday, plain(null, null)))).toBe("2026-10-10T00:00");
  });

  it("formats like TradingView", () => {
    expect(fmtCountdown(9 * 1000)).toBe("00:09");
    expect(fmtCountdown((12 * 60 + 9) * 1000)).toBe("12:09");
    expect(fmtCountdown((5 * 3600 + 12 * 60 + 9) * 1000 + 999)).toBe("05:12:09");
    expect(fmtCountdown((2 * 86400 + 5 * 3600 + 59 * 60) * 1000)).toBe("2d 5h");
  });
});
