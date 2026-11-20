/**
 * The vault is the user's content: `hebi8.yaml`, notes, journal, chart state. Writes go through
 * temp file + rename; yaml edits keep comments and order by mutating the parsed document.
 *
 * Every function takes the vault directory: the root vault (`vaultDir()`), or on a shared
 * instance a person's `users/<login>/` (`userVaultDir()`). Callers get it from the viewer.
 * Those paths are runtime data, so a few reads tell Turbopack not to trace them (it would
 * otherwise pull the whole project into the build output).
 */
import fs from "node:fs";
import path from "node:path";
import { isAlias, isMap, isNode, isScalar, isSeq, parse, parseDocument, visit, type Alias, type Document, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import { ConfigError, INSTANCE_KEYS, isLogin, normalizeConfig, normalizeUserConfig, resolveKey, writtenGroupName, type Config } from "./config";
import { fileKey, hash6, isValidKey } from "./symbols";
import { applyOp, groupNames, opError, type WatchlistOp } from "./watchlist";
import { isWeekId } from "./week";

/** The root vault: the single user's, or the owner's on a shared instance. */
export function vaultDir(): string {
  return process.env.HEBI8_VAULT ?? path.join(process.cwd(), "vault");
}

/** Someone else's vault on a shared instance. GitHub logins are case-insensitive, so the directory is lower case. */
export function userVaultDir(login: string): string {
  if (!isLogin(login)) throw new Error(`无效的 GitHub 用户名「${login}」`);
  return path.join(vaultDir(), "users", login.toLowerCase());
}

// directories only ever come from vaultDir() / userVaultDir(), so the strings compare as they are
const isRoot = (dir: string) => dir === vaultDir();
const yamlPath = (dir: string) => path.join(dir, "hebi8.yaml");

/** First run: start from the example config so the sample groups show up. */
export function ensureVault(): void {
  const yaml = path.join(vaultDir(), "hebi8.yaml");
  if (fs.existsSync(yaml)) return;
  // spelled out: a loop over the names makes Turbopack trace the whole project
  fs.mkdirSync(path.join(vaultDir(), "notes"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir(), "journal"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir(), "charts"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "vault.example", "hebi8.yaml"), yaml);
}

/**
 * A person's first visit: their yaml starts as a copy of the root one without the instance
 * settings and the owner's alerts (the old `conditions` included, nothing is assigned to anyone),
 * with 美股、宏观、加密 first; notes, journal and charts start empty. Returns the directory.
 */
export function ensureUserVault(login: string): string {
  const dir = userVaultDir(login);
  if (fs.existsSync(yamlPath(dir))) return dir;
  const doc = parseYaml(fs.readFileSync(yamlPath(vaultDir()), "utf8"));
  const drop: string[] = [...INSTANCE_KEYS, "alerts", "conditions"];
  // the yaml library hangs a file's opening comment on the first key; keep it when that key goes
  const first = isMap(doc.contents) ? doc.contents.items[0]?.key : null;
  if (isScalar(first) && first.commentBefore && drop.includes(String(first.value))) {
    doc.commentBefore = [doc.commentBefore, first.commentBefore].filter(Boolean).join("\n");
  }
  for (const key of drop) doc.delete(key);
  leadGroups(doc);
  atomicWrite(yamlPath(dir), doc.toString({ lineWidth: 0 }));
  return dir;
}

/** A new list starts with these groups in this order; the rest follow as the owner has them. */
export const LEADING_GROUPS = ["美股", "宏观", "加密"];

function leadGroups(doc: Document): void {
  const groups = doc.get("groups");
  if (!isSeq(groups)) return;
  const rank = (g: unknown) => {
    const i = isMap(g) ? LEADING_GROUPS.indexOf(String(g.get("name") ?? "").trim()) : -1;
    return i < 0 ? LEADING_GROUPS.length : i;
  };
  // sort is stable, so the other groups keep their order
  groups.items = [...groups.items].sort((a, b) => rank(a) - rank(b));
}

export interface VaultRef {
  /** '' for the root vault, else the login in lower case (the `vault` column of stats and alert_state) */
  id: string;
  dir: string;
}

/** The root vault, plus everyone else's when the instance is shared (`owner` set in the root yaml). */
export function listVaults(owners: string[]): VaultRef[] {
  const out: VaultRef[] = [{ id: "", dir: vaultDir() }];
  const users = path.join(vaultDir(), "users");
  if (!owners.length || !fs.existsSync(users)) return out;
  const skip = new Set(owners.map((o) => o.toLowerCase()));
  for (const id of fs.readdirSync(users).sort()) {
    // owners use the root vault, even if they had a vault of their own before
    if (skip.has(id) || !isLogin(id) || id !== id.toLowerCase()) continue;
    const dir = path.join(users, id);
    if (fs.existsSync(yamlPath(dir))) out.push({ id, dir });
  }
  return out;
}

export interface VaultConfig extends VaultRef {
  config: Config;
}

/** Every vault that syncs, with its config. A broken root yaml throws; a person's broken yaml only leaves them out. */
export function loadVaults(): VaultConfig[] {
  const root = readConfig(vaultDir());
  return listVaults(root.owners).flatMap((v) => {
    if (v.id === "") return [{ ...v, config: root }];
    const { config, error } = readConfigSafe(v.dir);
    if (!config) console.warn(`[hebi8m] vault ${v.id} skipped: ${error}`);
    return config ? [{ ...v, config }] : [];
  });
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------- hebi8.yaml

/** Parsed configs by file; a user's also depends on the root config it was merged with. */
const cache = new Map<string, { mtimeMs: number; size: number; root: Config | null; config: Config }>();

function parseYaml(text: string): Document {
  const doc = parseDocument(text);
  const err = doc.errors[0];
  if (err) {
    const line = err.linePos?.[0]?.line;
    throw new ConfigError(`hebi8.yaml${line ? ` 第 ${line} 行` : ""}：${err.message.split("\n")[0]}`);
  }
  return doc;
}

const normalizeIn = (raw: unknown, root: Config | null) => (root ? normalizeUserConfig(raw, root) : normalizeConfig(raw));

export function readConfig(dir: string): Config {
  const file = yamlPath(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ConfigError(`找不到 ${file}`);
  }
  const root = isRoot(dir) ? null : readConfig(vaultDir());
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.root === root) return hit.config;
  const config = normalizeIn(parseYaml(fs.readFileSync(file, "utf8")).toJS(), root);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, root, config });
  return config;
}

/** When a vault's yaml was last written (ms). */
export const configMtime = (dir: string) => fs.statSync(yamlPath(dir)).mtimeMs;

export function readConfigSafe(dir: string): { config: Config | null; error: string | null } {
  try {
    return { config: readConfig(dir), error: null };
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Edit the yaml in place; the result is validated before it is written. `mutate` gets the document
 * and the config it reads as, from the same read, so what an edit checks (is the symbol there
 * already, what an alias stands for) is what it changes, however long the caller waited before.
 */
export function updateConfig(dir: string, mutate: (doc: Document, current: Config) => void): Config {
  const file = yamlPath(dir);
  const doc = parseYaml(fs.readFileSync(file, "utf8"));
  const root = isRoot(dir) ? null : readConfig(vaultDir());
  mutate(doc, normalizeIn(doc.toJS(), root));
  const config = normalizeIn(doc.toJS(), root);
  // Comments and order survive; the library re-spaces inline comments, which is as close as it gets.
  atomicWrite(file, doc.toString({ lineWidth: 0 }));
  cache.delete(file);
  return config;
}

/** Replace a scalar's value, keeping the comment on its line. */
export function setScalar(doc: Document, keyPath: (string | number)[], value: unknown): void {
  const node = doc.getIn(keyPath, true);
  if (isScalar(node)) node.value = value;
  else doc.setIn(keyPath, value);
}

/** Replace a list's items, keeping its flow style and comment. */
export function setList(doc: Document, keyPath: (string | number)[], values: unknown[]): void {
  const node = doc.getIn(keyPath, true);
  if (isSeq(node)) node.items = values.map((v) => doc.createNode(v));
  else doc.setIn(keyPath, doc.createNode(values, { flow: true }));
}

export function flowNode(doc: Document, value: unknown) {
  return doc.createNode(value, { flow: true });
}

/** A node as it reads: an alias (`*watch`) is the node its anchor marks. */
const resolved = (doc: Document, node: unknown) => (isAlias(node) ? node.resolve(doc) : node);

/** The list under `name` in a map, created empty when missing. */
export function seqOf(parent: YAMLMap, name: string, doc: Document): YAMLSeq {
  const existing = parent.get(name);
  if (isSeq(existing)) return existing;
  const seq = doc.createNode([]) as YAMLSeq;
  parent.set(name, seq);
  return seq;
}

/** The key a `groups[].symbols` entry stands for (`SPY`, `{ key: QQQ }`), aliases resolved. */
export function entryKey(item: unknown, aliases: Record<string, string>): string | null {
  const value = isMap(item) ? item.get("key") : isScalar(item) ? item.value : item;
  return typeof value === "string" ? resolveKey(value, aliases) : null;
}

/** Where a watched key lives in the document: its group's `symbols` list and the index in it. */
export function locateEntry(doc: Document, key: string, aliases: Record<string, string>): { symbols: YAMLSeq; index: number } | null {
  const groups = doc.get("groups");
  if (!isSeq(groups)) return null;
  for (const group of groups.items) {
    if (!isMap(group)) continue;
    const symbols = group.get("symbols");
    if (!isSeq(symbols)) continue;
    const index = symbols.items.findIndex((item) => entryKey(item, aliases) === key);
    if (index >= 0) return { symbols, index };
  }
  return null;
}

// Watchlist edits and yaml aliases. An edit changes only its target groups: the ones whose name or
// symbols change, a new one, a deleted one. Before anything changes, each target (and the `groups`
// list, `name` and `symbols` on the way to it) is made its own: one written as an alias becomes a
// copy in its place, and aliases elsewhere that read an anchor in it become copies, so no node
// another place reads is changed. A field is replaced where it is, added only when missing. After
// the edit, an alias that would now come before its anchor (or whose anchor went with a deleted
// group) is written out as a copy: every alias reads what it read before.

const hasAnchor = (n: Node) => !isAlias(n) && n.anchor !== undefined;

/** A node to stand where an alias to it stood: a copy without anchors, so nothing else reads it. */
function copyOf(node: Node): Node {
  const copy = node.clone() as Node;
  visit(copy, {
    Node: (_, n) => {
      if (!isAlias(n)) n.anchor = undefined;
    },
  });
  return copy;
}

/** Aliases anywhere that read an anchor of `node` (or, `within`, of anything in it) become copies. */
function unshare(doc: Document, node: Node, within: boolean): void {
  const anchored = new Set<Node>();
  if (within) {
    visit(node, {
      Node: (_, n) => {
        if (hasAnchor(n)) anchored.add(n);
      },
    });
  } else if (hasAnchor(node)) anchored.add(node);
  if (anchored.size === 0) return;
  visit(doc, {
    Alias: (_, alias) => {
      const source = alias.resolve(doc);
      if (source && anchored.has(source)) return copyOf(source);
    },
  });
}

/** The node at `key` of `parent` made its own (see above), so it can change in place. */
function own(doc: Document, parent: YAMLMap | YAMLSeq, key: string | number, within = true): unknown {
  let node: unknown = parent.get(key, true);
  if (isAlias(node)) {
    node = copyOf(node.resolve(doc)!);
    parent.set(key, node);
  }
  if (isNode(node)) unshare(doc, node, within);
  return node;
}

/** The `groups` list as its own node (the groups in it are not touched), created empty when missing. */
function ownGroups(doc: Document): YAMLSeq {
  const root = doc.contents as YAMLMap;
  const groups = own(doc, root, "groups", false);
  return isSeq(groups) ? groups : seqOf(root, "groups", doc);
}

/** Group `i` with its `name` and `symbols` as its own nodes; null when it is not a map. */
function ownGroup(doc: Document, groups: YAMLSeq, i: number): YAMLMap | null {
  const group = own(doc, groups, i);
  if (!isMap(group)) return null;
  own(doc, group, "name");
  own(doc, group, "symbols");
  return group;
}

/** Each group's `name` as written (aliases resolved, as the config reader has them). */
const writtenNames = (doc: Document, groups: YAMLSeq) =>
  groups.items.map((g) => {
    const map = resolved(doc, g);
    return writtenGroupName(isMap(map) ? (map.toJS(doc) as { name?: unknown }).name : null);
  });

/** Replace a map's `name`, keeping the comment on its line; added first when there is none. */
function setName(doc: Document, map: YAMLMap, name: string | null): void {
  const node = map.get("name", true);
  if (isScalar(node)) node.value = name;
  else if (map.has("name")) map.set("name", name);
  else map.items.unshift(doc.createPair("name", name));
}

/** The group shown as `name`, as its own node with its own `symbols`; added at the end when there is none. */
export function groupNode(doc: Document, name: string): YAMLMap {
  const groups = ownGroups(doc);
  const i = groupNames(writtenNames(doc, groups)).indexOf(name);
  const group = i >= 0 ? ownGroup(doc, groups, i) : null;
  if (group) return group;
  const node = doc.createNode({ name, symbols: [] }) as YAMLMap;
  if (i >= 0) groups.items[i] = node;
  else groups.add(node);
  return node;
}

/** The groups as the page has them, each with its node and its entries' nodes. */
function readGroups(doc: Document, groups: YAMLSeq, aliases: Record<string, string>) {
  const written = writtenNames(doc, groups);
  const names = groupNames(written);
  return groups.items.map((node, i) => {
    const map = resolved(doc, node);
    const symbols = isMap(map) ? resolved(doc, map.get("symbols", true)) : null;
    const entries = isSeq(symbols) ? symbols.items : [];
    const keyOf = (entry: unknown) => {
      const value = resolved(doc, entry);
      const ref = isMap(value) ? (value.toJS(doc) as { key?: unknown }).key : isScalar(value) ? value.value : null;
      return typeof ref === "string" ? resolveKey(ref, aliases) : "";
    };
    return { name: names[i], node: node as unknown, written: written[i], entries, items: entries.map((entry) => ({ key: keyOf(entry), entry })) };
  });
}

/**
 * Apply a watchlist edit to the yaml with the page's own rules (`applyOp`), changing only its target
 * groups (see above): entries move as the nodes they are, so comments and fields go with them. A
 * group whose shown name would change when read again (an unnamed one that moved, one renamed)
 * gets the name it is shown with written down, so the next edit finds the same group. Throws what
 * `opError` says.
 */
export function editGroups(doc: Document, op: WatchlistOp, aliases: Record<string, string>): void {
  const plan = () => {
    const seq = ownGroups(doc);
    const groups = readGroups(doc, seq, aliases);
    const error = opError(groups, op);
    if (error) throw new Error(error);
    const next = applyOp(groups, op);
    const old = next.map((g) => groups.findIndex((o) => o.node === g.node && g.node !== undefined));
    // a group added by the edit has no node yet; write the name of any whose shown name would change
    const writing = next.map((g, i) => (old[i] >= 0 ? g.written : g.name));
    for (let shown = groupNames(writing); shown.some((name, i) => name !== next[i].name); shown = groupNames(writing)) {
      shown.forEach((name, i) => {
        if (name !== next[i].name) writing[i] = next[i].name;
      });
    }
    const keys = (items: { key: string }[]) => items.map((item) => item.key).join("\n");
    const changed = next.map((g, i) => old[i] < 0 || writing[i] !== g.written || keys(g.items) !== keys(groups[old[i]].items));
    const targets = groups.flatMap((_, j) => (old.includes(j) && !changed[old.indexOf(j)] ? [] : [j]));
    return { seq, groups, next, old, writing, changed, targets };
  };
  // make the targets their own first, then plan again on the nodes as they are now
  const first = plan();
  for (const j of first.targets) ownGroup(doc, first.seq, j);
  // what each alias reads before anything moves
  const sources = new Map<Alias, Node | undefined>();
  visit(doc, {
    Alias: (_, alias) => {
      sources.set(alias, alias.resolve(doc));
    },
  });
  const { seq, next, old, writing, changed } = plan();
  seq.items = next.map((g, i) => {
    if (!changed[i]) return g.node;
    const map = isMap(g.node) ? g.node : (doc.createNode({}) as YAMLMap);
    if (old[i] < 0 || writing[i] !== g.written) setName(doc, map, writing[i]);
    const after = g.items.map((item) => item.entry);
    const symbols = map.get("symbols", true);
    if (isSeq(symbols)) {
      const kept = symbols.items.filter((entry) => after.includes(entry));
      // `[GOLD]` becomes a block list once it takes an entry or changes order, so an entry with a comment stays on one line
      if (after.length !== kept.length || after.some((entry, j) => entry !== kept[j])) symbols.flow = false;
      symbols.items = after;
    } else {
      const list = doc.createNode([]) as YAMLSeq;
      list.items = after;
      map.set("symbols", list);
    }
    return map;
  });
  visit(doc, {
    Alias: (_, alias) => {
      const source = sources.get(alias);
      if (source && alias.resolve(doc) !== source) return copyOf(source);
    },
  });
}

// ---------------------------------------------------------------------------- per-key files

/**
 * The frontmatter key (or json `key`) owns the file; when two keys sanitize to the same name
 * the later one gets a hash suffix.
 */
function ownedPath(dir: string, key: string, ext: string, keyOf: (text: string) => string | null): string {
  const plain = path.join(dir, fileKey(key) + ext);
  if (!fs.existsSync(plain)) return plain;
  const owner = keyOf(fs.readFileSync(plain, "utf8"));
  return owner === null || owner === key ? plain : path.join(dir, `${fileKey(key)}_${hash6(key)}${ext}`);
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function frontKey(text: string): string | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  try {
    const key = (parse(m[1]) as { key?: unknown })?.key;
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
}

function jsonKey(text: string): string | null {
  try {
    const key = (JSON.parse(text) as { key?: unknown })?.key;
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
}

const notePath = (dir: string, key: string) => ownedPath(path.join(dir, "notes"), key, ".md", frontKey);

export function readNote(dir: string, key: string): string | null {
  const file = notePath(dir, key);
  if (!fs.existsSync(/* turbopackIgnore: true */ file)) return null;
  return fs.readFileSync(/* turbopackIgnore: true */ file, "utf8").replace(FRONTMATTER, "");
}

/** When the note was last written, for telling a local draft from the file. */
export function noteMtime(dir: string, key: string): number | null {
  const file = notePath(dir, key);
  return fs.existsSync(/* turbopackIgnore: true */ file) ? fs.statSync(/* turbopackIgnore: true */ file).mtimeMs : null;
}

export function writeNote(dir: string, key: string, body: string): void {
  const file = notePath(dir, key);
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) {
    fs.rmSync(file, { force: true });
    return;
  }
  atomicWrite(file, `---\nkey: ${key}\n---\n${trimmed}\n`);
}

export function listNotes(dir: string): { key: string; body: string }[] {
  const notes = path.join(dir, "notes");
  if (!fs.existsSync(notes)) return [];
  return fs
    .readdirSync(notes)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      const text = fs.readFileSync(path.join(notes, f), "utf8");
      const key = frontKey(text);
      return key && isValidKey(key) ? [{ key, body: text.replace(FRONTMATTER, "") }] : [];
    });
}

// ---------------------------------------------------------------------------- journal

export const JOURNAL_TEMPLATE = "## 市场\n\n\n## 持仓与自选\n\n\n## 变动\n\n\n## 下周看什么\n\n";

const journalPath = (dir: string, week: string) => {
  if (!isWeekId(week)) throw new Error(`无效的周「${week}」`);
  return path.join(dir, "journal", `${week}.md`);
};

export function readJournal(dir: string, week: string): string | null {
  const file = journalPath(dir, week);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function journalMtime(dir: string, week: string): number | null {
  const file = journalPath(dir, week);
  return fs.existsSync(file) ? fs.statSync(file).mtimeMs : null;
}

export function writeJournal(dir: string, week: string, body: string): void {
  atomicWrite(journalPath(dir, week), body.replace(/\s+$/, "") + "\n");
}

/** Newest first. */
export function listJournals(dir: string): { week: string; mtimeMs: number }[] {
  const journal = path.join(dir, "journal");
  if (!fs.existsSync(journal)) return [];
  return fs
    .readdirSync(journal)
    .flatMap((f) => {
      const week = f.replace(/\.md$/, "");
      return f.endsWith(".md") && isWeekId(week) ? [{ week, mtimeMs: fs.statSync(path.join(journal, f)).mtimeMs }] : [];
    })
    .sort((a, b) => (a.week < b.week ? 1 : -1));
}

// ---------------------------------------------------------------------------- charts/<fileKey>.json

export interface CompareEntry {
  key: string;
  mode: "percent" | "pane";
  color: string;
}

export interface OverlaySpec {
  name: string;
  points: { timestamp: number; value: number }[];
  styles?: unknown;
  lock?: boolean;
  /** Hidden from the floating toolbar's eye; 显示所有绘图 brings it back */
  hidden?: boolean;
  extendData?: unknown;
  /** The TradingView drawing it was imported from (§5.5), so importing it again adds nothing */
  tvId?: string;
  /** The price scale it was drawn on, which its lines are straight in; older drawings have none and follow the axis */
  scale?: "log" | "linear";
}

export interface ChartState {
  compare: CompareEntry[];
  overlays: OverlaySpec[];
}

export const EMPTY_CHART_STATE: ChartState = { compare: [], overlays: [] };

const chartPath = (dir: string, key: string) => ownedPath(path.join(dir, "charts"), key, ".json", jsonKey);

function parseChartState(text: string): ChartState {
  try {
    const raw = JSON.parse(text) as Partial<ChartState>;
    return {
      compare: Array.isArray(raw.compare) ? raw.compare.filter((c) => isValidKey(c?.key)) : [],
      overlays: Array.isArray(raw.overlays) ? raw.overlays.filter((o) => typeof o?.name === "string") : [],
    };
  } catch {
    return EMPTY_CHART_STATE;
  }
}

export function readChartState(dir: string, key: string): ChartState {
  const file = chartPath(dir, key);
  return fs.existsSync(/* turbopackIgnore: true */ file) ? parseChartState(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) : EMPTY_CHART_STATE;
}

export function writeChartState(dir: string, key: string, state: ChartState): void {
  atomicWrite(chartPath(dir, key), JSON.stringify({ key, ...state }, null, 2) + "\n");
}

/** Compare targets across every chart, so they get synced too. */
export function compareKeys(dir: string): string[] {
  const charts = path.join(dir, "charts");
  if (!fs.existsSync(charts)) return [];
  return fs
    .readdirSync(charts)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => parseChartState(fs.readFileSync(path.join(charts, f), "utf8")).compare.map((c) => c.key));
}
