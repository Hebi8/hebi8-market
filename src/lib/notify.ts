/**
 * Outbound delivery of post-sync alerts. The instance's settings are written by hand in
 * `notify.json` in the secrets dir (never the vault): the Telegram bot, the chart link, and the
 * root vault's chat and webhook. On a shared instance each person's own channels are in
 * `notify-users.json`, written by the notification settings page: a Telegram chat, a webhook and
 * the devices that turned on push (`push.ts`). Every request is outbound, nothing listens for
 * webhooks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicUrl } from "./app-info";
import { callBot } from "./bot-api";
import { fmtPrice } from "./format";
import { sendPush, vapidKeys, type PushDevice, type PushPayload } from "./push";
import { readJson, secretsDir, writeJson } from "./secrets";
import { TF_LABELS, type Timeframe } from "./symbols";

export interface Webhook {
  url: string;
  format: "text" | "json";
}

export interface NotifyConfig {
  /** `chat` is where the root vault's alerts go; a bot without one only serves people who bind on the page */
  /** `apis`: the Bot API addresses to choose from (`bot-api.ts`), Telegram's own when none are given */
  telegram?: { token: string; chat?: string; apis: string[] };
  webhook?: Webhook;
  /** Base URL of this app, for chart links in messages */
  link?: string;
  /** Only from notify-users.json; `login` is whose entry an expired device is removed from */
  push?: { login: string; devices: PushDevice[] };
}

/** One person's channels in notify-users.json, keyed by lower-case login. */
export interface UserChannels {
  telegram?: { chat: string };
  webhook?: Webhook;
  /** One per browser that turned push on */
  push?: PushDevice[];
}

export interface AlertEvent {
  rule: string;
  key: string;
  /** Display name of the symbol */
  name: string;
  /** Condition label or alert label */
  label: string;
  tf: Timeframe;
  close: number | null;
}

export interface Delivery {
  sent: string[];
  failed: { channel: string; error: string }[];
}

const NOTIFY_FILE = "notify.json";
const TELEGRAM_API = "https://api.telegram.org";
/** Telegram rejects messages over 4096 characters. */
const MAX_TEXT = 4000;
/** RFC 8291 leaves 3993 bytes of plaintext in a 4096-byte push message; Apple refuses more with 413 */
const MAX_PUSH = 3993;

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** `telegram.api` as written: one address, a list, or nothing for Telegram's own. */
function botApis(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.length ? list.map((v) => httpUrl(str(v) ?? "", "telegram.api")) : [TELEGRAM_API];
}

export function httpUrl(value: string, where: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where} 不是有效的地址`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${where} 只支持 http 或 https`);
  return value.replace(/\/+$/, "");
}

/** Validate the hand-written file; a section that is present but incomplete is an error. */
export function parseNotifyConfig(raw: unknown): NotifyConfig {
  const root = obj(raw);
  if (!root) throw new Error("notify.json 应是一个对象");
  const out: NotifyConfig = {};
  if (root.telegram !== undefined) {
    const t = obj(root.telegram);
    const token = str(t?.token);
    const chat = str(t?.chat);
    if (!token) throw new Error("notify.json 的 telegram 需要 token");
    out.telegram = { token, ...(chat ? { chat } : {}), apis: botApis(t?.api) };
  }
  if (root.webhook !== undefined) {
    const w = typeof root.webhook === "string" ? { url: root.webhook } : obj(root.webhook);
    const url = str(w?.url);
    if (!url) throw new Error("notify.json 的 webhook 需要 url");
    const format = w?.format ?? "text";
    if (format !== "text" && format !== "json") throw new Error("notify.json 的 webhook.format 应为 text 或 json");
    out.webhook = { url: httpUrl(url, "webhook.url"), format };
  }
  if (root.link !== undefined) {
    const link = str(root.link);
    if (link) out.link = httpUrl(link, "link");
  }
  return out;
}

/** What the page shows about the instance's bot; never the token. */
export interface BotSummary {
  configured: boolean;
  username: string | null;
  /** getMe failed for the configured token */
  error?: string;
}

/**
 * The owner sets the instance's bot from the page (§2.5): only the `telegram` section changes, every
 * other field of the hand-written file stays as it was. `token: null` removes the section.
 */
export function setInstanceBot(token: string | null): void {
  const raw = readNotifyFile();
  if (token) raw.telegram = { ...obj(raw.telegram), token };
  else delete raw.telegram;
  writeJson(NOTIFY_FILE, raw);
}

/** The Bot APIs a new token is checked against: the file's `telegram.api`, else Telegram's. */
export function instanceBotApis(): string[] {
  return botApis(obj(readNotifyFile().telegram)?.api);
}

/** notify.json as written; a file that is not a JSON object is not overwritten. */
function readNotifyFile(): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(secretsDir(), NOTIFY_FILE), "utf8");
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const root = obj(raw);
  if (!root) throw new Error("notify.json 不是有效的 JSON 对象，先手动修好它");
  return root;
}

/** A missing file means no channels; a broken one is reported, not ignored. */
export function readNotifyConfig(): { config: NotifyConfig; error: string | null } {
  const file = path.join(secretsDir(), NOTIFY_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { config: {}, error: null };
  }
  try {
    return { config: parseNotifyConfig(JSON.parse(text)), error: null };
  } catch (err) {
    return { config: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

const USERS_FILE = "notify-users.json";

export function readNotifyUsers(): Record<string, UserChannels> {
  return readJson<Record<string, UserChannels>>(USERS_FILE) ?? {};
}

/** Set (or with null, remove) one of a person's channels; someone left with none drops out of the file. */
export function setUserChannel<C extends keyof UserChannels>(login: string, channel: C, value: UserChannels[C] | null): void {
  const all = readNotifyUsers();
  const key = login.toLowerCase();
  const next: UserChannels = { ...all[key] };
  if (value) next[channel] = value;
  else delete next[channel];
  if (Object.keys(next).length) all[key] = next;
  else delete all[key];
  writeJson(USERS_FILE, all);
}

/** A device is named by a hash of its endpoint: the endpoint itself never goes to the page. */
export const pushDeviceId = (endpoint: string) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

/**
 * Add a device, or replace the one with the same endpoint (a browser subscribing again). A browser
 * is one person's: when someone else logs in on it and turns push on, it leaves the last one's list.
 */
export function addPushDevice(login: string, device: PushDevice): void {
  const all = readNotifyUsers();
  for (const [key, channels] of Object.entries(all)) {
    const left = channels.push?.filter((d) => d.endpoint !== device.endpoint);
    if (!left || left.length === channels.push!.length) continue;
    if (left.length) channels.push = left;
    else delete channels.push;
    if (!Object.keys(channels).length) delete all[key];
  }
  const key = login.toLowerCase();
  all[key] = { ...all[key], push: [...(all[key]?.push ?? []), device] };
  writeJson(USERS_FILE, all);
}

export function removePushDevices(login: string, ids: string[]): void {
  const left = (readNotifyUsers()[login.toLowerCase()]?.push ?? []).filter((d) => !ids.includes(pushDeviceId(d.endpoint)));
  setUserChannel(login, "push", left.length ? left : null);
}

/**
 * Where one vault's alerts go. The root vault ('', single user or the owner) uses notify.json's
 * chat and webhook, each replaced by the owner's own binding from the page when there is one;
 * anyone else only ever gets what they bound. Telegram always goes through the instance's bot.
 */
export function channelsFor(vault: string, owner: string | null): { config: NotifyConfig; error: string | null } {
  const { config: instance, error } = readNotifyConfig();
  const login = vault || owner?.toLowerCase();
  const own = login ? readNotifyUsers()[login] : undefined;
  const chat = own?.telegram?.chat ?? (vault === "" ? instance.telegram?.chat : undefined);
  const webhook = own?.webhook ?? (vault === "" ? instance.webhook : undefined);
  const config: NotifyConfig = {};
  if (instance.telegram && chat) config.telegram = { ...instance.telegram, chat };
  if (webhook) config.webhook = webhook;
  if (instance.link) config.link = instance.link;
  if (login && own?.push?.length) config.push = { login, devices: own.push };
  return { config, error };
}

/** What the notification settings page shows: no chat id beyond its last 4 digits, no webhook beyond its host. */
export interface ChannelSummary {
  /** The instance has a Telegram bot to bind to */
  bot: boolean;
  /** `fromFile`: notify.json's, not bound on the page (the owner's fallback) */
  telegram: { chat: string; fromFile: boolean } | null;
  webhook: { host: string; format: Webhook["format"]; fromFile: boolean } | null;
  push: {
    /** VAPID public key, for `pushManager.subscribe` */
    key: string;
    devices: { id: string; label: string; added: number }[];
    /** Where push can be turned on when the page was opened over plain http */
    publicUrl: string;
  };
}

export function channelSummary(vault: string, owner: string | null): ChannelSummary {
  const { config } = channelsFor(vault, owner);
  const own = readNotifyUsers()[vault || owner?.toLowerCase() || ""];
  const chat = config.telegram?.chat;
  return {
    bot: Boolean(readNotifyConfig().config.telegram),
    telegram: chat ? { chat: `…${chat.slice(-4)}`, fromFile: !own?.telegram } : null,
    webhook: config.webhook ? { host: new URL(config.webhook.url).host, format: config.webhook.format, fromFile: !own?.webhook } : null,
    push: {
      key: vapidKeys().publicKey,
      devices: (own?.push ?? []).map((d) => ({ id: pushDeviceId(d.endpoint), label: d.label, added: d.added })),
      publicUrl: publicUrl(),
    },
  };
}

/** What 发测试消息 and `npm run notify:test` send. */
export const testDigest = (link?: string) =>
  formatDigest([{ rule: "test", key: "binance:BTCUSDT", name: "测试", label: "通知通道可用", tf: "D", close: null }], link);

export const channelNames = (cfg: NotifyConfig): string[] =>
  [cfg.telegram?.chat ? "telegram" : null, cfg.webhook ? "webhook" : null, cfg.push ? "push" : null].filter((c): c is string => c !== null);

export const chartLink = (base: string, key: string) => `${base}/chart/${encodeURIComponent(key)}`;

/** An event as the digest lists it, in Telegram and in a notification alike. */
const eventLine = (e: AlertEvent) => `• ${e.name}：${e.label}（${TF_LABELS[e.tf]}线）${e.close === null ? "" : `  收 ${fmtPrice(e.close)}`}`;

/** One plain-text digest for every event of a sync. */
export function formatDigest(events: AlertEvent[], link?: string): { title: string; text: string } {
  const title = `hebi8/market · ${events.length} 条新提醒`;
  const lines = events.flatMap((e) => (link ? [eventLine(e), `  ${chartLink(link, e.key)}`] : [eventLine(e)]));
  let text = [title, "", ...lines].join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 2)}\n…`;
  return { title, text };
}

const TIMEOUT = 15_000;

/** Through the bot's fastest address; when and where it moves on is in `bot-api.ts`. */
export async function sendTelegram(cfg: { token: string; chat: string; apis: string[] }, text: string): Promise<void> {
  await callBot(cfg, "sendMessage", { chat_id: cfg.chat, text, disable_web_page_preview: true });
}

async function sendWebhook(cfg: NonNullable<NotifyConfig["webhook"]>, title: string, text: string, events: AlertEvent[]): Promise<void> {
  const init: RequestInit =
    cfg.format === "json"
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ title, text, events }) }
      : { headers: { "content-type": "text/plain; charset=utf-8", Title: "hebi8/market" }, body: text };
  let res: Response;
  try {
    res = await fetch(cfg.url, { method: "POST", ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    // ntfy topics are secrets too, so the URL stays out of the message
    throw new Error(`webhook 请求失败（${err instanceof Error ? err.name : "error"}）`);
  }
  if (!res.ok) throw new Error(`webhook ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * The notification for a digest: Telegram's lines without the links, which the tap replaces: one
 * symbol opens its chart, several open the overview. A message without events (usage limits) is
 * its text without the title line. Too long for a push message, it loses whole lines from the
 * end and says how many.
 */
export function pushPayload(title: string, text: string, events: AlertEvent[]): PushPayload {
  // from the events, not the text: Telegram's text may already be cut at 4000 characters
  const lines = events.length
    ? events.map(eventLine)
    : text
        .split("\n")
        .slice(1)
        .filter((l) => l.trim() && !/^\s*https?:\/\/\S+$/.test(l));
  const keys = [...new Set(events.map((e) => e.key))];
  const url = keys.length === 1 ? `/chart/${encodeURIComponent(keys[0])}` : "/";
  const make = (kept: number): PushPayload => {
    const cut = lines.length - kept;
    return { title, body: [...lines.slice(0, kept), ...(cut ? [`…还有 ${cut} 条`] : [])].join("\n"), url };
  };
  let kept = lines.length;
  while (Buffer.byteLength(JSON.stringify(make(kept))) > MAX_PUSH) kept--;
  return make(kept);
}

/** Every device at once; ones the push service no longer knows are removed. Fails only when none got it. */
async function sendPushes(cfg: NonNullable<NotifyConfig["push"]>, payload: PushPayload): Promise<void> {
  const results = await Promise.allSettled(cfg.devices.map((d) => sendPush(d, payload)));
  const gone = cfg.devices.filter((_, i) => results[i].status === "fulfilled" && results[i].value === "gone");
  if (gone.length) removePushDevices(cfg.login, gone.map((d) => pushDeviceId(d.endpoint)));
  if (results.some((r) => r.status === "fulfilled" && r.value === "sent")) return;
  const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
  if (gone.length) errors.push(`${gone.length} 台设备的订阅已失效，已移除`);
  throw new Error(errors.join("；"));
}

/** Every configured channel in parallel; one failing does not stop the others. */
export async function deliver(cfg: NotifyConfig, title: string, text: string, events: AlertEvent[] = []): Promise<Delivery> {
  const jobs: [string, () => Promise<void>][] = [];
  const telegram = cfg.telegram;
  const chat = telegram?.chat;
  if (telegram && chat) jobs.push(["telegram", () => sendTelegram({ ...telegram, chat }, text)]);
  if (cfg.webhook) jobs.push(["webhook", () => sendWebhook(cfg.webhook!, title, text, events)]);
  if (cfg.push) jobs.push(["push", () => sendPushes(cfg.push!, pushPayload(title, text, events))]);
  const results = await Promise.allSettled(jobs.map(([, job]) => job()));
  const out: Delivery = { sent: [], failed: [] };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out.sent.push(jobs[i][0]);
    else out.failed.push({ channel: jobs[i][0], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return out;
}
