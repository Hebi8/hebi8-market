"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { confirmAlert, deleteAlert, refresh, renameSymbol, setBench, setPeriods, setUpdown } from "@/app/actions";
import type { AlertBadge, AlertView } from "@/lib/alert-view";
import type { SymbolStatus } from "@/lib/api-types";
import { columnSortKey, nextSort, sortOverviewRows, type OverviewSort, type OverviewSortKey } from "@/lib/columns";
import type { UpDown } from "@/lib/config";
import { SESSION_LABELS, changeColor, columnColor, fmtAgo, fmtColumnValue, fmtPct, fmtPrice } from "@/lib/format";
import { CHANGE_PERIODS, MAX_PERIODS, type ChangePeriod } from "@/lib/periods";
import { pricePrecision, type Stats } from "@/lib/stats";
import { SOURCE_LABELS, TF_LABELS, type Source } from "@/lib/symbols";
import { mergeTarget } from "@/lib/watchlist";
import { AlertDialog } from "./AlertDialog";
import { AlertBadgeList, AlertLegend } from "./AlertBadges";
import { ColumnsDialog, type OverviewColumn } from "./ColumnsDialog";
import { HINT_LABEL, useHeaderHint } from "./HeaderHint";
import { RowMenu } from "./RowMenu";
import { Sparkline } from "./Sparkline";
import { chartHref, guideSeen, useUi } from "./UiProvider";
import { rowAttrs } from "./use-drag-sort";
import { buttonAnchor, pointerAnchor, type MenuAnchor } from "./use-menu";
import { useWatchlist } from "./use-watchlist";
import { DragHandle, FoldButton, GroupMenu, NewGroup } from "./WatchlistParts";

export interface OverviewRow {
  key: string;
  name: string;
  /** The name written in the yaml, if any (kept on undo) */
  yamlName: string | null;
  ticker: string;
  source: Source | "expr";
  currency: string | null;
  bench: string | null;
  benchLabel: string | null;
  /** From today's bar built from the quote when `quote` is set */
  stats: Stats | null;
  /** Latest values of configured custom formula columns, by column id */
  columns: Record<string, number | null>;
  /** The quote the price comes from (newer than the daily sync); its session is set while it is current */
  quote: SymbolStatus | null;
  syncError: string | null;
  /** The viewer's alerts on this symbol, and the whole-watchlist ones where they hold */
  badges: AlertBadge[];
}

export interface OverviewData {
  groups: { name: string; items: OverviewRow[] }[];
  periods: ChangePeriod[];
  /** Custom formula columns configured in `hebi8.yaml` */
  columns: OverviewColumn[];
  updown: UpDown;
  /** Every alert of the viewer's vault, for the dialog (none for a visitor) */
  alerts: AlertView[];
  aliases: Record<string, string>;
  lastReviewDays: number | null;
  lastSync: number | null;
  firstRun: boolean;
  /** Muted lines above the table: yaml settings that are ignored */
  notices: string[];
  /** A visitor on a shared instance: sees the owner's list as the example, display choices stay in the page */
  readOnly: boolean;
}

/**
 * Column widths shared by every group, so the price column sits at the same x everywhere. The name
 * takes what is left (at least 140px) and the alerts as much as their badges need: up to two side by
 * side, one below 900px. The sparkline only fits from xl (1280px) up; below md the table becomes a list.
 */
const COL = { price: 112, period: 72, formula: 84, high: 96, menu: 28 }; // spark 200 comes from a CSS variable

/** What each change column is measured against (stats.ts: the close on or before that day). */
const SINCE: Record<ChangePeriod, string> = {
  "1W": "7 天前",
  "1M": "30 天前",
  "3M": "91 天前",
  YTD: "去年最后一个交易日",
  "1Y": "一年前",
  "3Y": "三年前",
  "5Y": "五年前",
};

const HINTS = {
  name: "标的名称，下一行是代码 · 数据源 · 币种。拖动行或分组标题调整顺序，顺序写回 hebi8.yaml",
  last: "最新价：最近一根日线的收盘价。\n自选里的标的另取报价（盘中每 5 分钟，盘前、盘后、休市每小时），价格下面标着时段和多久前取的，涨跌幅也按这个价算",
  high: "距高点：最新价比历史最高收盘低多少，0% 就是在历史高点。\n下面的短条是 52 周区间位置：最左是近 52 周最低价，最右是最高价，竖线是现在的价格",
  spark: "近两年的周收盘走势",
};

/** Under or beside a quoted price: its session while the quote is current and how old it is, 「盘后 · 40 分钟前」, just 「休市」, or just 「3 小时前」 once it is stale. */
function QuoteTag({ quote, className = "" }: { quote: SymbolStatus; className?: string }) {
  const session = quote.session && SESSION_LABELS[quote.session];
  const how = !quote.session ? "盘中每 5 分钟、其余时段每小时取一次" : quote.session === "open" || quote.session === "always" ? "每 5 分钟取一次" : "盘中以外每小时取一次";
  return (
    <span className={`text-[11px] whitespace-nowrap text-muted ${className}`} title={`${session ? `${session} · ` : ""}${fmtAgo(quote.quotedAt, "报价")}\n${how}，涨跌幅按这个价算`}>
      {/* a closed market's price does not age: the time stays in the title */}
      {quote.session === "closed" ? session : `${session ? `${session} · ` : ""}${fmtAgo(quote.quotedAt, "")}`}
    </span>
  );
}

/** Where the last close sits between the 52-week low (left) and high (right). */
function Range52({ pos }: { pos: number }) {
  const pct = Math.round(pos * 100);
  return (
    <div className="relative mt-1.5 ml-auto h-1 w-16 rounded bg-line" title={`52 周区间位置 ${pct}%：0% 是近 52 周最低，100% 是最高`}>
      <div className="absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-fg" style={{ left: `${pct}%` }} />
    </div>
  );
}

function PeriodPicker({ value, onChange }: { value: ChangePeriod[]; onChange: (next: ChangePeriod[]) => void }) {
  const toggle = (key: ChangePeriod) => {
    if (value.includes(key)) {
      if (value.length > 1) onChange(value.filter((k) => k !== key));
    } else if (value.length < MAX_PERIODS) {
      onChange([...value, key]);
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="mr-1 text-muted">显示的涨跌周期（最多 {MAX_PERIODS} 个）</span>
      {CHANGE_PERIODS.map(({ key, label }) => (
        <button key={key} onClick={() => toggle(key)} aria-pressed={value.includes(key)} className="btn btn-secondary">
          {label}
        </button>
      ))}
    </div>
  );
}

/** The row whose menu is open, and where. */
type RowMenuAt = { key: string; at: MenuAnchor };

/** The alert dialog of a row: a new alert on its symbol, or one of its badges. */
type AlertTarget = { row: OverviewRow; alert: AlertView | null };

function Th({
  label,
  hint,
  sortKey,
  sort,
  onSort,
  width,
  error = false,
  className = "",
}: {
  label: string;
  /** What the column means, in the header's hover card */
  hint: string;
  sortKey?: OverviewSortKey;
  sort: OverviewSort;
  onSort: (key: OverviewSortKey) => void;
  width?: number;
  error?: boolean;
  className?: string;
}) {
  const active = sortKey !== undefined && sort?.key === sortKey;
  const sorted = active ? (sort.dir < 0 ? "descending" : "ascending") : undefined;
  const sortHint = active ? (sort.dir < 0 ? "降序，再点升序" : "升序，再点恢复默认顺序") : "点击排序";
  const card = useHeaderHint(
    <>
      {hint}
      {sortKey && <span className="text-muted">{sortHint}</span>}
    </>,
  );
  return (
    <th {...card.hover} style={width ? { width } : undefined} aria-sort={sorted} className={`p-0 text-[11px] font-normal ${error ? "text-[var(--red)]" : "text-muted"} ${className}`}>
      {sortKey ? (
        <button
          {...card.trigger}
          onClick={() => {
            card.dismiss();
            onSort(sortKey);
          }}
          className={`flex h-7 w-full items-center gap-1 px-2 hover:text-fg ${className.includes("text-right") ? "justify-end" : ""} ${active ? "text-fg" : ""}`}
        >
          <span className={`${HINT_LABEL} truncate`}>{label}</span>
          <span className="w-2 shrink-0 text-[9px]">{active ? (sort.dir < 0 ? "▼" : "▲") : ""}</span>
        </button>
      ) : (
        <span tabIndex={0} {...card.trigger} className="flex h-7 cursor-help items-center px-2">
          <span className={HINT_LABEL}>{label}</span>
        </span>
      )}
      {card.panel}
    </th>
  );
}

export function Overview({ data }: { data: OverviewData }) {
  const router = useRouter();
  const { openSearch, toast, login, openGuide } = useUi();
  const readOnly = data.readOnly;
  const [, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<OverviewSort>(null);
  const [choosingPeriods, setChoosingPeriods] = useState(false);
  const [editingColumns, setEditingColumns] = useState(false);
  const [periods, setPeriodsState] = useState(data.periods);
  const [updown, setUpdownState] = useState(data.updown);
  const [message, setMessage] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<RowMenuAt | null>(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  const [alertTarget, setAlertTarget] = useState<AlertTarget | null>(null);
  const openAlert = (row: OverviewRow, id: string) => setAlertTarget({ row, alert: data.alerts.find((a) => a.id === id) ?? null });
  const activeSort = sort && sort.key.startsWith("col:") && !data.columns.some((c) => columnSortKey(c.id) === sort.key) ? null : sort;
  const wl = useWatchlist(data.groups, { readOnly, sorted: activeSort !== null });
  // an agent's alerts waiting to be confirmed (§2.5): no badge shows them, so they are listed above the table
  const drafts = data.alerts.filter((a) => a.draft);

  // the how-to opens once per browser, on the first visit to the overview
  useEffect(() => {
    if (!guideSeen()) openGuide();
  }, [openGuide]);

  useEffect(() => {
    if (!data.firstRun) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [data.firstRun, router]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setMessage(null);
        done?.();
      } else setMessage(result.error ?? "操作失败");
    });

  const onSort = (key: OverviewSortKey) => setSort((s) => nextSort(s, key));

  const changeUpdown = (next: UpDown) => {
    if (next === updown) return;
    setUpdownState(next);
    if (next === "red-up") document.documentElement.dataset.updown = "red-up";
    else delete document.documentElement.dataset.updown;
    if (!readOnly) act(() => setUpdown(next));
  };

  const remove = (row: OverviewRow, group: string) => {
    closeMenu();
    wl.edit.removeSymbol(row, group);
  };

  const shownPeriods = CHANGE_PERIODS.filter((p) => periods.includes(p.key));
  const groups = wl.groups;
  const groupNames = groups.map((g) => g.name);
  const colCount = 6 + shownPeriods.length + data.columns.length;

  const menu = (row: OverviewRow, group: string) =>
    menuFor?.key === row.key && (
      <RowMenu
        at={menuFor.at}
        readOnly={readOnly}
        onLogin={() => {
          closeMenu();
          login();
        }}
        name={row.name}
        group={group}
        groups={groupNames}
        benchLabel={row.benchLabel}
        onOpen={() => router.push(chartHref(row.key))}
        onMove={(target) => {
          closeMenu();
          wl.edit.moveSymbol(row.key, target, groups.find((g) => g.name === target)?.items.length ?? 0);
          toast(`${row.name} 已移到 ${target}`);
        }}
        onRename={(name) => {
          closeMenu();
          act(() => renameSymbol(row.key, name));
        }}
        onBench={(bench) => {
          closeMenu();
          act(() => setBench(row.key, bench));
        }}
        onRemove={() => remove(row, group)}
        onAddAlert={() => {
          closeMenu();
          setAlertTarget({ row, alert: null });
        }}
        onClose={closeMenu}
      />
    );

  const groupHead = (group: OverviewData["groups"][number]) => {
    const open = !wl.collapsed.includes(group.name);
    return (
      <>
        {wl.canDrag && <DragHandle label={`分组「${group.name}」`} onKeyDown={(e) => wl.drag.onHandleKeyDown(e, { kind: "group", name: group.name })} />}
        <FoldButton name={group.name} open={open} count={group.items.length} onToggle={() => wl.toggle(group.name)} />
        <span className="flex-1" />
        {!readOnly && (
          <GroupMenu
            name={group.name}
            count={group.items.length}
            mergeInto={mergeTarget(groups, group.name)}
            onRename={(next) => wl.edit.renameGroup(group.name, next)}
            onDelete={() => wl.edit.deleteGroup(group.name)}
          />
        )}
      </>
    );
  };

  return (
    <main className="mx-auto w-full max-w-[1400px] px-5 py-5">
      {data.notices.map((n) => (
        <p key={n} className="mb-2 text-xs text-muted">
          {n}
        </p>
      ))}
      {drafts.length > 0 && (
        <section className="mb-4 rounded-lg border border-line bg-card text-xs" aria-label="待确认的警报">
          <h2 className="border-b border-line px-3 py-2 font-medium">
            待确认的警报 <span className="font-normal text-muted">· agent 建的，确认后才开始判断</span>
          </h2>
          <ul className="divide-y divide-line">
            {drafts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={a.label}>
                    {a.label}
                  </span>
                  <span className="block truncate text-[11px] text-muted" title={a.summary}>
                    {a.name} · {a.summary}
                    {!a.notify && " · 不推送"}
                  </span>
                </span>
                <button type="button" className="btn btn-secondary h-6 px-1.5" onClick={() => act(() => confirmAlert(a.id), () => toast(`已确认警报「${a.label}」`))}>
                  确认
                </button>
                <button type="button" className="btn h-6 px-1.5 text-down" onClick={() => act(() => deleteAlert(a.id), () => toast(`已丢弃警报「${a.label}」`))}>
                  丢弃
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-medium">{readOnly ? "示例列表" : "自选"}</h1>
          <span className="text-xs text-muted">{fmtAgo(data.lastSync)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Link href="/review" className="btn">
            {data.lastReviewDays === null ? "还没有复盘" : data.lastReviewDays === 0 ? "今天复盘过" : `上次复盘 ${data.lastReviewDays} 天前`}
          </Link>
          <button onClick={() => setChoosingPeriods((v) => !v)} aria-pressed={choosingPeriods} className="btn" title="选择显示的涨跌周期">
            周期 · {shownPeriods.map((p) => p.label).join(" ")}
          </button>
          {!readOnly && (
            <button onClick={() => setEditingColumns(true)} aria-pressed={editingColumns} className="btn" title="管理总览的自定义公式列">
              {data.columns.length > 0 ? `公式列 · ${data.columns.length}` : "公式列"}
            </button>
          )}
          <div className="seg" role="group" aria-label="涨跌颜色">
            <button onClick={() => changeUpdown("green-up")} aria-pressed={updown === "green-up"}>
              绿涨
            </button>
            <button onClick={() => changeUpdown("red-up")} aria-pressed={updown === "red-up"}>
              红涨
            </button>
          </div>
          {!readOnly && (
            <>
              <button
                onClick={() => {
                  setRefreshing(true);
                  startTransition(async () => {
                    const result = await refresh();
                    setMessage(result.ok ? null : result.error);
                    setRefreshing(false);
                  });
                }}
                disabled={refreshing}
                className="btn"
              >
                {refreshing ? "同步中…" : "刷新"}
              </button>
              <button onClick={() => openSearch("", "add")} className="btn btn-secondary" title="搜索标的并加入自选">
                + 添加
              </button>
            </>
          )}
        </div>
      </div>

      {choosingPeriods && (
        <PeriodPicker
          value={periods}
          onChange={(next) => {
            setPeriodsState(next);
            if (!readOnly) act(() => setPeriods(next));
          }}
        />
      )}
      {message && <p className="mb-3 text-xs text-down">{message}</p>}
      {data.firstRun && <p className="mb-3 text-sm text-muted">首次拉取中，正在从数据源获取全部历史，稍等几秒…</p>}
      {groups.length === 0 && (
        <p className="mb-3 text-sm text-muted">
          还没有自选。点「+ 添加」，或按 <kbd className="rounded border border-line px-1 font-mono">/</kbd> 搜索后点结果行上的 +。
        </p>
      )}
      {activeSort && !readOnly && <p className="mb-2 text-[11px] text-muted">按列排序时不能拖动；再点表头直到恢复默认顺序，就可以拖动调整了。</p>}

      <div className="overflow-x-auto">
        <table className="hidden w-full border-separate border-spacing-0 text-xs md:table">
          <colgroup>
            <col />
            <col style={{ width: COL.price }} />
            {shownPeriods.map((p) => (
              <col key={p.key} style={{ width: COL.period }} />
            ))}
            {data.columns.map((c) => (
              <col key={c.id} style={{ width: COL.formula }} />
            ))}
            <col style={{ width: COL.high }} />
            {/* as narrow as the badges allow */}
            <col style={{ width: 1 }} />
            <col style={{ width: "var(--col-spark)" }} />
            <col style={{ width: COL.menu }} />
          </colgroup>
          <thead>
            <tr className="text-left">
              <Th label="名称" hint={readOnly ? HINTS.name.split("。")[0] : HINTS.name} sort={activeSort} onSort={onSort} />
              <Th label="价格" hint={HINTS.last} sortKey="last" sort={activeSort} onSort={onSort} className="text-right" />
              {shownPeriods.map((p) => (
                <Th key={p.key} label={p.label} hint={`${p.label}涨跌：最新价相对 ${SINCE[p.key]}收盘的涨跌幅`} sortKey={p.key} sort={activeSort} onSort={onSort} className="text-right" />
              ))}
              {data.columns.map((c) => (
                <Th
                  key={c.id}
                  label={c.label}
                  hint={c.error ? `${TF_LABELS[c.tf]}线 · ${c.formula}\n公式错误：${c.error}` : `${TF_LABELS[c.tf]}线 · ${c.formula}`}
                  sortKey={columnSortKey(c.id)}
                  sort={activeSort}
                  onSort={onSort}
                  error={Boolean(c.error)}
                  className="text-right"
                />
              ))}
              <Th label="距高点" hint={HINTS.high} sortKey="ddAth" sort={activeSort} onSort={onSort} className="text-right" />
              <th className="min-w-16 p-0 text-[11px] font-normal text-muted">
                <AlertLegend readOnly={readOnly} />
              </th>
              <Th label="两年" hint={HINTS.spark} sort={activeSort} onSort={onSort} className="wide-col" />
              <th />
            </tr>
          </thead>
          <tbody {...wl.drag.rootProps}>
            {groups.map((group) => (
              <GroupRows
                key={group.name}
                group={group}
                head={groupHead(group)}
                open={!wl.collapsed.includes(group.name)}
                sort={activeSort}
                colCount={colCount}
                shownPeriods={shownPeriods}
                columns={data.columns}
                openAlert={openAlert}
                menuFor={menuFor}
                setMenuFor={setMenuFor}
                menu={menu}
                wl={wl}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: one card per symbol, compact lines. */}
      <div className="md:hidden" {...wl.drag.rootProps}>
        {groups.map((group) => {
          const open = !wl.collapsed.includes(group.name);
          return (
            <section key={group.name} className="mb-4">
              <h2 {...rowAttrs(`g:${group.name}`, group.name, wl.drag)} className="mb-1 flex items-center gap-1 rounded px-1 text-xs font-medium">
                {groupHead(group)}
              </h2>
              {open && (
                <ul className="divide-y divide-line rounded-lg border border-line bg-card">
                  {group.items.length === 0 && (
                    <li {...rowAttrs(`e:${group.name}`, group.name, wl.drag)} className="px-3 py-2 text-xs text-muted">
                      这组还没有标的
                    </li>
                  )}
                  {sortOverviewRows(group.items, activeSort).map((row) => (
                    <li key={row.key} {...rowAttrs(`s:${row.key}`, group.name, wl.drag)} className="relative">
                      <div className="flex items-center">
                      {wl.canDrag && <DragHandle label={row.name} onKeyDown={(e) => wl.drag.onHandleKeyDown(e, { kind: "symbol", key: row.key })} className="ml-1" />}
                      <Link href={chartHref(row.key)} className="block min-w-0 flex-1 px-3 py-2 text-xs">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="truncate text-sm">{row.name}</span>
                          <span className="flex shrink-0 items-baseline gap-2">
                            {row.quote && <QuoteTag quote={row.quote} />}
                            <span className="tabular text-sm">{row.stats ? fmtPrice(row.stats.last) : "—"}</span>
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px]">
                          <span className="text-muted">{row.ticker}</span>
                          {shownPeriods.map((p) => (
                            <span key={p.key} className={`tabular ${changeColor(row.stats?.changes[p.key])}`}>
                              {p.label} {fmtPct(row.stats?.changes[p.key])}
                            </span>
                          ))}
                        </div>
                        {data.columns.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px]">
                            {data.columns.map((c) => {
                              const v = Object.hasOwn(row.columns, c.id) ? row.columns[c.id] : null;
                              return (
                                <span key={c.id} className="tabular">
                                  <span className="text-muted">{c.label}</span>{" "}
                                  <span className={columnColor(v, c.format)}>{fmtColumnValue(v, c.format)}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </Link>
                      </div>
                      {/* outside the link: a badge is a button */}
                      {row.badges.length > 0 && (
                        <div className="-mt-1 px-3 pb-2">
                          <AlertBadgeList badges={row.badges} onOpen={(id) => openAlert(row, id)} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {!readOnly && <NewGroup onAdd={wl.edit.addGroup} className="mt-3 h-6" />}
      <div aria-live="polite" className="sr-only">
        {wl.drag.announcement}
      </div>
      {editingColumns && !readOnly && (
        <ColumnsDialog
          columns={data.columns}
          aliases={data.aliases}
          onSaved={(label, isNew) => toast(isNew ? `已添加公式列「${label}」` : `已保存公式列「${label}」`)}
          onDeleted={(label) => toast(`已删除公式列「${label}」`)}
          onClose={() => setEditingColumns(false)}
        />
      )}
      {alertTarget && (
        <AlertDialog
          symbolKey={alertTarget.row.key}
          symbolName={alertTarget.row.name}
          alert={alertTarget.alert}
          price={alertTarget.row.stats?.last ?? null}
          precision={alertTarget.row.stats ? pricePrecision(alertTarget.row.stats.last) : 2}
          aliases={data.aliases}
          bench={alertTarget.row.bench}
          onSaved={() => {
            toast(alertTarget.alert ? "已保存警报" : "已创建警报");
            setAlertTarget(null);
          }}
          onDeleted={() => {
            toast(`已删除警报「${alertTarget.alert?.label}」`);
            setAlertTarget(null);
          }}
          onClose={() => setAlertTarget(null)}
        />
      )}
    </main>
  );
}

function GroupRows({
  group,
  head,
  open,
  sort,
  colCount,
  shownPeriods,
  columns,
  openAlert,
  menuFor,
  setMenuFor,
  menu,
  wl,
}: {
  group: OverviewData["groups"][number];
  head: React.ReactNode;
  open: boolean;
  sort: OverviewSort;
  colCount: number;
  shownPeriods: (typeof CHANGE_PERIODS)[number][];
  columns: OverviewColumn[];
  openAlert: (row: OverviewRow, id: string) => void;
  menuFor: RowMenuAt | null;
  setMenuFor: (menu: RowMenuAt | null) => void;
  menu: (row: OverviewRow, group: string) => React.ReactNode;
  wl: ReturnType<typeof useWatchlist<OverviewRow>>;
}) {
  const router = useRouter();
  const cell = "border-t border-line px-2 py-1.5";
  return (
    <>
      <tr {...rowAttrs(`g:${group.name}`, group.name, wl.drag)}>
        <td colSpan={colCount} className="pt-4 pb-1 text-[13px] font-medium">
          <div className="flex items-center gap-1">{head}</div>
        </td>
      </tr>
      {open && group.items.length === 0 && (
        <tr {...rowAttrs(`e:${group.name}`, group.name, wl.drag)}>
          <td colSpan={colCount} className={`${cell} text-muted`}>
            这组还没有标的
          </td>
        </tr>
      )}
      {open &&
        sortOverviewRows(group.items, sort).map((row) => {
          const s = row.stats;
          const href = chartHref(row.key);
          const menuOpen = menuFor?.key === row.key;
          return (
            <tr
              key={row.key}
              {...rowAttrs(`s:${row.key}`, group.name, wl.drag)}
              onClick={() => router.push(href)}
              onAuxClick={(e) => {
                if (e.button === 1) window.open(href, "_blank");
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor({ key: row.key, at: pointerAnchor(e, e.currentTarget.querySelector<HTMLElement>("[data-row-menu]")!) });
              }}
              className="group cursor-pointer bg-card hover:bg-bg/60"
            >
              <td className={`${cell} rounded-l-md`}>
                <div className="flex w-[140px] min-w-full items-center gap-1">
                  {!wl.readOnly && (
                    <DragHandle
                      label={row.name}
                      onKeyDown={(e) => wl.drag.onHandleKeyDown(e, { kind: "symbol", key: row.key })}
                      className={`-ml-1 ${wl.canDrag ? "" : "invisible"}`}
                    />
                  )}
                  <Link href={href} onClick={(e) => e.stopPropagation()} draggable={false} className="block min-w-0 flex-1">
                    <div className="truncate text-sm" title={row.name}>
                      {row.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted">
                      {row.ticker} · {row.source === "expr" ? "合成" : SOURCE_LABELS[row.source]}
                      {row.currency && ` · ${row.currency}`}
                    </div>
                    {row.syncError && (
                      <div className="truncate text-[11px] text-down" title={row.syncError}>
                        {row.syncError}
                      </div>
                    )}
                  </Link>
                </div>
              </td>
              <td className={`${cell} text-right`}>
                <div className="tabular text-sm">{s ? fmtPrice(s.last) : "—"}</div>
                {row.quote && <QuoteTag quote={row.quote} className="block truncate" />}
              </td>
              {shownPeriods.map((p) => (
                <td key={p.key} className={`tabular ${cell} text-right ${changeColor(s?.changes[p.key])}`}>
                  {fmtPct(s?.changes[p.key])}
                </td>
              ))}
              {columns.map((c) => {
                const v = Object.hasOwn(row.columns, c.id) ? row.columns[c.id] : null;
                return (
                  <td
                    key={c.id}
                    className={`font-mono tabular ${cell} text-right ${columnColor(v, c.format)}`}
                    title={v != null && Number.isFinite(v) ? String(Number(v.toPrecision(8))) : (c.error ?? undefined)}
                  >
                    {fmtColumnValue(v, c.format)}
                  </td>
                );
              })}
              <td className={`${cell} text-right`}>
                <div className={`tabular ${changeColor(s?.ddAth)}`}>{fmtPct(s?.ddAth)}</div>
                {s?.pos52 != null && <Range52 pos={s.pos52} />}
              </td>
              <td className={cell}>
                <div className="w-max max-w-[120px] min-[900px]:max-w-[204px]">
                  <AlertBadgeList badges={row.badges} onOpen={(id) => openAlert(row, id)} />
                </div>
              </td>
              <td className={`${cell} wide-col py-1`}>{s && <Sparkline values={s.spark} width={180} height={26} className="w-[180px]" />}</td>
              <td className="rounded-r-md border-t border-line py-1.5 text-right">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(menuOpen ? null : { key: row.key, at: buttonAnchor(e.currentTarget) });
                  }}
                  data-row-menu=""
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={`${row.name} 的操作`}
                  className={`h-6 w-6 rounded text-sm leading-none text-muted hover:bg-line hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 ${menuOpen ? "opacity-100" : "opacity-0"}`}
                >
                  ⋯
                </button>
                {menu(row, group.name)}
              </td>
            </tr>
          );
        })}
    </>
  );
}
