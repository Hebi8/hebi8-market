"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LINE_WIDTHS } from "@/lib/config";
import { TF_LABELS, TIMEFRAMES, type Timeframe } from "@/lib/symbols";
import type { PriceScale } from "./drawing-scale";
import { normalizeTimeframes } from "./drawing-spec";
import type { LineDash } from "./drawing-style";
import { editedFields, type Extension } from "./drawing-edit";
import {
  FIB_PRESETS,
  applyFibTemplate,
  cleanFibSettings,
  fibLevelsOf,
  fibTemplateFrom,
  type FibLevelItem,
  type FibSettings,
  type FibTemplate,
} from "./fib";
import { Dialog } from "./Dialog";
import { DRAW_ICONS, IconAlarm, IconCaret, IconClose, IconEye, IconGear, IconLineDash, IconLineWidth, IconLock, IconPlus, IconText, IconTrash } from "./chart-icons";
import { DRAW_TOOLS, SCALED_DRAWINGS, TEXT_DRAWINGS } from "./chart-types";

/** What the floating toolbar and the settings dialog show of the selected drawing. */
export interface DrawingInfo {
  name: string;
  color: string;
  size: number;
  dash: LineDash;
  textSize: number;
  text: string;
  locked: boolean;
  values: number[];
  /** The price scale it was drawn on; none for older drawings, sub-pane drawings, and tools the scale does not change */
  scale?: PriceScale;
  /** Sub-pane identifier; omitted for main-pane drawings */
  pane?: string;
  /** Timeframes this drawing is shown on; omitted means every timeframe */
  timeframes?: Timeframe[];
  timestamps: number[];
  /** 向左延长 / 向右延长 of a trend line; null for other drawings */
  extend: Extension | null;
  /** Background, extension, levels and colours of a Fibonacci retracement or extension; null for other drawings */
  fib: FibSettings | null;
}

export interface DrawingChange {
  color?: string;
  size?: number;
  dash?: LineDash;
  textSize?: number;
  text?: string;
  /** The prices typed over; undefined for a point whose price stays */
  values?: (number | undefined)[];
  scale?: PriceScale;
  /** Timeframe visibility: null resets to all timeframes; array restricts to those timeframes */
  timeframes?: Timeframe[] | null;
  /** UTC midnight of each point's date; KChart puts it on the bar that date falls in */
  timestamps?: (number | undefined)[];
  extend?: Extension;
  fib?: FibSettings;
}

/** TradingView's colour picker: a row of hues and a row of greys. */
const PALETTE = [
  ["#f23645", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63"],
  ["#ffffff", "#d1d4dc", "#b2b5be", "#9598a1", "#787b86", "#5d606b", "#434651", "#2a2e39", "#131722", "#000000"],
];
export const DASHES: { dash: LineDash; label: string }[] = [
  { dash: "solid", label: "实线" },
  { dash: "dashed", label: "虚线" },
  { dash: "dotted", label: "点线" },
];
const TEXT_SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40];
const SCALES: { scale: PriceScale; label: string }[] = [
  { scale: "linear", label: "常规" },
  { scale: "log", label: "对数" },
];

export const toolLabel = (name: string) => DRAW_TOOLS.find((t) => t.name === name)?.label ?? name;

export function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {PALETTE.map((row, i) => (
        <div key={i} className="flex gap-1">
          {row.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={c}
              aria-pressed={c.toLowerCase() === value.toLowerCase()}
              onClick={() => onPick(c)}
              className="h-5 w-5 rounded-sm border border-line aria-pressed:ring-2 aria-pressed:ring-accent aria-pressed:ring-offset-1"
              style={{ background: c }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Generic timeframe visibility selector driven by `TIMEFRAMES` (so future intraday timeframes work
 * automatically): "全部", "仅当前", and one checkbox per timeframe with at least one kept enabled.
 */
function TimeframePicker({
  value,
  currentTf,
  onChange,
}: {
  value: Timeframe[] | undefined;
  currentTf: Timeframe;
  onChange: (next: Timeframe[] | null) => void;
}) {
  const allOn = !value || value.length === 0;
  const active = new Set<Timeframe>(allOn ? TIMEFRAMES : value);
  const onlyCurrent = !allOn && value.length === 1 && value[0] === currentTf;
  const toggle = (tf: Timeframe) => {
    if (active.has(tf)) {
      if (active.size <= 1) return;
      const next = TIMEFRAMES.filter((t) => t !== tf && active.has(t));
      onChange(normalizeTimeframes(next) ?? null);
    } else {
      const next = TIMEFRAMES.filter((t) => t === tf || active.has(t));
      onChange(normalizeTimeframes(next) ?? null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="tb-btn h-6 px-2 text-xs" aria-pressed={allOn} onClick={() => onChange(null)}>
          全部
        </button>
        {TIMEFRAMES.length > 1 && (
          <button type="button" className="tb-btn h-6 px-2 text-xs" aria-pressed={onlyCurrent} onClick={() => onChange([currentTf])}>
            仅{TF_LABELS[currentTf]}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {TIMEFRAMES.map((tf) => {
          const checked = active.has(tf);
          const last = checked && active.size <= 1;
          return (
            <label key={tf} className={`flex items-center gap-1 text-xs ${last ? "opacity-60" : "cursor-pointer"}`} title={last ? "至少保留 1 个可见周期" : `${TF_LABELS[tf]}线`}>
              <input type="checkbox" checked={checked} disabled={last} onChange={() => toggle(tf)} />
              {TF_LABELS[tf]}
            </label>
          );
        })}
      </div>
    </div>
  );
}

type Popover = "color" | "width" | "dash" | "textSize" | "timeframes";

/**
 * TradingView's floating toolbar for the selected drawing: colour, width, dash (or font size and
 * the text for text drawings), timeframe visibility, settings, an alert for main-pane price lines,
 * lock, hide and delete.
 */
export function DrawingToolbar({
  info,
  currentTf,
  top = 8,
  flipUp = false,
  canAlert,
  onChange,
  onEditText,
  onSettings,
  onAlert,
  onLock,
  onHide,
  onDelete,
}: {
  info: DrawingInfo;
  currentTf: Timeframe;
  top?: number;
  flipUp?: boolean;
  canAlert: boolean;
  onChange: (change: DrawingChange) => void;
  onEditText: () => void;
  onSettings: () => void;
  onAlert: () => void;
  onLock: () => void;
  onHide: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState<Popover | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const isText = TEXT_DRAWINGS.has(info.name);
  const Icon = DRAW_ICONS[info.name];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (p: Popover) => setOpen((cur) => (cur === p ? null : p));
  const pick = (change: DrawingChange) => {
    onChange(change);
    setOpen(null);
  };
  const button = (key: string, title: string, child: ReactNode, onClick: () => void, extra: Partial<{ pressed: boolean; expanded: boolean }> = {}) => (
    <button key={key} type="button" className="tb-btn" title={title} aria-label={title} aria-pressed={extra.pressed} aria-expanded={extra.expanded} onClick={onClick}>
      {child}
    </button>
  );

  const tfSummary = !info.timeframes
    ? "全部"
    : info.timeframes.length <= 2
      ? info.timeframes.map((t) => TF_LABELS[t]).join("/")
      : `${info.timeframes.length}周期`;
  const tfTitle = info.timeframes ? `可见周期：${info.timeframes.map((t) => TF_LABELS[t]).join("、")}` : "可见周期：全部";

  return (
    <div
      ref={ref}
      className="absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-line bg-card p-0.5 shadow-lg"
      style={{ top }}
      role="toolbar"
      aria-label="绘图工具栏"
      // keep the chart's own mousedown (which would deselect) out of it
      onMouseDown={(e) => e.stopPropagation()}
    >
      {Icon && (
        <span className="flex h-[30px] items-center px-1.5 text-muted" title={toolLabel(info.name)}>
          <Icon />
        </span>
      )}
      <span className="tb-sep" />
      {button(
        "color",
        isText ? "文字颜色" : "线条颜色",
        <span className="flex flex-col items-center gap-0.5">
          {isText ? <IconText size={14} /> : <IconLineWidth size={14} width={2} />}
          <span className="h-1 w-4 rounded-sm" style={{ background: info.color }} />
        </span>,
        () => toggle("color"),
        { expanded: open === "color" },
      )}
      {isText
        ? [
            button("size", "字号", <span className="flex items-center gap-0.5 text-xs">{info.textSize}<IconCaret className="text-muted" /></span>, () => toggle("textSize"), { expanded: open === "textSize" }),
            button("edit", "编辑文字（双击文字也可以）", <IconText />, onEditText),
          ]
        : [
            button("width", "线宽", <span className="flex items-center gap-0.5 text-xs"><IconLineWidth width={Math.min(3, info.size)} />{info.size}px</span>, () => toggle("width"), { expanded: open === "width" }),
            button("dash", "线型", <IconLineDash dash={info.dash} />, () => toggle("dash"), { expanded: open === "dash" }),
          ]}
      {button(
        "timeframes",
        tfTitle,
        <span className={`flex items-center gap-0.5 px-0.5 text-xs ${info.timeframes ? "font-medium text-accent" : ""}`}>
          {tfSummary}
          <IconCaret className="text-muted" />
        </span>,
        () => toggle("timeframes"),
        { expanded: open === "timeframes" },
      )}
      {button("settings", "设置", <IconGear />, onSettings)}
      {canAlert && button("alert", "添加警报", <IconAlarm />, onAlert)}
      <span className="tb-sep" />
      {button("lock", info.locked ? "解锁" : "锁定", <IconLock open={!info.locked} />, onLock, { pressed: info.locked })}
      {button("hide", "隐藏（左侧「显示所有绘图」恢复）", <IconEye off />, onHide)}
      {button("delete", "删除 · Del", <IconTrash />, onDelete)}

      {open && (
        <div
          className={`menu absolute left-1/2 -translate-x-1/2 p-2 ${flipUp ? "bottom-full mb-1" : "top-full mt-1"}`}
          style={{ right: "auto", minWidth: 0 }}
          role="menu"
        >
          {open === "color" && <Swatches value={info.color} onPick={(color) => pick({ color })} />}
          {open === "width" &&
            LINE_WIDTHS.map((w) => (
              <button key={w} type="button" role="menuitemradio" aria-checked={w === info.size} className={`menu-item flex items-center gap-2 ${w === info.size ? "font-medium" : ""}`} onClick={() => pick({ size: w })}>
                <IconLineWidth width={w} /> {w}px
              </button>
            ))}
          {open === "dash" &&
            DASHES.map((d) => (
              <button key={d.dash} type="button" role="menuitemradio" aria-checked={d.dash === info.dash} className={`menu-item flex items-center gap-2 ${d.dash === info.dash ? "font-medium" : ""}`} onClick={() => pick({ dash: d.dash })}>
                <IconLineDash dash={d.dash} /> {d.label}
              </button>
            ))}
          {open === "textSize" &&
            TEXT_SIZES.map((s) => (
              <button key={s} type="button" role="menuitemradio" aria-checked={s === info.textSize} className={`menu-item ${s === info.textSize ? "font-medium" : ""}`} onClick={() => pick({ textSize: s })}>
                {s}
              </button>
            ))}
          {open === "timeframes" && (
            <div className="min-w-[13.5rem]">
              <div className="mb-1.5 text-[11px] text-muted">可见周期</div>
              <TimeframePicker value={info.timeframes} currentTf={currentTf} onChange={(timeframes) => onChange({ timeframes })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A point's date as the date field shows it (UTC, like the chart). */
const dayOf = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

interface LevelRow {
  id: number;
  text: string;
  color: string;
  enabled: boolean;
}

export interface DrawingPreview {
  color: string;
  size?: number;
  dash?: LineDash;
  fib?: FibSettings;
}

/** The 设置 dialog of a drawing: style, text, trend extension, Fibonacci levels & templates, timeframe visibility, price scale and coordinates. */
export function DrawingSettings({
  info,
  precision,
  currentTf,
  fibTemplates,
  readOnly,
  onSaveFibTemplate,
  onDeleteFibTemplate,
  onPreview,
  onApply,
  onClose,
}: {
  info: DrawingInfo;
  precision: number;
  currentTf: Timeframe;
  fibTemplates: FibTemplate[];
  readOnly: boolean;
  onSaveFibTemplate: (tpl: FibTemplate) => Promise<string | null>;
  onDeleteFibTemplate: (name: string) => Promise<string | null>;
  onPreview?: (preview: DrawingPreview) => void;
  onApply: (change: DrawingChange) => void;
  onClose: () => void;
}) {
  const isText = TEXT_DRAWINGS.has(info.name);
  const [color, setColor] = useState(info.color);
  const [size, setSize] = useState(info.size);
  const [dash, setDash] = useState(info.dash);
  const [textSize, setTextSize] = useState(info.textSize);
  const [text, setText] = useState(info.text);
  const shown = info.values.map((v) => v.toFixed(precision));
  const [values, setValues] = useState(shown);
  const [scale, setScale] = useState(info.scale);
  const [timeframes, setTimeframes] = useState<Timeframe[] | undefined>(info.timeframes);
  const shownDays = info.timestamps.map(dayOf);
  const [days, setDays] = useState(shownDays);
  const [extend, setExtend] = useState(info.extend);
  const [fib, setFib] = useState(info.fib);

  const [levelRows, setLevelRows] = useState<LevelRow[]>(() =>
    info.fib ? fibLevelsOf(info.fib).map((l, i) => ({ id: i + 1, text: String(l.level), color: l.color, enabled: l.enabled !== false })) : [],
  );
  const rowSeq = useRef(levelRows.length);
  const toRows = (items: FibLevelItem[]): LevelRow[] =>
    items.map((l) => ({ id: ++rowSeq.current, text: String(l.level), color: l.color, enabled: l.enabled !== false }));
  const [colorRowId, setColorRowId] = useState<number | null>(null);
  const [levelError, setLevelError] = useState<string | null>(null);
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplBusy, setTplBusy] = useState(false);
  const [tplError, setTplError] = useState<string | null>(null);

  const previewRef = useRef(onPreview);
  useEffect(() => {
    previewRef.current = onPreview;
  }, [onPreview]);

  // Live canvas preview on style / Fibonacci preset / level edits without persisting or touching undo history
  const previewReady = useRef(false);
  useEffect(() => {
    if (!previewReady.current) {
      previewReady.current = true;
      return;
    }
    const emit = previewRef.current;
    if (!emit) return;
    if (fib) {
      const levels: FibLevelItem[] = [];
      for (const r of levelRows) {
        const trimmed = r.text.trim();
        if (!trimmed) continue;
        const num = Number(trimmed);
        if (!Number.isFinite(num)) continue;
        levels.push(r.enabled ? { level: num, color: r.color } : { level: num, color: r.color, enabled: false });
      }
      if (!levels.some((l) => l.enabled !== false)) return;
      emit({ color, size, dash, fib: cleanFibSettings({ ...fib, levels }) });
    } else if (!isText) {
      emit({ color, size, dash });
    }
  }, [fib, levelRows, color, size, dash, isText]);

  const enabledCount = levelRows.filter((r) => r.enabled).length;
  const parseRows = (): { levels: FibLevelItem[]; error: string | null } => {
    const levels: FibLevelItem[] = [];
    for (const r of levelRows) {
      const trimmed = r.text.trim();
      const num = Number(trimmed);
      if (!trimmed || !Number.isFinite(num)) return { levels: [], error: `无效的档位数值「${r.text}」` };
      levels.push(r.enabled ? { level: num, color: r.color } : { level: num, color: r.color, enabled: false });
    }
    if (!levels.some((l) => l.enabled !== false)) return { levels: [], error: "至少保留 1 个启用档位" };
    return { levels, error: null };
  };

  const applyTpl = (tpl: FibTemplate) => {
    const nextFib = applyFibTemplate(tpl);
    setFib(nextFib);
    setLevelRows(toRows(fibLevelsOf(nextFib)));
    if (tpl.color) setColor(tpl.color);
    if (tpl.size !== undefined) setSize(tpl.size);
    if (tpl.dash !== undefined) setDash(tpl.dash);
    setColorRowId(null);
    setLevelError(null);
    setTplError(null);
  };

  const addLevelRow = () => {
    const nextColor = PALETTE[0][levelRows.length % PALETTE[0].length];
    const next: LevelRow = { id: ++rowSeq.current, text: "", color: nextColor, enabled: true };
    setLevelRows([...levelRows, next]);
    setLevelError(null);
  };

  const saveTpl = async () => {
    if (!fib || tplBusy) return;
    const trimmed = tplName.trim();
    if (!trimmed) {
      setTplError("请输入模板名称");
      return;
    }
    const { levels, error } = parseRows();
    if (error) {
      setLevelError(error);
      return;
    }
    setTplBusy(true);
    setTplError(null);
    const tpl = fibTemplateFrom(trimmed, { ...fib, levels }, { color, size, dash });
    const err = await onSaveFibTemplate(tpl);
    setTplBusy(false);
    if (err) {
      setTplError(err);
      return;
    }
    setTplName("");
    setShowSaveTpl(false);
  };

  const removeTpl = async (name: string) => {
    if (tplBusy) return;
    setTplBusy(true);
    setTplError(null);
    const err = await onDeleteFibTemplate(name);
    setTplBusy(false);
    if (err) setTplError(err);
  };

  const row = "flex items-center justify-between gap-4";
  const extendRow = (left: boolean, right: boolean, set: (side: "left" | "right", on: boolean) => void) => (
    <div className={row}>
      <span className="text-muted">延长</span>
      <span className="flex gap-3">
        {(["left", "right"] as const).map((side) => (
          <label key={side} className="flex items-center gap-1.5">
            <input type="checkbox" checked={side === "left" ? left : right} onChange={(e) => set(side, e.target.checked)} />
            {side === "left" ? "向左延长" : "向右延长"}
          </label>
        ))}
      </span>
    </div>
  );

  return (
    <Dialog title={toolLabel(info.name)} onClose={onClose} className={fib ? "max-w-[440px]" : "max-w-[400px]"}>
      <form
        className="flex min-h-0 flex-1 flex-col text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          let nextFib: FibSettings | undefined;
          if (fib) {
            const { levels, error } = parseRows();
            if (error) {
              setLevelError(error);
              return;
            }
            nextFib = cleanFibSettings({ ...fib, levels });
          }
          // only the prices and dates typed over change; the rest keep their exact values
          const nums = editedFields(shown, values, Number);
          const times = editedFields(shownDays, days, (d) => Date.parse(`${d}T00:00:00Z`));
          // a log drawing on the main pane has no place for a price at zero or below
          const valid = nums?.every((v) => v === undefined || (Number.isFinite(v) && (Boolean(info.pane) || scale !== "log" || v > 0)));
          const tfChanged = JSON.stringify(timeframes) !== JSON.stringify(info.timeframes);
          onApply({
            color,
            ...(isText ? { textSize, text } : { size, dash }),
            ...(nums && valid ? { values: nums } : {}),
            ...(times ? { timestamps: times } : {}),
            ...(extend && (extend.left !== info.extend?.left || extend.right !== info.extend?.right) ? { extend } : {}),
            ...(nextFib ? { fib: nextFib } : {}),
            ...(!info.pane && scale !== info.scale ? { scale } : {}),
            ...(tfChanged ? { timeframes: timeframes ?? null } : {}),
          });
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4">
        {fib && (
          <div className="flex min-w-0 flex-col gap-1.5 border-b border-line pb-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">模板</span>
              {!readOnly ? (
                <button
                  type="button"
                  className="btn h-6 px-2 text-xs text-muted hover:text-fg"
                  onClick={() => {
                    setShowSaveTpl((v) => !v);
                    setTplError(null);
                  }}
                >
                  {showSaveTpl ? "收起" : "存为模板"}
                </button>
              ) : (
                <span className="text-[11px] text-muted" title="登录后可保存个人模板">
                  仅预设预览
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap gap-1">
              {FIB_PRESETS.map((tpl) => (
                <button key={tpl.name} type="button" className="btn btn-secondary h-7 px-2 text-xs" onClick={() => applyTpl(tpl)}>
                  {tpl.name}
                </button>
              ))}
              {fibTemplates.map((tpl) => (
                <span key={tpl.name} className="inline-flex max-w-full min-w-0 items-center rounded border border-line bg-bg/50">
                  <button type="button" title={tpl.name} className="h-7 min-w-0 flex-1 truncate px-2 text-xs hover:bg-fg/10" onClick={() => applyTpl(tpl)}>
                    {tpl.name}
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      disabled={tplBusy}
                      aria-label={`删除模板 ${tpl.name}`}
                      title={`删除模板「${tpl.name}」`}
                      className="flex h-7 w-6 shrink-0 items-center justify-center border-l border-line text-muted hover:bg-fg/10 hover:text-down"
                      onClick={() => void removeTpl(tpl.name)}
                    >
                      <IconClose size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {showSaveTpl && !readOnly && (
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  value={tplName}
                  maxLength={40}
                  placeholder="新模板名称（同名将覆盖）"
                  aria-label="模板名称"
                  className="input h-7 flex-1 text-xs"
                  onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveTpl();
                    }
                  }}
                />
                <button type="button" disabled={tplBusy} className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => void saveTpl()}>
                  保存
                </button>
              </div>
            )}
            {tplError && <p className="text-xs text-down">{tplError}</p>}
          </div>
        )}
        <div className={row}>
          <span className="text-muted">颜色</span>
          <Swatches
            value={color}
            onPick={(c) => {
              setColor(c);
              // a colour picked for a Fibonacci drawing is the one colour of all its levels, as on TradingView
              if (fib) setFib({ ...fib, oneColor: true });
            }}
          />
        </div>
        {fib && (
          <label className="flex items-center justify-end gap-1.5" title="不勾选时每一档用自己的颜色，上面的颜色只用于两点间的虚线">
            <input type="checkbox" checked={fib.oneColor} onChange={(e) => setFib({ ...fib, oneColor: e.target.checked })} />
            使用单一颜色
          </label>
        )}
        {isText ? (
          <>
            <label className={row}>
              <span className="text-muted">字号</span>
              <select className="input h-7 w-24" value={textSize} onChange={(e) => setTextSize(Number(e.target.value))}>
                {TEXT_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">文字</span>
              <textarea className="input min-h-20 py-1" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <div className={row}>
              <span className="text-muted">线宽</span>
              <span className="flex gap-1">
                {LINE_WIDTHS.map((w) => (
                  <button key={w} type="button" className="tb-btn h-7 px-2 text-xs" aria-pressed={w === size} onClick={() => setSize(w)}>
                    {w}px
                  </button>
                ))}
              </span>
            </div>
            <div className={row}>
              <span className="text-muted">线型</span>
              <span className="flex gap-1">
                {DASHES.map((d) => (
                  <button key={d.dash} type="button" className="tb-btn h-7 px-2" aria-pressed={d.dash === dash} title={d.label} aria-label={d.label} onClick={() => setDash(d.dash)}>
                    <IconLineDash dash={d.dash} />
                  </button>
                ))}
              </span>
            </div>
          </>
        )}
        {extend && extendRow(extend.left, extend.right, (side, on) => setExtend({ ...extend, [side]: on }))}
        {fib && (
          <>
            <div className={row}>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={fib.background} onChange={(e) => setFib({ ...fib, background: e.target.checked })} />
                背景
              </label>
              <label className="flex items-center gap-2">
                <span className="text-muted">透明度</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  className="w-28"
                  disabled={!fib.background}
                  value={fib.transparency}
                  onChange={(e) => setFib({ ...fib, transparency: Number(e.target.value) })}
                />
                <span className="w-9 text-right font-mono text-xs">{fib.transparency}%</span>
              </label>
            </div>
            {extendRow(fib.extendLeft, fib.extendRight, (side, on) => setFib({ ...fib, [side === "left" ? "extendLeft" : "extendRight"]: on }))}
            <div className={row}>
              <span className="text-muted">方向</span>
              <label className="flex items-center gap-1.5" title="档位方向反过来：0 和 1 对调位置，1 以上的档位越过另一个点；点不动">
                <input type="checkbox" checked={fib.reverse} onChange={(e) => setFib({ ...fib, reverse: e.target.checked })} />
                反向
              </label>
            </div>
            <fieldset className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <div className="flex items-center justify-between">
                <legend className="text-muted">档位</legend>
                <button type="button" className="btn flex h-6 items-center gap-1 px-2 text-xs text-muted hover:text-fg" onClick={addLevelRow}>
                  <IconPlus size={14} /> 添加档位
                </button>
              </div>
              <div className="flex max-h-52 flex-col gap-1 overflow-y-auto pr-1">
                {levelRows.map((item, idx) => {
                  const lastEnabled = item.enabled && enabledCount <= 1;
                  return (
                    <div key={item.id} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.enabled}
                          disabled={lastEnabled}
                          title={lastEnabled ? "至少保留 1 个启用档位" : "启用或停用该档位"}
                          aria-label={`启用档位 ${idx + 1}`}
                          onChange={(e) => {
                            if (!e.target.checked && lastEnabled) return;
                            setLevelRows(levelRows.map((r) => (r.id === item.id ? { ...r, enabled: e.target.checked } : r)));
                            setLevelError(null);
                          }}
                        />
                        <input
                          value={item.text}
                          inputMode="decimal"
                          placeholder="如 0.618"
                          aria-label={`档位 ${idx + 1} 数值`}
                          className="input h-7 w-24 font-mono text-xs"
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => {
                            setLevelRows(levelRows.map((r) => (r.id === item.id ? { ...r, text: e.target.value } : r)));
                            setLevelError(null);
                          }}
                        />
                        <button
                          type="button"
                          aria-label={`档位 ${idx + 1} 颜色`}
                          title={fib.oneColor ? "已勾选使用单一颜色，取消后按每档配色显示" : `颜色 ${item.color}`}
                          className={`h-6 w-6 shrink-0 rounded-sm border border-line ${fib.oneColor ? "opacity-50" : ""}`}
                          style={{ background: item.color }}
                          onClick={() => setColorRowId((cur) => (cur === item.id ? null : item.id))}
                        />
                        <span className="flex-1" />
                        <button
                          type="button"
                          disabled={lastEnabled || levelRows.length <= 1}
                          aria-label={`删除档位 ${idx + 1}`}
                          title={lastEnabled ? "至少保留 1 个启用档位" : "删除档位"}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-fg/10 hover:text-down disabled:opacity-30"
                          onClick={() => {
                            if (lastEnabled || levelRows.length <= 1) return;
                            setLevelRows(levelRows.filter((r) => r.id !== item.id));
                            if (colorRowId === item.id) setColorRowId(null);
                            setLevelError(null);
                          }}
                        >
                          <IconClose size={14} />
                        </button>
                      </div>
                      {colorRowId === item.id && (
                        <div className="ml-6 rounded border border-line bg-bg/60 p-1.5">
                          <Swatches
                            value={item.color}
                            onPick={(c) => {
                              setLevelRows(levelRows.map((r) => (r.id === item.id ? { ...r, color: c } : r)));
                              setColorRowId(null);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {levelError && <p className="text-xs text-down">{levelError}</p>}
            </fieldset>
          </>
        )}
        <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
          <span className="text-muted">可见周期</span>
          <TimeframePicker value={timeframes} currentTf={currentTf} onChange={(next) => setTimeframes(next ?? undefined)} />
        </div>
        {!info.pane && SCALED_DRAWINGS.has(info.name) && (
          <div className={row}>
            <span className="text-muted" title="画线在哪种价格坐标里是直线；在另一种坐标上显示为曲线">
              价格坐标
            </span>
            <span className="flex gap-1">
              {SCALES.map((s) => {
                const off = s.scale === "log" && info.values.some((v) => v <= 0);
                return (
                  <button
                    key={s.scale}
                    type="button"
                    className="tb-btn h-7 px-2 text-xs"
                    aria-pressed={s.scale === scale}
                    disabled={off}
                    title={off ? "有价格在 0 或以下，不能用对数" : scale ? undefined : "旧画线没有记录坐标，在当前坐标上画直线"}
                    onClick={() => setScale(s.scale)}
                  >
                    {s.label}
                  </button>
                );
              })}
            </span>
          </div>
        )}
        {values.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-muted">{info.pane ? "坐标（日期、数值）" : "坐标（日期、价格）"}</legend>
            {values.map((v, i) => (
              <div key={i} className={row}>
                <span className="text-xs text-muted">点 {i + 1}</span>
                <span className="flex gap-1.5">
                  <input
                    type="date"
                    aria-label={`点 ${i + 1} 日期`}
                    className="input h-7 w-36 font-mono"
                    value={days[i]}
                    onChange={(e) => setDays(days.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <input
                    aria-label={`点 ${i + 1} ${info.pane ? "数值" : "价格"}`}
                    className="input h-7 w-28 font-mono"
                    inputMode="decimal"
                    value={v}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                </span>
              </div>
            ))}
          </fieldset>
        )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-card px-4 py-3">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            确定
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Text width in `ch`, CJK and other wide characters counting double. */
const widthOf = (line: string) => [...line].reduce((n, ch) => n + (/[\u1100-\uffff]/.test(ch) ? 2 : 1), 0);

/** Typing a text drawing in place, TradingView style: Enter commits, Shift+Enter breaks the line, Esc cancels. */
export function TextEditor({
  x,
  y,
  center,
  size,
  color,
  initial,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  /** Centred above (x, y), like a 注释's label; otherwise the top-left corner is at (x, y) */
  center: boolean;
  size: number;
  color: string;
  initial: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(text);
    else onCancel();
  };
  const rows = Math.max(1, text.split("\n").length);
  return (
    <textarea
      autoFocus
      aria-label="绘图文字"
      placeholder="文字"
      value={text}
      rows={rows}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Enter or Esc that picks or drops an input method's candidate belongs to the input method
        // (Safari ends the composition first and reports keyCode 229)
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          // the page's Esc would also leave the drawing tool and blur (= commit) this box
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
      }}
      className="absolute z-20 resize-none overflow-hidden rounded-sm border border-dashed border-accent bg-card/80 px-0.5 leading-[1.35] outline-none"
      style={{
        left: x,
        top: y,
        transform: center ? "translate(-50%, -100%)" : undefined,
        fontSize: size,
        color,
        width: `${Math.max(6, ...text.split("\n").map(widthOf)) + 1}ch`,
        minWidth: "4ch",
      }}
    />
  );
}
