/**
 * What a symbol is (design §2.8), the parts shared by the server and the 商品详情 panel: when the
 * weekly facts are due again, the numbers that follow the price, and how they are written.
 */
import type { SourceProfile } from "./sources/types";

export type { ProfileWeight, SourceProfile } from "./sources/types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Facts are fetched again after a week; a fetch that failed is tried again after a day. */
export const PROFILE_TTL_MS = 7 * DAY_MS;
export const PROFILE_RETRY_MS = DAY_MS;

/** When a symbol's profile was last fetched and tried (ms), and what the last attempt failed with */
export interface ProfileState {
  fetchedAt: number | null;
  triedAt: number;
  error: string | null;
}

/** Never tried, a week old, or failed a day ago. */
export function profileDue(state: ProfileState | null, now: number): boolean {
  if (!state) return true;
  if (state.error) return now - state.triedAt >= PROFILE_RETRY_MS;
  return now - (state.fetchedAt ?? 0) >= PROFILE_TTL_MS;
}

export interface Valuation {
  marketCap: number | null;
  /** Price over trailing earnings; none while the company loses money */
  pe: number | null;
  /** 0.012 = 1.2% */
  dividendYield: number | null;
}

/** The numbers that move with the price, from the stored facts and the latest price: never stored. */
export function valuation(profile: Pick<SourceProfile, "shares" | "eps" | "dividend"> | null, price: number | null): Valuation {
  const p = price != null && price > 0 ? price : null;
  return {
    marketCap: p && profile?.shares ? profile.shares * p : null,
    pe: p && profile?.eps && profile.eps > 0 ? p / profile.eps : null,
    dividendYield: p && profile?.dividend ? profile.dividend / p : null,
  };
}

/** The next earnings report (unix seconds) while it is still ahead: a date that passed since the weekly fetch is not the next one. */
export function nextEarnings(profile: Pick<SourceProfile, "earningsAt"> | null, now: number): number | null {
  return profile?.earningsAt && profile.earningsAt * 1000 > now - DAY_MS ? profile.earningsAt : null;
}

/** A description that is already Chinese needs no translation: a third of its letters are Han. */
export function isChinese(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  return letters > 0 && han / letters >= 1 / 3;
}

/** 5.53T, 816.74B, 42.00M: large amounts as TradingView writes them. */
export function fmtAmount(value: number): string {
  const abs = Math.abs(value);
  const [div, unit] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  return `${(value / div).toFixed(2)}${unit}`;
}

/**
 * The regular session as people write it: `09:30–16:00`, `09:30–11:30 · 13:00–15:00`, `全天`.
 * From the hours in TradingView's notation (`TradingCalendar.hours`): the newest version's hours
 * for an ordinary weekday; other days' hours and auction windows are left out.
 */
export function fmtHours(hours: string): string | null {
  if (hours === "24x7") return "全天";
  const parts = hours.split("/").at(-1)!.replace(/#\d{8}$/, "").split("|");
  const regular = (parts.find((p) => !/:\d+$/.test(p)) ?? parts[0]).replace(/:\d+$/, "");
  const sessions = regular.split(/[,SU]/).flatMap((s) => {
    const m = /^(\d{2})(\d{2})(?:F\d*)?-(\d{2})(\d{2})/.exec(s);
    return m ? [`${m[1]}:${m[2]}–${m[3]}:${m[4]}`] : [];
  });
  return sessions.length > 0 ? sessions.join(" · ") : null;
}

/** What the page and an agent get for one symbol: cached facts, the stored translation, and what there is to say without a profile. */
export interface ProfileView {
  /** yahoo | tv | binance | data, or `expr` for a synthetic key */
  source: string;
  /** The cached metadata every real symbol has */
  kind: string | null;
  exchange: string | null;
  currency: string | null;
  timezone: string | null;
  hours: string | null;
  profile: SourceProfile | null;
  /** When the facts were fetched (ms) */
  fetchedAt: number | null;
  /** The next earnings report (unix seconds) while it is still ahead */
  earningsAt: number | null;
  /** The source has profiles and this symbol's has not been fetched yet */
  pending: boolean;
  /** The description in Simplified Chinese, when one was made from the text as it is now */
  translation: string | null;
  /** A model is configured and the description is not Chinese already: someone who may write can ask for a translation */
  translatable: boolean;
  /** A synthetic key's operands: it has no profile of its own */
  legs: { key: string; name: string }[] | null;
}
