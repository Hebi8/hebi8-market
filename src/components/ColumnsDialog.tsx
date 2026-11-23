"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { deleteColumn, reorderColumns, saveColumn } from "@/app/actions";
import { FUNCTIONS, SERIES_VARS } from "@/indicators/formula";
import { compileFormula } from "@/indicators/formula-indicators";
import { COLUMN_EXAMPLES, COLUMN_FORMATS, MAX_COLUMNS, type ColumnDef, type ColumnFormat } from "@/lib/columns";
import { TF_LABELS, TIMEFRAMES, type Timeframe } from "@/lib/symbols";
import { Dialog } from "./Dialog";

export interface OverviewColumn extends ColumnDef {
  /** Compile error when a hand-edited yaml column is broken; null when valid */
  error: string | null;
}

interface ColumnsDialogProps {
  columns: OverviewColumn[];
  aliases: Record<string, string>;
  onSaved: (label: string, isNew: boolean) => void;
  onDeleted: (label: string) => void;
  onClose: () => void;
}

/** Manage custom overview formula columns: list, reorder, add, edit and delete. */
export function ColumnsDialog({ columns, aliases, onSaved, onDeleted, onClose }: ColumnsDialogProps) {
  // when none exist yet, open straight into creating the first one
  const [editing, setEditing] = useState<OverviewColumn | "new" | null>(() => (columns.length === 0 ? "new" : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (editing && columns.length > 0) setEditing(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, columns.length, onClose]);

  const move = async (from: number, to: number) => {
    if (busy || to < 0 || to >= columns.length) return;
    const ids = columns.map((c) => c.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    setBusy(true);
    setError(null);
    const result = await reorderColumns(ids);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const remove = async (col: OverviewColumn) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteColumn(col.id);
    setBusy(false);
    if (result.ok) {
      onDeleted(col.label);
      if (editing !== "new" && editing?.id === col.id) setEditing(null);
    } else {
      setError(result.error);
    }
  };

  if (editing) {
    const leave = () => {
      if (columns.length === 0) onClose();
      else setEditing(null);
    };
    return (
      <Dialog title={editing === "new" ? "新建公式列" : `编辑公式列 · ${editing.label}`} onClose={onClose} className="max-w-[560px]">
        <ColumnEditor
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          aliases={aliases}
          onSave={async (input) => {
            const result = await saveColumn(input);
            if (!result.ok) return result.error;
            onSaved(input.label, editing === "new");
            setEditing(null);
            return null;
          }}
          onDelete={
            editing === "new"
              ? undefined
              : async () => {
                  const result = await deleteColumn(editing.id);
                  if (!result.ok) return result.error;
                  onDeleted(editing.label);
                  setEditing(null);
                  return null;
                }
          }
          onCancel={leave}
        />
      </Dialog>
    );
  }

  return (
    <Dialog title="总览公式列" onClose={onClose} className="max-w-[540px]">
      <div className="flex flex-col gap-3 p-4 text-xs">
        {columns.length === 0 ? (
          <div className="rounded-md border border-line bg-bg/50 px-3 py-4 text-muted">
            <p>还没有自定义公式列。为每个自选标的显示一条公式的最新值，支持跨标的引用与点击表头排序。</p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span>快速添加：</span>
              {COLUMN_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    const result = await saveColumn({ label: ex.label, formula: ex.formula, tf: ex.tf, format: ex.format });
                    setBusy(false);
                    if (result.ok) onSaved(ex.label, true);
                    else setError(result.error);
                  }}
                  className="btn btn-secondary h-6 px-2"
                >
                  + {ex.title}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-bg/40">
            {columns.map((col, i) => (
              <li key={col.id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium text-fg">{col.label}</span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {TF_LABELS[col.tf]}线 · {COLUMN_FORMATS[col.format]}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted" title={col.formula}>
                    {col.formula}
                  </div>
                  {col.error && <div className="mt-0.5 text-[11px] text-[var(--red)]">{col.error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    className="btn h-6 w-6 px-0"
                    disabled={i === 0 || busy}
                    onClick={() => void move(i, i - 1)}
                    aria-label={`将「${col.label}」左移一列`}
                    title="左移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn h-6 w-6 px-0"
                    disabled={i === columns.length - 1 || busy}
                    onClick={() => void move(i, i + 1)}
                    aria-label={`将「${col.label}」右移一列`}
                    title="右移"
                  >
                    ↓
                  </button>
                  <button type="button" className="btn h-6 px-1.5" disabled={busy} onClick={() => setEditing(col)}>
                    编辑
                  </button>
                  <button type="button" className="btn h-6 px-1.5 text-[var(--red)]" disabled={busy} onClick={() => void remove(col)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-[var(--red)]">{error}</p>}
        <div className="-mx-4 -mb-4 flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="mr-auto text-[11px] text-muted">
            {columns.length} / {MAX_COLUMNS} 列
          </span>
          <button type="button" className="btn" onClick={onClose}>
            完成
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={columns.length >= MAX_COLUMNS || busy}
            title={columns.length >= MAX_COLUMNS ? `最多保留 ${MAX_COLUMNS} 个公式列` : undefined}
            onClick={() => setEditing("new")}
          >
            + 新建公式列
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ColumnEditor({
  initial,
  aliases,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: OverviewColumn | null;
  aliases: Record<string, string>;
  onSave: (input: { id?: string; label: string; formula: string; tf: Timeframe; format: ColumnFormat }) => Promise<string | null>;
  onDelete?: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [tf, setTf] = useState<Timeframe>(initial?.tf ?? "W");
  const [format, setFormat] = useState<ColumnFormat>(initial?.format ?? "number");
  const [formula, setFormula] = useState(initial?.formula ?? "");
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const compiled = useMemo(() => (formula.trim() ? compileFormula(formula, { aliases }) : null), [formula, aliases]);
  const valid = compiled !== null && compiled.error === null && label.trim() !== "";

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setServerError(null);
    const err = await fn();
    setBusy(false);
    if (err) setServerError(err);
  };

  const submit = () => {
    if (!valid || busy) return;
    void run(() =>
      onSave({
        ...(initial ? { id: initial.id } : {}),
        label: label.trim(),
        formula: formula.trim(),
        tf,
        format,
      }),
    );
  };

  return (
    <form
      className="flex flex-col gap-3 p-4 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="标题">
        <span className="flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="如：距200W、月RSI、量比"
            maxLength={40}
            autoFocus
            aria-label="列标题"
            className="input w-48"
          />
          {initial && <span className="font-mono text-[11px] text-muted">id: {initial.id}</span>}
        </span>
      </Field>
      <Field label="周期">
        <div className="seg max-w-full overflow-x-auto" role="group" aria-label="周期">
          {TIMEFRAMES.map((t) => (
            <button key={t} type="button" aria-pressed={tf === t} onClick={() => setTf(t)}>
              {TF_LABELS[t]}线
            </button>
          ))}
        </div>
      </Field>
      <Field label="格式">
        <div className="seg max-w-full overflow-x-auto" role="group" aria-label="展示格式">
          {(Object.keys(COLUMN_FORMATS) as ColumnFormat[]).map((f) => (
            <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)}>
              {COLUMN_FORMATS[f]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="公式">
        <div className="flex flex-col gap-1.5">
          <textarea
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            spellCheck={false}
            aria-label="公式"
            placeholder="(close / sma(close, 200) - 1) * 100"
            className="input h-auto w-full resize-y py-1.5 font-mono leading-5"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {compiled === null ? (
              <span className="text-muted">多行公式取最后一行最新值；支持 bench、跨标的 close(DXY)、yearopen 等</span>
            ) : compiled.error !== null ? (
              <span className="text-[var(--red)]">{compiled.error}</span>
            ) : (
              <span className="text-[#0f7640] dark:text-[var(--green)]">
                ✓ 公式有效{compiled.program.outputs.length > 1 ? `（取最后一行：${compiled.program.outputs.at(-1)}）` : ""}
              </span>
            )}
          </div>
          {!initial && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
              <span className="text-muted">示例：</span>
              {COLUMN_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => {
                    setLabel(ex.label);
                    setTf(ex.tf);
                    setFormat(ex.format);
                    setFormula(ex.formula);
                  }}
                  className="cursor-pointer text-accent hover:underline"
                >
                  {ex.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>

      {showHelp && (
        <div className="grid gap-2 rounded-md border border-line bg-bg/50 p-3 text-[11px] text-muted sm:grid-cols-2">
          <div>
            <div className="mb-1 text-fg">变量</div>
            {Object.entries(SERIES_VARS).map(([name, desc]) => (
              <div key={name}>
                <code className="text-fg">{name}</code> {desc}
              </div>
            ))}
            <div className="mt-2">
              别的标的：<code className="text-fg">close(DXY)</code>（别名）、<code className="text-fg">close(&quot;yahoo:SPY&quot;)</code>、
              <code className="text-fg">close(bench)</code>
            </div>
            <div className="mt-1">运算：+ - * / ^ 和括号；比较 &gt; &lt; &gt;= &lt;= == !=；逻辑 and or not</div>
          </div>
          <div>
            <div className="mb-1 text-fg">函数</div>
            {Object.entries(FUNCTIONS).map(([name, fn]) => {
              const end = fn.hint.indexOf(")") + 1;
              return (
                <div key={name}>
                  <code className="text-fg">{fn.hint.slice(0, end)}</code>
                  {fn.hint.slice(end)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted">
        {format === "pct" ? "百分比格式直接给公式结果加 %（如 roc(close, 20) 或 (close / sma(close, 200) - 1) * 100），不额外乘 100。" : "缺少基准、历史不足或计算无效的标的显示 —，排序时排在末尾。"}
      </p>
      {serverError && <p className="text-[var(--red)]">{serverError}</p>}

      <div className="-mx-4 -mb-4 flex items-center gap-2 border-t border-line px-4 py-3">
        {onDelete && (
          <button type="button" className="btn text-[var(--red)]" disabled={busy} onClick={() => void run(onDelete)}>
            删除
          </button>
        )}
        <button type="button" className="btn mr-auto" aria-pressed={showHelp} onClick={() => setShowHelp((v) => !v)}>
          {showHelp ? "收起语法" : "语法"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {busy ? "保存中…" : initial ? "保存" : "添加"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-3">
      <span className="leading-[26px] text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
