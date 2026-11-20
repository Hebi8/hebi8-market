/**
 * Edits of the watchlist's groups as pure functions, the one set of rules for both sides: the page
 * applies an edit at once (optimistic) and the server applies the same one to the groups in the
 * yaml (`editGroups` in vault.ts), so what is written is what was shown. The overview table and
 * the chart's side panel share them.
 */

export interface ListGroup<T extends { key: string }> {
  name: string;
  items: T[];
}

/** Indexes count without the moved entry; out of range is clamped. */
export type WatchlistOp =
  | { type: "moveSymbol"; key: string; group: string; index: number }
  | { type: "removeSymbol"; key: string }
  | { type: "moveGroup"; name: string; index: number }
  | { type: "addGroup"; name: string }
  | { type: "renameGroup"; name: string; next: string }
  | { type: "deleteGroup"; name: string };

/** Which groups are folded is a browser preference, shared by the overview and the chart's panel. */
export const COLLAPSED_KEY = "hebi8:watchlist:collapsed";

/**
 * The names groups are shown with, which are also how an edit names a group: the name as written,
 * else「组 N」by position, with ` (2)`, ` (3)`… when a group before it, or any written name, has it
 * already. So no two groups share one, whatever the yaml says.
 */
export function groupNames(written: (string | null)[]): string[] {
  const named = new Set(written.filter((n): n is string => n !== null));
  const used = new Set<string>();
  return written.map((own, i) => {
    const base = own ?? `组 ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name) || (name !== own && named.has(name)); n++) name = `${base} (${n})`;
    used.add(name);
    return name;
  });
}

const insert = <T>(list: T[], index: number, item: T) => [...list.slice(0, index), item, ...list.slice(index)];

/** A drop position inside 0..length; the end when it is not a whole number. */
const position = (index: unknown, length: number) => (Number.isInteger(index) ? Math.min(Math.max(index as number, 0), length) : length);

/** Names as typed, trimmed. */
function clean(op: WatchlistOp): WatchlistOp {
  switch (op.type) {
    case "moveSymbol":
      return { ...op, group: op.group.trim() };
    case "renameGroup":
      return { ...op, name: op.name.trim(), next: op.next.trim() };
    case "removeSymbol":
      return op;
    default:
      return { ...op, name: op.name.trim() };
  }
}

/** The group a deleted group's symbols join: the one above, or below for the first; null when it is the only one. */
export function mergeTarget<T extends { key: string }>(groups: ListGroup<T>[], name: string): string | null {
  const i = groups.findIndex((g) => g.name === name);
  return groups[i - 1]?.name ?? groups[i + 1]?.name ?? null;
}

/** Why an edit cannot be made, as the person reads it; null when it can. Removing a symbol that is not there is fine: nothing happens. */
export function opError<T extends { key: string }>(groups: ListGroup<T>[], raw: WatchlistOp): string | null {
  const op = clean(raw);
  const has = (name: string) => groups.some((g) => g.name === name);
  const missing = (name: string) => `没有「${name}」这个分组`;
  switch (op.type) {
    case "moveSymbol":
      if (!op.group) return "请选择分组";
      return groups.some((g) => g.items.some((i) => i.key === op.key)) ? null : `${op.key} 不在自选里`;
    case "removeSymbol":
      return null;
    case "moveGroup":
      return has(op.name) ? null : missing(op.name);
    case "addGroup":
      if (!op.name) return "分组名不能为空";
      return has(op.name) ? `已经有「${op.name}」分组了` : null;
    case "renameGroup":
      if (!op.next) return "分组名不能为空";
      if (!has(op.name)) return missing(op.name);
      return op.next !== op.name && has(op.next) ? `已经有「${op.next}」分组了` : null;
    case "deleteGroup": {
      const group = groups.find((g) => g.name === op.name);
      if (!group) return missing(op.name);
      return group.items.length > 0 && mergeTarget(groups, op.name) === null ? "这是唯一的分组，先移除里面的标的" : null;
    }
  }
}

/** The groups after an edit; one `opError` refuses changes nothing. Groups and items keep whatever else they carry. */
export function applyOp<T extends { key: string }, G extends ListGroup<T>>(groups: G[], raw: WatchlistOp): G[] {
  if (opError(groups, raw)) return groups;
  const op = clean(raw);
  switch (op.type) {
    case "moveSymbol": {
      const item = groups.flatMap((g) => g.items).find((i) => i.key === op.key)!;
      const without = groups.map((g) => ({ ...g, items: g.items.filter((i) => i.key !== op.key) }));
      const target = without.find((g) => g.name === op.group);
      if (!target) return [...without, { name: op.group, items: [item] } as G];
      return without.map((g) => (g === target ? { ...g, items: insert(g.items, position(op.index, g.items.length), item) } : g));
    }
    case "removeSymbol":
      return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.key !== op.key) }));
    case "moveGroup": {
      const group = groups.find((g) => g.name === op.name)!;
      const rest = groups.filter((g) => g !== group);
      return insert(rest, position(op.index, rest.length), group);
    }
    case "addGroup":
      return [...groups, { name: op.name, items: [] } as unknown as G];
    case "renameGroup":
      return groups.map((g) => (g.name === op.name ? { ...g, name: op.next } : g));
    case "deleteGroup": {
      const i = groups.findIndex((g) => g.name === op.name);
      const moving = groups[i].items;
      const into = i > 0 ? i - 1 : 1;
      return groups.flatMap((g, j) => (j === i ? [] : j === into ? [{ ...g, items: i > 0 ? [...g.items, ...moving] : [...moving, ...g.items] }] : [g]));
    }
  }
}

/** One step up or down for the keyboard: across the edge of a group into the next one; null at either end. */
export function stepSymbol<T extends { key: string }>(groups: ListGroup<T>[], key: string, step: 1 | -1): { group: string; index: number } | null {
  const gi = groups.findIndex((g) => g.items.some((i) => i.key === key));
  if (gi < 0) return null;
  const items = groups[gi].items;
  const i = items.findIndex((x) => x.key === key);
  if (step < 0) {
    if (i > 0) return { group: groups[gi].name, index: i - 1 };
    const prev = groups[gi - 1];
    return prev ? { group: prev.name, index: prev.items.length } : null;
  }
  if (i < items.length - 1) return { group: groups[gi].name, index: i + 1 };
  const next = groups[gi + 1];
  return next ? { group: next.name, index: 0 } : null;
}

export function stepGroup<T extends { key: string }>(groups: ListGroup<T>[], name: string, step: 1 | -1): number | null {
  const i = groups.findIndex((g) => g.name === name);
  const to = i + step;
  return i < 0 || to < 0 || to >= groups.length ? null : to;
}
