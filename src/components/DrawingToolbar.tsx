"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { LINE_WIDTHS } from "@/lib/config";
import type { PriceScale } from "./drawing-scale";
import type { LineDash } from "./drawing-style";
import { editedFields, type Extension } from "./drawing-edit";
import type { FibSettings } from "./fib";
import { Dialog } from "./Dialog";
import { DRAW_ICONS, IconAlarm, IconCaret, IconEye, IconGear, IconLineDash, IconLineWidth, IconLock, IconText, IconTrash } from "./chart-icons";
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
  /** The price scale it was drawn on; none for older drawings and tools the scale does not change */
  scale?: PriceScale;
  timestamps: number[];
  /** 向左延长 / 向右延长 of a trend line; null for other drawings */
  extend: Extension | null;
  /** Background, extension and colours of a Fibonacci retracement or extension; null for other drawings */
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

type Popover = "color" | "width" | "dash" | "textSize";

/**
 * TradingView's floating toolbar for the selected drawing: colour, width, dash (or font size and
 * the text for text drawings), settings, an alert for price lines, lock, hide and delete.
 */
export function DrawingToolbar({
  info,
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

  return (
    <div
      ref={ref}
      className="absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-line bg-card p-0.5 shadow-lg"
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
      {button("settings", "设置", <IconGear />, onSettings)}
      {canAlert && button("alert", "添加警报", <IconAlarm />, onAlert)}
      <span className="tb-sep" />
      {button("lock", info.locked ? "解锁" : "锁定", <IconLock open={!info.locked} />, onLock, { pressed: info.locked })}
      {button("hide", "隐藏（左侧「显示所有绘图」恢复）", <IconEye off />, onHide)}
      {button("delete", "删除 · Del", <IconTrash />, onDelete)}

      {open && (
        <div className="menu absolute top-full left-1/2 mt-1 -translate-x-1/2 p-2" style={{ right: "auto", minWidth: 0 }} role="menu">
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
        </div>
      )}
    </div>
  );
}

/** A point's date as the date field shows it (UTC, like the chart). */
const dayOf = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

/** The 设置 dialog of a drawing: style, its text (text drawings), a trend line's extension, a Fibonacci drawing's background and extension, and the date and price of each point. */
export function DrawingSettings({ info, precision, onApply, onClose }: { info: DrawingInfo; precision: number; onApply: (change: DrawingChange) => void; onClose: () => void }) {
  const isText = TEXT_DRAWINGS.has(info.name);
  const [color, setColor] = useState(info.color);
  const [size, setSize] = useState(info.size);
  const [dash, setDash] = useState(info.dash);
  const [textSize, setTextSize] = useState(info.textSize);
  const [text, setText] = useState(info.text);
  const shown = info.values.map((v) => v.toFixed(precision));
  const [values, setValues] = useState(shown);
  const [scale, setScale] = useState(info.scale);
  const shownDays = info.timestamps.map(dayOf);
  const [days, setDays] = useState(shownDays);
  const [extend, setExtend] = useState(info.extend);
  const [fib, setFib] = useState(info.fib);
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
    <Dialog title={toolLabel(info.name)} onClose={onClose} className="max-w-[400px]">
      <form
        className="flex flex-col gap-3 overflow-y-auto p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          // only the prices and dates typed over change; the rest keep their exact values
          const nums = editedFields(shown, values, Number);
          const times = editedFields(shownDays, days, (d) => Date.parse(`${d}T00:00:00Z`));
          // a log drawing has no place for a price at zero or below
          const valid = nums?.every((v) => v === undefined || (Number.isFinite(v) && (scale !== "log" || v > 0)));
          onApply({
            color,
            ...(isText ? { textSize, text } : { size, dash }),
            ...(nums && valid ? { values: nums } : {}),
            ...(times ? { timestamps: times } : {}),
            ...(extend && (extend.left !== info.extend?.left || extend.right !== info.extend?.right) ? { extend } : {}),
            ...(fib ? { fib } : {}),
            ...(scale !== info.scale ? { scale } : {}),
          });
        }}
      >
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
              <span className="text-muted">档位</span>
              <label className="flex items-center gap-1.5" title="档位方向反过来：0 和 1 对调位置，1 以上的档位越过另一个点；点不动">
                <input type="checkbox" checked={fib.reverse} onChange={(e) => setFib({ ...fib, reverse: e.target.checked })} />
                反向
              </label>
            </div>
          </>
        )}
        {SCALED_DRAWINGS.has(info.name) && (
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
            <legend className="mb-1 text-muted">坐标（日期、价格）</legend>
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
                    aria-label={`点 ${i + 1} 价格`}
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
        <div className="-mx-4 mt-1 flex justify-end gap-2 border-t border-line px-4 pt-3">
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
