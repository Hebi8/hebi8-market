/**
 * Alerts (§2.5, §2.6): the `alerts` list, on one symbol or (without a key) on every watched one.
 * `check: price` ones are judged after every 5-minute quote round on daily bars whose last one is
 * today's unfinished bar, and again when a daily sync ends; `check: close` ones only when a daily
 * sync ends, on the daily bars that are complete. State lives in the `alert_state` table, per
 * vault, so a restart does not repeat a message, event conditions compare with the previous
 * check, and the overview can tell which alerts fired when.
 */
import { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { crossed, observe, ALERT_CONDS, type AlertCondition, type AlertTrigger } from "./alert-conds";
import { closedReader, lastInputs, loadDaily, type DailyReader } from "./bars";
import { evalRule, type SeriesCache } from "./conditions";
import { allItems, conditionId, isLive, parseAlert, type AlertDef, type Config } from "./config";
import { getDb } from "./db";
import { nameOf } from "./names";
import { channelNames, channelsFor, deliver, formatDigest, type AlertEvent } from "./notify";
import type { ConditionResult } from "./stats";
import { listSymbols, readDaily } from "./store";
import { isTimeframe, type Timeframe } from "./symbols";
import { updateConfig, type VaultRef } from "./vault";

export interface StateRow {
  /** 0/1 for formulas and states; an event's position (-1, 0, 1, see `observe`) */
  state: number;
  firedBar: number | null;
  /** When it last fired (ms), as committed */
  firedAt?: number | null;
  /** The day of each input of the last daily bar the check that wrote this row saw, by key (`lastInputs`); a check where one of them is older is not taken */
  seen?: Record<string, number> | null;
}

type Decision = { fire: boolean; next: StateRow | null };

/**
 * Whether a bar at `t` may still fire after `firedBar` did: only a later one. The same bar fired
 * already, and an older one (a sync that failed or did not bring today's bar, judged between two
 * quote rounds) neither fires nor moves `firedBar` back, which would let today's bar fire twice.
 */
const mayFire = (firedBar: number | null | undefined, t: number | null): boolean => firedBar == null || t === null || t > firedBar;

/**
 * Formula alerts (`when`), pure. Unknown results leave the row alone;
 * the first sighting only records; a rule fires when it turns true, at most once per bar (a
 * weekly condition that flickers inside the unfinished week fires once).
 */
export function decide(row: StateRow | undefined, result: Pick<ConditionResult, "now" | "t">): Decision {
  if (result.now === null) return { fire: false, next: null };
  const now = result.now;
  const t = result.t ?? null;
  if (!row) return { fire: false, next: { state: now ? 1 : 0, firedBar: now ? t : null } };
  if (now && row.state === 0 && mayFire(row.firedBar, t)) return { fire: true, next: { state: 1, firedBar: t } };
  return { fire: false, next: { state: now ? 1 : 0, firedBar: row.firedBar } };
}

/**
 * TradingView conditions, pure. Events compare this check's side with the previous check's (the
 * first check only records); states fire whenever they hold, the first check included. `bar`
 * fires at most once per daily bar; `once` is switched off by the caller after it fires.
 */
export function decideCondition(c: AlertCondition, trigger: AlertTrigger, row: StateRow | undefined, seen: number | null, t: number | null): Decision {
  if (seen === null) return { fire: false, next: null };
  const firedThisBar = trigger === "bar" && !mayFire(row?.firedBar, t);
  const fire = !firedThisBar && (ALERT_CONDS[c.cond].kind === "event" ? row !== undefined && crossed(c.cond, row.state, seen) : seen === 1);
  return { fire, next: { state: seen, firedBar: fire ? t : (row?.firedBar ?? null) } };
}

interface Check {
  rule: string;
  key: string;
  text: string;
  tf: Timeframe;
  /** Set for `once` alerts, which are switched off after they fire */
  once: boolean;
  /** Off: a firing is recorded for the overview but not pushed */
  notify: boolean;
  /** The bars it was judged on, for the price in the message */
  read: DailyReader;
  /** How far those bars go: the day of each input of the last one, by key (`lastInputs`) */
  seen: Record<string, number>;
  decide: (row: StateRow | undefined) => Decision;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const log = (msg: string) => console.log(`[hebi8m] ${msg}`);

/** Which alerts a run judges: all of them after a daily sync, the `check: price` ones in a quote round, the whole-watchlist ones after one is saved. */
export type AlertPass = "sync" | "quotes" | "watchlist";

/** The symbols an alert covers: its own, or every watched one. */
export const alertKeys = (alert: AlertDef, cfg: Config): string[] => (alert.key ? [alert.key] : allItems(cfg).map((i) => i.key));

/**
 * Every (alert, symbol) pair to judge in this pass. `check: price` alerts see the bars `live`
 * gives (a quote round's, with today's unfinished bar); `check: close` ones only the daily bars
 * that are complete.
 */
function checks(cfg: Config, pass: AlertPass, live: DailyReader, who: string): Check[] {
  const out: Check[] = [];
  const closed = closedReader();
  // formulas on the same symbol, bars and timeframe share the loaded series
  const caches = new Map<string, SeriesCache>();
  const seen = new Map<string, Record<string, number>>();
  const seenOf = (key: string, check: string, read: DailyReader) => {
    const id = `${check}\u0000${key}`;
    if (!seen.has(id)) seen.set(id, Object.fromEntries(lastInputs(key, loadDaily(key, cfg.prices, cfg, read), cfg.aliases, read).map((input) => [input.key, input.t])));
    return seen.get(id)!;
  };
  for (const alert of cfg.alerts) {
    if (!isLive(alert) || (pass === "watchlist" && alert.key) || (pass === "quotes" && alert.check !== "price")) continue;
    const read = alert.check === "close" ? closed : live;
    // on the whole watchlist one line per alert, not per symbol (`bench` on a symbol without one is common)
    const failed: { key: string; error: string }[] = [];
    const fail = (key: string, error: string) => (alert.key ? log(`alert ${alert.id} on ${key}${who}: ${error}`) : failed.push({ key, error }));
    for (const key of alertKeys(alert, cfg)) {
      const base = { rule: alert.id, key, text: alert.text, tf: alert.tf, once: alert.trigger === "once", notify: alert.notify, read, seen: seenOf(key, alert.check, read) };
      if (alert.when) {
        const cacheId = `${alert.check}\u0000${key}`;
        const cache = caches.get(cacheId) ?? new Map();
        caches.set(cacheId, cache);
        const result = evalRule(key, alert.when, alert.tf, cfg, cache, read);
        if (result.error) fail(key, result.error);
        out.push({ ...base, decide: (row) => decide(row, result) });
        continue;
      }
      const condition = alert.condition!;
      let bars;
      try {
        bars = loadDaily(key, cfg.prices, cfg, read);
      } catch (err) {
        fail(key, message(err));
        continue;
      }
      const seen = observe(condition, bars);
      const t = bars.at(-1)?.t ?? null;
      out.push({ ...base, decide: (row) => decideCondition(condition, alert.trigger, row, seen, t) });
    }
    if (failed.length) log(`alert ${alert.id} failed on ${failed.length} watched symbol(s)${who}, ${failed[0].key}: ${failed[0].error}`);
  }
  return out;
}

export const stateId = (rule: string, key: string) => `${rule}\u0000${key}`;

/** Every (alert, symbol) row of a vault, by `stateId`. */
export function readState(vault: string): Map<string, StateRow> {
  const rows = getDb().prepare("SELECT rule, key, state, fired_bar, fired_at, seen FROM alert_state WHERE vault = ?").all(vault) as {
    rule: string;
    key: string;
    state: number | null;
    fired_bar: number | null;
    fired_at: number | null;
    seen: string | null;
  }[];
  return new Map(rows.map((r) => [stateId(r.rule, r.key), { state: r.state ?? 0, firedBar: r.fired_bar, firedAt: r.fired_at, seen: r.seen === null ? null : (JSON.parse(r.seen) as Record<string, number>) }]));
}

/** Rows of an alert that left the yaml, or of a symbol it no longer covers, start over (old `cond:` rows included). */
function writeState(vault: string, updates: { rule: string; key: string; row: StateRow; fired: boolean }[], keep: Set<string>): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO alert_state (vault, rule, key, state, fired_bar, fired_at, seen) VALUES (@vault, @rule, @key, @state, @firedBar, @firedAt, @seen)
     ON CONFLICT (vault, rule, key) DO UPDATE SET state = @state, fired_bar = @firedBar, fired_at = coalesce(@firedAt, fired_at), seen = @seen`,
  );
  const all = db.prepare("SELECT rule, key FROM alert_state WHERE vault = ?").all(vault) as { rule: string; key: string }[];
  const remove = db.prepare("DELETE FROM alert_state WHERE vault = ? AND rule = ? AND key = ?");
  db.transaction(() => {
    for (const u of updates) {
      upsert.run({ vault, rule: u.rule, key: u.key, state: u.row.state, firedBar: u.row.firedBar, firedAt: u.fired ? Date.now() : null, seen: u.row.seen && Object.keys(u.row.seen).length > 0 ? JSON.stringify(u.row.seen) : null });
    }
    for (const r of all) if (!keep.has(stateId(r.rule, r.key))) remove.run(vault, r.rule, r.key);
  })();
}

/** When each of a vault's alerts last fired (ms), by alert id. */
export function alertFiredAt(vault: string): Map<string, number> {
  const rows = getDb().prepare("SELECT rule, fired_at FROM alert_state WHERE vault = ? AND rule LIKE 'alert:%' AND fired_at IS NOT NULL").all(vault) as { rule: string; fired_at: number }[];
  return new Map(rows.map((r) => [r.rule, r.fired_at]));
}

/** An edited or resumed alert starts over: events record their side again, nothing counts as fired. */
export function forgetAlerts(vault: string, ids: string[]): void {
  const remove = getDb().prepare("DELETE FROM alert_state WHERE vault = ? AND rule = ?");
  for (const alertId of ids) remove.run(vault, alertId);
}

/** Where an alert sits in the yaml's `alerts` list, found by the id it parses to; -1 when gone. */
export function alertIndex(doc: Document, alertId: string, aliases: Record<string, string>): number {
  const seq = doc.get("alerts");
  if (!isSeq(seq)) return -1;
  return seq.items.findIndex((item, i) => {
    try {
      return parseAlert(isMap(item) ? item.toJSON() : item, i, aliases).id === alertId;
    } catch {
      return false;
    }
  });
}

/**
 * The migration of the old `conditions` list: each entry moves, as the node it is (comments and
 * aliases stay), to the end of `alerts` and becomes the alert on the whole watchlist it is read as:
 * `formula` is renamed `when`, the id is the one `conditionId` gives, and the old defaults are
 * written out (label = id, tf W, not pushed unless `notify: true`). Then `conditions` goes.
 */
function adoptConditions(doc: Document, alerts: YAMLSeq, cfg: Config): void {
  const moved = new Set(Object.values(cfg.conditionRules));
  const taken = new Set(cfg.alerts.map((a) => a.id).filter((id) => !moved.has(id)));
  const conditions = doc.get("conditions");
  const nodes = (isSeq(conditions) ? conditions.items : []) as YAMLMap[];
  // the comments on the `conditions:` line and above its first entry belong to the list; they go with that entry
  if (nodes[0] && isSeq(conditions) && conditions.commentBefore) nodes[0].commentBefore = [conditions.commentBefore, nodes[0].commentBefore].filter(Boolean).join("\n");
  for (const node of nodes) {
    const own = node.get("id");
    const id = conditionId(own, taken);
    const idNode = node.get("id", true);
    if (!id) node.delete("id");
    else if (isScalar(idNode)) idNode.value = id;
    const formula = node.items.find((pair) => isScalar(pair.key) && pair.key.value === "formula");
    if (formula && isScalar(formula.key)) formula.key.value = "when";
    if (!node.has("label")) node.set("label", own);
    if (!isTimeframe(node.get("tf"))) node.set("tf", "W");
    if (node.get("notify") !== true) node.set("notify", false);
    alerts.items.push(node);
  }
  doc.delete("conditions");
}

/**
 * The old conditions' state rows (`cond:<id>`) continue as their alerts' rows, so a condition that
 * fired this week still shows it and the next turn still pushes. Run before a vault's state is
 * read and before the yaml moves the conditions; a no-op once the rows are renamed.
 */
export function adoptConditionState(vault: string, cfg: Config): void {
  const rename = getDb().prepare("UPDATE OR IGNORE alert_state SET rule = ? WHERE vault = ? AND rule = ?");
  for (const [from, to] of Object.entries(cfg.conditionRules)) rename.run(to, vault, from);
}

/** Every UI edit of the alerts goes through here, so the old conditions become editable alerts first. */
export function editAlerts(dir: string, mutate: (doc: Document, alerts: YAMLSeq, current: Config) => void): Config {
  return updateConfig(dir, (doc, current) => {
    let alerts = doc.get("alerts");
    if (!isSeq(alerts)) {
      alerts = doc.createNode([]);
      doc.set("alerts", alerts);
    }
    const seq = alerts as YAMLSeq;
    // `alerts: []` from the example becomes a block list once it has entries
    seq.flow = false;
    if (doc.has("conditions")) adoptConditions(doc, seq, current);
    mutate(doc, seq, current);
  });
}

/** Switch alerts on or off in a vault's yaml, keeping comments. */
export function setAlertsEnabled(dir: string, ids: string[], enabled: boolean): void {
  editAlerts(dir, (doc, _, current) => {
    for (const alertId of ids) {
      const i = alertIndex(doc, alertId, current.aliases);
      if (i < 0) continue;
      // `enabled: true` is the default, so switching back on just drops the key
      if (enabled) doc.deleteIn(["alerts", i, "enabled"]);
      else doc.setIn(["alerts", i, "enabled"], false);
    }
  });
}

/** A daily sync and a quote round may end together; one vault's state is read and written by one run at a time. */
let queue: Promise<unknown> = Promise.resolve();

/** Alert edits and judging share the same queue, including delivery and its committed state. */
export function serializeAlerts<T>(run: () => T | Promise<T>): Promise<T> {
  const job = queue.then(run);
  queue = job.catch(() => undefined);
  return job;
}

/**
 * Judge one vault and deliver its events as one digest. `read` gives the bars `check: price` alerts
 * see (a quote round's live ones; the daily ones as synced by default). The config is loaded when the run starts, not when it is
 * queued, so a `once` alert switched off (or an alert paused) by the run before is seen as off.
 * Never throws; returns the events.
 */
export function runAlerts(vault: VaultRef, loadConfig: () => Config, pass: AlertPass = "sync", read?: DailyReader): Promise<AlertEvent[]> {
  return serializeAlerts(() => judge(vault, loadConfig, pass, read));
}

async function judge(vault: VaultRef, loadConfig: () => Config, pass: AlertPass, read: DailyReader | undefined): Promise<AlertEvent[]> {
  const who = vault.id ? ` (${vault.id})` : "";
  try {
    const cfg = loadConfig();
    adoptConditionState(vault.id, cfg);
    const list = checks(cfg, pass, read ?? readDaily, who);
    const state = readState(vault.id);
    const symbols = listSymbols();
    const updates: { rule: string; key: string; row: StateRow; fired: boolean; notify: boolean }[] = [];
    const events: AlertEvent[] = [];
    const switchOff: { rule: string; notify: boolean }[] = [];
    const retryOff: string[] = [];
    for (const c of list) {
      const row = state.get(stateId(c.rule, c.key));
      // Delivery already committed: retry the failed yaml switch-off without sending again.
      if (c.once && row?.firedAt != null) {
        retryOff.push(c.rule);
        continue;
      }
      // bars older than the ones the row was last judged on (a sync that failed or did not bring
      // today's bar, between two quote rounds; for a synthetic key, any operand's) are not news:
      // they neither fire nor turn it off. Only the same symbol is compared: an alias pointed at
      // another symbol starts it over.
      const was = row?.seen;
      if (was && Object.entries(c.seen).some(([key, t]) => key in was && t < was[key])) continue;
      const { fire, next } = c.decide(row);
      if (next) updates.push({ rule: c.rule, key: c.key, row: { ...next, seen: c.seen }, fired: fire, notify: c.notify });
      if (!fire) continue;
      if (c.once) switchOff.push({ rule: c.rule, notify: c.notify });
      if (!c.notify) continue;
      let close: number | null = null;
      try {
        close = loadDaily(c.key, cfg.prices, cfg, c.read).at(-1)?.c ?? null;
      } catch {
        // the name and label are enough
      }
      events.push({ rule: c.rule, key: c.key, name: nameOf(cfg, c.key, symbols[c.key]?.name), label: c.text, tf: c.tf, close });
    }
    // every row an alert in the yaml covers stays, so a switched-off alert can tell 已触发 from 已停止
    const keep = new Set(cfg.alerts.flatMap((a) => alertKeys(a, cfg).map((key) => stateId(a.id, key))));
    const commit = (delivered: boolean) => {
      // nothing got through: leave the pushed rows (and their `once` alerts) as they were so the next check tries again
      writeState(vault.id, delivered ? updates : updates.filter((u) => !(u.fired && u.notify)), keep);
      const stopped = [...retryOff, ...switchOff.filter((s) => delivered || !s.notify).map((s) => s.rule)];
      if (stopped.length === 0) return;
      try {
        setAlertsEnabled(vault.dir, stopped, false);
      } catch (err) {
        log(`could not switch off fired alerts${who}: ${message(err)}`);
      }
    };

    if (events.length === 0) {
      commit(true);
      return [];
    }
    const { config, error } = channelsFor(vault.id, cfg.owner);
    if (error) log(`notify.json: ${error}`);
    const { title, text } = formatDigest(events, config.link);
    log(`${events.length} new alert(s)${who}: ${events.map((e) => `${e.key} ${e.rule}`).join(", ")}`);
    if (channelNames(config).length === 0) {
      log(`no notification channel configured${who}, alerts only logged`);
      commit(true);
      return events;
    }
    const delivery = await deliver(config, title, text, events);
    for (const f of delivery.failed) log(`notify via ${f.channel}${who} failed: ${f.error}`);
    commit(delivery.sent.length > 0);
    return events;
  } catch (err) {
    log(`alerts${who} failed: ${message(err)}`);
    return [];
  }
}
