"use client";

import { useMemo, useState, type FocusEvent, type ReactNode } from "react";
import { deleteAlert, saveAlert } from "@/app/actions";
import { compileFormula } from "@/indicators/formula-indicators";
import { ALERT_CHECKS, ALERT_CONDS, WATCHLIST, defaultCheck, describeCondition, parseCondition, type AlertCheck, type AlertCond, type AlertCondition, type AlertTrigger } from "@/lib/alert-conds";
import type { AlertView } from "@/lib/alert-view";
import { shortName } from "@/lib/config";
import type { AlertInput } from "@/lib/ops";
import { TF_LABELS, TIMEFRAMES, type Timeframe } from "@/lib/symbols";
import { Dialog } from "./Dialog";
import { LoginButton } from "./UiProvider";

type CondChoice = AlertCond | "formula";

const selectAll = (e: FocusEvent<HTMLInputElement>) => e.target.select();
const num = (text: string) => (text.trim() === "" ? NaN : Number(text.replace(/,/g, "")));
const fixed = (v: number, precision: number) => String(Number(v.toFixed(precision)));

/** A visitor sees the entry points; opening one asks them to log in. */
export function AlertLoginDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="新建警报" onClose={onClose} className="max-w-[360px]">
      <div className="flex flex-col items-start gap-3 p-4 text-sm">
        <p className="text-muted">警报是各人自己的，登录后设置，触发时推到你绑定的 Telegram 或 webhook。</p>
        <LoginButton />
      </div>
    </Dialog>
  );
}

/**
 * 新建警报 / 编辑警报, TradingView's dialog: the symbol (or 全部自选), 条件 with the value inputs
 * that condition needs, 判断时机 (盘中价格 | 日线收盘), 触发 (仅一次 | 每根 K 线一次), an optional name
 * whose placeholder is the generated one, and whether it is pushed. The chart and the overview open the same dialog.
 */
export function AlertDialog({
  symbolKey,
  symbolName,
  alert,
  price,
  precision,
  aliases,
  bench,
  onSaved,
  onDeleted,
  onClose,
}: {
  symbolKey: string;
  symbolName: string;
  /** The alert being edited, null for a new one */
  alert: AlertView | null;
  /** Where a new alert's value starts: the latest price, a right-clicked price, a horizontal line's */
  price: number | null;
  precision: number;
  aliases: Record<string, string>;
  bench: string | null;
  onSaved: () => void;
  /** Given, an edited alert can be deleted here too */
  onDeleted?: () => void;
  onClose: () => void;
}) {
  const start = price ?? 0;
  const v = alert?.value;
  const [cond, setCond] = useState<CondChoice>(alert ? (alert.cond ?? "formula") : "crossing");
  const [level, setLevel] = useState(typeof v === "number" ? String(v) : fixed(start, precision));
  const [low, setLow] = useState(Array.isArray(v) ? String(v[0]) : fixed(start * 0.95, precision));
  const [high, setHigh] = useState(Array.isArray(v) ? String(v[1]) : fixed(start * 1.05, precision));
  const [pct, setPct] = useState(v && typeof v === "object" && !Array.isArray(v) ? String(v.pct) : "5");
  const [bars, setBars] = useState(v && typeof v === "object" && !Array.isArray(v) ? String(v.bars) : "1");
  const [when, setWhen] = useState(alert?.when ?? "close > sma(close, 200)");
  const [tf, setTf] = useState<Timeframe>(alert?.tf ?? "D");
  const [trigger, setTrigger] = useState<AlertTrigger>(alert?.trigger ?? "once");
  const [label, setLabel] = useState(alert?.ownLabel ?? "");
  /** On every watched symbol instead of this one */
  const [all, setAll] = useState(alert ? alert.key === null : false);
  /** Null: what an alert of this scope does by default, so switching the scope switches it too */
  const [chosenCheck, setChosenCheck] = useState<AlertCheck | null>(alert && alert.check !== defaultCheck(alert.key) ? alert.check : null);
  const check = chosenCheck ?? defaultCheck(all ? null : symbolKey);
  const [notify, setNotify] = useState(alert?.notify ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shape = cond === "formula" ? "formula" : ALERT_CONDS[cond].value;
  /** The condition as typed, or why it is not one yet */
  const parsed = useMemo((): { condition: AlertCondition } | { error: string } | null => {
    if (cond === "formula") return null;
    const value = shape === "price" ? num(level) : shape === "channel" ? [num(low), num(high)] : { pct: num(pct), bars: num(bars) };
    try {
      return { condition: parseCondition(cond, value) };
    } catch {
      return { error: shape === "move" ? "百分比要大于 0，K 线数是正整数" : "请输入数字" };
    }
  }, [cond, shape, level, low, high, pct, bars]);
  // on the whole watchlist `bench` is each symbol's own
  const formulaError = cond === "formula" ? compileFormula(when, { aliases, bench: all ? undefined : bench }).error : null;
  const short = shortName(symbolKey, aliases);
  const what = parsed && "condition" in parsed ? describeCondition(parsed.condition) : cond === "formula" ? when.trim() : "";
  const autoName = what && !all && cond !== "formula" ? `${short} ${what}` : what;
  /** A price or a channel only means something on one symbol */
  const needsSymbol = (c: CondChoice) => c !== "formula" && ALERT_CONDS[c].value !== "move";

  const chooseScope = (next: boolean) => {
    setAll(next);
    if (next && needsSymbol(cond)) setCond("formula");
  };

  const submit = async () => {
    if (busy) return;
    if (parsed && "error" in parsed) return setError(parsed.error);
    if (formulaError) return setError(formulaError);
    const input: AlertInput = {
      ...(alert ? { id: alert.id } : {}),
      key: all ? null : symbolKey,
      cond,
      ...(parsed && "condition" in parsed ? { value: parsed.condition.value } : { when, tf }),
      trigger,
      check,
      label,
      notify,
    };
    setBusy(true);
    setError(null);
    const result = await saveAlert(input);
    setBusy(false);
    if (result.ok) onSaved();
    else setError(result.error);
  };

  const remove = async () => {
    if (busy || !alert || !onDeleted) return;
    setBusy(true);
    const result = await deleteAlert(alert.id);
    setBusy(false);
    if (result.ok) onDeleted();
    else setError(result.error);
  };

  const numberInput = (value: string, set: (v: string) => void, aria: string, autoFocus = false) => (
    <input className="input w-full font-mono" inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} onFocus={selectAll} aria-label={aria} autoFocus={autoFocus} />
  );

  return (
    <Dialog title={alert ? "编辑警报" : "新建警报"} onClose={onClose} className="max-w-[440px]">
      <form
        className="flex flex-col gap-3 p-4 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="商品">
          <span className="flex min-w-0 items-center gap-2">
            <span className="seg shrink-0" role="group" aria-label="商品">
              <button type="button" aria-pressed={!all} onClick={() => chooseScope(false)} title={symbolName}>
                {short}
              </button>
              <button type="button" aria-pressed={all} onClick={() => chooseScope(true)} title="对每个自选标的分别判断">
                {WATCHLIST}
              </button>
            </span>
            {!all && symbolName !== short && <span className="truncate text-muted">{symbolName}</span>}
          </span>
        </Field>
        <Field label="条件">
          <select className="input w-full" value={cond} onChange={(e) => setCond(e.target.value as CondChoice)} aria-label="条件">
            {(Object.keys(ALERT_CONDS) as AlertCond[]).map((c) => (
              <option key={c} value={c} disabled={all && needsSymbol(c)}>
                {ALERT_CONDS[c].label}
              </option>
            ))}
            <option value="formula">自定义公式</option>
          </select>
        </Field>
        {shape === "price" && <Field label="价格">{numberInput(level, setLevel, "价格", true)}</Field>}
        {shape === "channel" && (
          <>
            <Field label="上沿">{numberInput(high, setHigh, "通道上沿", true)}</Field>
            <Field label="下沿">{numberInput(low, setLow, "通道下沿")}</Field>
          </>
        )}
        {shape === "move" && (
          <Field label="幅度">
            <span className="flex items-center gap-2">
              {numberInput(pct, setPct, "百分比", true)}
              <span className="shrink-0 text-muted">% ·</span>
              {numberInput(bars, setBars, "K 线数")}
              <span className="shrink-0 text-muted">根日线内</span>
            </span>
          </Field>
        )}
        {shape === "formula" && (
          <Field label="公式">
            <span className="flex flex-col gap-1">
              <textarea
                className="input h-16 w-full resize-y py-1.5 font-mono leading-snug"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits like the other inputs; Shift+Enter is a new line
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                aria-label="公式"
                autoFocus
                spellCheck={false}
              />
              <span className={formulaError ? "text-down" : "text-muted"}>{formulaError ?? "布尔公式，新成立时触发；明确的上穿写 cross(close, X)"}</span>
            </span>
          </Field>
        )}
        {shape === "formula" && (
          <Field label="周期">
            <div className="seg" role="group" aria-label="公式的周期">
              {TIMEFRAMES.map((t) => (
                <button key={t} type="button" aria-pressed={tf === t} onClick={() => setTf(t)}>
                  {TF_LABELS[t]}线
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="判断时机">
          <div className="seg" role="group" aria-label="判断时机">
            {(Object.keys(ALERT_CHECKS) as AlertCheck[]).map((c) => (
              <button key={c} type="button" aria-pressed={check === c} onClick={() => setChosenCheck(c)}>
                {ALERT_CHECKS[c]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="触发">
          {all ? (
            <span className="text-muted">每个标的每根 K 线最多一次</span>
          ) : (
            <div className="seg" role="group" aria-label="触发">
              <button type="button" aria-pressed={trigger === "once"} onClick={() => setTrigger("once")}>
                仅一次
              </button>
              <button type="button" aria-pressed={trigger === "bar"} onClick={() => setTrigger("bar")}>
                每根 K 线一次
              </button>
            </div>
          )}
        </Field>
        <Field label="名称">
          <input className="input w-full" value={label} placeholder={autoName} onChange={(e) => setLabel(e.target.value)} onFocus={selectAll} aria-label="名称" maxLength={80} />
        </Field>
        <Field label="通知">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            推到我的通知通道
            {!notify && <span className="text-muted">（只在总览显示）</span>}
          </label>
        </Field>
        <p className="text-[11px] text-muted">
          {check === "price" ? "每 5 分钟取一次最新价判断（休市时每小时），今天还没收完的日线也算。" : "每次日线同步后判断，只看已经收盘的日线。"}
          {all ? "对每个自选标的分别判断，总览上在成立的标的旁显示这个名字。" : "总览上这个标的旁显示这个名字。"}
        </p>
        {alert?.draft && <p className="text-[11px] text-muted">这条警报还在等确认：保存后仍是草稿，在警报面板或总览顶部点「确认」才开始判断。</p>}
        {error && <p className="text-down">{error}</p>}
        <div className="-mx-4 -mb-4 flex justify-end gap-2 border-t border-line px-4 py-3">
          {alert && onDeleted && (
            <button type="button" className="btn mr-auto text-down" onClick={() => void remove()} disabled={busy}>
              删除
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "保存中…" : alert ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A row of the form; the inputs carry their own aria-label (a <label> would forward clicks to the first button). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[3.5rem_1fr] items-center gap-3">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}
