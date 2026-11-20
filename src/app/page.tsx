import type { Metadata } from "next";
import { ConfigErrorView } from "@/components/ConfigErrorView";
import { Overview, type OverviewData, type OverviewRow } from "@/components/Overview";
import { alertBadges, alertViews } from "@/lib/alert-view";
import { benchLabel, nameOf } from "@/lib/names";
import { overviewStats } from "@/lib/quotes";
import { hasBars, listSymbols, maxSyncedAt } from "@/lib/store";
import { isSynthetic, parseKey, tickerOf } from "@/lib/symbols";
import { syncAll } from "@/lib/sync";
import { listJournals, readConfigSafe } from "@/lib/vault";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { alternates: { canonical: "/" } };

const daysAgo = (ms: number) => Math.floor((Date.now() - ms) / 86400000);

export default async function Home() {
  const viewer = await getViewer();
  const { config, error } = readConfigSafe(viewer.dir);
  if (!config) return <ConfigErrorView error={error} vaultPath={viewer.dir} />;

  const symbols = listSymbols();
  // rows whose price comes from a quote show it, with their changes on today's live bar
  const stats = overviewStats(viewer.vault, config, symbols);
  const firstRun = !hasBars();
  if (firstRun) void syncAll().catch(() => undefined);
  // alerts are personal like notes: a visitor sees none
  const badges = viewer.canWrite ? alertBadges(viewer.vault, config) : {};

  const groups = config.groups.map((g) => ({
    name: g.name,
    items: g.symbols.map((item): OverviewRow => {
      const row = symbols[item.key];
      return {
        key: item.key,
        name: nameOf(config, item.key, row?.name),
        yamlName: item.name,
        ticker: tickerOf(item.key),
        source: isSynthetic(item.key) ? "expr" : parseKey(item.key).source,
        currency: row?.currency ?? null,
        bench: item.bench,
        benchLabel: item.bench ? benchLabel(config, item.bench, symbols[item.bench]?.name) : null,
        stats: stats[item.key]?.stats ?? null,
        quote: stats[item.key]?.status ?? null,
        syncError: row?.syncError ?? null,
        badges: badges[item.key] ?? [],
      };
    }),
  }));

  const journal = viewer.shared && !viewer.login ? undefined : listJournals(viewer.dir)[0];
  const notices = config.ignored.length ? [`hebi8.yaml 里的 ${config.ignored.join("、")} 是实例设置，只有 ${viewer.owner} 的 vault 里写的生效，这里忽略`] : [];
  const data: OverviewData = {
    groups,
    periods: config.periods,
    updown: config.updown,
    alerts: viewer.canWrite ? alertViews(viewer.vault, config, symbols) : [],
    aliases: config.aliases,
    lastReviewDays: journal ? daysAgo(journal.mtimeMs) : null,
    lastSync: maxSyncedAt(),
    firstRun,
    notices,
    readOnly: !viewer.canWrite,
  };
  return <Overview key={`${viewer.vault}:${viewer.canWrite ? "w" : "r"}`} data={data} />;
}
