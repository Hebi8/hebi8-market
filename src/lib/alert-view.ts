/** What the alert lines, the alert list and the overview badges show (§2.6, §5.1, §5.2), read from the vault, the cache and the quotes table. No network. */
import type { AlertCheck, AlertCond, AlertCondition, AlertTrigger } from "./alert-conds";
import { ALERT_CHECKS, ALERT_CONDS, WATCHLIST, conditionLevels } from "./alert-conds";
import { alertFiredAt, alertKeys, readState, stateId } from "./alerts";
import { loadDaily, type DailyReader } from "./bars";
import { checkNote, describeAlert, isLive, type AlertDef, type Config } from "./config";
import { nameOf } from "./names";
import { liveReader, priceTime } from "./quotes";
import { getSymbol, readQuotes, type SymbolRow } from "./store";
import type { Timeframe } from "./symbols";
import { currentWeekId } from "./week";

export interface AlertView {
  id: string;
  /** Null for an alert on the whole watchlist */
  key: string | null;
  /** Display name of the symbol, or 全部自选 */
  name: string;
  label: string;
  /** In plain words: 「收盘价大于 1」, or the formula with its timeframe, then 「日线收盘」 or 「盘中价格」 when that is not the default; shown under the name whatever the name is */
  summary: string;
  /** The label as written, null when generated */
  ownLabel: string | null;
  cond: AlertCond | null;
  value: AlertCondition["value"] | null;
  when: string | null;
  tf: Timeframe;
  trigger: AlertTrigger;
  check: AlertCheck;
  enabled: boolean;
  notify: boolean;
  /** Waiting to be confirmed on the page (§2.5) */
  draft: boolean;
  /** Made or last changed by an agent through `/mcp` */
  by: "agent" | null;
  /** 待确认 (a draft) / 活动 / 已触发 (a `once` alert that fired) / 已停止 */
  status: "draft" | "active" | "triggered" | "stopped";
  /** Price lines on the chart: enabled condition alerts with a level */
  levels: number[];
  /** Latest price (quote, else the last daily close) and when it was taken (ms) */
  price: number | null;
  priceAt: number | null;
}

/**
 * The latest price of any key, synthetic ones included, and when it was taken (`priceTime`):
 * today's live bar where a quote is taken (`withQuote`), else the last daily close. One snapshot
 * of the quotes and the symbols serves every key asked for.
 */
export function latestPrice(key: string, cfg: Config, quotes = readQuotes(), symbols: (key: string) => SymbolRow | null | undefined = getSymbol, read: DailyReader = liveReader(quotes)): { price: number | null; at: number | null } {
  let price: number | null = null;
  try {
    price = loadDaily(key, cfg.prices, cfg, read).at(-1)?.c ?? null;
  } catch {
    // a broken synthetic expression shows no price
  }
  return { price, at: priceTime(key, cfg.aliases, quotes, symbols) };
}

export function alertViews(vault: string, cfg: Config, symbols: Record<string, SymbolRow>): AlertView[] {
  const fired = alertFiredAt(vault);
  const quotes = readQuotes();
  const read = liveReader(quotes);
  const prices = new Map<string, { price: number | null; at: number | null }>();
  const priceOf = (key: string) => {
    if (!prices.has(key)) prices.set(key, latestPrice(key, cfg, quotes, (k) => symbols[k], read));
    return prices.get(key)!;
  };
  return cfg.alerts.map((a) => {
    const { price, at } = a.key ? priceOf(a.key) : { price: null, at: null };
    return {
      id: a.id,
      key: a.key,
      name: a.key ? nameOf(cfg, a.key, symbols[a.key]?.name) : WATCHLIST,
      label: a.label,
      summary: [describeAlert(a), checkNote(a)].filter(Boolean).join(" · "),
      ownLabel: a.ownLabel,
      cond: a.condition?.cond ?? null,
      value: a.condition?.value ?? null,
      when: a.when,
      tf: a.tf,
      trigger: a.trigger,
      check: a.check,
      enabled: a.enabled,
      notify: a.notify,
      draft: a.draft,
      by: a.by,
      status: a.draft ? "draft" : a.enabled ? "active" : a.trigger === "once" && fired.has(a.id) ? "triggered" : "stopped",
      levels: isLive(a) && a.condition ? conditionLevels(a.condition) : [],
      price,
      priceAt: at,
    };
  });
}

/** 本周新触发 · 已触发 or 成立中 · 未触发 · 已停止 */
export type BadgeState = "fresh" | "on" | "idle" | "stopped";

export interface AlertBadge {
  id: string;
  label: string;
  state: BadgeState;
  /** The state in words: 「成立中（上次触发 10/09 07:31）」 */
  status: string;
  /** Hover text: the name, the definition in plain words, where it applies, and the state */
  title: string;
}

/** How an alert fires, in words: 「全部自选 · 日线收盘 · 每根 K 线最多一次 · 推送」 */
export function alertScope(a: Pick<AlertDef, "key" | "trigger" | "notify" | "check">): string {
  return [a.key ? null : WATCHLIST, ALERT_CHECKS[a.check], a.trigger === "once" ? "仅一次" : "每根 K 线最多一次", a.notify ? "推送到通知通道" : "只在总览显示"].filter(Boolean).join(" · ");
}

/**
 * Each symbol's alert badges, by key, from the alert state the last checks left. An alert on a
 * symbol always shows; one on the whole watchlist only where it holds or fired this week (the
 * week by the clock in `sync.tz`), so it reads like a filter.
 */
export function alertBadges(vault: string, cfg: Config, now = new Date()): Record<string, AlertBadge[]> {
  const rows = readState(vault);
  const week = currentWeekId(cfg.sync.tz, now);
  const day = new Intl.DateTimeFormat("zh-CN", { timeZone: cfg.sync.tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const out: Record<string, AlertBadge[]> = {};
  for (const a of cfg.alerts) {
    // a draft is nobody's alert yet
    if (a.draft) continue;
    // an event (a crossing) holds once it fired; a state or formula holds while it is true
    const event = a.condition !== null && ALERT_CONDS[a.condition.cond].kind === "event";
    for (const key of alertKeys(a, cfg)) {
      const row = rows.get(stateId(a.id, key));
      const firedAt = row?.firedAt ?? null;
      const last = firedAt === null ? "" : `（上次触发 ${day.format(firedAt)}）`;
      let state: BadgeState;
      let status: string;
      if (firedAt !== null && currentWeekId(cfg.sync.tz, new Date(firedAt)) === week) [state, status] = ["fresh", `本周新触发（${day.format(firedAt)}）`];
      else if (!a.enabled) [state, status] = a.trigger === "once" && firedAt !== null ? ["on", `已触发${last}`] : ["stopped", "已停止"];
      else if (event ? firedAt !== null : row?.state === 1) [state, status] = ["on", event ? `已触发${last}` : `成立中${last}`];
      else [state, status] = ["idle", `未触发${last}`];
      if (!a.key && (state === "idle" || state === "stopped")) continue;
      const title = [a.label, describeAlert(a), alertScope(a), `状态：${status}`].filter((line, i) => i !== 1 || line !== a.label).join("\n");
      (out[key] ??= []).push({ id: a.id, label: a.label, state, status, title });
    }
  }
  return out;
}
