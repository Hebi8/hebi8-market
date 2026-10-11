import type { Metadata } from "next";
import { ChartView } from "@/components/ChartView";
import { alertViews, latestPrice } from "@/lib/alert-view";
import { publicUrl } from "@/lib/app-info";
import { BRAND } from "@/lib/brand";
import { ConfigErrorView } from "@/components/ConfigErrorView";
import { allItems, findItem } from "@/lib/config";
import { renderMarkdown } from "@/lib/markdown";
import { benchLabel, nameOf } from "@/lib/names";
import { CHANGE_PERIODS } from "@/lib/periods";
import { profileView } from "@/lib/profiles";
import { listSymbols } from "@/lib/store";
import { chartTitle, decodeChartKey, isSynthetic, isValidKey, tickerOf } from "@/lib/symbols";
import { synthName } from "@/lib/synth";
import { noteMtime, readChartState, readConfigSafe, readNote } from "@/lib/vault";
import { statsFor } from "@/lib/sync";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** 「英伟达 NVDA · 周线」 in the viewer's names and timeframe; the card a link unfurls into is opengraph-image.tsx. */
export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const key = decodeChartKey((await params).key);
  const { config } = readConfigSafe((await getViewer()).dir);
  if (!config || !isValidKey(key)) return { title: key };
  const name = nameOf(config, key, listSymbols()[key]?.name);
  const title = chartTitle(name, isSynthetic(key) ? synthName(key) : tickerOf(key), config.chart.tf);
  const description = `${name}（${key}）的长期 K 线、指标与对比，在 ${BRAND} 上做周度复盘。`;
  const url = `/chart/${encodeURIComponent(key)}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: BRAND, locale: "zh_CN", title: `${title} · ${BRAND}`, description, url },
    twitter: { card: "summary_large_image", title: `${title} · ${BRAND}`, description },
  };
}

export default async function ChartPage({ params }: { params: Promise<{ key: string }> }) {
  const key = decodeChartKey((await params).key);
  const viewer = await getViewer();
  const { config, error } = readConfigSafe(viewer.dir);
  if (!config) return <ConfigErrorView error={error} vaultPath={viewer.dir} />;
  if (!isValidKey(key)) return <main className="p-6 text-sm text-muted">无效的 key「{key}」，例如 /chart/yahoo%3ASPY</main>;

  const item = findItem(config, key);
  const symbols = listSymbols();
  const state = readChartState(viewer.dir, key);
  // a visitor sees the owner's chart and drawings, not their notes
  const note = viewer.canWrite ? readNote(viewer.dir, key) : null;

  // display names for everything the chart may show: yaml name > dictionary > source
  const names: Record<string, string> = {};
  for (const k of [...Object.keys(symbols), ...allItems(config).map((i) => i.key), ...state.compare.map((c) => c.key), key]) {
    names[k] = nameOf(config, k, symbols[k]?.name);
  }
  // the watchlist in yaml order and groups, for the side panel and Space / Shift+Space
  const stats = statsFor(viewer.vault, config);
  const period = config.periods[0] ?? "1W";
  const watchlist = config.groups.map((g) => ({
    name: g.name,
    items: g.symbols.map((i) => ({
      key: i.key,
      name: names[i.key],
      // what the yaml says, so a removed symbol comes back as it was
      yamlName: i.name,
      bench: i.bench,
      last: stats[i.key]?.last ?? null,
      change: stats[i.key]?.changes[period] ?? null,
    })),
  }));

  // alerts are personal like notes: a visitor sees none
  const alerts = viewer.canWrite ? alertViews(viewer.vault, config, symbols) : [];

  return (
    <ChartView
      // a different person (or a visitor turning into one) gets a fresh chart, not the last one's state
      key={`${viewer.vault}:${viewer.canWrite ? "w" : "r"}:${key}`}
      vault={viewer.vault}
      symbolKey={key}
      prefs={config.chart}
      prices={config.prices}
      formulas={config.indicators}
      aliases={config.aliases}
      bench={item?.bench ?? null}
      benchLabel={item?.bench ? benchLabel(config, item.bench, symbols[item.bench]?.name) : null}
      names={names}
      watchlist={watchlist}
      changeLabel={CHANGE_PERIODS.find((p) => p.key === period)?.label ?? period}
      chartState={state}
      note={note}
      noteHtml={note ? renderMarkdown(note) : null}
      noteSavedAt={viewer.canWrite ? noteMtime(viewer.dir, key) : null}
      readOnly={!viewer.canWrite}
      alerts={alerts}
      livePrice={latestPrice(key, config).price}
      profile={profileView(key, config)}
      shareUrl={`${publicUrl()}/chart/${encodeURIComponent(key)}`}
    />
  );
}
