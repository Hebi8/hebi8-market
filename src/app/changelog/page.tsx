import { readFileSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { APP_INFO, REPO_URL } from "@/lib/app-info";
import { changelogBody } from "@/lib/changelog";
import { renderMarkdown } from "@/lib/markdown";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "更新记录" };

/** CHANGELOG.md as it is in the checkout that runs; opening it marks the version seen (ChangelogLink). */
export default function ChangelogPage() {
  const source = readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-8 text-sm">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-medium">更新记录</h1>
        <p className="text-[11px] text-muted">
          当前版本 v{APP_INFO.version} ·{" "}
          <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            GitHub Releases
          </a>
        </p>
      </div>
      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(changelogBody(source)) }} />
    </main>
  );
}
