"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import { translateProfile } from "@/app/actions";
import { fmtDate } from "@/lib/format";
import { fmtAmount, fmtHours, valuation, type ProfileView, type ProfileWeight, type Translation } from "@/lib/profile";
import { kindLabel } from "@/lib/search";
import { IconClose } from "./chart-icons";
import { chartHref, useUi } from "./UiProvider";

const SOURCES: Record<string, string> = { yahoo: "Yahoo Finance", tv: "TradingView", binance: "Binance", data: "数据集" };

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** A site the source names, as a link: only http(s), shown as its host. */
function siteOf(url: string): { href: string; host: string } | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? { href: u.href, host: u.host.replace(/^www\./, "") } : null;
  } catch {
    return null;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-2.5 last:border-b-0">
      <h3 className="mb-1.5 text-[11px] font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** Label and value rows; a row without a value is not there at all. */
function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="truncate text-right tabular-nums" title={typeof value === "string" ? value : undefined}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A fund's holdings or sector split: name, a bar as wide as its share, the share. */
function Weights({ items, linked }: { items: ProfileWeight[]; linked: boolean }) {
  const max = Math.max(...items.map((i) => i.weight));
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={`${item.key ?? ""}${item.name}`} className="grid grid-cols-[minmax(0,1fr)_3rem_3.2rem] items-center gap-2">
          {linked && item.key ? (
            <Link href={chartHref(item.key)} className="truncate hover:text-accent" title={`打开 ${item.name}`}>
              {item.name}
            </Link>
          ) : (
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
          )}
          <span className="h-1 rounded-full bg-fg/10">
            <span className="block h-full rounded-full bg-accent/60" style={{ width: `${(item.weight / max) * 100}%` }} />
          </span>
          <span className="text-right text-muted tabular-nums">{pct(item.weight)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The description as the source wrote it, and in Chinese once someone asked for it: 翻译 calls the
 * model once and the result is kept for everyone, so afterwards the translation is what shows,
 * with the original one click away. A visitor sees a stored translation but cannot ask for one.
 * A translation made here only shows while the description is still the text it was made from.
 */
function Description({ symbolKey, view, canAsk }: { symbolKey: string; view: ProfileView; canAsk: boolean }) {
  const { toast } = useUi();
  const [made, setMade] = useState<Translation | null>(null);
  const [original, setOriginal] = useState(false);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const [pending, start] = useTransition();
  const description = view.profile!.description!;
  const translation = view.translation ?? (made?.source === description ? made.text : null);
  const text = translation && !original ? translation : description;
  // 显示更多 only when the six lines cut something off, at whatever width the panel has
  const measure = useCallback(
    (el: HTMLParagraphElement | null) => {
      if (!el || open) return;
      const observer = new ResizeObserver(() => setLong(el.scrollHeight > el.clientHeight + 1));
      observer.observe(el);
      return () => observer.disconnect();
    },
    // measured again when the other text is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, text],
  );
  // another text is folded again, so that whether it needs 显示更多 is measured anew
  const translate = () =>
    start(async () => {
      const result = await translateProfile(symbolKey);
      if (!result.ok) return toast(`翻译失败：${result.error}`, { kind: "error" });
      setMade({ source: result.source, text: result.text });
      setOpen(false);
    });
  const flip = () => {
    setOriginal(!original);
    setOpen(false);
  };
  return (
    <Section title="简介">
      <p ref={measure} className={`leading-5 whitespace-pre-line ${open ? "" : "line-clamp-6"}`}>
        {text}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1 empty:hidden">
        {(open || long) && (
          <button type="button" className="btn h-6 px-1.5" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "收起" : "显示更多"}
          </button>
        )}
        {translation ? (
          <button type="button" className="btn h-6 px-1.5" onClick={flip}>
            {original ? "显示译文" : "显示原文"}
          </button>
        ) : (
          canAsk &&
          view.translatable && (
            <button type="button" className="btn btn-secondary h-6 px-1.5" onClick={translate} disabled={pending} title="由模型翻译成简体中文，译文会保存下来，所有人都看得到">
              {pending ? "翻译中…" : "翻译"}
            </button>
          )
        )}
      </div>
    </Section>
  );
}

/**
 * TradingView's 商品详情: what the symbol is. The facts are the cached weekly profile (§2.8); market
 * cap, P/E and the dividend yield are computed here from them and the latest price as traded, so
 * they move with it. A field the source does not have is not shown; a symbol without any profile
 * (an index, an FX pair, a coin) still has what the cache knows about where and when it trades.
 * A synthetic symbol has no profile of its own: its operands are listed, each opening its chart.
 */
export function ProfilePanel({
  symbolKey,
  name,
  ticker,
  view,
  price,
  readOnly,
  onClose,
  className = "",
}: {
  symbolKey: string;
  name: string;
  ticker: string;
  view: ProfileView;
  /** The latest price as traded (no dividend adjustment), the one market cap, P/E and yield are computed with */
  price: number | null;
  readOnly: boolean;
  onClose: () => void;
  className?: string;
}) {
  // a symbol just added or opened gets its profile a moment after its bars (sync.ts): look again
  // twice, soon and once the slowest source has timed out, then leave it to the next visit
  const router = useRouter();
  useEffect(() => {
    if (!view.pending) return;
    const timers = [3_000, 25_000].map((ms) => setTimeout(() => router.refresh(), ms));
    return () => timers.forEach(clearTimeout);
  }, [view.pending, router]);

  const p = view.profile;
  const currency = view.currency ? ` ${view.currency}` : "";
  const { marketCap, pe, dividendYield } = valuation(p, price);
  const site = p?.website ? siteOf(p.website) : null;
  const present = (rows: [string, ReactNode | null | undefined | false][]) => rows.filter((row): row is [string, ReactNode] => row[1] != null && row[1] !== false && row[1] !== "");

  const figures = present([
    ["市值", marketCap != null && `${fmtAmount(marketCap)}${currency}`],
    ["市盈率 (TTM)", pe != null && pe.toFixed(2)],
    ["每股收益 (TTM)", p?.eps != null && `${p.eps.toFixed(2)}${currency}`],
    ["股息收益率", dividendYield != null && pct(dividendYield)],
    ["下一次财报", view.earningsDay != null && fmtDate(view.earningsDay)],
  ]);
  const company = present([
    ["板块", p?.sector],
    ["行业", p?.industry],
    ["国家/地区", p?.country],
    ["员工", p?.employees?.toLocaleString("en-US")],
    [
      "网站",
      site && (
        <a href={site.href} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
          {site.host}
        </a>
      ),
    ],
  ]);
  const fund = present([
    ["发行商", p?.issuer],
    ["类别", p?.category],
    ["费率", p?.expenseRatio != null && pct(p.expenseRatio)],
    ["资产管理规模", p?.netAssets != null && `${fmtAmount(p.netAssets)}${currency}`],
  ]);
  const trading = present([
    ["类型", view.kind && kindLabel(view.kind)],
    ["交易所", view.exchange],
    ["币种", view.currency],
    ["时区", view.timezone],
    ["交易时段", view.hours && fmtHours(view.hours)],
    ["数据源", SOURCES[view.source]],
  ]);

  return (
    <aside className={`flex flex-col bg-card text-xs ${className}`} aria-label="商品详情">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-1 pl-3">
        <span className="flex-1 font-medium">商品详情</span>
        <button type="button" onClick={onClose} className="tb-btn h-7 min-w-7" title="收起" aria-label="收起商品详情">
          <IconClose size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-line px-3 py-2.5">
          <div className="text-[13px] leading-5 font-medium">{name}</div>
          <div className="truncate text-[11px] text-muted">{[ticker, view.exchange, view.currency].filter(Boolean).join(" · ")}</div>
        </div>
        {view.legs && (
          <Section title="合成标的">
            <p className="mb-1.5 leading-5 text-muted">由下面的标的按需计算，没有自己的资料。</p>
            <ul className="space-y-1">
              {view.legs.map((leg) => (
                <li key={leg.key} className="flex items-baseline gap-2">
                  <Link href={chartHref(leg.key)} className="min-w-0 flex-1 truncate hover:text-accent" title={`打开 ${leg.name}`}>
                    {leg.name}
                  </Link>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{leg.key}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {p?.description && <Description key={symbolKey} symbolKey={symbolKey} view={view} canAsk={!readOnly} />}
        {figures.length > 0 && (
          <Section title="关键数据">
            <Rows rows={figures} />
          </Section>
        )}
        {company.length > 0 && (
          <Section title="公司">
            <Rows rows={company} />
          </Section>
        )}
        {fund.length > 0 && (
          <Section title="基金">
            <Rows rows={fund} />
          </Section>
        )}
        {p?.holdings && (
          <Section title="前十大持仓">
            <Weights items={p.holdings} linked />
          </Section>
        )}
        {p?.sectors && (
          <Section title="行业分布">
            <Weights items={p.sectors} linked={false} />
          </Section>
        )}
        {trading.length > 0 && (
          <Section title="交易信息">
            <Rows rows={trading} />
          </Section>
        )}
        {/* a symbol whose source has nothing to say about it (an index, a commodity) has no facts to date */}
        {view.fetchedAt != null && p && Object.keys(p).length > 0 ? (
          <p className="px-3 py-2.5 text-[11px] leading-4 text-muted">
            资料更新于 {fmtDate(view.fetchedAt / 1000)}，每周刷新{(marketCap ?? pe ?? dividendYield) != null && "；市值、市盈率和股息收益率按最新价计算"}。
          </p>
        ) : (
          view.pending && <p className="px-3 py-2.5 text-[11px] text-muted">资料还没有取到，下次同步后补上。</p>
        )}
      </div>
    </aside>
  );
}
