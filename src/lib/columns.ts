/** Custom formula columns shown on the overview table (§1.1, §5.1). */
import type { ChangePeriod } from "./periods";
import type { Stats } from "./stats";
import type { Timeframe } from "./symbols";

export type ColumnFormat = "number" | "pct" | "ratio";

export const COLUMN_FORMATS: Record<ColumnFormat, string> = {
  number: "数值",
  pct: "百分比 %",
  ratio: "倍数 x",
};

export const MAX_COLUMNS = 6;

/** Letters, digits, underscores and hyphens; matches explicit alert ids. */
export const COLUMN_ID = /^[A-Za-z0-9_-]+$/;

/** Prototype property names that must not be used as column ids. */
export const RESERVED_COLUMN_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const isValidColumnId = (id: string) => COLUMN_ID.test(id) && !RESERVED_COLUMN_IDS.has(id);

export function isColumnFormat(value: unknown): value is ColumnFormat {
  return value === "number" || value === "pct" || value === "ratio";
}

export interface ColumnDef {
  id: string;
  label: string;
  formula: string;
  tf: Timeframe;
  format: ColumnFormat;
}

export interface ColumnExample extends Omit<ColumnDef, "id"> {
  /** Descriptive button text in the column editor */
  title: string;
}

export const COLUMN_EXAMPLES: ColumnExample[] = [
  { title: "距 200W 均线 %", label: "距200W", formula: "(close / sma(close, 200) - 1) * 100", tf: "W", format: "pct" },
  { title: "月线 RSI(14)", label: "月RSI", formula: "rsi(close, 14)", tf: "M", format: "number" },
  { title: "20 周量比", label: "量比", formula: "volume / sma(volume, 20)", tf: "W", format: "ratio" },
];

/** Generate a short unique column id that does not collide with `taken`. */
export function newColumnId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (let i = 0; i < 100; i++) {
    const id = `c${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) return id;
  }
  return `c${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------- overview sorting

export type OverviewSortKey = "last" | "ddAth" | ChangePeriod | `col:${string}`;
export type OverviewSort = { key: OverviewSortKey; dir: 1 | -1 } | null;

export const columnSortKey = (id: string): OverviewSortKey => `col:${id}`;

/** Three-state header sort cycle: descending → ascending → default order. */
export function nextSort(current: OverviewSort, key: OverviewSortKey): OverviewSort {
  if (current?.key !== key) return { key, dir: -1 };
  return current.dir === -1 ? { key, dir: 1 } : null;
}

export interface SortableOverviewRow {
  stats: Stats | null;
  columns: Record<string, number | null>;
}

export function sortOverviewValue(row: SortableOverviewRow, key: OverviewSortKey): number | null {
  if (key.startsWith("col:")) {
    const id = key.slice(4);
    const v = Object.hasOwn(row.columns, id) ? row.columns[id] : null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  const s = row.stats;
  if (!s) return null;
  if (key === "last") return s.last;
  if (key === "ddAth") return s.ddAth;
  return s.changes[key as ChangePeriod];
}

/** Sort rows by `sort`, always placing missing (`null`) values at the end. */
export function sortOverviewRows<T extends SortableOverviewRow>(rows: T[], sort: OverviewSort): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const va = sortOverviewValue(a, sort.key);
    const vb = sortOverviewValue(b, sort.key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * sort.dir;
  });
}
