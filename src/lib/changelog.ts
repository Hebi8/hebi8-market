/** localStorage key of the version whose changelog this browser has seen (a UI state, never written to the server). */
export const CHANGELOG_SEEN = "hebi8m:changelog-seen";

/** `[major, minor]` of an `x.y.z` version; `null` when it is not one. */
function minorOf(version: string): [number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.\d+/.exec(version);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** `current` is a later minor release than `seen`: a patch (a hotfix) never counts as news. */
export function newerMinor(current: string, seen: string): boolean {
  const a = minorOf(current);
  const b = minorOf(seen);
  if (!a || !b) return false;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

/** CHANGELOG.md for the page: its own `# ` title goes, the page has one. */
export function changelogBody(source: string): string {
  return source.replace(/^# .*\n+/, "");
}
