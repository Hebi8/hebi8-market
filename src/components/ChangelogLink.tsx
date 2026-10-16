"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { APP_INFO } from "@/lib/app-info";
import { CHANGELOG_SEEN, newerMinor } from "@/lib/changelog";
import { useLocalStorage } from "@/lib/use-local-storage";

function stored(): boolean {
  try {
    return window.localStorage.getItem(CHANGELOG_SEEN) !== null;
  } catch {
    return true;
  }
}

/**
 * 更新 in the header, with TradingView's quiet dot for 新功能 while this browser has not seen a newer minor
 * release's notes. A first visit has nothing to catch up on, so it just remembers the version; opening the
 * changelog marks it seen.
 */
export function ChangelogLink() {
  const pathname = usePathname();
  const [seen, setSeen] = useLocalStorage<string | null>(CHANGELOG_SEEN, null);
  // read storage itself: on the first commit the hook still has the server's fallback
  useEffect(() => {
    if (pathname === "/changelog" || !stored()) setSeen(APP_INFO.version);
  }, [pathname, setSeen]);
  const fresh = seen !== null && newerMinor(APP_INFO.version, seen);
  return (
    <Link href="/changelog" className="relative hover:text-fg" title={fresh ? `有新版本 v${APP_INFO.version}` : undefined}>
      更新
      {fresh && <span aria-label="有新版本" className="absolute -top-0.5 -right-1.5 size-1.5 rounded-full bg-accent" />}
    </Link>
  );
}
