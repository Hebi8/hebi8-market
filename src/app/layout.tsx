import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ChangelogLink } from "@/components/ChangelogLink";
import { ErrorCapture } from "@/components/ErrorCapture";
import { ServiceWorker } from "@/components/ServiceWorker";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { Account, HelpButton, SearchTrigger, UiProvider } from "@/components/UiProvider";
import { githubClientId, publicUrl } from "@/lib/app-info";
import { BRAND, DESCRIPTION, SLOGAN, TAGLINE } from "@/lib/brand";
import { webLoginClient } from "@/lib/github";
import type { SearchContext } from "@/lib/search";
import { searchContextFor } from "@/lib/search-context";
import { readConfigSafe } from "@/lib/vault";
import { getViewer, type Viewer } from "@/lib/viewer";
import "./globals.css";

export const dynamic = "force-dynamic";

/** The page reaches under the iPhone's rounded corners and home bar; the edges pad themselves by the safe-area insets (globals.css). */
export const viewport: Viewport = { viewportFit: "cover" };

/** Absolute URLs (social images, canonical links) use the public address, read when the request comes in. */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(publicUrl()),
    title: { default: BRAND, template: `%s · ${BRAND}` },
    description: DESCRIPTION,
    applicationName: BRAND,
    openGraph: { type: "website", siteName: BRAND, locale: "zh_CN", title: BRAND, description: DESCRIPTION, url: "/" },
    twitter: { card: "summary_large_image", title: BRAND, description: DESCRIPTION },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let updown = "green-up";
  let searchCtx: SearchContext = { watchlist: [], aliases: {}, groups: [] };
  let viewer: Viewer | null = null;
  try {
    viewer = await getViewer();
    const config = readConfigSafe(viewer.dir).config;
    updown = config?.updown ?? "green-up";
    searchCtx = searchContextFor(config);
  } catch {
    // a broken vault is reported by the page itself
  }
  // 登录 is a redirect to github.com where this origin has the web login, else the device flow's drawer
  const webLogin = Boolean(webLoginClient(await headers()));
  return (
    <html lang="zh-CN" data-updown={updown === "red-up" ? "red-up" : undefined}>
      <head>
        {/* VibeCafé's pageview counter (/privacy says what it sends). The key is a browser id that only works from the public origin. */}
        <script defer src="https://vibecafe.ai/telemetry/v1.js" data-vc-product-id="cmv68559h000106maupvumst4" data-vc-auth-key="vc_web_zGKqr86FCcDKfYnZCpjtBXwHPUUmTbVoWT7-vSh_NX4" />
      </head>
      <body className="flex min-h-screen flex-col font-sans antialiased">
        <ErrorCapture />
        <ServiceWorker />
        <UiProvider ctx={searchCtx} readOnly={!viewer?.canWrite} webLogin={webLogin}>
          <SiteHeader>
            <Link href="/" className="flex shrink-0 items-baseline gap-3" title={TAGLINE}>
              <span className="font-mono text-sm tracking-tight">{BRAND}</span>
              <span className="hidden text-[11px] text-muted lg:inline">{SLOGAN}</span>
            </Link>
            <div className="flex min-w-0 flex-1 justify-center">
              <SearchTrigger />
            </div>
            <nav className="flex shrink-0 items-center gap-3 text-xs text-muted sm:gap-4">
              <Link href="/" className="hover:text-fg">
                总览
              </Link>
              <Link href="/review" className="hover:text-fg">
                复盘
              </Link>
              <Link href="/settings" className="hover:text-fg">
                设置
              </Link>
              <ChangelogLink />
              {viewer?.shared && (
                <Account user={viewer.login ? { login: viewer.login, avatarUrl: viewer.avatarUrl ?? "" } : null} enabled={Boolean(githubClientId())} owner={viewer.isOwner} />
              )}
              <HelpButton />
            </nav>
          </SiteHeader>
          {children}
          <SiteFooter />
        </UiProvider>
      </body>
    </html>
  );
}
