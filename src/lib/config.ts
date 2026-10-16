/** Typed view of `vault/hebi8.yaml`; pure so it can be tested without a file system. */
import type { LineDash } from "@/components/drawing-style";
import { compile } from "@/indicators/formula";
import { ALERT_CHECKS, ALERT_CONDS, defaultCheck, describeCondition, parseCondition, type AlertCheck, type AlertCondition, type AlertTrigger } from "./alert-conds";
import { CHANGE_PERIODS, DEFAULT_PERIODS, MAX_PERIODS, type ChangePeriod } from "./periods";
import type { Prices } from "./series";
import { DATA_ID, TF_LABELS, hash6, isSynthetic, isTimeframe, isValidKey, tickerOf, type Timeframe } from "./symbols";
import { parseSynth, synthName } from "./synth";

export type UpDown = "green-up" | "red-up";
export type ChartStyle = "candle_solid" | "candle_up_stroke" | "ohlc" | "area";
export const CHART_STYLES: Record<ChartStyle, string> = {
  candle_solid: "实心 K 线",
  candle_up_stroke: "空心阳线",
  ohlc: "美国线",
  area: "面积",
};

export interface WatchItem {
  key: string;
  /** Display name from the yaml; null falls back to what the source reports */
  name: string | null;
  bench: string | null;
  group: string;
}

export interface Group {
  name: string;
  symbols: WatchItem[];
}

export interface FormulaDef {
  id: string;
  label: string;
  pane: "main" | "sub";
  formula: string;
}

/**
 * An alert (§2.6): a TradingView-style condition or a formula, on one symbol or, without a key,
 * on every watched symbol. The overview shows each one under its name.
 */
export interface AlertDef {
  /** `alert:<id>` when given in the yaml, else a hash of the key and the condition (or formula and timeframe) */
  id: string;
  /** Null: every watched symbol */
  key: string | null;
  /** As written, or generated: 「BTC 上穿 130,000」 */
  label: string;
  /** What a message says after the symbol's name: the written label, else the condition or formula */
  text: string;
  /** The label as written in the yaml, null when generated */
  ownLabel: string | null;
  /** Exactly one of `condition` and `when` is set */
  condition: AlertCondition | null;
  when: string | null;
  /** Always D for conditions */
  tf: Timeframe;
  /** Always `bar` for the whole watchlist: each symbol fires at most once per bar */
  trigger: AlertTrigger;
  /** `price`: judged on today's live bar after every quote round (and after a sync); `close`: after a daily sync, on closed daily bars only */
  check: AlertCheck;
  enabled: boolean;
  /** False: only shown on the overview, never pushed */
  notify: boolean;
  /** 待确认 (`draft: true`): written down but not judged, pushed or shown on the overview until confirmed on the page; what an agent's alert on the whole watchlist starts as */
  draft: boolean;
  /** `by: agent`: created or last changed through the MCP endpoint */
  by: "agent" | null;
}

/** Whether an alert is judged at all: switched on and not waiting to be confirmed. */
export const isLive = (a: Pick<AlertDef, "enabled" | "draft">) => a.enabled && !a.draft;

export type ParamOverrides = Partial<Record<Timeframe, Record<string, number[]>>>;

/** One line of an indicator as restyled on its 样式 page; what is left out is KLineChart's default for that line. */
export interface LineOverride {
  /** `#rrggbb` */
  color?: string;
  /** 1–4 px */
  size?: number;
  dash?: LineDash;
}

export const LINE_WIDTHS = [1, 2, 3, 4];

export interface ChartPrefs {
  tf: Timeframe;
  log: boolean;
  style: ChartStyle;
  /** Enabled indicator names: built-in, custom, or formula ids */
  indicators: string[];
  params: ParamOverrides;
  /** Indicators moved off their usual pane (legend ⋯ → 移动到), by the same names as `indicators` */
  panes: Record<string, "main" | "sub">;
  /** Line styles by the same names as `indicators`, one entry per line in the order it is drawn; not per timeframe */
  styles: Record<string, LineOverride[]>;
}

export interface Config {
  /**
   * GitHub logins that own the root vault, e.g. one person's two accounts; any set means the
   * instance is shared (root vault only). The first is the one named on the page.
   */
  owners: string[];
  owner: string | null;
  sync: { at: string[]; tz: string };
  prices: Prices;
  periods: ChangePeriod[];
  updown: UpDown;
  aliases: Record<string, string>;
  groups: Group[];
  indicators: FormulaDef[];
  /** Including the old `conditions` list, read as alerts on the whole watchlist */
  alerts: AlertDef[];
  /** The old conditions' `alert_state` rules (`cond:<id>`) → the alert ids they continue as; empty once the yaml has moved them */
  conditionRules: Record<string, string>;
  /** Dataset name → git URL or local directory (absolute, `~/`, or relative to the vault) */
  datasets: Record<string, string>;
  chart: ChartPrefs;
  /** Daily limits that notify the owner once a day when passed (§1.7); root vault only */
  usage: UsageLimits;
  /** Instance settings written in a user's yaml, which only the root vault's count */
  ignored: string[];
}

/** Each limit is off when null. */
export interface UsageLimits {
  /** Distinct visitors through the public tunnel in a day */
  visitors: number | null;
  /** Upstream calls that look rate limited in a day, all sources together */
  limited: number | null;
}

export const USAGE_LIMITS: Record<keyof UsageLimits, string> = { visitors: "每日公网独立访客", limited: "每日上游疑似限流次数" };

export class ConfigError extends Error {}

export const DEFAULT_CHART: ChartPrefs = { tf: "W", log: true, style: "candle_solid", indicators: ["MA", "VOL"], params: {}, panes: {}, styles: {} };

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Aliases first, otherwise the reference is taken as a full key. */
export function resolveKey(ref: string, aliases: Record<string, string>): string {
  const r = ref.trim();
  return aliases[r] ?? r;
}

function checkKey(key: string, aliases: Record<string, string>, where: string): void {
  if (!isValidKey(key)) throw new ConfigError(`${where}：无效的 key「${key}」，应为 source:ticker 或 =表达式`);
  if (isSynthetic(key)) {
    try {
      parseSynth(key.slice(1), aliases);
    } catch (err) {
      throw new ConfigError(`${where}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function parseGroups(raw: unknown, aliases: Record<string, string>): Group[] {
  const seen = new Map<string, string>();
  return list(raw).map((g, gi) => {
    const group = obj(g);
    const name = text(group.name) ?? `组 ${gi + 1}`;
    const symbols = list(group.symbols).map((s, si) => {
      const where = `groups[${gi}].symbols[${si}]`;
      const entry = typeof s === "string" ? { key: s } : obj(s);
      const ref = text(entry.key);
      if (!ref) throw new ConfigError(`${where}：缺少 key`);
      const key = resolveKey(ref, aliases);
      checkKey(key, aliases, where);
      const benchRef = text(entry.bench);
      const bench = benchRef ? resolveKey(benchRef, aliases) : null;
      if (bench) checkKey(bench, aliases, `${where}.bench`);
      const owner = seen.get(key);
      if (owner) throw new ConfigError(`${where}：${key} 已经在「${owner}」组里，一个标的只能出现在一个组`);
      seen.set(key, name);
      return { key, name: text(entry.name), bench, group: name };
    });
    return { name, symbols };
  });
}

function parseParams(raw: unknown): ParamOverrides {
  const out: ParamOverrides = {};
  for (const [tf, byName] of Object.entries(obj(raw))) {
    if (!isTimeframe(tf)) continue;
    const params: Record<string, number[]> = {};
    for (const [name, values] of Object.entries(obj(byName))) {
      const nums = list(values).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length) params[name] = nums;
    }
    out[tf] = params;
  }
  return out;
}

/** `#abc` or `#aabbcc`, as lower-case `#aabbcc`; anything else is null. */
function hexColor(v: unknown): string | null {
  const m = typeof v === "string" ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

/** An indicator's line styles with the invalid values dropped; trailing lines left at their defaults go too. */
export function parseLineStyles(raw: unknown): LineOverride[] {
  const lines = list(raw).map((entry) => {
    const d = obj(entry);
    const color = hexColor(d.color);
    const size = Number(d.size);
    return {
      ...(color ? { color } : {}),
      ...(LINE_WIDTHS.includes(size) ? { size } : {}),
      ...(d.dash === "solid" || d.dash === "dashed" || d.dash === "dotted" ? { dash: d.dash as LineDash } : {}),
    };
  });
  while (lines.length && !Object.keys(lines.at(-1)!).length) lines.pop();
  return lines;
}

function parseStyles(raw: unknown): Record<string, LineOverride[]> {
  return Object.fromEntries(Object.entries(obj(raw)).flatMap(([name, lines]) => {
    const parsed = parseLineStyles(lines);
    return parsed.length ? [[name, parsed]] : [];
  }));
}

/** What GitHub allows in a login: letters, digits and single inner hyphens, at most 39 characters. */
export const isLogin = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/.test(v);

export function normalizeConfig(raw: unknown): Config {
  const root = obj(raw);

  const owners = root.owner == null ? [] : (Array.isArray(root.owner) ? root.owner : [root.owner]).map((o) => (typeof o === "string" ? o.trim() : o));
  for (const o of owners) if (!isLogin(o)) throw new ConfigError(`owner：「${String(o)}」不是 GitHub 用户名`);

  const sync = obj(root.sync);
  const at = list(sync.at)
    .map(String)
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  const tz = text(sync.tz) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new ConfigError(`sync.tz：无效的时区「${tz}」`);
  }

  const prices = root.prices ?? "split";
  if (prices !== "split" && prices !== "total") throw new ConfigError("prices 应为 split 或 total");

  const valid = new Set<string>(CHANGE_PERIODS.map((p) => p.key));
  const periods = list(root.periods)
    .map(String)
    .filter((p): p is ChangePeriod => valid.has(p))
    .slice(0, MAX_PERIODS);

  const updown = root.updown ?? "green-up";
  if (updown !== "green-up" && updown !== "red-up") throw new ConfigError("updown 应为 green-up 或 red-up");

  const aliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(obj(root.aliases))) {
    const key = text(value);
    if (!key) continue;
    if (!isValidKey(key)) throw new ConfigError(`aliases.${name}：无效的 key「${key}」`);
    aliases[name] = key;
  }

  const indicators = list(root.indicators).flatMap((raw, i) => {
    const d = obj(raw);
    const id = text(d.id);
    const formula = text(d.formula);
    if (!id || !formula) throw new ConfigError(`indicators[${i}]：需要 id 和 formula`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new ConfigError(`indicators[${i}]：id「${id}」只能用字母、数字、下划线`);
    return [{ id, label: text(d.label) ?? id, pane: d.pane === "main" ? ("main" as const) : ("sub" as const), formula }];
  });

  const alerts = list(root.alerts).map((raw, i) => parseAlert(raw, i, aliases));
  const taken = new Set(alerts.map((a) => a.id));
  const conditionRules: Record<string, string> = {};
  for (const [i, raw] of list(root.conditions).entries()) {
    const alert = parseAlert(conditionAsAlert(raw, taken), i, aliases, "conditions");
    alerts.push(alert);
    conditionRules[`cond:${text(obj(raw).id)}`] = alert.id;
  }
  const ids = new Set<string>();
  for (const a of alerts) {
    if (ids.has(a.id)) throw new ConfigError(`alerts：重复的规则「${a.id.slice(6)}」，同一条件只写一次，或给每条写不同的 id`);
    ids.add(a.id);
  }

  const datasets: Record<string, string> = {};
  for (const [name, value] of Object.entries(obj(root.datasets))) {
    const where = `datasets.${name}`;
    if (!DATA_ID.test(name)) throw new ConfigError(`${where}：名字只能用字母、数字、点、下划线、横线，并以字母或数字开头`);
    const location = text(value);
    if (!location) throw new ConfigError(`${where}：需要 git 地址或本机目录`);
    if (!isDatasetLocation(location)) throw new ConfigError(`${where}：「${location}」应为 https:// / ssh:// / git@ / file:// 地址，或以 / ~/ ./ ../ 开头的目录`);
    datasets[name] = location;
  }

  const rawUsage = obj(root.usage);
  const usage: UsageLimits = { visitors: null, limited: null };
  for (const k of Object.keys(USAGE_LIMITS) as (keyof UsageLimits)[]) {
    const v = rawUsage[k];
    if (v == null) continue;
    if (!Number.isInteger(v) || (v as number) < 1) throw new ConfigError(`usage.${k}：应为正整数`);
    usage[k] = v as number;
  }

  const chart = obj(root.chart);
  const style = chart.style ?? DEFAULT_CHART.style;
  if (typeof style !== "string" || !(style in CHART_STYLES)) throw new ConfigError(`chart.style：未知样式「${String(style)}」`);

  return {
    owners: owners as string[],
    owner: (owners[0] as string | undefined) ?? null,
    sync: { at: at.length ? at : ["07:30", "17:30"], tz },
    prices,
    periods: periods.length ? periods : DEFAULT_PERIODS,
    updown,
    aliases,
    groups: parseGroups(root.groups, aliases),
    indicators,
    alerts,
    conditionRules,
    datasets,
    chart: {
      tf: isTimeframe(chart.tf) ? chart.tf : DEFAULT_CHART.tf,
      log: typeof chart.log === "boolean" ? chart.log : DEFAULT_CHART.log,
      style: style as ChartStyle,
      indicators: Array.isArray(chart.indicators) ? chart.indicators.map(String) : DEFAULT_CHART.indicators,
      params: parseParams(chart.params),
      panes: Object.fromEntries(Object.entries(obj(chart.panes)).filter((e): e is [string, "main" | "sub"] => e[1] === "main" || e[1] === "sub")),
      styles: parseStyles(chart.styles),
    },
    usage,
    ignored: [],
  };
}

/** Settings that belong to the instance, not a person: read from the root vault only. */
export const INSTANCE_KEYS = ["owner", "sync", "datasets", "usage"] as const;

/** A user's yaml on a shared instance: the instance settings come from the root vault's config. */
export function normalizeUserConfig(raw: unknown, root: Config): Config {
  const own = { ...obj(raw) };
  const ignored = INSTANCE_KEYS.filter((k) => k in own);
  for (const k of INSTANCE_KEYS) delete own[k];
  return { ...normalizeConfig(own), owners: root.owners, owner: root.owner, sync: root.sync, datasets: root.datasets, usage: root.usage, ignored };
}

/** The short name an alert's generated label uses: the alias, else the ticker. */
const shortName = (key: string, aliases: Record<string, string>) => Object.entries(aliases).find(([, k]) => k === key)?.[0] ?? (isSynthetic(key) ? synthName(key) : tickerOf(key));

/**
 * The id an old condition keeps as an alert: its own, `cond-<id>` when an alert in `alerts` has
 * it already, none (a hash) when it is free text an alert id cannot be.
 */
export function conditionId(raw: unknown, taken: Set<string>): string | undefined {
  const id = text(raw);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  return taken.has(`alert:${id}`) ? `cond-${id}` : id;
}

/**
 * An entry of the old `conditions` list (`{ id, label, formula, tf: W by default, notify }`) as the
 * alert on the whole watchlist it now is; the first alert edit in the UI moves them into `alerts`.
 */
function conditionAsAlert(raw: unknown, taken: Set<string>): Record<string, unknown> {
  const d = obj(raw);
  return { id: conditionId(d.id, taken), label: d.label ?? d.id, when: d.formula, tf: isTimeframe(d.tf) ? d.tf : "W", notify: d.notify === true };
}

/** 「收盘价上穿 130,000」, 「5 根 K 线内上涨 3%」, or the formula with its timeframe. */
/** 「日线收盘」 or 「盘中价格」 when it is not what an alert of its kind does anyway. */
export function checkNote(a: Pick<AlertDef, "key" | "check">): string | null {
  return a.check === defaultCheck(a.key) ? null : ALERT_CHECKS[a.check];
}

export function describeAlert(a: Pick<AlertDef, "condition" | "when" | "tf">): string {
  if (a.condition) return a.condition.cond.startsWith("moving_") ? describeCondition(a.condition) : `收盘价${describeCondition(a.condition)}`;
  return `${TF_LABELS[a.tf]}线公式 ${a.when}`;
}

/** One entry of `alerts`; exported so a write-back can find an entry by its id. */
export function parseAlert(raw: unknown, i: number, aliases: Record<string, string>, list = "alerts"): AlertDef {
  const d = obj(raw);
  const where = `${list}[${i}]`;
  const ref = text(d.key);
  const key = ref ? resolveKey(ref, aliases) : null;
  if (key) checkKey(key, aliases, `${where}.key`);
  const when = text(d.when);
  if (when && d.cond !== undefined) throw new ConfigError(`${where}：when 和 cond 只能写一个`);
  if (!when && d.cond === undefined) throw new ConfigError(`${where}：需要 cond + value，或 when 公式`);
  let condition: AlertCondition | null = null;
  if (!when) {
    try {
      condition = parseCondition(d.cond, d.value);
    } catch (err) {
      throw new ConfigError(`${where}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!key && ALERT_CONDS[condition.cond].value !== "move") throw new ConfigError(`${where}：价格和通道条件要写 key；不写 key 的警报对全部自选生效，只能用涨跌 % 或 when 公式`);
  }
  const trigger = key ? (d.trigger ?? "once") : "bar";
  if (trigger !== "once" && trigger !== "bar") throw new ConfigError(`${where}：trigger 应为 once 或 bar`);
  for (const flag of ["enabled", "notify", "draft"]) {
    if (d[flag] !== undefined && typeof d[flag] !== "boolean") throw new ConfigError(`${where}：${flag} 应为 true 或 false`);
  }
  const check = d.check ?? defaultCheck(key);
  if (check !== "price" && check !== "close") throw new ConfigError(`${where}：check 应为 price（盘中价格）或 close（日线收盘）`);
  const tf = when && isTimeframe(d.tf) ? d.tf : ("D" as const);
  const own = text(d.id);
  if (own && !/^[A-Za-z0-9_-]+$/.test(own)) throw new ConfigError(`${where}：id「${own}」只能用字母、数字、下划线、横线`);
  // pausing, or switching the trigger or the check, keeps the id, so the alert keeps its state
  const scope = key ?? "*";
  const identity = condition ? `${scope}|${condition.cond}|${JSON.stringify(condition.value)}` : `${scope}|${when}|${tf}`;
  const label = text(d.label);
  const what = condition ? describeCondition(condition) : when!;
  return {
    id: `alert:${own ?? hash6(identity)}`,
    key,
    label: label ?? (condition && key ? `${shortName(key, aliases)} ${what}` : what),
    text: label ?? what,
    ownLabel: label,
    condition,
    when,
    tf,
    trigger,
    check,
    enabled: d.enabled !== false,
    notify: d.notify !== false,
    draft: d.draft === true,
    by: d.by === "agent" ? "agent" : null,
  };
}

/** Remote repos are cloned into the cache; anything path-like is read in place. */
export const isRemoteDataset = (location: string) => /^(https:\/\/|ssh:\/\/|file:\/\/|git@[^:]+:)/.test(location);
const isDatasetLocation = (location: string) => isRemoteDataset(location) || /^(\/|~\/|\.\.?\/)/.test(location);

export function allItems(cfg: Config): WatchItem[] {
  return cfg.groups.flatMap((g) => g.symbols);
}

export function findItem(cfg: Config, key: string): WatchItem | null {
  return allItems(cfg).find((s) => s.key === key) ?? null;
}

/** Every real key that needs syncing: watched symbols, benchmarks, formula references, synthetic operands. */
export function syncKeys(cfg: Config, extra: string[] = []): string[] {
  const keys = new Set<string>();
  const add = (key: string) => {
    if (!isValidKey(key)) return;
    if (!isSynthetic(key)) {
      keys.add(key);
      return;
    }
    try {
      parseSynth(key.slice(1), cfg.aliases).keys.forEach(add);
    } catch {
      // reported on the page, not here
    }
  };
  for (const item of allItems(cfg)) {
    add(item.key);
    if (item.bench) add(item.bench);
  }
  for (const formula of cfg.indicators.map((d) => d.formula).concat(cfg.alerts.flatMap((a) => (a.when ? [a.when] : [])))) {
    try {
      compile(formula, { aliases: cfg.aliases }).refs.forEach(add);
    } catch {
      // bad formulas are shown where they are used
    }
  }
  for (const alert of cfg.alerts) {
    if (!alert.key) continue;
    add(alert.key);
    const bench = findItem(cfg, alert.key)?.bench;
    if (bench) add(bench);
  }
  extra.forEach(add);
  return [...keys];
}
