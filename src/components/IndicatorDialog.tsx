"use client";

import { useState } from "react";
import { INDICATORS, type IndicatorDef } from "@/indicators/catalog";
import { LINE_WIDTHS, type FormulaDef, type LineOverride } from "@/lib/config";
import { TF_LABELS, type Timeframe } from "@/lib/symbols";
import type { IndicatorLine } from "./chart-types";
import { IconCheck, IconLineDash, IconPencil, IconSearch } from "./chart-icons";
import { Dialog, Dropdown } from "./Dialog";
import { DASHES, Swatches } from "./DrawingToolbar";
import { FormulaEditor, type FormulaScope } from "./FormulaEditor";

export interface FormulaStatus {
  def: FormulaDef;
  /** Why it cannot run for this symbol (e.g. no benchmark), or null */
  error: string | null;
}

type Category = "builtin" | "formula";

interface IndicatorDialogProps {
  enabled: string[];
  hasBenchmark: boolean;
  formulas: FormulaStatus[];
  scope: FormulaScope;
  /** Open straight into the formula editor (from a legend row's settings) */
  initialFormula?: FormulaDef | "new" | null;
  onToggle: (name: string) => void;
  onSaveFormula: (def: FormulaDef) => Promise<string | null>;
  onDeleteFormula: (id: string) => Promise<string | null>;
  /** A saved formula's lines for its 样式 tab; null while it does not compile */
  linesOf: (def: FormulaDef) => IndicatorLine[] | null;
  styles: Record<string, LineOverride[]>;
  /** Shown on the chart while the 样式 tab is open, saved only by 确定 */
  onPreviewStyles: (id: string, lines: LineOverride[]) => void;
  onSaveStyles: (id: string, lines: LineOverride[] | null) => void;
  onClose: () => void;
}

/** TradingView's「指标」dialog: search, categories on the left, click a row to add (or remove) it. */
export function IndicatorDialog({
  enabled,
  hasBenchmark,
  formulas,
  scope,
  initialFormula = null,
  onToggle,
  onSaveFormula,
  onDeleteFormula,
  linesOf,
  styles,
  onPreviewStyles,
  onSaveStyles,
  onClose,
}: IndicatorDialogProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>(initialFormula ? "formula" : "builtin");
  const [editing, setEditing] = useState<FormulaDef | "new" | null>(initialFormula);
  const [tab, setTab] = useState<SettingsTab>("inputs");
  const q = query.trim().toLowerCase();
  const match = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const builtins = INDICATORS.filter((d) => match(d.label, d.name, d.hint));
  const mine = formulas.filter((f) => match(f.def.label, f.def.id, f.def.formula));
  // a search spans both categories, like TradingView's
  const showBuiltin = q ? builtins.length > 0 : category === "builtin";
  const showMine = q ? true : category === "formula";

  const row = "flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-fg/5 disabled:cursor-default disabled:opacity-45";

  if (editing) {
    // a formula's inputs are its source; its lines have a 样式 tab once it is saved and compiles
    const lines = editing === "new" ? null : linesOf(editing);
    const leave = () => {
      setEditing(null);
      setTab("inputs");
    };
    return (
      <Dialog title={editing === "new" ? "新建公式" : `编辑公式 · ${editing.label}`} onClose={onClose} className="max-w-[760px]">
        {lines && editing !== "new" && <SettingsTabs tab={tab} onTab={setTab} />}
        {lines && editing !== "new" && tab === "style" && (
          <StyleForm
            key={editing.id}
            lines={lines}
            value={styles[editing.id] ?? []}
            onPreview={(next) => onPreviewStyles(editing.id, next)}
            onSave={(next) => {
              onSaveStyles(editing.id, next);
              leave();
            }}
            onClose={leave}
          />
        )}
        {/* hidden, not unmounted, on the 样式 tab: an edit not saved yet is still there on the way back */}
        <div className={`overflow-y-auto p-3 ${tab === "style" && lines ? "hidden" : ""}`}>
          <FormulaEditor
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? null : editing}
            scope={scope}
            onSave={async (def) => {
              const error = await onSaveFormula(def);
              if (!error) setEditing(null);
              return error;
            }}
            onDelete={
              editing === "new"
                ? undefined
                : async () => {
                    const error = await onDeleteFormula(editing.id);
                    if (!error) setEditing(null);
                    return error;
                  }
            }
            onClose={() => setEditing(null)}
          />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="指标" onClose={onClose} className="max-w-[680px] min-h-[min(407px,84dvh)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4">
        <IconSearch className="text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索"
          autoFocus
          spellCheck={false}
          className="h-10 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-40 shrink-0 flex-col gap-0.5 border-r border-line p-2 text-[13px] sm:flex">
          {(
            [
              ["builtin", "内置"],
              ["formula", "我的公式"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setCategory(id);
                setQuery("");
              }}
              className={`rounded px-3 py-1.5 text-left ${!q && category === id ? "bg-fg/10 font-medium" : "text-muted hover:bg-fg/5 hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto overscroll-contain py-1">
          {/* narrow screens: categories as a segmented row */}
          {!q && (
            <div className="seg mx-4 my-2 sm:hidden">
              <button type="button" aria-pressed={category === "builtin"} onClick={() => setCategory("builtin")}>
                内置
              </button>
              <button type="button" aria-pressed={category === "formula"} onClick={() => setCategory("formula")}>
                我的公式
              </button>
            </div>
          )}
          {showBuiltin && (
            <>
              {q && <div className="px-4 pt-2 pb-1 text-[11px] text-muted">内置</div>}
              {builtins.map((def) => {
                const on = enabled.includes(def.name);
                const unavailable = def.needsBenchmark && !hasBenchmark;
                return (
                  <button
                    key={def.name}
                    type="button"
                    disabled={unavailable}
                    onClick={() => onToggle(def.name)}
                    className={row}
                    title={unavailable ? "需要在 hebi8.yaml 里给这个标的设置 bench" : on ? "已添加，点击移除" : "添加到图表"}
                  >
                    <span className="w-4 shrink-0 text-accent">{on && <IconCheck size={16} />}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {def.label}
                      {def.label !== def.name && <span className="ml-2 font-mono text-[11px] text-muted">{def.name}</span>}
                    </span>
                    <span className="hidden shrink-0 truncate text-[11px] text-muted sm:inline">{unavailable ? "需要基准" : def.hint}</span>
                  </button>
                );
              })}
            </>
          )}
          {showMine && (
            <>
              {q && <div className="px-4 pt-2 pb-1 text-[11px] text-muted">我的公式</div>}
              {mine.map(({ def, error }) => {
                const on = enabled.includes(def.id);
                return (
                  <div key={def.id} className="group flex items-center hover:bg-fg/5">
                    <button type="button" disabled={Boolean(error)} onClick={() => onToggle(def.id)} className={`${row} hover:bg-transparent`} title={error ?? def.formula}>
                      <span className="w-4 shrink-0 text-accent">{on && <IconCheck size={16} />}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="mr-1 font-mono text-muted italic">ƒ</span>
                        {def.label}
                      </span>
                      <span className={`hidden shrink-0 truncate font-mono text-[11px] sm:inline ${error ? "text-down" : "text-muted"}`}>{error ?? (def.pane === "main" ? "主图" : "副图")}</span>
                    </button>
                    <button type="button" onClick={() => setEditing(def)} className="tb-btn mr-2 shrink-0" title="编辑公式" aria-label={`编辑 ${def.label}`}>
                      <IconPencil size={16} />
                    </button>
                  </div>
                );
              })}
              {!q && (
                <button type="button" onClick={() => setEditing("new")} className={`${row} text-accent`} title="用公式定义自己的指标，保存在 hebi8.yaml">
                  <span className="w-4 shrink-0 text-center">+</span>
                  新建公式
                </button>
              )}
            </>
          )}
          {q && builtins.length === 0 && mine.length === 0 && <div className="px-4 py-3 text-xs text-muted">没有匹配的指标</div>}
        </div>
      </div>
    </Dialog>
  );
}

function parseParams(text: string): number[] | null {
  const parts = text.split(/[\s,，]+/).filter(Boolean).map(Number);
  return parts.length > 0 && parts.every((n) => Number.isFinite(n) && n > 0) ? parts : null;
}

type SettingsTab = "inputs" | "style";

/** TradingView's 输入 / 样式 tabs under a settings dialog's title. */
function SettingsTabs({ tab, onTab }: { tab: SettingsTab; onTab: (tab: SettingsTab) => void }) {
  return (
    <div role="tablist" aria-label="设置" className="flex h-9 shrink-0 items-stretch gap-1 border-b border-line px-3">
      {(
        [
          ["inputs", "输入"],
          ["style", "样式"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          onClick={() => onTab(id)}
          className={`-mb-px border-b-2 px-2 text-[13px] ${tab === id ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** TradingView's 样式 tab: a row per line the indicator draws, its colour and width in one menu and its line style in another. */
function StylePage({ lines, value, onChange }: { lines: IndicatorLine[]; value: LineOverride[]; onChange: (next: LineOverride[]) => void }) {
  if (!lines.length) return <p className="text-muted">这个指标没有可设置样式的线。</p>;
  const set = (i: number, change: LineOverride) => {
    // lines beyond the ones drawn now (fewer periods than before) keep their styles
    const next = Array.from({ length: Math.max(value.length, lines.length) }, (_, j) => value[j] ?? {});
    next[i] = { ...next[i], ...change };
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line, i) => {
        const color = value[i]?.color ?? line.color;
        const size = value[i]?.size ?? line.size;
        const dash = value[i]?.dash ?? line.dash;
        return (
          <div key={i} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{line.title}</span>
            <Dropdown
              label={
                <span className="flex h-4 w-7 items-center rounded-sm border border-line px-0.5">
                  <span className="w-full rounded-full" style={{ background: color, height: size + 1 }} />
                </span>
              }
              title={`${line.title} 颜色和线宽`}
              className="tb-btn h-7 px-1.5"
              menuClassName="p-2"
            >
              {() => (
                <div className="flex flex-col gap-2">
                  <Swatches value={color} onPick={(c) => set(i, { color: c })} />
                  <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
                    <span className="text-muted">线宽</span>
                    <span className="flex gap-1">
                      {LINE_WIDTHS.map((w) => (
                        <button key={w} type="button" className="tb-btn h-7 px-2 text-xs" aria-pressed={w === size} onClick={() => set(i, { size: w })}>
                          {w}px
                        </button>
                      ))}
                    </span>
                  </div>
                </div>
              )}
            </Dropdown>
            <Dropdown label={<IconLineDash dash={dash} />} title={`${line.title} 线型`} className="tb-btn h-7 px-1.5" menuClassName="min-w-[7rem]">
              {(close) =>
                DASHES.map((d) => (
                  <button
                    key={d.dash}
                    type="button"
                    role="menuitemradio"
                    aria-checked={d.dash === dash}
                    className={`menu-item flex items-center gap-2 ${d.dash === dash ? "font-medium" : ""}`}
                    onClick={() => {
                      set(i, { dash: d.dash });
                      close();
                    }}
                  >
                    <IconLineDash dash={d.dash} /> {d.label}
                  </button>
                ))
              }
            </Dropdown>
          </div>
        );
      })}
      <p className="pt-1 text-[11px] text-muted">样式对所有周期生效。</p>
    </div>
  );
}

/** The 样式 tab of a formula, whose 输入 tab is the formula editor with its own buttons. */
function StyleForm({ lines, value, onPreview, onSave, onClose }: { lines: IndicatorLine[]; value: LineOverride[]; onPreview: (next: LineOverride[]) => void; onSave: (next: LineOverride[] | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <form
      className="flex flex-col gap-3 p-4 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <StylePage
        lines={lines}
        value={draft}
        onChange={(next) => {
          setDraft(next);
          onPreview(next);
        }}
      />
      <div className="flex items-center gap-2 pt-1">
        {value.length > 0 && (
          <button type="button" onClick={() => onSave(null)} className="btn btn-secondary">
            恢复默认
          </button>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="btn btn-secondary">
          取消
        </button>
        <button type="submit" className="btn btn-primary">
          确定
        </button>
      </div>
    </form>
  );
}

/** The settings dialog a legend row's gear opens: 输入 per timeframe, as before, and 样式 for every timeframe. */
export function ParamDialog({
  def,
  tf,
  value,
  overridden,
  lines,
  styles,
  onSave,
  onPreviewStyles,
  onSaveStyles,
  onClose,
}: {
  def: IndicatorDef;
  tf: Timeframe;
  value: number[];
  overridden: boolean;
  /** The lines it draws now */
  lines: IndicatorLine[];
  styles: LineOverride[];
  onSave: (params: number[] | null) => void;
  /** Shown on the chart while the dialog is open, saved only by 确定 */
  onPreviewStyles: (lines: LineOverride[]) => void;
  onSaveStyles: (lines: LineOverride[] | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("inputs");
  const initial = value.join(", ");
  const [text, setText] = useState(initial);
  const [draft, setDraft] = useState(styles);
  const noInputs = value.length === 0 && !overridden && !def.optionalParams;
  // an optional param left empty goes back to the default (none)
  const cleared = Boolean(def.optionalParams) && !text.trim();
  const parsed = parseParams(text);
  const valid = noInputs || Boolean(parsed) || cleared;
  return (
    <Dialog title={`${def.label} 设置`} onClose={onClose} className="max-w-[420px]">
      <SettingsTabs tab={tab} onTab={setTab} />
      <form
        className="flex flex-col gap-3 p-4 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          // only what was changed is saved: 确定 on the 样式 tab does not pin the periods
          if (!noInputs && text !== initial) onSave(cleared ? null : parsed);
          if (draft !== styles) onSaveStyles(draft);
          onClose();
        }}
      >
        {tab === "style" ? (
          <StylePage
            lines={lines}
            value={draft}
            onChange={(next) => {
              setDraft(next);
              onPreviewStyles(next);
            }}
          />
        ) : noInputs ? (
          <p className="text-muted">{def.hint}</p>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-muted">{def.hint}</span>
              <input value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} autoFocus aria-invalid={!valid} className="input h-8 font-mono text-[13px]" />
            </label>
            <p className="text-[11px] text-muted">
              只对{TF_LABELS[tf]}线生效，其它周期各自保存{overridden ? "；当前为自定义值" : ""}。多个参数用逗号分隔。
            </p>
          </>
        )}
        <div className="flex items-center gap-2 pt-1">
          {(overridden || styles.length > 0) && (
            <button
              type="button"
              title="参数和样式都回到默认"
              onClick={() => {
                if (overridden) onSave(null);
                if (styles.length) onSaveStyles(null);
                onClose();
              }}
              className="btn btn-secondary"
            >
              恢复默认
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="btn btn-secondary">
            取消
          </button>
          <button type="submit" disabled={!valid} className="btn btn-primary">
            确定
          </button>
        </div>
      </form>
    </Dialog>
  );
}
