/**
 * Profiles in the cache (design §2.8). A symbol's slow facts are fetched from its source when its
 * daily bars are first pulled and again once they are a week old, after the scheduled sync; a
 * failure stays on that symbol and is tried again a day later. A dataset series is the exception:
 * its profile is a few lines of the manifest on disk and is read again with every sync (sync.ts). Pages and agents only read the
 * tables. A description's Chinese translation is made by the model when someone asks, once per
 * text: it is stored with the hash of what it translates and no longer applies when a later
 * refresh brings another text.
 */
import crypto from "node:crypto";
import type { Config } from "./config";
import { getDb } from "./db";
import { profileLinks } from "./links";
import { nameOf } from "./names";
import { isChinese, nextEarnings, profileDue, type ProfileState, type ProfileView, type SourceProfile, type Translation } from "./profile";
import { adapters } from "./sources";
import { getSymbol, listSymbols } from "./store";
import { isSynthetic, parseKey } from "./symbols";
import { parseSynth } from "./synth";
import { llmConfig, translateToChinese } from "./translate";

export interface ProfileRow extends ProfileState {
  /** The facts of the last fetch that worked */
  profile: SourceProfile | null;
}

export function readProfile(key: string): ProfileRow | null {
  const row = getDb().prepare("SELECT json, fetched_at, tried_at, error FROM profiles WHERE key = ?").get(key) as
    | { json: string | null; fetched_at: number | null; tried_at: number; error: string | null }
    | undefined;
  return row ? { profile: row.json ? (JSON.parse(row.json) as SourceProfile) : null, fetchedAt: row.fetched_at, triedAt: row.tried_at, error: row.error } : null;
}

export function writeProfile(key: string, profile: SourceProfile, now = Date.now()): void {
  getDb().prepare("INSERT OR REPLACE INTO profiles (key, json, fetched_at, tried_at, error) VALUES (?, ?, ?, ?, NULL)").run(key, JSON.stringify(profile), now, now);
}

/** A failed fetch: the facts from before stay. */
function markProfileError(key: string, message: string, now = Date.now()): void {
  getDb()
    .prepare("INSERT INTO profiles (key, tried_at, error) VALUES (@key, @now, @message) ON CONFLICT(key) DO UPDATE SET tried_at = @now, error = @message")
    .run({ key, now, message });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const inflight = new Map<string, Promise<void>>();

/** Fetch one real key's profile now, if its source has profiles; concurrent calls share the request. Never throws. */
export function refreshProfile(key: string): Promise<void> {
  const { source, ticker } = parseKey(key);
  const fetchProfile = adapters[source].profile;
  if (!fetchProfile) return Promise.resolve();
  let job = inflight.get(key);
  if (!job) {
    job = fetchProfile(ticker)
      .then(
        (profile) => writeProfile(key, profile),
        (err) => markProfileError(key, message(err)),
      )
      // nobody waits for a profile (sync.ts): a cache that cannot be written is logged, not left as an unhandled rejection
      .catch((err) => console.warn(`[hebi8m] profiles: ${key} not stored: ${message(err)}`))
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

/** Fetch the profiles among `keys` (real ones) that are due, two at a time. */
export async function refreshProfiles(keys: string[], now = Date.now()): Promise<void> {
  const queue = [...new Set(keys)].filter((key) => adapters[parseKey(key).source].profile && profileDue(readProfile(key), now));
  if (queue.length === 0) return;
  const due = [...queue];
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) await refreshProfile(key);
  };
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
  const failed = due.flatMap((key) => {
    const error = readProfile(key)?.error;
    return error ? [`${key} (${error})`] : [];
  });
  console.log(`[hebi8m] profiles: refreshed ${due.length - failed.length} of ${due.length}` + (failed.length ? `, failed: ${failed.join(", ")}` : ""));
}

// ---------------------------------------------------------------------------- translation

const hashOf = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** The stored Chinese for `description`; null when there is none or it was made from another text. */
export function readTranslation(key: string, description: string): string | null {
  const row = getDb().prepare("SELECT hash, text FROM translations WHERE key = ?").get(key) as { hash: string; text: string } | undefined;
  return row && row.hash === hashOf(description) ? row.text : null;
}

const translating = new Map<string, Promise<string>>();

/**
 * A symbol's description in Simplified Chinese, with the text it translates: the stored one when
 * it still matches, else the model is asked once per text, however many people click at the same
 * time, and the answer is kept for everyone. A refresh that brings another text while the model
 * works starts over for whoever asks next: they get the new text's translation, and the late
 * answer for the old text is not stored over it. Throws (Chinese, for the page) when there is
 * nothing to translate or no model.
 */
export async function translateDescription(key: string): Promise<Translation> {
  const current = () => (isSynthetic(key) ? undefined : readProfile(key)?.profile?.description);
  const source = current();
  if (!source) throw new Error("这个标的没有可翻译的简介");
  const stored = readTranslation(key, source);
  if (stored) return { source, text: stored };
  const llm = llmConfig();
  if (!llm) throw new Error("这台实例没有配置翻译用的模型");
  const hash = hashOf(source);
  const id = `${key} ${hash}`;
  let job = translating.get(id);
  if (!job) {
    job = translateToChinese(source, llm)
      .then((text) => {
        if (current() === source) getDb().prepare("INSERT OR REPLACE INTO translations (key, hash, text, model, at) VALUES (?, ?, ?, ?, ?)").run(key, hash, text, llm.model, Date.now());
        return text;
      })
      .finally(() => translating.delete(id));
    translating.set(id, job);
  }
  return { source, text: await job };
}

// ---------------------------------------------------------------------------- read

/** One symbol for the 商品详情 panel and for agents, from the cache only; names are the viewer's. */
export function profileView(key: string, cfg: Config): ProfileView {
  if (isSynthetic(key)) {
    const symbols = listSymbols();
    let legs: string[] = [];
    try {
      legs = parseSynth(key.slice(1), cfg.aliases).keys;
    } catch {
      // a broken expression is reported by the chart
    }
    return {
      source: "expr",
      kind: null,
      exchange: null,
      currency: null,
      timezone: null,
      hours: null,
      profile: null,
      fetchedAt: null,
      earningsDay: null,
      pending: false,
      translation: null,
      translatable: false,
      links: [],
      legs: legs.map((k) => ({ key: k, name: nameOf(cfg, k, symbols[k]?.name) })),
    };
  }
  const row = getSymbol(key);
  const stored = readProfile(key);
  const description = stored?.profile?.description;
  const { source } = parseKey(key);
  return {
    source,
    kind: row?.kind ?? null,
    exchange: row?.exchange ?? null,
    currency: row?.currency ?? null,
    timezone: row?.timezone ?? null,
    hours: row?.hours ?? null,
    profile: stored?.profile ?? null,
    fetchedAt: stored?.fetchedAt ?? null,
    earningsDay: nextEarnings(stored?.profile ?? null, Date.now(), row?.timezone ?? "UTC"),
    pending: Boolean(adapters[source].profile) && !stored?.profile,
    translation: description ? readTranslation(key, description) : null,
    translatable: Boolean(description && !isChinese(description) && llmConfig()),
    links: profileLinks({ key, kind: row?.kind ?? null, exchange: row?.exchange ?? null, profile: stored?.profile ?? null }),
    legs: null,
  };
}
