"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { addSymbol, deleteIndicator, loadSymbol, removeSymbol, saveChartState, saveIndicator, setChartPrefs } from "@/app/actions";
import type { AlertView } from "@/lib/alert-view";
import { INDICATORS } from "@/indicators/catalog";
import { compileFormula, formulaIndicatorName, formulaTemplate, isFormulaIndicator } from "@/indicators/formula-indicators";
import type { BarsResponse, BarsSymbol, StatusResponse, SymbolStatus } from "@/lib/api-types";
import { BRAND } from "@/lib/brand";
import { CHART_STYLES, parseLineStyles, type ChartPrefs, type ChartStyle, type FormulaDef, type LineOverride, type ParamOverrides } from "@/lib/config";
import { copyText } from "@/lib/copy-text";
import { SESSION_LABELS, fmtAgo } from "@/lib/format";
import { setChartContext } from "@/lib/page-context";
import type { Prices } from "@/lib/series";
import { QUOTE_ROUND_MS } from "@/lib/session";
import { SOURCE_LABELS, TF_LABELS, TIMEFRAMES, chartTitle, isSynthetic, tickerOf, type Timeframe } from "@/lib/symbols";
import type { ProfileView } from "@/lib/profile";
import { synthName } from "@/lib/synth";
import { useLocalStorage } from "@/lib/use-local-storage";
import { useMediaQuery } from "@/lib/use-media-query";
import type { ChartState, OverlaySpec } from "@/lib/vault";
import {
  IconArea,
  IconBack,
  IconBars,
  IconCamera,
  IconCandles,
  IconCaret,
  IconCursor,
  IconDetails,
  IconEye,
  IconFullscreen,
  IconHelp,
  IconHollowCandles,
  IconLock,
  IconMagnet,
  IconNotes,
  IconAlarm,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRuler,
  IconSearch,
  IconTrash,
  IconWatchlist,
} from "./chart-icons";
import { renderSnapshot, snapshotFileName } from "./chart-snapshot";
import { COMPARE_COLORS, DRAW_GROUPS, DRAW_TOOLS, MEASURE_TOOL, OPEN_DRAWINGS, RANGES, type ChartControl, type IndicatorSpec } from "./chart-types";
import { DrawToolGroups, GroupMenuItems } from "./DrawToolGroups";
import { AlertDialog, AlertLoginDialog } from "./AlertDialog";
import { AlertsPanel } from "./AlertsPanel";
import { CompareDialog } from "./CompareDialog";
import { Dialog, Dropdown } from "./Dialog";
import { IndicatorDialog, ParamDialog } from "./IndicatorDialog";
import type { DrawingModes } from "./KChart";
import { LoginPrompt, NotesPanel } from "./NotesPanel";
import { ProfilePanel } from "./ProfilePanel";
import { chartHref, isEditable, useUi } from "./UiProvider";
import { WatchlistPanel, type WatchlistGroup } from "./WatchlistPanel";

const KChart = dynamic(() => import("./KChart").then((m) => m.KChart), { ssr: false });

const STYLE_ICONS: Record<ChartStyle, (p: { size?: number }) => ReactNode> = {
  candle_solid: IconCandles,
  candle_up_stroke: IconHollowCandles,
  ohlc: IconBars,
  area: IconArea,
};

type Panel = "watchlist" | "details" | "notes" | "alerts";
type DialogState =
  | { kind: "indicators"; formula?: FormulaDef | "new" }
  | { kind: "compare" }
  | { kind: "params"; name: string }
  | { kind: "clear" }
  /** 新建警报 at a price, or 编辑警报 */
  | { kind: "alert"; alert: AlertView | null; price: number | null }
  | null;


/** The status strip's line: the exchange (or 按需合成), the quote's session, the last day, how fresh. */
function statusLine(meta: BarsSymbol): string {
  const synth = meta.source === "expr";
  const day = new Date(meta.lastDay);
  return [
    synth ? "按需合成" : meta.exchange,
    meta.session && SESSION_LABELS[meta.session],
    `最新 ${day.getUTCMonth() + 1}/${day.getUTCDate()}`,
    // a synthetic symbol is as fresh as the oldest quote behind it, and has no sync of its own
    meta.syncError ? "同步失败" : (meta.quotedAt ?? 0) > (meta.syncedAt ?? 0) ? fmtAgo(meta.quotedAt, "报价") : synth ? null : fmtAgo(meta.syncedAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

const DEFAULT_DRAWING: DrawingModes = { magnet: false, locked: false, hidden: false };

interface ChartViewProps {
  symbolKey: string;
  prefs: ChartPrefs;
  prices: Prices;
  formulas: FormulaDef[];
  aliases: Record<string, string>;
  bench: string | null;
  benchLabel: string | null;
  names: Record<string, string>;
  /** The watchlist as grouped in the yaml, for the side panel and Space / Shift+Space */
  watchlist: WatchlistGroup[];
  /** Label of the change column in the watchlist panel (the overview's first period) */
  changeLabel: string;
  chartState: ChartState;
  note: string | null;
  noteHtml: string | null;
  noteSavedAt: number | null;
  /** A visitor on a shared instance: preferences stay in this page, drawings and notes need a login */
  readOnly: boolean;
  /** The viewer's vault ('' = root), for per-person drafts */
  vault: string;
  /** Every alert of the viewer's vault (none for a visitor) */
  alerts: AlertView[];
  /** The latest price of this symbol, where a new alert starts */
  livePrice: number | null;
  /** What the symbol is, for the 商品详情 panel (§2.8), and its latest price as traded: not the chart's, which carries dividends under ADJ */
  profile: ProfileView;
  tradedPrice: number | null;
  /** This chart at the instance's public address: copied, shared and printed under a snapshot */
  shareUrl: string;
}

export function ChartView({
  symbolKey,
  prefs,
  prices: initialPrices,
  formulas,
  aliases,
  bench,
  benchLabel,
  names,
  watchlist,
  changeLabel,
  chartState,
  note,
  noteHtml,
  noteSavedAt,
  readOnly,
  vault,
  alerts,
  livePrice,
  profile,
  tradedPrice,
  shareUrl,
}: ChartViewProps) {
  const router = useRouter();
  const { openSearch, openHelp, searchCtx, toast } = useUi();
  const [tf, setTf] = useState(prefs.tf);
  const [log, setLog] = useState(prefs.log);
  const [chartStyle, setChartStyle] = useState(prefs.style);
  const [prices, setPrices] = useState(initialPrices);
  const [enabled, setEnabled] = useState(prefs.indicators);
  const [overrides, setOverrides] = useState<ParamOverrides>(prefs.params);
  const [panes, setPanes] = useState(prefs.panes);
  const [styles, setStyles] = useState(prefs.styles);
  /** An indicator's lines as its open 样式 tab has them, before 确定 */
  const [stylePreview, setStylePreview] = useState<{ id: string; lines: LineOverride[] } | null>(null);
  const [hiddenCompares, setHiddenCompares] = useState<string[]>([]);
  const [hiddenIndicators, setHiddenIndicators] = useState<string[]>([]);
  const [pctAxis, setPctAxis] = useLocalStorage("hebi8:chart:pct", false);
  const [drawing, setDrawing] = useLocalStorage<DrawingModes>("hebi8:chart:drawing", DEFAULT_DRAWING);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [drawTool, setDrawTool] = useState<string | null>(null);
  /** The last tool used in each toolbar group, shown on the group's button */
  const [groupTools, setGroupTools] = useLocalStorage<Record<string, string>>("hebi8:chart:tools", {});
  const [clearSeq, setClearSeq] = useState(0);
  const [revealSeq, setRevealSeq] = useState(0);
  const [autoScale, setAutoScale] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const control = useRef<ChartControl | null>(null);

  // right panel: one at a time, remembered on wide screens; a bottom sheet that starts closed on narrow ones
  // 768px itself is narrow (§5.2), like the classes below and the CSS in globals.css
  const wide = useMediaQuery("(min-width: 769px)");
  const [storedPanel, setStoredPanel] = useLocalStorage<Panel | "none" | null>("hebi8:chart:panel", null);
  const [sheet, setSheet] = useState<Panel | null>(null);
  const panel: Panel | null = wide ? (storedPanel === "none" ? null : (storedPanel ?? (note ? "notes" : null))) : sheet;
  const togglePanel = (p: Panel) => {
    const next = panel === p ? null : p;
    if (wide) setStoredPanel(next ?? "none");
    else setSheet(next);
  };

  const order = useMemo(() => watchlist.flatMap((g) => g.items), [watchlist]);
  const position = order.findIndex((o) => o.key === symbolKey);
  const watched = position >= 0;
  // from a chart that is not on the list, the only symbol on it is still somewhere to go
  const neighbour = (step: 1 | -1) => (order.length < (watched ? 2 : 1) ? null : order[(Math.max(position, step > 0 ? -1 : 0) + step + order.length) % order.length]);

  const [data, setData] = useState<BarsResponse | null>(null);
  // the status strip's sync and quote, read again between bar loads (which reset the chart's view)
  const [live, setLive] = useState<StatusResponse | null>(null);
  const [dataTf, setDataTf] = useState<Timeframe>(tf);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // Opening a symbol that is not in the list never adds it (TradingView); its bars are fetched into
  // the cache by a Server Action, since rendering the page never touches the network. A visitor only
  // sees what is cached.
  const [fetching, setFetching] = useState(!watched && !readOnly);
  const [, startFetch] = useTransition();
  useEffect(() => {
    if (watched || readOnly) return;
    startFetch(async () => {
      const result = await loadSymbol(symbolKey);
      setFetching(false);
      if (result.ok) setReloadTick((n) => n + 1);
      // in the error line, where the bars' own "no data" would otherwise hide why
      else setError(result.error);
    });
    // once per symbol: adding it to the list later changes nothing here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolKey]);

  const stateRef = useRef(chartState);
  useEffect(() => {
    stateRef.current = chartState;
  }, [chartState]);

  // Back in view (another tab may have imported drawings or changed the comparisons): read the
  // page again, then let the chart take over drawings that differ, before anything here saves.
  const [reloadSeq, setReloadSeq] = useState(0);
  const [reloading, startReload] = useTransition();
  const reloadedRef = useRef(false);
  useEffect(() => {
    const reload = () => {
      if (document.visibilityState !== "visible") return;
      reloadedRef.current = true;
      startReload(() => router.refresh());
    };
    document.addEventListener("visibilitychange", reload);
    window.addEventListener("focus", reload);
    return () => {
      document.removeEventListener("visibilitychange", reload);
      window.removeEventListener("focus", reload);
    };
  }, [router]);
  useEffect(() => {
    if (reloading || !reloadedRef.current) return;
    reloadedRef.current = false;
    setReloadSeq((n) => n + 1);
  }, [reloading]);
  const paramTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const styleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingStyles = useRef<Record<string, LineOverride[] | null>>({});

  const scope = useMemo(() => ({ aliases, bench }), [aliases, bench]);
  const compiled = useMemo(() => formulas.map((def) => ({ def, ...compileFormula(def.formula, scope) })), [formulas, scope]);

  const compare = chartState.compare;
  const withParam = useMemo(() => {
    const keys = new Set<string>(compare.map((c) => c.key));
    for (const f of compiled) if (f.program && enabled.includes(f.def.id)) f.program.refs.forEach((k) => keys.add(k));
    return [...keys].sort().join(",");
  }, [compare, compiled, enabled]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for the fetch below
    setLoading(true);
    const query = new URLSearchParams({ key: symbolKey, tf, prices });
    if (withParam) query.set("with", withParam);
    fetch(`/api/bars?${query}`, { signal: controller.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setData(json as BarsResponse);
        setLive(null);
        setDataTf(tf);
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [symbolKey, tf, prices, withParam, reloadTick]);

  // The status strip and the last bar follow the quote rounds while the page is in view, and catch
  // up when it comes back: read just after each round instead of loading the bars again.
  useEffect(() => {
    if (!data) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // one request at a time: an answer that was overtaken by a later one must not put older prices back
    let request: AbortController | undefined;
    const schedule = (s: SymbolStatus) => {
      const due = (s.quotedAt ?? 0) + QUOTE_ROUND_MS + 20_000 - Date.now();
      timer = setTimeout(poll, due > 0 ? due : QUOTE_ROUND_MS);
    };
    const poll = () => {
      clearTimeout(timer);
      request?.abort();
      if (document.visibilityState !== "visible") return;
      request = new AbortController();
      const query = new URLSearchParams({ key: data.symbol.key, tf: dataTf, prices });
      if (withParam) query.set("with", withParam);
      fetch(`/api/status?${query}`, { signal: request.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const s = (await res.json()) as StatusResponse;
          // the page slept through more than one bar: the tail alone would leave a hole, so load them all;
          // the same when the 3D bars are now counted the other way (a dataset's first weekend row)
          // (the next round is still scheduled: when the reload fails, this effect is not started again)
          if ((s.tail?.prev != null && s.tail.prev > (data.bars.at(-1)?.timestamp ?? 0)) || (s.tail && s.tail.weekends !== data.weekends)) setReloadTick((n) => n + 1);
          else setLive(s);
          schedule(s);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") timer = setTimeout(poll, QUOTE_ROUND_MS);
        });
    };
    schedule(data.symbol);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener("visibilitychange", poll);
    };
  }, [data, dataTf, prices, withParam]);

  // Space opens the next symbol, so warm its bars up
  const nextKey = neighbour(1)?.key ?? null;
  useEffect(() => {
    if (!data || !nextKey) return;
    const query = new URLSearchParams({ key: nextKey, tf, prices });
    void fetch(`/api/bars?${query}`, { priority: "low" }).catch(() => undefined);
  }, [data, nextKey, tf, prices]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /** TradingView: a new alert starts at the latest price unless it came from a price on the chart */
  const openAlert = (price?: number) => setDialog({ kind: "alert", alert: null, price: price ?? livePrice ?? data?.bars.at(-1)?.close ?? null });
  const report = (result: { ok: boolean; error?: string }) => setMessage(result.ok ? null : (result.error ?? "操作失败"));
  const persist = (partial: Parameters<typeof setChartPrefs>[0]) => {
    if (!readOnly) void setChartPrefs(partial).then(report);
  };

  // indicator parameters follow the bars on screen, so a timeframe still loading never runs weekly MAs on daily bars
  const tfOverrides = useMemo(() => overrides[dataTf] ?? {}, [overrides, dataTf]);
  const params = useMemo(
    () => Object.fromEntries(INDICATORS.map((d) => [d.name, tfOverrides[d.name] ?? d.params[dataTf]])),
    [dataTf, tfOverrides],
  );
  const hasBench = Boolean(bench);
  const templates = useMemo(
    () => compiled.flatMap((f) => (f.program && enabled.includes(f.def.id) ? [formulaTemplate(f.def, f.program, data?.refs ?? {})] : [])),
    [compiled, enabled, data],
  );
  // a preview lasts as long as the settings dialog it came from
  const preview = dialog?.kind === "params" || dialog?.kind === "indicators" ? stylePreview : null;
  const specs: IndicatorSpec[] = useMemo(() => {
    const linesOf = (id: string) => (preview?.id === id ? preview.lines : styles[id]);
    return [
      ...INDICATORS.filter((d) => enabled.includes(d.name) && (!d.needsBenchmark || hasBench)).map((d) => ({
        name: d.name,
        pane: panes[d.name] ?? d.pane,
        ownScale: d.pane === "sub",
        calcParams: params[d.name],
        hidden: hiddenIndicators.includes(d.name),
        precision: d.precision,
        lines: linesOf(d.name),
      })),
      ...compiled
        .filter((f) => f.program && enabled.includes(f.def.id))
        .map((f) => {
          const name = formulaIndicatorName(f.def.id);
          return { name, pane: panes[f.def.id] ?? f.def.pane, ownScale: f.def.pane === "sub", calcParams: [], hidden: hiddenIndicators.includes(name), lines: linesOf(f.def.id) };
        }),
    ];
  }, [enabled, hasBench, params, compiled, hiddenIndicators, panes, styles, preview]);
  const labels = useMemo(
    () => Object.fromEntries([...INDICATORS.map((d) => [d.name, d.label]), ...formulas.map((f) => [formulaIndicatorName(f.id), f.label])]),
    [formulas],
  );

  const changeTf = (next: Timeframe) => {
    setTf(next);
    persist({ tf: next });
  };
  const toggle = (name: string) => {
    const next = enabled.includes(name) ? enabled.filter((n) => n !== name) : [...enabled, name];
    setEnabled(next);
    persist({ indicators: next });
  };
  const setParams = (name: string, value: number[] | null) => {
    const next = { ...tfOverrides };
    if (value) next[name] = value;
    else delete next[name];
    setOverrides({ ...overrides, [dataTf]: next });
    clearTimeout(paramTimer.current);
    paramTimer.current = setTimeout(() => persist({ params: { [dataTf]: { [name]: value ?? [] } } }), 600);
  };
  /** 样式 → 确定 (null: 恢复默认); by built-in name or formula id, for every timeframe */
  const saveStyles = (id: string, lines: LineOverride[] | null) => {
    const own = parseLineStyles(lines);
    const rest = Object.fromEntries(Object.entries(styles).filter(([k]) => k !== id));
    setStyles(own.length ? { ...rest, [id]: own } : rest);
    setStylePreview(null);
    pendingStyles.current[id] = own.length ? own : null;
    clearTimeout(styleTimer.current);
    styleTimer.current = setTimeout(() => {
      persist({ styles: pendingStyles.current });
      pendingStyles.current = {};
    }, 600);
  };
  const openIndicators = (formula?: FormulaDef) => {
    setStylePreview(null);
    setDialog({ kind: "indicators", ...(formula ? { formula } : {}) });
  };
  const saveFormula = async (def: FormulaDef) => {
    const result = await saveIndicator(def);
    if (result.ok && !enabled.includes(def.id)) setEnabled([...enabled, def.id]);
    return result.ok ? null : result.error;
  };
  const deleteFormula = async (id: string) => {
    const result = await deleteIndicator(id);
    if (result.ok) setEnabled(enabled.filter((n) => n !== id));
    return result.ok ? null : result.error;
  };

  const saveState = async (next: Partial<ChartState>) => {
    if (readOnly) {
      setMessage("登录后才能保存画线和比较商品");
      return false;
    }
    const result = await saveChartState(symbolKey, { ...stateRef.current, ...next });
    report(result);
    return result.ok;
  };
  const onOverlaysChange = (overlays: OverlaySpec[]) => void saveState({ overlays });
  const removeCompare = (key: string) => void saveState({ compare: compare.filter((c) => c.key !== key) });

  // legend row actions: eye, gear (or double click), ×, and ⋯ → 移动到
  const onIndicator = (name: string, action: "toggle" | "settings" | "remove" | "move") => {
    const id = isFormulaIndicator(name) ? name.slice(2) : name;
    if (action === "toggle") setHiddenIndicators((h) => (h.includes(name) ? h.filter((n) => n !== name) : [...h, name]));
    else if (action === "move") {
      // between the main pane and a pane of its own; only a move away from the usual pane is kept
      const home = INDICATORS.find((d) => d.name === id)?.pane ?? formulas.find((f) => f.id === id)?.pane ?? "sub";
      const next = (panes[id] ?? home) === "main" ? "sub" : "main";
      const rest = Object.fromEntries(Object.entries(panes).filter(([k]) => k !== id));
      setPanes(next === home ? rest : { ...rest, [id]: next });
      persist({ panes: { [id]: next === home ? null : next } });
    } else if (action === "remove") {
      if (enabled.includes(id)) toggle(id);
    } else if (isFormulaIndicator(name)) {
      const def = formulas.find((f) => f.id === id);
      if (def) openIndicators(def);
    } else {
      setStylePreview(null);
      setDialog({ kind: "params", name });
    }
  };
  const onCompare = (key: string, action: "toggle" | "remove") => {
    if (action === "remove") removeCompare(key);
    else setHiddenCompares((h) => (h.includes(key) ? h.filter((k) => k !== key) : [...h, key]));
  };

  const chooseTool = (name: string | null) => {
    // TradingView shows hidden drawings again when you start a new one
    if (name && drawing.hidden) setDrawing({ ...drawing, hidden: false });
    // ...and the group's button keeps the tool picked last
    const group = name ? DRAW_GROUPS.find((g) => g.sections.some((s) => s.tools.some((t) => t.name === name))) : undefined;
    if (group && groupTools[group.id] !== name) setGroupTools({ ...groupTools, [group.id]: name! });
    setDrawTool((cur) => (cur === name ? null : name));
  };

  const go = (step: 1 | -1) => {
    const target = neighbour(step);
    if (target) router.push(chartHref(target.key));
  };

  // range buttons fit the bars; when they would be under a pixel each, step up to a longer timeframe like TV
  const pendingRange = useRef<number | null | undefined>(undefined);
  const fitRange = (years: number | null) => {
    const c = control.current;
    if (!c || c.fitRange(years)) return;
    const next = TIMEFRAMES[TIMEFRAMES.indexOf(tf) + 1];
    if (!next) return;
    pendingRange.current = years;
    changeTf(next);
  };
  useEffect(() => {
    if (pendingRange.current === undefined || !data || dataTf !== tf) return;
    const years = pendingRange.current;
    pendingRange.current = undefined;
    fitRange(years);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the new timeframe's bars are in
  }, [data, dataTf, tf]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => setMessage("浏览器不允许全屏"));
  };

  // what in-app feedback attaches about this chart
  useEffect(() => {
    setChartContext({
      symbol: symbolKey,
      tf,
      style: chartStyle,
      log,
      prices,
      indicators: enabled,
      compares: compare.map((c) => ({ key: c.key, mode: c.mode })),
    });
  }, [symbolKey, tf, chartStyle, log, prices, enabled, compare]);
  useEffect(() => () => setChartContext(null), []);

  const bars = data?.bars;
  const meta = data?.symbol;
  const alertLines = useMemo(() => alerts.filter((a) => a.key === symbolKey).flatMap((a) => a.levels.map((price) => ({ id: a.id, price }))), [alerts, symbolKey]);
  // a log axis has no place for zero or negative prices (a data: series can have them): the button is off, the saved preference stays
  const nonPositive = useMemo(() => Boolean(bars?.some((b) => b.low <= 0)), [bars]);
  const forcedPercent = compare.some((c) => c.mode === "percent" && !hiddenCompares.includes(c.key));
  const percentOn = forcedPercent || pctAxis;
  const compareWithHidden = useMemo(() => compare.map((c) => ({ ...c, hidden: hiddenCompares.includes(c.key) })), [compare, hiddenCompares]);
  const drawLabel = drawTool === MEASURE_TOOL ? "测量" : DRAW_TOOLS.find((t) => t.name === drawTool)?.label;
  // TradingView's 测量 is not a drawing: starting it leaves hidden drawings hidden and no group remembers it
  const toggleMeasure = () => setDrawTool((cur) => (cur === MEASURE_TOOL ? null : MEASURE_TOOL));
  // drawings hidden one by one (the floating toolbar's eye) are shown again by the same button as "hide all"
  const someHidden = drawing.hidden || chartState.overlays.some((o) => o.hidden);
  const toggleHidden = () => {
    if (!someHidden) return setDrawing({ ...drawing, hidden: true });
    setDrawing({ ...drawing, hidden: false });
    setRevealSeq((n) => n + 1);
  };
  const name = names[symbolKey] ?? meta?.name ?? symbolKey;
  const ticker = meta?.ticker ?? (isSynthetic(symbolKey) ? synthName(symbolKey) : tickerOf(symbolKey));
  const sourceLabel = meta ? (meta.source === "expr" ? "合成" : SOURCE_LABELS[meta.source]) : null;
  const syncText = meta ? (meta.source === "expr" ? "按需合成" : fmtAgo(meta.syncedAt)) : "";
  const { tail = null, ...liveStatus } = live ?? {};
  const shown = meta && { ...meta, ...liveStatus, lastDay: tail?.lastDay ?? meta.lastDay };
  const status = shown ? statusLine(shown) : "";
  const [session, quotedAt, calendar] = [shown?.session ?? null, shown?.quotedAt ?? null, meta?.calendar];
  const clock = useMemo(() => ({ hours: null, timezone: null, holidays: null, corrections: null, ...calendar, session, quotedAt }), [session, quotedAt, calendar]);
  const subtitle = [
    TF_LABELS[dataTf],
    ...(sourceLabel ? [sourceLabel] : []),
    ...(meta?.currency ? [meta.currency] : []),
    ...(meta?.bench ? [`基准 ${benchLabel ?? names[meta.bench] ?? meta.bench}`] : []),
  ];
  const StyleIcon = STYLE_ICONS[chartStyle];
  const title = chartTitle(name, ticker, dataTf);

  // TradingView updates the tab title as the chart changes; the server only knows the saved timeframe
  useEffect(() => {
    document.title = `${title} · ${BRAND}`;
  }, [title]);

  // 拍快照, after TradingView's camera menu
  const snapshot = () => {
    const capture = control.current?.capture();
    if (!capture || !bars?.length) return Promise.reject(new Error("图表还没加载好"));
    return renderSnapshot(capture, {
      title: name,
      ticker,
      subtitle,
      tf: dataTf,
      last: bars.at(-1) ?? null,
      prevClose: bars.at(-2)?.close ?? null,
      pricePrecision: data?.pricePrecision ?? 2,
      url: shareUrl,
      compare: compareWithHidden,
      names,
      labels,
      hiddenIndicators,
    });
  };
  const snapshotFailed = (err: Error) => toast(err.message || "生成图片失败", { kind: "error" });
  const downloadImage = () =>
    void snapshot().then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = snapshotFileName(ticker);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, snapshotFailed);
  // the async clipboard (and with it any image copy) exists only on https or localhost, not on the tailnet's http
  const canCopyImage = () => window.isSecureContext && typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);
  // the pending picture goes into the clipboard item at once: Safari only allows the write during the click
  const copyImage = () => void navigator.clipboard.write([new ClipboardItem({ "image/png": snapshot() })]).then(() => toast("已复制图片"), snapshotFailed);
  const copyLink = () => (copyText(shareUrl) ? toast("已复制图表链接") : toast("复制失败", { kind: "error" }));
  // like TradingView, X gets the link and a line of text: an intent cannot carry a picture
  const postToX = () => window.open(`https://x.com/intent/post?${new URLSearchParams({ text: `${title} · ${BRAND}`, url: shareUrl })}`, "_blank", "noopener");
  const canShareImage = () => typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([], "chart.png", { type: "image/png" })] });
  // Making the picture can use up the click's user activation, and the share sheet then refuses it:
  // the picture is kept and the next click shares it at once.
  const pendingShare = useRef<File | null>(null);
  const shareImage = () => {
    const share = (file: File) => navigator.share({ files: [file], title, text: `${title} · ${BRAND} ${shareUrl}` });
    const kept = pendingShare.current;
    pendingShare.current = null;
    const shared = kept
      ? share(kept)
      : snapshot().then((blob) => {
          const file = new File([blob], snapshotFileName(ticker), { type: "image/png" });
          return share(file).catch((err: Error) => {
            if (err.name !== "NotAllowedError") throw err;
            pendingShare.current = file;
            toast("图片已生成，再点一次分享");
          });
        });
    void shared.catch((err: Error) => err.name !== "AbortError" && snapshotFailed(err));
  };

  // TradingView hotkeys; the latest closure is kept in a ref so the listener is attached once
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    onKeyRef.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Esc works from inside an editor's own input too; the search overlay stops its own Esc
      if (e.key === "Escape") {
        setDialog(null);
        control.current?.closeDialog();
        setDrawTool(null);
        if (isEditable(e.target)) (e.target as HTMLElement).blur();
        return;
      }
      if (isEditable(e.target) || dialog || control.current?.dialogOpen()) return;
      // TradingView's snapshot keys: Ctrl/Cmd+Alt+S saves the picture, Alt+S (below) copies the link
      if (e.code === "KeyS" && (e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey) {
        e.preventDefault();
        downloadImage();
        return;
      }
      // TradingView: Ctrl+Z undoes a drawing change, Ctrl+Y or Ctrl+Shift+Z redoes it (⌘ on a Mac)
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === "z" || key === "y")) {
        const done = key === "y" || e.shiftKey ? control.current?.redo() : control.current?.undo();
        if (done) e.preventDefault();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const tool = DRAW_TOOLS.find((t) => t.code === e.code);
        if (tool) {
          e.preventDefault();
          chooseTool(tool.name);
        } else if (e.code === "KeyR") {
          e.preventDefault();
          control.current?.reset();
        } else if (e.code === "KeyA") {
          e.preventDefault();
          openAlert();
        } else if (e.code === "KeyS") {
          e.preventDefault();
          copyLink();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const c = control.current;
      switch (e.key) {
        case "Delete":
        case "Backspace":
          if (c?.deleteSelected()) e.preventDefault();
          return;
        case "ArrowLeft":
        case "ArrowRight":
          if (e.shiftKey) return; // KLineChart's own Shift+arrow scroll
          e.preventDefault();
          c?.scroll(e.key === "ArrowLeft" ? -0.1 : 0.1);
          return;
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          c?.zoom(e.key === "ArrowUp" ? 1.25 : 0.8);
          return;
        case " ":
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur?.();
          go(e.shiftKey ? -1 : 1);
          return;
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const shownError = fetching && !data ? null : error;

  const addToList = async (group: string) => {
    const result = await addSymbol({ key: symbolKey, group });
    if (!result.ok) return setMessage(result.error);
    setMessage(null);
    toast(`已把 ${name} 加入「${group}」`, { action: { label: "撤销", onClick: () => void removeSymbol(symbolKey).then(report) } });
  };
  const paramDef = dialog?.kind === "params" ? INDICATORS.find((d) => d.name === dialog.name) : undefined;

  const clearDrawings = () => {
    if (chartState.overlays.length === 0) return;
    // in-page confirm: a native confirm() would drop fullscreen
    setDialog({ kind: "clear" });
  };
  const confirmClearDrawings = () => {
    setDialog(null);
    setDrawTool(null);
    setClearSeq((n) => n + 1);
  };
  const drawingMenu = (close: () => void) => (
    <>
      <button role="menuitem" className="menu-item flex items-center gap-2" onClick={() => {
          chooseTool(null);
          close();
        }}>
        <IconCursor /> 十字光标
      </button>
      <button role="menuitem" className="menu-item flex items-center gap-2" onClick={() => {
          toggleMeasure();
          close();
        }}>
        <IconRuler /> 测量{drawTool === MEASURE_TOOL && " ✓"}
      </button>
      {DRAW_GROUPS.map((g) => (
        <GroupMenuItems
          key={g.id}
          group={g}
          active={drawTool}
          hotkeys={false}
          onPick={(tool) => {
            chooseTool(tool);
            close();
          }}
        />
      ))}
      <div className="my-1 h-px bg-line" />
      <button role="menuitem" className="menu-item flex items-center gap-2" onClick={() => setDrawing({ ...drawing, magnet: !drawing.magnet })}>
        <IconMagnet /> 磁铁模式{drawing.magnet && " ✓"}
      </button>
      <button role="menuitem" className="menu-item flex items-center gap-2" onClick={() => setDrawing({ ...drawing, locked: !drawing.locked })}>
        <IconLock open={!drawing.locked} /> 锁定所有绘图{drawing.locked && " ✓"}
      </button>
      <button role="menuitem" className="menu-item flex items-center gap-2" onClick={toggleHidden}>
        <IconEye off={someHidden} /> {someHidden ? "显示所有绘图" : "隐藏所有绘图"}
      </button>
      <button role="menuitem" className="menu-item flex items-center gap-2 text-down" onClick={() => {
          close();
          clearDrawings();
        }}>
        <IconTrash /> 删除所有绘图
      </button>
    </>
  );
  const panelContent =
    panel === "watchlist" ? (
      <WatchlistPanel
        groups={watchlist}
        changeLabel={changeLabel}
        current={symbolKey}
        readOnly={readOnly}
        onPick={(key) => {
          if (!wide) setSheet(null);
          if (key !== symbolKey) router.push(chartHref(key));
        }}
        onAdd={() => openSearch("", "add")}
        onClose={() => togglePanel("watchlist")}
        className="h-full"
      />
    ) : panel === "details" ? (
      <ProfilePanel
        symbolKey={symbolKey}
        name={names[symbolKey] ?? symbolKey}
        ticker={data?.symbol.ticker ?? symbolKey}
        view={profile}
        // as traded, moving with the quote rounds like the chart's last bar
        price={live?.price ?? tradedPrice}
        readOnly={readOnly}
        onClose={() => togglePanel("details")}
        className="h-full"
      />
    ) : panel === "alerts" ? (
      <AlertsPanel
        alerts={alerts}
        current={symbolKey}
        readOnly={readOnly}
        onCreate={() => openAlert()}
        onEdit={(alert) => setDialog({ kind: "alert", alert, price: null })}
        onClose={() => togglePanel("alerts")}
        className="h-full"
      />
    ) : panel === "notes" ? (
      readOnly ? (
        <LoginPrompt text="登录后看自己的笔记" onClose={() => togglePanel("notes")} className="h-full" />
      ) : (
        <NotesPanel key={vault} vault={vault} symbolKey={symbolKey} note={note} html={noteHtml} savedAt={noteSavedAt} onClose={() => togglePanel("notes")} className="h-full" />
      )
    ) : null;

  return (
    <main
      className="flex w-full flex-col overflow-hidden bg-card"
      style={{ height: "calc(100dvh - var(--site-header-h))" }}
    >
      {/* top toolbar: one row, scrolls sideways on narrow screens */}
      <div className="scroll-row flex h-[38px] shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5" role="toolbar" aria-label="图表工具栏">
        <Link href="/" className="tb-btn" title="返回总览">
          <IconBack />
          <span className="hidden text-xs text-muted lg:inline">总览</span>
        </Link>
        <span className="tb-sep" />
        <button type="button" onClick={() => openSearch()} className="tb-btn max-w-[16rem] px-2" title={`${name} · 商品代码搜索（直接敲字母，或 /）`}>
          <IconSearch size={16} />
          <span className="font-semibold">{ticker}</span>
          {name !== ticker && <span className="hidden truncate text-xs text-muted sm:inline">{name}</span>}
        </button>
        {!watched && !readOnly && (
          <Dropdown
            label={
              <>
                <IconWatchlist />
                <span className="text-xs">加入自选</span>
              </>
            }
            title="加入自选列表"
            className="tb-btn px-1.5"
            menuClassName="min-w-[10rem]"
          >
            {(close) => (
              <>
                <div className="px-2 pt-1.5 pb-1 text-[11px] text-muted">加入分组</div>
                {watchlist.map((g) => (
                  <button
                    key={g.name}
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      close();
                      void addToList(g.name);
                    }}
                  >
                    {g.name}
                  </button>
                ))}
                <form
                  className="p-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const group = String(new FormData(e.currentTarget).get("group") ?? "").trim();
                    if (!group) return;
                    close();
                    void addToList(group);
                  }}
                >
                  <input name="group" placeholder="新分组名 · Enter" aria-label="新分组名" className="input h-7 w-full text-xs" />
                </form>
              </>
            )}
          </Dropdown>
        )}
        <button type="button" onClick={() => setDialog({ kind: "compare" })} className="tb-btn" title="比较商品" aria-label="比较商品">
          <IconPlus />
          {compare.length > 0 && <span className="text-[11px] text-muted">{compare.length}</span>}
        </button>
        <span className="tb-sep" />
        {TIMEFRAMES.map((t) => (
          <button key={t} type="button" onClick={() => changeTf(t)} aria-pressed={t === tf} className="tb-btn min-w-[30px] px-1.5" title={`${TF_LABELS[t]}线`}>
            {TF_LABELS[t]}
          </button>
        ))}
        <span className="tb-sep" />
        <Dropdown label={<><StyleIcon /><IconCaret className="text-muted" /></>} title={`图表类型：${CHART_STYLES[chartStyle]}`} menuClassName="min-w-[9rem]">
          {(close) =>
            (Object.keys(CHART_STYLES) as ChartStyle[]).map((s) => {
              const Icon = STYLE_ICONS[s];
              return (
                <button
                  key={s}
                  role="menuitemradio"
                  aria-checked={s === chartStyle}
                  onClick={() => {
                    setChartStyle(s);
                    persist({ style: s });
                    close();
                  }}
                  className={`menu-item flex items-center gap-2 ${s === chartStyle ? "font-medium" : ""}`}
                >
                  <Icon /> {CHART_STYLES[s]}
                </button>
              );
            })
          }
        </Dropdown>
        <span className="tb-sep" />
        <button type="button" onClick={() => openIndicators()} className="tb-btn px-2" title="指标">
          <span className="font-serif text-[15px] italic">fx</span>
          <span>指标</span>
        </button>
        <button type="button" onClick={() => openAlert()} className="tb-btn px-2" title="创建警报 · Alt+A">
          <IconAlarm />
          <span className="hidden sm:inline">警报</span>
        </button>
        {/* narrow screens: drawing tools and the side panels live in the top bar */}
        <span className="tb-sep min-[769px]:hidden" />
        <span className="flex min-[769px]:hidden">
          <Dropdown label={<><IconPencil /><span className="text-xs">画线</span></>} title="画线工具" pressed={Boolean(drawTool)} menuClassName="w-[200px] max-h-[70vh] overflow-y-auto">
            {drawingMenu}
          </Dropdown>
          <button type="button" onClick={() => togglePanel("watchlist")} aria-pressed={panel === "watchlist"} className="tb-btn" title="自选列表" aria-label="自选列表">
            <IconWatchlist />
          </button>
          <button type="button" onClick={() => togglePanel("details")} aria-pressed={panel === "details"} className="tb-btn" title="商品详情" aria-label="商品详情">
            <IconDetails />
          </button>
          <button type="button" onClick={() => togglePanel("notes")} aria-pressed={panel === "notes"} className="tb-btn" title="笔记" aria-label="笔记">
            <IconNotes />
          </button>
          <button type="button" onClick={() => togglePanel("alerts")} aria-pressed={panel === "alerts"} className="tb-btn" title="警报列表" aria-label="警报列表">
            <IconAlarm />
          </button>
        </span>
        <span className="min-w-2 flex-1" />
        <button type="button" onClick={() => setReloadTick((n) => n + 1)} disabled={loading || fetching} className="tb-btn" title={`刷新 · ${loading || fetching ? "加载中…" : syncText}`} aria-label="刷新">
          <IconRefresh className={loading || fetching ? "animate-spin" : ""} />
        </button>
        <Dropdown label={<IconCamera />} title="拍快照" className="tb-btn" menuClassName="min-w-[13rem]">
          {(close) => {
            const item = (label: string, keys: string, run: () => void, disabled?: string) => (
              <button
                role="menuitem"
                className="menu-item flex items-center gap-2 disabled:cursor-default disabled:opacity-50"
                disabled={Boolean(disabled)}
                title={disabled}
                onClick={() => {
                  close();
                  run();
                }}
              >
                <span className="flex-1">{label}</span>
                {keys && <span className="pl-4 text-[11px] text-muted">{keys}</span>}
              </button>
            );
            const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
            const noChart = bars?.length ? undefined : "图表还没加载好";
            return (
              <>
                {item("下载图片", mac ? "⌘⌥S" : "Ctrl+Alt+S", downloadImage, noChart)}
                {item("复制图片", "", copyImage, noChart ?? (canCopyImage() ? undefined : "浏览器只在 HTTPS 页面允许复制图片"))}
                {item("复制链接", mac ? "⌥S" : "Alt+S", copyLink)}
                {item("在 X 上分享", "", postToX)}
                {canShareImage() && item("分享…", "", shareImage, noChart)}
              </>
            );
          }}
        </Dropdown>
        {/* the site header (and its "?") is hidden in fullscreen */}
        {fullscreen && (
          <button type="button" onClick={() => openHelp()} className="tb-btn" title="帮助与反馈 · ?" aria-label="帮助与反馈">
            <IconHelp />
          </button>
        )}
        <button type="button" onClick={toggleFullscreen} className="tb-btn" title={fullscreen ? "退出全屏" : "全屏"} aria-label={fullscreen ? "退出全屏" : "全屏"}>
          <IconFullscreen exit={fullscreen} />
        </button>
      </div>

      {(shownError || message) && <p className="shrink-0 border-b border-line px-3 py-1 text-xs text-down">{shownError ? `加载失败：${shownError}` : message}</p>}

      <div className="flex min-h-0 flex-1">
        {/* left drawing toolbar */}
        <div className="hidden w-[42px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line py-1.5 min-[769px]:flex" role="toolbar" aria-label="画线工具" aria-orientation="vertical">
          <button type="button" onClick={() => chooseTool(null)} aria-pressed={!drawTool} className="tb-btn" title="十字光标 · Esc" aria-label="十字光标">
            <IconCursor />
          </button>
          <DrawToolGroups active={drawTool} remembered={groupTools} onPick={(tool) => chooseTool(tool)} />
          <span className="tb-sep-h" />
          <button type="button" onClick={toggleMeasure} aria-pressed={drawTool === MEASURE_TOOL} className="tb-btn" title="测量 · Shift + 点击" aria-label="测量">
            <IconRuler />
          </button>
          <span className="tb-sep-h" />
          <button
            type="button"
            onClick={() => setDrawing({ ...drawing, magnet: !drawing.magnet })}
            aria-pressed={drawing.magnet}
            className="tb-btn"
            title={drawing.magnet ? "磁铁模式：开（吸附到开高低收）" : "磁铁模式"}
            aria-label="磁铁模式"
          >
            <IconMagnet />
          </button>
          <button
            type="button"
            onClick={() => setDrawing({ ...drawing, locked: !drawing.locked })}
            aria-pressed={drawing.locked}
            className="tb-btn"
            title={drawing.locked ? "解锁所有绘图" : "锁定所有绘图"}
            aria-label="锁定所有绘图"
          >
            <IconLock open={!drawing.locked} />
          </button>
          <button
            type="button"
            onClick={toggleHidden}
            aria-pressed={someHidden}
            className="tb-btn"
            title={someHidden ? "显示所有绘图" : "隐藏所有绘图"}
            aria-label={someHidden ? "显示所有绘图" : "隐藏所有绘图"}
          >
            <IconEye off={someHidden} />
          </button>
          <button type="button" onClick={clearDrawings} disabled={chartState.overlays.length === 0} className="tb-btn" title="删除所有绘图" aria-label="删除所有绘图">
            <IconTrash />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {fetching && !data && (
              <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 text-xs text-muted" role="status">
                正在拉取 {name} 的日线…
              </div>
            )}
            {drawLabel && (
              <div className="pointer-events-none absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded border border-line bg-card/95 px-2 py-1 text-[11px] text-muted" role="status">
                {drawLabel} · 在主图上点击{drawTool && OPEN_DRAWINGS.has(drawTool) ? " · 双击或回车结束" : ""} · Esc 退出
              </div>
            )}
            <div className="absolute inset-0">
              <KChart
                symbolKey={symbolKey}
                tf={dataTf}
                bars={bars ?? null}
                weekends={data?.weekends ?? false}
                tail={tail}
                clock={clock}
                pricePrecision={data?.pricePrecision ?? 2}
                log={log && !nonPositive}
                percentAxis={pctAxis}
                chartStyle={chartStyle}
                indicators={specs}
                templates={templates}
                compare={compareWithHidden}
                refs={data?.refs ?? {}}
                overlays={chartState.overlays}
                onOverlaysChange={onOverlaysChange}
                drawTool={drawTool}
                onDrawDone={() => setDrawTool(null)}
                clearSeq={clearSeq}
                revealSeq={revealSeq}
                reloadSeq={reloadSeq}
                drawing={drawing}
                controlRef={control}
                onAutoScaleChange={setAutoScale}
                legend={{ title: name, subtitle, names, labels, hiddenIndicators, onIndicator, onCompare }}
                alertLines={alertLines}
                onAddAlert={openAlert}
                onEditAlert={(id) => {
                  const alert = alerts.find((a) => a.id === id);
                  if (alert) setDialog({ kind: "alert", alert, price: null });
                }}
              />
            </div>
          </div>

          {/* bottom bar: date ranges left, scale toggles right */}
          <div className="scroll-row flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-line px-1.5" role="toolbar" aria-label="范围与坐标">
            {RANGES.map((r) => (
              <button key={r.label} type="button" onClick={() => fitRange(r.years)} className="tb-btn h-6 px-1.5 text-xs" title={r.years ? `显示最近 ${r.years} 年` : "显示全部历史"}>
                {r.label}
              </button>
            ))}
            <span className="min-w-2 flex-1" />
            <button
              type="button"
              onClick={() => {
                const next: Prices = prices === "total" ? "split" : "total";
                setPrices(next);
                persist({ prices: next });
              }}
              aria-pressed={prices === "total"}
              className="tb-btn h-6 px-1.5 text-xs"
              title="ADJ 含分红：把分红折进价格（总回报）"
            >
              ADJ
            </button>
            <span className="tb-sep" />
            <button
              type="button"
              onClick={() => {
                if (forcedPercent) return;
                if (!pctAxis && log && !nonPositive) {
                  setLog(false);
                  persist({ log: false });
                }
                setPctAxis(!pctAxis);
              }}
              aria-pressed={percentOn}
              data-locked={forcedPercent}
              className="tb-btn h-6 px-1.5 text-xs"
              title={forcedPercent ? "比较模式下使用百分比坐标" : "百分比坐标"}
            >
              %
            </button>
            <button
              type="button"
              onClick={() => {
                if (!log && pctAxis) setPctAxis(false);
                setLog(!log);
                persist({ log: !log });
              }}
              aria-pressed={log && !percentOn && !nonPositive}
              disabled={forcedPercent || nonPositive}
              className="tb-btn h-6 px-1.5 text-xs"
              title={nonPositive ? "价格里有 0 或负数，不能用对数坐标" : forcedPercent ? "比较模式下使用百分比坐标" : "对数坐标"}
            >
              log
            </button>
            <button
              type="button"
              onClick={() => control.current?.setAutoScale(!autoScale)}
              aria-pressed={autoScale}
              className="tb-btn h-6 px-1.5 text-xs"
              title={autoScale ? "自动缩放价格坐标：开（点击关闭后可上下拖动图表）· Alt+R 重置图表" : "自动缩放价格坐标：关（点击恢复）· Alt+R 重置图表"}
            >
              自动
            </button>
          </div>
        </div>

        {panel && wide && <div className="w-[280px] shrink-0 border-l border-line">{panelContent}</div>}

        {/* right icon strip */}
        <div className="hidden w-[42px] shrink-0 flex-col items-center gap-0.5 border-l border-line py-1.5 min-[769px]:flex" role="toolbar" aria-label="侧栏" aria-orientation="vertical">
          <button type="button" onClick={() => togglePanel("watchlist")} aria-pressed={panel === "watchlist"} className="tb-btn" title="自选列表 · Space / Shift+Space 下一只 / 上一只" aria-label="自选列表">
            <IconWatchlist />
          </button>
          <button type="button" onClick={() => togglePanel("details")} aria-pressed={panel === "details"} className="tb-btn" title="商品详情" aria-label="商品详情">
            <IconDetails />
          </button>
          <button type="button" onClick={() => togglePanel("notes")} aria-pressed={panel === "notes"} className="tb-btn" title="笔记" aria-label="笔记">
            <IconNotes />
          </button>
          <button type="button" onClick={() => togglePanel("alerts")} aria-pressed={panel === "alerts"} className="tb-btn" title="警报" aria-label="警报列表">
            <IconAlarm />
          </button>
        </div>
      </div>

      {/* status strip: as high as the iPhone's home bar inset, so 0 (hidden) elsewhere; clear of the rounded corners */}
      <div className={`h-[var(--safe-bottom)] shrink-0 overflow-hidden px-8 text-center text-[11px] leading-5 ${shown?.syncError ? "text-down" : "text-muted"}`} title={shown?.syncError ?? undefined}>
        <span className="block truncate">{status}</span>
      </div>

      {panel && !wide && (
        <div className="fixed inset-x-0 bottom-0 z-40 h-[60vh] overflow-hidden rounded-t-lg pb-[var(--safe-bottom)] border-t border-line bg-card shadow-[0_-8px_24px_rgb(0_0_0/0.15)]">{panelContent}</div>
      )}

      {dialog?.kind === "indicators" && (
        <IndicatorDialog
          enabled={enabled}
          hasBenchmark={hasBench}
          formulas={compiled.map((f) => ({ def: f.def, error: f.error }))}
          scope={scope}
          initialFormula={dialog.formula}
          onToggle={toggle}
          onSaveFormula={saveFormula}
          onDeleteFormula={deleteFormula}
          linesOf={(def) => {
            const outputs = compiled.find((f) => f.def.id === def.id)?.program?.outputs;
            return outputs ? (control.current?.indicatorLines(formulaIndicatorName(def.id), { titles: outputs }) ?? null) : null;
          }}
          styles={styles}
          onPreviewStyles={(id, lines) => setStylePreview(lines ? { id, lines } : null)}
          onSaveStyles={saveStyles}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "compare" && (
        <CompareDialog
          ctx={searchCtx}
          symbolKey={symbolKey}
          existing={compare}
          names={names}
          onAdd={async (key, mode) => {
            const used = new Set(compare.map((c) => c.color));
            const color = COMPARE_COLORS.find((c) => !used.has(c)) ?? COMPARE_COLORS[compare.length % COMPARE_COLORS.length];
            return saveState({ compare: [...compare, { key, mode, color }] });
          }}
          onRemove={removeCompare}
          onClose={() => setDialog(null)}
        />
      )}
      {paramDef && (
        <ParamDialog
          key={`${paramDef.name}:${dataTf}`}
          def={paramDef}
          tf={dataTf}
          value={params[paramDef.name] ?? []}
          overridden={paramDef.name in tfOverrides}
          linesFor={(p) => control.current?.indicatorLines(paramDef.name, { params: p }) ?? []}
          styles={styles[paramDef.name] ?? []}
          onSave={(p) => setParams(paramDef.name, p)}
          onPreviewStyles={(lines) => setStylePreview({ id: paramDef.name, lines })}
          onSaveStyles={(lines) => saveStyles(paramDef.name, lines)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "alert" &&
        (readOnly ? (
          <AlertLoginDialog onClose={() => setDialog(null)} />
        ) : (
          <AlertDialog
            symbolKey={dialog.alert?.key ?? symbolKey}
            symbolName={dialog.alert?.name ?? name}
            alert={dialog.alert}
            price={dialog.price}
            precision={data?.pricePrecision ?? 2}
            aliases={aliases}
            bench={bench}
            onSaved={() => {
              toast(dialog.alert ? "已保存警报" : "已创建警报");
              setDialog(null);
            }}
            onClose={() => setDialog(null)}
          />
        ))}
      {dialog?.kind === "clear" && (
        <Dialog title="删除所有绘图" onClose={() => setDialog(null)} className="max-w-[360px]">
          <div className="p-4 text-sm">删除这个标的的全部 {chartState.overlays.length} 个绘图？</div>
          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" autoFocus onClick={confirmClearDrawings}>
              删除
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
