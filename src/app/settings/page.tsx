import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { AgentTokens } from "@/components/AgentTokens";
import { ConfigErrorView } from "@/components/ConfigErrorView";
import { TvExport, TvDrawingsImport, TvListImport } from "@/components/TvImport";
import { APP_INFO, publicUrl } from "@/lib/app-info";
import { requestOrigin } from "@/lib/github";
import { listTokens } from "@/lib/secrets";
import { listSymbols } from "@/lib/store";
import { exportTvList } from "@/lib/tv-import";
import { readConfigSafe } from "@/lib/vault";
import { getViewer, tokenOwner } from "@/lib/viewer";

export const dynamic = "force-dynamic";
// a person's own page: not for search engines (robots.ts keeps crawlers out as well)
export const metadata: Metadata = { title: "设置", robots: { index: false, follow: false } };

const card = "rounded-lg border border-line bg-card";
const head = "border-b border-line px-4 py-2.5";

/** The address an agent is given: this page's own origin, so a token made on the tailnet connects over the tailnet. */
async function mcpEndpoint(): Promise<string> {
  try {
    return `${requestOrigin(await headers())}/mcp`;
  } catch {
    return `${publicUrl()}/mcp`;
  }
}

/** Settings that need a page (design §5.5): TradingView in and out, and the tokens agents connect with. */
export default async function SettingsPage() {
  const viewer = await getViewer();
  const { config, error } = readConfigSafe(viewer.dir);
  if (!config) return <ConfigErrorView error={error} vaultPath={viewer.dir} />;

  const symbols = listSymbols();
  const exported = exportTvList(config.groups.map((g) => ({ name: g.name, items: g.symbols.map((s) => ({ key: s.key, exchange: symbols[s.key]?.exchange })) })));
  const watched = config.groups.map((g) => ({ name: g.name, keys: g.symbols.map((s) => s.key) }));
  const day = new Intl.DateTimeFormat("zh-CN", { timeZone: config.sync.tz, year: "numeric", month: "2-digit", day: "2-digit" });
  // a visitor has no tokens; everyone else sees their own
  const tokens = viewer.canWrite ? listTokens(tokenOwner(viewer)).map((t) => ({ id: t.id, name: t.name, write: t.write, created: day.format(t.created_at), used: t.used_at === null ? null : day.format(t.used_at) })) : [];

  return (
    <main className="settings-page mx-auto flex w-full max-w-[960px] flex-col gap-5 px-5 py-5">
      <h1 className="text-sm font-medium">设置</h1>

      <section className={card}>
        <div className={head}>
          <h2 className="text-xs font-medium">Agent 接入（MCP）</h2>
          <p className="mt-1 text-[11px] text-muted">让 Claude Code 这类 agent 读你的自选和行情、拿公式扫自选、把想法存成警报。每个 agent 一个令牌，拿着它就是你本人；它建的对全部自选的警报先是草稿，等你在页面上确认。</p>
        </div>
        <AgentTokens tokens={tokens} endpoint={await mcpEndpoint()} canWrite={viewer.canWrite} />
      </section>

      <section className={card}>
        <div className={head}>
          <h2 className="text-xs font-medium">从 TradingView 导入自选列表</h2>
          <p className="mt-1 text-[11px] text-muted">在 TradingView 自选列表的菜单里选「导出列表…」，把得到的 .txt 传上来或者把内容贴进来。分节变成分组，新标的用 tv: 数据源。</p>
        </div>
        <TvListImport watched={watched} canWrite={viewer.canWrite} />
      </section>

      <section className={card}>
        <div className={head}>
          <h2 className="text-xs font-medium">导出自选列表到 TradingView</h2>
          <p className="mt-1 text-[11px] text-muted">下载的 .txt 在 TradingView 自选列表菜单的「导入列表…」里打开；每个分组是一节。</p>
        </div>
        <TvExport text={exported.text} count={exported.count} skipped={exported.skipped} />
      </section>

      <section className={card}>
        <div className={head}>
          <h2 className="text-xs font-medium">从 TradingView 导入画线</h2>
          <p className="mt-1 text-[11px] text-muted">按标的追加到各自图表，原有的画线和对比不动；同一条画线导入两次也只有一份。</p>
        </div>
        <TvDrawingsImport groups={config.groups.map((g) => g.name)} canWrite={viewer.canWrite} />
      </section>

      <p className="text-[11px] text-muted">
        hebi8/market v{APP_INFO.version} ·{" "}
        <Link href="/changelog" className="hover:text-fg">
          更新记录
        </Link>
      </p>
    </main>
  );
}
