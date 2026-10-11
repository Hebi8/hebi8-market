/**
 * The tools an agent gets at `/mcp` (design §6). Every one runs as the viewer its token stands
 * for and touches that viewer's vault only. Reads come from the vault, the cache and the quotes
 * table like the pages' (no network, except the symbol search); writes go through the same
 * operations as the page (`src/lib/ops.ts`), and a read-only token is refused before they run.
 * Descriptions are written for the agent; errors are the ones the page shows, as they are.
 */
import { z } from "zod";
import { ALERT_CONDS, type AlertCond, type AlertCondition } from "../alert-conds";
import { alertBadges, alertViews } from "../alert-view";
import { adoptConditionState, alertKeys, readState, stateId } from "../alerts";
import { barClosed, loadDaily, synthNoData } from "../bars";
import { allItems, findItem, resolveKey, type Config } from "../config";
import { fmtDate } from "../format";
import { nameOf } from "../names";
import * as ops from "../ops";
import { CHANGE_PERIODS } from "../periods";
import { valuation } from "../profile";
import { profileView } from "../profiles";
import { liveReader, liveStats, tradedPrice } from "../quotes";
import { readerFor, scan, testFormula } from "../scan";
import { scheduledNextSync, nextRun } from "../scheduler";
import { localSearch, mergeResults, normalizeQuery, suggestGroup } from "../search";
import { searchContextFor } from "../search-context";
import { searchExternal } from "../search-external";
import { aggregate } from "../series";
import { getSymbol, listSymbols, maxSyncedAt } from "../store";
import { isSynthetic, isValidKey, TIMEFRAMES } from "../symbols";
import { statsFor } from "../sync";
import { listJournals, listNotes, readConfig, readJournal, readNote } from "../vault";
import type { Viewer } from "../viewer";
import { currentWeekId, isWeekId } from "../week";
import { formulaReference } from "./reference";

export interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  /** Changes the vault: needs a token that may write */
  write: boolean;
  run: (viewer: Viewer, args: never) => unknown;
}

function tool<S extends z.ZodRawShape>(def: { name: string; description: string; input: S; write?: boolean; run: (viewer: Viewer, args: z.infer<z.ZodObject<S>>) => unknown }): Tool {
  return { name: def.name, description: def.description, input: z.object(def.input), write: def.write ?? false, run: def.run as Tool["run"] };
}

const KEY = "an alias from the user's yaml (`BTC`), a full key `source:ticker` (`yahoo:NVDA`, `binance:BTCUSDT`, `tv:TVC:GOLD`, `data:gpu/4090-xianyu`) or a synthetic `=expression` (`=BTC/GOLD`)";
const tf = z.enum(TIMEFRAMES).default("D").describe("Timeframe: D daily (default), W weekly, M monthly, Q quarterly. There is nothing below daily.");
const check = z
  .enum(["price", "close"])
  .default("price")
  .describe("Which bars to read. `price` (default): with today's unfinished daily bar built from the latest quote, as alerts with `check: price` see them. `close`: closed daily bars only, as alerts with `check: close` see them.");

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const pct = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10000) / 100);
const num = (v: number) => Number(v.toPrecision(10));

/** A symbol an agent names, as its key. */
function keyOf(cfg: Config, ref: string): string {
  const key = resolveKey(ref, cfg.aliases);
  if (!isValidKey(key)) throw new Error(`无效的 key「${key}」，应为 source:ticker 或 =表达式`);
  return key;
}

const aliasOf = (cfg: Config, key: string) => Object.entries(cfg.aliases).find(([, k]) => k === key)?.[0];

const SAVED_DRAFT =
  "Saved as a DRAFT, not active. An alert on the whole watchlist only takes effect after the user confirms it on the page: 确认 at the top of the overview, or in the 警报 panel of any chart. Until then it is not judged and nothing is pushed. Tell the user it is waiting for their confirmation.";

export const TOOLS: Tool[] = [
  // ------------------------------------------------------------------------------------ read

  tool({
    name: "overview",
    description:
      "The user's watchlist as the overview page shows it: groups, and for each symbol its key, alias, name, benchmark, latest price (from the latest quote when there is one, with its session), percentage changes over 1W…5Y, distance from the all-time-high close, position in the 52-week range, the alerts that currently hold or fired on it, and its sync error if any. Also when daily bars were last synced and will be next. Start here.",
    input: {},
    run: ({ dir, vault }) => {
      const cfg = readConfig(dir);
      const symbols = listSymbols();
      const stats = statsFor(vault, cfg);
      const live = liveStats(vault, cfg, symbols);
      const badges = alertBadges(vault, cfg);
      const failed = allItems(cfg).flatMap((i) => (symbols[i.key]?.syncError ? [{ key: i.key, error: symbols[i.key].syncError }] : []));
      return {
        prices: cfg.prices === "total" ? "total return (dividends folded in)" : "split-adjusted",
        change_periods_on_page: cfg.periods,
        groups: cfg.groups.map((g) => ({
          name: g.name,
          symbols: g.symbols.map((item) => {
            const row = symbols[item.key];
            const s = live[item.key]?.stats ?? stats[item.key];
            const quote = live[item.key]?.status;
            const holding = (badges[item.key] ?? []).filter((b) => b.state === "fresh" || b.state === "on");
            return {
              key: item.key,
              alias: aliasOf(cfg, item.key),
              name: nameOf(cfg, item.key, row?.name),
              bench: item.bench ?? undefined,
              price: s ? num(s.last) : null,
              date: s ? fmtDate(s.lastTime) : null,
              currency: row?.currency ?? s?.currency ?? undefined,
              session: quote?.session ?? undefined,
              quoted_at: iso(quote?.quotedAt) ?? undefined,
              change_pct: s ? Object.fromEntries(CHANGE_PERIODS.map((p) => [p.key, pct(s.changes[p.key])])) : null,
              from_high_pct: s ? pct(s.ddAth) : null,
              range_52w_pct: s ? pct(s.pos52) : null,
              alerts: holding.length ? holding.map((b) => ({ id: b.id, label: b.label, status: b.status })) : undefined,
              sync_error: row?.syncError ?? undefined,
            };
          }),
        })),
        sync: {
          last: iso(maxSyncedAt()),
          next: iso(scheduledNextSync() ?? nextRun(new Date(), cfg.sync.at, cfg.sync.tz).getTime()),
          daily_at: cfg.sync.at,
          tz: cfg.sync.tz,
          failed,
        },
        alerts_waiting_for_confirmation: cfg.alerts.filter((a) => a.draft).length,
      };
    },
  }),

  tool({
    name: "get_bars",
    description:
      "OHLCV bars of one symbol from the cache, oldest first, the newest `limit` of them. Daily bars are the smallest unit (no intraday bars); W, M and Q are aggregated from them and their last bar is the period so far. The last daily bar is today's unfinished one when a quote is newer than the last sync; `last_daily_bar.closed` says whether that bar's trading day is over (the exchange has closed, or the UTC day ended for crypto), whatever its price came from. Prices follow the user's `prices` setting. Only cached symbols have bars: every watched symbol, its benchmark and anything an alert or formula refers to; add_symbol caches a new one.",
    input: {
      key: z.string().describe(`The symbol: ${KEY}`),
      tf,
      limit: z.number().int().min(1).max(1000).default(200).describe("How many of the newest bars (default 200, at most 1000)"),
    },
    run: ({ dir }, args) => {
      const cfg = readConfig(dir);
      const key = keyOf(cfg, args.key);
      const live = liveReader();
      const daily = loadDaily(key, cfg.prices, cfg, live);
      const last = daily.at(-1);
      if (!last) throw new Error(isSynthetic(key) ? synthNoData(key, cfg, (k) => getSymbol(k)?.syncError ?? null) : (getSymbol(key)?.syncError ?? "没有缓存的日线：这个标的不在自选里，也没有被引用过"));
      const bars = aggregate(daily, args.tf);
      return {
        key,
        name: nameOf(cfg, key, getSymbol(key)?.name),
        tf: args.tf,
        currency: getSymbol(key)?.currency ?? undefined,
        total_bars: bars.length,
        last_daily_bar: { date: fmtDate(last.t), closed: barClosed(key, last.t, cfg, live) },
        columns: ["date", "open", "high", "low", "close", "volume"],
        bars: bars.slice(-args.limit).map((b) => [fmtDate(b.t), num(b.o), num(b.h), num(b.l), num(b.c), b.v]),
      };
    },
  }),

  tool({
    name: "get_profile",
    description:
      "What one symbol is, from the cache: for a company its description, sector, industry, country, employees, website and next earnings date; for a fund its description, issuer, category, expense ratio, net assets, top holdings and sector weights; for anything else (an index, an FX pair, a commodity, a coin, a dataset series) the type, exchange, currency, timezone and trading hours, with a description when its source has one. A field the source does not have is absent. These facts are fetched from the symbol's source once a week (`profile_fetched_at`); `market_cap`, `pe_ttm` and `dividend_yield_pct` are not stored but computed now from the stored shares, trailing EPS and yearly dividend per share with `price`, the latest price as traded (the quote when there is one, else the last daily close; never dividend-adjusted, whatever the user's `prices` setting, so it can differ from get_bars under `total`). `description_zh` is a Simplified Chinese translation someone asked for on the page, when there is one. `links` are pages to read more on, each with a Chinese name: the company's or fund's website, its filings (SEC EDGAR, HKEX, SSE, SZSE), the fund issuer, official sources for a yield, currency, commodity or index, and always the data source's own quote page; they are built from the symbol, not fetched or checked at call time. A synthetic key has no profile and returns its operands. Nothing is fetched: a symbol that was never cached, or whose profile has not been fetched yet, comes back with what the cache has.",
    input: { key: z.string().describe(`The symbol: ${KEY}`) },
    run: ({ dir }, args) => {
      const cfg = readConfig(dir);
      const key = keyOf(cfg, args.key);
      const view = profileView(key, cfg);
      const p = view.profile;
      const price = tradedPrice(key);
      const { marketCap, pe, dividendYield } = valuation(p, price);
      const weights = (items: NonNullable<typeof p>["holdings"]) => items?.map((i) => ({ name: i.name, key: i.key, weight_pct: pct(i.weight) }));
      return {
        key,
        name: nameOf(cfg, key, getSymbol(key)?.name),
        source: view.source,
        type: view.kind ?? undefined,
        exchange: view.exchange ?? undefined,
        currency: view.currency ?? undefined,
        timezone: view.timezone ?? undefined,
        hours: view.hours ?? undefined,
        operands: view.legs ?? undefined,
        description: p?.description,
        description_zh: view.translation ?? undefined,
        sector: p?.sector,
        industry: p?.industry,
        country: p?.country,
        employees: p?.employees,
        website: p?.website,
        price: price != null ? num(price) : null,
        market_cap: marketCap != null ? num(marketCap) : undefined,
        pe_ttm: pe != null ? num(pe) : undefined,
        dividend_yield_pct: pct(dividendYield) ?? undefined,
        shares_outstanding: p?.shares,
        eps_ttm: p?.eps,
        dividend_per_share: p?.dividend != null ? num(p.dividend) : undefined,
        next_earnings: view.earningsDay != null ? fmtDate(view.earningsDay) : undefined,
        issuer: p?.issuer,
        category: p?.category,
        expense_ratio_pct: p?.expenseRatio != null ? num(p.expenseRatio * 100) : undefined,
        net_assets: p?.netAssets,
        top_holdings: weights(p?.holdings),
        sector_weights: weights(p?.sectors),
        links: view.links.map((l) => ({ name: l.label, url: l.url })),
        profile_fetched_at: iso(view.fetchedAt),
      };
    },
  }),

  tool({
    name: "scan",
    description:
      "Evaluate one formula on many symbols at once and return, per symbol, its value on the last bar and on the bar before, whether it holds on the last bar, or why it failed. A boolean formula gives 1 or 0. `holds` is how an alert would judge the value: true for anything that is not 0, absent where there is no value. A value is null where there is none yet (not enough bars, a referenced symbol without data); an infinite value (a division by zero) is the string \"Infinity\" or \"-Infinity\", which is a value and holds. `true_now` counts the symbols where it holds and `turned_true` lists those where it holds now and did not on the bar before. By default every watched symbol; narrow it with `group` or `keys`. Only cached bars are read and nothing is fetched: a symbol that was never synced comes back with an error instead of a value. Use this to find which symbols a condition holds on right now; use test_formula to see how it behaved in the past. See formula_reference for the language.",
    input: {
      formula: z.string().describe("Boolean or numeric formula, e.g. `close < sma(close, 200)` or `(close / sma(close, 40) - 1) * 100`"),
      tf,
      group: z.string().optional().describe("Only the symbols of this watchlist group (its name as in overview)"),
      keys: z.array(z.string()).max(200).optional().describe(`Only these symbols instead of the watchlist; each is ${KEY}. They need not be watched, but must be cached.`),
      check,
      only_true: z.boolean().default(false).describe("Leave out the symbols where the formula is false or has no value: only the ones where it holds and the ones that failed are returned. The counts still cover all of them."),
    },
    run: ({ dir }, args) => {
      const cfg = readConfig(dir);
      let keys: string[];
      if (args.keys) keys = [...new Set(args.keys.map((k) => keyOf(cfg, k)))];
      else if (args.group !== undefined) {
        const group = cfg.groups.find((g) => g.name === args.group!.trim());
        if (!group) throw new Error(`没有「${args.group}」这个分组`);
        keys = group.symbols.map((s) => s.key);
      } else keys = allItems(cfg).map((i) => i.key);
      const { rows, uncached } = scan(cfg, keys, args.formula, args.tf, readerFor(args.check));
      return {
        tf: args.tf,
        check: args.check,
        scanned: rows.length,
        true_now: rows.filter((r) => r.holds).length,
        turned_true: rows.filter((r) => r.holds && r.held === false).map((r) => r.key),
        failed: rows.filter((r) => r.error).length,
        uncached_references: uncached.length ? uncached : undefined,
        rows: (args.only_true ? rows.filter((r) => r.holds || r.error) : rows).map((r) => ({ key: r.key, alias: aliasOf(cfg, r.key), name: r.name, value: r.value, prev: r.prev, holds: r.holds ?? undefined, date: r.date, error: r.error })),
      };
    },
  }),

  tool({
    name: "test_formula",
    description:
      "How a formula behaved on one symbol over its last `bars` bars: on how many bars it was true, the runs of bars where it held, and each bar on which it turned from false to true, which is when an alert with this formula as `when` would have fired. Check a formula with this before saving it as an alert: one that never turned true, or does on most bars, is probably not what the user means. True means what it means to an alert: any value that is not 0, an infinite one (shown as the string \"Infinity\" or \"-Infinity\") included; null is no value and changes nothing. History is judged bar by bar on final values; a live `check: price` alert can also fire on an unfinished bar that later closes false. Cached bars only.",
    input: {
      key: z.string().describe(`The symbol: ${KEY}`),
      formula: z.string().describe("The formula; a numeric one counts as true wherever it is not 0"),
      tf,
      bars: z.number().int().min(2).max(3000).default(250).describe("How many of the newest bars to look at (default 250, about a year of daily bars)"),
      check,
    },
    run: ({ dir }, args) => {
      const cfg = readConfig(dir);
      const t = testFormula(cfg, keyOf(cfg, args.key), args.formula, args.tf, args.bars, readerFor(args.check));
      return {
        key: t.key,
        name: t.name,
        tf: args.tf,
        check: args.check,
        window: { bars: t.bars, from: t.from, to: t.to },
        value: t.value,
        prev: t.prev,
        true_bars: t.trueBars,
        no_value_bars: t.unknownBars,
        turned_true: t.turnedTrue.count,
        turned_true_dates: t.turnedTrue.dates,
        true_runs: t.trueRanges.count,
        true_ranges: t.trueRanges.ranges,
        recent: t.recent.map((r) => [r.date, r.value]),
        ...(t.turnedTrue.count > t.turnedTrue.dates.length || t.trueRanges.count > t.trueRanges.ranges.length ? { note: "Only the newest dates and ranges are listed; the counts cover the whole window." } : {}),
      };
    },
  }),

  tool({
    name: "formula_reference",
    description: "The formula language (syntax, variables, every function) and the fields and condition kinds of an alert. Read it once before writing a formula or saving an alert.",
    input: {},
    run: () => formulaReference(),
  }),

  tool({
    name: "search_symbols",
    description:
      "Find a symbol's key by name or ticker, the same search as the page's: the user's watchlist, aliases and the built-in dictionary first, then Yahoo, Binance, TradingView and the instance's datasets over the network. Each result says whether it is already watched (`in_watchlist` is its group) and which group it would suit. Pass a result's `key` to add_symbol.",
    input: { query: z.string().describe("A name, ticker or key, Chinese or English: `nvidia`, `腾讯`, `US10Y`, `tv:TVC:GOLD`") },
    run: async ({ dir }, args) => {
      const q = normalizeQuery(args.query);
      if (!q) throw new Error("搜索词为空");
      const ctx = searchContextFor(readConfig(dir));
      return mergeResults(localSearch(q, ctx), await searchExternal(q, ctx)).map((r) => ({ key: r.key, name: r.name, exchange: r.exchange, kind: r.kind, source: r.source, in_watchlist: r.inWatchlist, suggested_group: r.suggestedGroup }));
    },
  }),

  tool({
    name: "list_alerts",
    description:
      "Every alert of the user with its definition and state. `status`: `active`, `stopped`, `triggered` (a `once` alert that fired and switched itself off) or `draft` (waiting for the user's confirmation on the page; not judged). `holds_on` lists the symbols on which a formula or state alert was true at its last check (alerts are checked after each quote round or daily sync, not when you call this); event conditions such as crossing have no such state, see `last_fired`. `by: agent` marks alerts made through this endpoint.",
    input: {},
    run: ({ dir, vault }) => {
      const cfg = readConfig(dir);
      adoptConditionState(vault, cfg);
      const rows = readState(vault);
      const views = alertViews(vault, cfg, listSymbols());
      return cfg.alerts.map((a, i) => {
        const view = views[i];
        const state = alertKeys(a, cfg).map((key) => ({ key, row: rows.get(stateId(a.id, key)) }));
        const event = a.condition !== null && ALERT_CONDS[a.condition.cond].kind === "event";
        const fired = state.flatMap((s) => s.row?.firedAt ?? []);
        return {
          id: a.id,
          key: a.key,
          symbol: view.name,
          label: a.label,
          definition: view.summary,
          when: a.when ?? undefined,
          tf: a.when ? a.tf : undefined,
          cond: a.condition?.cond,
          value: a.condition?.value,
          trigger: a.trigger,
          check: a.check,
          notify: a.notify,
          status: view.status,
          by: a.by ?? undefined,
          holds_on: event ? undefined : state.filter((s) => s.row?.state === 1).map((s) => s.key),
          last_fired: fired.length ? iso(Math.max(...fired)) : null,
          price: view.price ?? undefined,
        };
      });
    },
  }),

  tool({
    name: "read_note",
    description: "The user's note (their thesis, in markdown) on one symbol, or without `key` the list of symbols that have a note.",
    input: { key: z.string().optional().describe(`The symbol: ${KEY}. Omit to list the symbols with notes.`) },
    run: ({ dir }, args) => {
      const cfg = readConfig(dir);
      if (args.key === undefined) return { notes: listNotes(dir).map((n) => ({ key: n.key, name: nameOf(cfg, n.key, getSymbol(n.key)?.name), characters: n.body.length })) };
      const key = keyOf(cfg, args.key);
      return { key, name: nameOf(cfg, key, getSymbol(key)?.name), note: readNote(dir, key) };
    },
  }),

  tool({
    name: "read_journal",
    description: "The user's weekly review journal (markdown, one file per ISO week). Without `week`: the current week's id and the weeks that have a journal, newest first. With `week`: that week's text, null when nothing was written.",
    input: { week: z.string().optional().describe("ISO week id such as `2026-W41`. Omit to list the weeks.") },
    run: ({ dir }, args) => {
      const cfg = readConfig(dir);
      if (args.week === undefined) return { current_week: currentWeekId(cfg.sync.tz), weeks: listJournals(dir).map((j) => ({ week: j.week, updated: iso(j.mtimeMs) })) };
      if (!isWeekId(args.week)) throw new Error(`无效的周「${args.week}」`);
      return { week: args.week, journal: readJournal(dir, args.week) };
    },
  }),

  // ------------------------------------------------------------------------------------ write

  tool({
    name: "save_alert",
    write: true,
    description:
      "Create an alert, or with `id` replace an existing one (pass every field again: what is left out goes back to its default, and an edited alert starts over). Give either `when` (a boolean formula) or `cond` + `value`. With `key` the alert watches that one symbol and is active at once: the server judges it after every quote round (`check: price`, about every 5 minutes in market hours) or after each daily sync (`check: close`) and pushes to the user's channels when it fires. Without `key` it covers every watched symbol and is ALWAYS saved as a draft that the user must confirm on the page; you cannot activate it, so say so in your reply. With `id` you can replace an alert on one symbol or a draft, but not a whole-watchlist alert that is not a draft (`status` other than `draft` in list_alerts): that is refused and the alert keeps running, so save your new version without `id` as a new draft and let the user confirm it and delete the old one. Only daily and higher timeframes exist. Run test_formula first.",
    input: {
      id: z.string().optional().describe("The id of the alert to replace, from list_alerts (`alert:…`): one on a single symbol, or a draft. Omit to create one."),
      key: z.string().nullish().describe(`The symbol to watch: ${KEY}. Omit (or null) for every watched symbol, which is saved as a draft.`),
      when: z.string().optional().describe("Boolean formula; fires when it turns true, at most once per bar of `tf`"),
      tf: z.enum(TIMEFRAMES).optional().describe("Timeframe of `when` (default D); conditions are always daily"),
      cond: z
        .enum(Object.keys(ALERT_CONDS) as [AlertCond, ...AlertCond[]])
        .optional()
        .describe("A TradingView-style condition on the price instead of `when`; price and channel conditions need `key`"),
      value: z
        .union([z.number(), z.tuple([z.number(), z.number()]), z.object({ pct: z.number(), bars: z.number().int() })])
        .optional()
        .describe("For `cond`: a price level; `[low, high]` for entering / exiting / inside / outside; `{ pct, bars }` for moving_up_pct / moving_down_pct"),
      trigger: z.enum(["once", "bar"]).default("once").describe("`once`: fires once and switches itself off (default). `bar`: at most once per daily bar. The whole watchlist is always `bar`."),
      check: z.enum(["price", "close"]).optional().describe("`price`: judged on the live price after every quote round. `close`: only on closed daily bars after a sync. Default: price with `key`, close without."),
      label: z.string().max(80).optional().describe("The name shown on the overview and in the message; generated from the condition when omitted"),
      notify: z.boolean().default(true).describe("false: only shown on the overview, never pushed"),
    },
    run: async (viewer, args) => {
      if (args.when !== undefined && args.cond !== undefined) throw new Error("when 和 cond 只能写一个");
      if (args.when === undefined && args.cond === undefined) throw new Error("需要 cond + value，或 when 公式");
      const saved = await ops.saveAlert(
        viewer,
        {
          id: args.id,
          key: args.key ?? null,
          ...(args.cond ? { cond: args.cond, value: args.value as AlertCondition["value"] } : { cond: "formula", when: args.when, tf: args.tf }),
          trigger: args.trigger,
          check: args.check,
          label: args.label,
          notify: args.notify,
        },
        "agent",
      );
      const alert = readConfig(viewer.dir).alerts.find((a) => a.id === saved.id);
      return { id: saved.id, label: alert?.label, status: saved.draft ? "draft" : "active", message: saved.draft ? SAVED_DRAFT : `Active: judged ${alert?.check === "close" ? "after each daily sync on closed daily bars" : "after every quote round on the live price"}.` };
    },
  }),

  tool({
    name: "delete_alert",
    write: true,
    description: "Delete an alert (any alert, drafts included) by its id from list_alerts.",
    input: { id: z.string().describe("The alert's id, `alert:…`") },
    run: async (viewer, args) => {
      alertById(viewer, args.id);
      await ops.deleteAlert(viewer, args.id);
      return { deleted: args.id };
    },
  }),

  tool({
    name: "set_alert_enabled",
    write: true,
    description: "Stop (`enabled: false`) or resume (`enabled: true`) an alert. Stopping works on any alert. Resuming works only on an alert on one symbol, which then starts over; an alert on the whole watchlist can only be resumed by the user on the page, and a draft is confirmed there too.",
    input: { id: z.string().describe("The alert's id, `alert:…`"), enabled: z.boolean() },
    run: async (viewer, args) => {
      alertById(viewer, args.id);
      await ops.setAlertEnabled(viewer, args.id, args.enabled, "agent");
      return { id: args.id, enabled: args.enabled };
    },
  }),

  tool({
    name: "add_symbol",
    write: true,
    description:
      "Add a symbol to the user's watchlist. Its daily history is fetched first (this goes to the data source and can take a few seconds); nothing is written if that fails. From then on it is synced daily, polled for quotes, and covered by scans and whole-watchlist alerts. Find the key with search_symbols.",
    input: {
      key: z.string().describe(`The symbol: ${KEY}`),
      group: z.string().optional().describe("The watchlist group to put it in, created when it does not exist. Default: the existing group that suits the symbol."),
      name: z.string().max(80).optional().describe("Display name; default is the built-in or the source's name"),
      bench: z.string().optional().describe("Benchmark for relative strength and `bench` in formulas: an alias or key"),
    },
    run: async (viewer, args) => {
      const cfg = readConfig(viewer.dir);
      const group = args.group?.trim() || suggestGroup(keyOf(cfg, args.key), undefined, cfg.groups.map((g) => g.name));
      await ops.addSymbol(viewer, { key: args.key, group, name: args.name, bench: args.bench });
      const after = readConfig(viewer.dir);
      const key = resolveKey(args.key, after.aliases);
      return { added: key, group, name: nameOf(after, key, getSymbol(key)?.name) };
    },
  }),

  tool({
    name: "remove_symbol",
    write: true,
    description: "Remove a symbol from the user's watchlist. Its note, drawings and the alerts on it stay.",
    input: { key: z.string().describe(`The symbol: ${KEY}`) },
    run: (viewer, args) => {
      const cfg = readConfig(viewer.dir);
      const key = keyOf(cfg, args.key);
      if (!findItem(cfg, key)) throw new Error(`${key} 不在自选里`);
      ops.removeSymbol(viewer, key);
      return { removed: key };
    },
  }),

  tool({
    name: "append_note",
    write: true,
    description: "Add markdown to the END of the user's note on a symbol (a blank line is put in between). You cannot replace or edit what is there: the page autosaves the note, so only appending is safe. Say in the text that it comes from you, e.g. start with a dated heading.",
    input: { key: z.string().describe(`The symbol: ${KEY}`), text: z.string().max(20000).describe("Markdown to append") },
    run: (viewer, args) => {
      const key = keyOf(readConfig(viewer.dir), args.key);
      ops.appendNote(viewer, key, args.text);
      return { key, characters: readNote(viewer.dir, key)?.length ?? 0 };
    },
  }),

  tool({
    name: "append_journal",
    write: true,
    description: "Add markdown to the END of a week's review journal (the current week by default). Append only, like append_note; a week nobody has written yet starts from the page's section template, so begin your text with a heading of its own (`## …`).",
    input: { text: z.string().max(20000).describe("Markdown to append"), week: z.string().optional().describe("ISO week id such as `2026-W41`; default is the current week") },
    run: (viewer, args) => {
      const week = args.week ?? currentWeekId(readConfig(viewer.dir).sync.tz);
      ops.appendJournal(viewer, week, args.text);
      return { week, characters: readJournal(viewer.dir, week)?.length ?? 0 };
    },
  }),

  tool({
    name: "save_indicator",
    write: true,
    description: "Create or replace (same `id`) a formula indicator the user can switch on in the chart; a new one is switched on right away. Every statement of the formula is plotted as a line. Nothing is pushed: for monitoring use save_alert.",
    input: {
      id: z.string().describe("Letters, digits and underscores, not starting with a digit: `dev40`"),
      formula: z.string().describe("The formula, see formula_reference"),
      label: z.string().max(40).optional().describe("Name in the chart's legend; default is the id"),
      pane: z.enum(["main", "sub"]).default("sub").describe("`main`: over the candles (price-like values). `sub`: a pane of its own (default)."),
    },
    run: (viewer, args) => {
      ops.saveIndicator(viewer, { id: args.id, label: args.label ?? "", pane: args.pane, formula: args.formula });
      return { saved: args.id.trim() };
    },
  }),

  tool({
    name: "delete_indicator",
    write: true,
    description: "Delete a formula indicator by its id (the ones in the user's yaml; built-in indicators are not affected).",
    input: { id: z.string() },
    run: (viewer, args) => {
      if (!readConfig(viewer.dir).indicators.some((d) => d.id === args.id.trim())) throw new Error(`没有 id 为「${args.id}」的公式指标`);
      ops.deleteIndicator(viewer, args.id);
      return { deleted: args.id.trim() };
    },
  }),
];

/** An alert an agent named, or the page's own message when it is gone. */
function alertById({ dir }: Viewer, id: string) {
  const alert = readConfig(dir).alerts.find((a) => a.id === id.trim());
  if (!alert) throw new Error("这条警报已经不在 hebi8.yaml 里了");
  return alert;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

/**
 * Run a tool as `viewer` with the arguments as they came. Whatever goes wrong (bad arguments, a
 * read-only token on a write, an error from the operation) is the tool's result with `isError`,
 * which is where an agent looks; nothing is thrown.
 */
export async function callTool(viewer: Viewer, name: string, args: unknown): Promise<ToolResult> {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) return text(`Unknown tool: ${name}`, true);
  if (found.write && !viewer.canWrite) return text("这个令牌是只读的：请用户在设置页生成一个可写的令牌", true);
  const parsed = found.input.safeParse(args ?? {});
  if (!parsed.success) return text(`Invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}`, true);
  try {
    const result = await found.run(viewer, parsed.data as never);
    return text(typeof result === "string" ? result : JSON.stringify(result));
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err), true);
  }
}
