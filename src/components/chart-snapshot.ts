"use client";

/**
 * 拍快照 (design §5.2): the chart laid out like TradingView's snapshot and signed hebi8/market.
 * A bar on top names the symbol and gives the last bar's OHLC and change (it stands in for the
 * legend's symbol row, and grows by a line wherever it has to wrap); the chart keeps its drawings and the legend rows of indicators and
 * compares; a strip at the bottom carries the logo, the name and the public address. Colors are
 * read from the page, so the picture follows the color scheme and the up/down convention. Only
 * the picture is signed, never the chart on the page.
 */
import { BRAND, SLOGAN, bareUrl } from "@/lib/brand";
import { fmtPct, fmtPrice } from "@/lib/format";
import type { Timeframe } from "@/lib/symbols";
import type { CompareEntry } from "@/lib/vault";
import { MONO, SANS, type ChartCapture, type LegendIndicator } from "./chart-types";

const FOOTER = 34;
const PAD = 12;
const ROW = 20;
const CANDLE_PANE = "candle_pane";

export interface SnapshotInfo {
  title: string;
  ticker: string;
  /** Interval · source · currency · benchmark, as in the legend */
  subtitle: string[];
  tf: Timeframe;
  last: { timestamp: number; open: number; high: number; low: number; close: number } | null;
  prevClose: number | null;
  pricePrecision: number;
  /** The chart's public address, printed at the bottom */
  url: string;
  compare: (CompareEntry & { hidden?: boolean })[];
  names: Record<string, string>;
  labels: Record<string, string>;
  hiddenIndicators: string[];
}

type Colors = Record<"card" | "fg" | "muted" | "line" | "up" | "down", string>;

export async function renderSnapshot(capture: ChartCapture, info: SnapshotInfo): Promise<Blob> {
  const [chart, logo] = await Promise.all([loadImage(capture.url), loadImage("/icon.svg")]);
  const scale = chart.naturalWidth / capture.width;
  const width = capture.width;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const style = getComputedStyle(document.documentElement);
  const c = Object.fromEntries(["card", "fg", "muted", "line", "up", "down"].map((k) => [k, style.getPropertyValue(`--${k}`).trim()])) as Colors;
  // the info bar grows by the lines it wraps into and pushes the chart down
  const header = headerLayout(ctx, info, c, width);
  const top = header.height;
  const height = top + capture.height + FOOTER;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  ctx.scale(scale, scale);

  ctx.fillStyle = c.card;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(chart, 0, top, capture.width, capture.height);
  drawLegend(ctx, capture, info, c, top);
  header.draw();
  drawFooter(ctx, logo, info.url, c, width, height);
  ctx.fillStyle = c.line;
  ctx.fillRect(0, top - 1, width, 1);
  ctx.fillRect(0, top + capture.height, width, 1);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("生成图片失败"))), "image/png"));
}

/** TradingView names a snapshot after the symbol and the moment: `NVDA_2026-10-09_10-30-00.png`. */
export function snapshotFileName(ticker: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ticker.replace(/[^A-Za-z0-9.-]+/g, "_")}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("生成图片失败"));
    img.src = src;
  });
}

/** Text on a baseline; returns where it ends. */
function put(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, color: string): number {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return x + ctx.measureText(text).width;
}

function measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** The last bar's day, or the three days / week / month / quarter it covers. */
function barDate(timestamp: number, tf: Timeframe): string {
  const iso = new Date(timestamp).toISOString();
  if (tf === "3D") return `${iso.slice(0, 10)} 起 3 日`;
  if (tf === "W") return `${iso.slice(0, 10)} 当周`;
  if (tf === "M") return iso.slice(0, 7);
  if (tf === "Q") return `${iso.slice(0, 4)} Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
  return iso.slice(0, 10);
}

type Piece = { text: string; font: string; color: string; pad?: number };

/**
 * A run of text that wraps as one piece, like a nowrap span in the page's flex-wrap rows. `gap` is
 * the space before it and `lead` a separator in front of it (` · `), both only when something
 * precedes it on the line, so a wrapped line never ends or starts with a lone separator.
 */
interface Token {
  pieces: Piece[];
  gap: number;
  lead?: Piece;
}

const piecesWidth = (ctx: CanvasRenderingContext2D, pieces: Piece[]) => pieces.reduce((w, p) => w + (p.pad ?? 0) + measure(ctx, p.text, p.font), 0);
const tokenWidth = (ctx: CanvasRenderingContext2D, token: Token) => piecesWidth(ctx, token.pieces);
/** What the token adds after something else on its line */
const joinedWidth = (ctx: CanvasRenderingContext2D, token: Token) => token.gap + (token.lead ? piecesWidth(ctx, [token.lead]) : 0) + tokenWidth(ctx, token);

/** Tokens in lines no wider than `room(line)`; a token wider than a whole line gets one to itself. */
function wrap(ctx: CanvasRenderingContext2D, tokens: Token[], room: (line: number) => number): Token[][] {
  const lines: Token[][] = [];
  let used = 0;
  for (const token of tokens) {
    const w = tokenWidth(ctx, token);
    const line = lines.at(-1);
    const joined = joinedWidth(ctx, token);
    if (line && used + joined <= room(lines.length - 1)) {
      line.push(token);
      used += joined;
    } else {
      lines.push([token]);
      used = w;
    }
  }
  return lines;
}

function drawLine(ctx: CanvasRenderingContext2D, line: Token[], x: number, y: number) {
  line.forEach((token, i) => {
    const pieces = i && token.lead ? [token.lead, ...token.pieces] : token.pieces;
    if (i) x += token.gap;
    for (const p of pieces) x = put(ctx, p.text, x + (p.pad ?? 0), y, p.font, p.color);
  });
}

/**
 * The info bar: name · ticker · interval · source · currency · benchmark (the date of the last bar
 * on the right), then OHLC and the change. Nothing is cut: what does not fit wraps onto the next
 * line, the change (amount and percentage together) first.
 */
function headerLayout(ctx: CanvasRenderingContext2D, info: SnapshotInfo, c: Colors, width: number) {
  const { last } = info;
  const small = `12px ${SANS}`;
  const mono = `12px ${MONO}`;
  const date = last ? barDate(last.timestamp, info.tf) : "";
  const dateWidth = measure(ctx, date, mono);
  const full = width - 2 * PAD;

  const names: Token[] = [{ pieces: [{ text: info.title, font: `600 15px ${SANS}`, color: c.fg }], gap: 0 }];
  if (info.ticker !== info.title) names.push({ pieces: [{ text: info.ticker, font: mono, color: c.muted }], gap: 8 });
  info.subtitle.forEach((part, i) => {
    names.push({ pieces: [{ text: part, font: small, color: c.muted }], gap: i ? 0 : 10, lead: i ? { text: " · ", font: small, color: c.muted } : undefined });
  });
  const nameLines = wrap(ctx, names, (line) => (line === 0 ? full - dateWidth - 16 : full));

  const prices: Token[] = [];
  if (last) {
    const tone = (v: number) => (v > 0 ? c.up : v < 0 ? c.down : c.muted);
    const px = (v: number) => fmtPrice(v, info.pricePrecision);
    for (const [label, value] of [["开", last.open], ["高", last.high], ["低", last.low], ["收", last.close]] as const) {
      prices.push({ pieces: [{ text: label, font: small, color: c.muted }, { text: px(value), font: mono, color: tone(last.close - last.open), pad: 3 }], gap: 10 });
    }
    if (info.prevClose) {
      const change = last.close - info.prevClose;
      const sign = change > 0 ? "+" : change < 0 ? "−" : "";
      prices.push({ pieces: [{ text: `${sign}${px(Math.abs(change))} (${fmtPct(last.close / info.prevClose - 1, 2)})`, font: mono, color: tone(change) }], gap: 10 });
    }
  }
  const priceLines = wrap(ctx, prices, () => full);

  // baselines: the name line, 20px per wrapped line, the prices 21px under the names
  const nameYs = nameLines.map((_, i) => 23 + i * 20);
  const priceYs = priceLines.map((_, i) => nameYs[nameYs.length - 1] + 21 + i * 20);
  const height = (priceYs.at(-1) ?? nameYs[nameYs.length - 1]) + 12;
  return {
    height,
    draw: () => {
      put(ctx, date, width - PAD - dateWidth, 23, mono, c.muted);
      nameLines.forEach((line, i) => drawLine(ctx, line, PAD, nameYs[i]));
      priceLines.forEach((line, i) => drawLine(ctx, line, PAD, priceYs[i]));
    },
  };
}

/**
 * The legend's indicator and compare rows where the page shows them (the symbol row is the info bar
 * now), wrapped like the page's rows: no wider than the plot minus 5rem, so never over the price axis.
 */
function drawLegend(ctx: CanvasRenderingContext2D, capture: ChartCapture, info: SnapshotInfo, c: Colors, top: number) {
  const snap = capture.legend;
  const left = snap.left + 6;
  // the page's rows: max-width calc(100% - 5rem), 4px padding on each side
  const box = capture.width - 80;
  const font = `12px ${SANS}`;
  const mono = `12px ${MONO}`;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, left + box, capture.height);
  ctx.clip();
  /** Draws one legend row at `y` (its top) and returns the y under it */
  const row = (y: number, title: string, color: string, params: string, values: [string, string][]) => {
    const head: Token = { pieces: [{ text: title, font, color }], gap: 0 };
    if (params) head.pieces.push({ text: params, font, color: c.muted, pad: 4 });
    const lines = wrap(ctx, [head, ...values.map(([text, tone]) => ({ pieces: [{ text, font: mono, color: tone }], gap: 6 }))], () => box - 8);
    lines.forEach((line, i) => drawLine(ctx, line, left + 4, y + 14 + i * ROW));
    return y + lines.length * ROW;
  };
  const indicatorRow = (ind: LegendIndicator, y: number) => {
    const hidden = info.hiddenIndicators.includes(ind.name);
    return row(y, info.labels[ind.name] ?? ind.name, hidden ? c.muted : c.fg, ind.params.join(" "), hidden ? [] : ind.values.map((v) => [v.text, v.color]));
  };
  const compareRow = (slot: number, y: number) => {
    const entry = info.compare[slot];
    const live = snap.compares[slot];
    const values: [string, string][] = [];
    if (!entry.hidden && live?.value != null) values.push([fmtPrice(live.value), entry.color]);
    if (!entry.hidden && live?.pct != null) values.push([fmtPct(live.pct, 2), live.pct > 0 ? c.up : live.pct < 0 ? c.down : c.muted]);
    return row(y, info.names[entry.key] ?? entry.key, entry.hidden ? c.muted : entry.color, "", values);
  };

  // the main pane's rows, unless folded away under the legend's arrow
  if (localStorage.getItem("hebi8:chart:legend-collapsed") !== "true") {
    let y = top + 4;
    info.compare.forEach((entry, slot) => {
      if (entry.mode === "percent") y = compareRow(slot, y);
    });
    for (const ind of snap.indicators.filter((i) => i.paneId === CANDLE_PANE)) y = indicatorRow(ind, y);
  }
  for (const [paneId, paneTop] of Object.entries(snap.paneTops)) {
    if (paneId === CANDLE_PANE) continue;
    let y = top + paneTop + 2;
    const slot = /^pane_cmp_(\d+)$/.exec(paneId)?.[1];
    if (slot !== undefined && info.compare[Number(slot)]) y = compareRow(Number(slot), y);
    for (const ind of snap.indicators.filter((i) => i.paneId === paneId)) y = indicatorRow(ind, y);
  }
  ctx.restore();
}

/** Logo, name and slogan on the left, the address on the right; a narrow picture drops the slogan, then the path. */
function drawFooter(ctx: CanvasRenderingContext2D, logo: HTMLImageElement, url: string, c: Colors, width: number, height: number) {
  const mid = height - FOOTER / 2;
  ctx.drawImage(logo, PAD, mid - 9, 18, 18);
  const x = put(ctx, BRAND, PAD + 26, mid + 4.5, `13px ${MONO}`, c.fg);
  const urlFont = `11px ${MONO}`;
  const sloganFont = `11px ${SANS}`;
  const address = bareUrl(url);
  const room = width - PAD - x - 16;
  const shown = [address, address.split("/")[0]].find((t) => measure(ctx, t, urlFont) <= room);
  const urlWidth = shown ? measure(ctx, shown, urlFont) : 0;
  if (measure(ctx, SLOGAN, sloganFont) + 10 + urlWidth <= room) put(ctx, SLOGAN, x + 10, mid + 4, sloganFont, c.muted);
  if (shown) put(ctx, shown, width - PAD - urlWidth, mid + 4, urlFont, c.muted);
}
