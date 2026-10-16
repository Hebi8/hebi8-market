/**
 * Binding a person's Telegram chat on a shared instance (design §2.5). A one-time code lives in
 * memory for 10 minutes and goes out as a `t.me/<bot>?start=<code>` link. While any code is
 * waiting, the instance's bot is long-polled with getUpdates for a private `/start <code>`; with
 * no code waiting nothing reads the bot, so it never competes with anything else. Outbound only.
 * The token stays on the server: it is in every URL here, so errors carry only the error name.
 * The bot's Bot API addresses are timed here every 5 minutes (`startProbes`); see `bot-api.ts`.
 */
import crypto from "node:crypto";
import { callAt, callBot, probe, type Bot } from "./bot-api";
import { readNotifyConfig, sendTelegram, setUserChannel } from "./notify";

const CODE_TTL_MS = 10 * 60 * 1000;
const LONG_POLL_S = 25;
const RETRY_MS = 5000;
const PROBE_MS = 5 * 60 * 1000;

interface Binding {
  /** As GitHub spells it, for the confirmation message */
  login: string;
  code: string;
  expiresAt: number;
  /** Set as soon as its `/start` is read, so the same message read through another address binds once */
  used?: boolean;
  /** Set once the binding is written and confirmed */
  chat?: string;
}

interface Update {
  update_id: number;
  message?: { chat?: { id?: number | string; type?: string }; text?: string };
}

interface State {
  /** Pending and just-bound codes by lower-case login */
  bindings: Map<string, Binding>;
  /** The bot token the waiting codes and the polling loops are for */
  token: string | null;
  /** The polling loops running now, one per Bot API address; another bot (or none) replaces them, see `resetBindings` */
  runs: Map<string, { stop: AbortController }>;
  /** The last failure of each address's loop, until it answers again */
  errors: Map<string, string>;
  /** Bot username by token, from getMe */
  botNames: Map<string, string>;
  probing: boolean;
}

const g = globalThis as unknown as { hebi8Telegram?: State };
const state: State = (g.hebi8Telegram ??= { bindings: new Map(), token: null, runs: new Map(), errors: new Map(), botNames: new Map(), probing: false });

const log = (msg: string) => console.log(`[hebi8m] telegram: ${msg}`);

/** The instance's bot from notify.json, or null when there is none to bind to. */
export function instanceBot(): Bot | null {
  const t = readNotifyConfig().config.telegram;
  return t ? { token: t.token, apis: t.apis } : null;
}

/** Started once per process from instrumentation: a bot with more than one address has them timed every 5 minutes. */
export function startProbes(): void {
  if (state.probing) return;
  state.probing = true;
  const tick = () => {
    const bot = instanceBot();
    if (bot && bot.apis.length > 1) void probe(bot);
  };
  tick();
  setInterval(tick, PROBE_MS);
}

/** The bot's @username from getMe, cached per token; throws when Telegram does not accept the token. */
export async function botName(bot: Bot): Promise<string> {
  const known = state.botNames.get(bot.token);
  if (known) return known;
  const me = await callBot<{ username?: string }>(bot, "getMe", {});
  if (!me.username) throw new Error("Telegram getMe 没有返回 bot 用户名");
  state.botNames.set(bot.token, me.username);
  return me.username;
}

/** A new code for this login (replacing any earlier one) and the link that sends it to the bot. */
export async function startBinding(login: string, now = Date.now()): Promise<{ url: string; expiresAt: number }> {
  const bot = instanceBot();
  if (!bot) throw new Error("这台 hebi8/market 没有配置 Telegram bot（notify.json 的 telegram.token），请找部署的人");
  const name = await botName(bot);
  // replaced while getMe was out, on the page or by hand; another start for the same bot is fine
  if (checkConfig(bot.token) === "changed") throw new Error("bot 已更换，请重新开始绑定");
  // the token was changed by hand since the last codes: theirs are for the old bot
  if (state.token !== bot.token) resetBindings();
  state.token = bot.token;
  const code = crypto.randomBytes(9).toString("base64url");
  const expiresAt = now + CODE_TTL_MS;
  state.bindings.set(login.toLowerCase(), { login, code, expiresAt });
  pollUpdates(bot);
  return { url: `https://t.me/${name}?start=${code}`, expiresAt };
}

export type BindingStatus = { status: "pending"; error?: string } | { status: "bound"; chat: string } | { status: "expired" };

/** What happened to this login's code; `bound` and `expired` are reported once. */
export function bindingStatus(login: string, now = Date.now()): BindingStatus {
  const key = login.toLowerCase();
  const b = state.bindings.get(key);
  if (b?.chat) {
    state.bindings.delete(key);
    return { status: "bound", chat: b.chat };
  }
  if (!b || b.expiresAt <= now) {
    state.bindings.delete(key);
    return { status: "expired" };
  }
  // one address failing while another answers is not worth showing
  const errors = [...state.errors.values()];
  return errors.length && errors.length === state.runs.size ? { status: "pending", error: errors.join("；") } : { status: "pending" };
}

const waiting = () => [...state.bindings.values()].some((b) => !b.chat && b.expiresAt > Date.now());

/** 取消 or 解除绑定: the waiting code stops working, and with nobody else waiting the polling ends. */
export function cancelBinding(login: string): void {
  const key = login.toLowerCase();
  if (!state.bindings.get(key)?.chat) state.bindings.delete(key);
}

/**
 * The owner set or removed the bot: codes still waiting point at the old one, so they stop working
 * and the old bot's polling ends now (its long poll is aborted). The next code starts a new loop.
 */
export function resetBindings(): void {
  state.token = null;
  for (const [key, b] of state.bindings) if (!b.chat) state.bindings.delete(key);
  for (const run of state.runs.values()) run.stop.abort();
  state.runs.clear();
  state.errors.clear();
}

/**
 * While a code is waiting, every address of the bot is long-polled, each in its own loop with its
 * own offset. Once the bot has been used on Telegram's cloud server and on a self-hosted one,
 * Telegram does not say which of them gets an update, so a `/start` is read wherever it arrives.
 * Update ids are each server's own and are not compared; the code is what is used once (`receive`
 * takes it before anything else), so the same `/start` read on both binds once.
 */
function pollUpdates(bot: Bot): void {
  for (const api of bot.apis) if (!state.runs.has(api)) void pollAt(api, bot.token);
}

/**
 * notify.json as it is now, read on every round of every loop and before each update is handled,
 * since it may be edited by hand. `changed`: another token or no bot, which voids the waiting codes
 * and ends every loop. `unreadable`: the file does not parse right now (say, half saved), so that
 * round waits and the codes keep their time.
 */
function checkConfig(token: string): Bot | "unreadable" | "changed" {
  const { config, error } = readNotifyConfig();
  if (error) return "unreadable";
  if (config.telegram?.token !== token) {
    resetBindings();
    return "changed";
  }
  return { token, apis: config.telegram.apis };
}

/**
 * One address's loop. An update is confirmed by asking for the next offset; once nothing waits, a
 * last `timeout: 0` call confirms the final batch (and whatever it returns is handled like any
 * other). A code started meanwhile keeps the same loop going.
 */
async function pollAt(api: string, token: string): Promise<void> {
  const run = { stop: new AbortController() };
  state.runs.set(api, run);
  const current = () => state.runs.get(api) === run;
  // update ids can restart after a quiet week, so an offset is only trusted within one run
  let offset: number | undefined;
  let unconfirmed = false;
  try {
    poll: for (;;) {
      const busy = waiting();
      if (!current() || (!busy && !unconfirmed)) break;
      const bot = checkConfig(token);
      if (bot === "changed") break;
      if (bot === "unreadable") {
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      // an address added meanwhile gets its loop; one taken out ends its own
      pollUpdates(bot);
      if (!bot.apis.includes(api)) break;
      try {
        const updates: Update[] = await callAt<Update[]>(
          api,
          bot.token,
          "getUpdates",
          { offset, timeout: busy ? LONG_POLL_S : 0, allowed_updates: ["message"] },
          (LONG_POLL_S + 10) * 1000,
          run.stop.signal,
        );
        // the bot changed while this was in flight: its updates are not ours to confirm
        if (!current()) break;
        state.errors.delete(api);
        unconfirmed = updates.length > 0;
        for (const u of updates) {
          // answered for a token that is no longer the bot's: none of it is handled
          const now = checkConfig(token);
          if (now === "changed") break poll;
          // not confirmed, so the next round reads the rest again
          if (now === "unreadable") break;
          offset = u.update_id + 1;
          await receive(now, u);
        }
      } catch (err) {
        if (!current()) break;
        // e.g. 409 when something else reads the same bot: shown in the panel, retried
        const msg = err instanceof Error ? err.message : String(err);
        state.errors.set(api, bot.apis.length > 1 ? `${new URL(api).host} ${msg}` : msg);
        log(state.errors.get(api)!);
        if (!waiting()) break;
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  } finally {
    if (current()) {
      state.runs.delete(api);
      state.errors.delete(api);
    }
  }
}

async function receive(bot: Bot, u: Update): Promise<void> {
  const chat = u.message?.chat;
  const code = /^\/start\s+(\S+)$/.exec(u.message?.text?.trim() ?? "")?.[1];
  if (chat?.type !== "private" || chat.id === undefined || !code) return;
  const binding = [...state.bindings.values()].find((b) => b.code === code && !b.used && b.expiresAt > Date.now());
  if (!binding) return;
  binding.used = true;
  const id = String(chat.id);
  setUserChannel(binding.login, "telegram", { chat: id });
  log(`bound ${binding.login}`);
  await sendTelegram({ ...bot, chat: id }, `已绑定 hebi8/market：${binding.login}`).catch((err) => log(`confirmation failed: ${err instanceof Error ? err.message : String(err)}`));
  // only now does the panel hear about it, so the confirmation is already in the chat
  binding.chat = id;
}
