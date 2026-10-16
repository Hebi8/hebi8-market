/**
 * The instance bot's Bot API addresses (design §2.5). `telegram.api` in notify.json may list
 * several, e.g. a self-hosted server and Telegram's own. `probe` times getMe on each (the 5-minute
 * timer is in `telegram.ts`); a call goes to the fastest address that answered, then the ones not
 * measured yet in the configured order, then the ones that failed. What was measured lives in
 * memory only.
 *
 * A call moves on to the next address only when it certainly did not reach that server: the
 * connection was never made (refused, DNS, unreachable, connect timeout) or the server answered
 * 5xx. Once the request may have gone out (our own timeout fired, the connection dropped before an
 * answer), a sendMessage is not repeated elsewhere, since the chat could get it twice; that
 * address counts as failed until the next probe and the error is reported. getMe changes nothing,
 * so it moves on after those too. Telegram's own answers (4xx: chat not found, bot blocked, 429)
 * would be the same on every address and come back as they are.
 */

export interface Bot {
  token: string;
  /** In the configured order, at least one */
  apis: string[];
}

const TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3000;
/** Codes undici reports when no connection was ever made, so nothing was sent */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
/** Methods that change nothing, safe to ask again elsewhere whatever happened */
const READ_ONLY = new Set(["getMe"]);

/** `answer`: the server replied with an error; `unsent`: it certainly got nothing; `unknown`: it may have got the request */
export class BotApiError extends Error {
  constructor(
    message: string,
    readonly kind: "answer" | "unsent" | "unknown",
  ) {
    super(message);
  }
}

interface Route {
  ok: boolean;
  ms: number;
}

const g = globalThis as unknown as { hebi8BotApi?: Map<string, Route> };
const routes: Map<string, Route> = (g.hebi8BotApi ??= new Map());

/** One request to one address. The token is in the URL, so errors carry only the error code or name. */
export async function callAt<T>(api: string, token: string, method: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS, stop?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    res = await fetch(`${api}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
    });
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    const name = typeof code === "string" ? code : err instanceof Error ? err.name : "error";
    throw new BotApiError(`Telegram ${method} 请求失败（${name}）`, NOT_CONNECTED.has(name) ? "unsent" : "unknown");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !json?.ok) throw new BotApiError(`Telegram ${method} ${res.status}${json?.description ? `：${json.description}` : ""}`, res.status >= 500 ? "unsent" : "answer");
  return json.result as T;
}

/** The bot's addresses in the order a call tries them. */
export function routeOrder(apis: string[]): string[] {
  const group = (r: Route | undefined) => (!r ? 1 : r.ok ? 0 : 2);
  return [...apis].sort((a, b) => {
    const ra = routes.get(a);
    const rb = routes.get(b);
    return group(ra) - group(rb) || (ra?.ok && rb?.ok ? ra.ms - rb.ms : 0);
  });
}

/** A call through the bot's addresses, moving on only by the rules above. */
export async function callBot<T>(bot: Bot, method: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const errors: string[] = [];
  for (const api of routeOrder(bot.apis)) {
    try {
      return await callAt<T>(api, bot.token, method, body, timeoutMs);
    } catch (err) {
      if (!(err instanceof BotApiError) || err.kind === "answer") throw err;
      routes.set(api, { ok: false, ms: 0 });
      errors.push(bot.apis.length > 1 ? `${new URL(api).host} ${err.message}` : err.message);
      if (err.kind === "unknown" && !READ_ONLY.has(method)) break;
    }
  }
  throw new Error(errors.join("；"));
}

/** getMe on every address at once with a short timeout; any answer but a success counts as down. */
export async function probe(bot: Bot): Promise<void> {
  await Promise.all(
    bot.apis.map(async (api) => {
      const start = performance.now();
      const ok = await callAt(api, bot.token, "getMe", {}, PROBE_TIMEOUT_MS).then(
        () => true,
        () => false,
      );
      routes.set(api, { ok, ms: performance.now() - start });
    }),
  );
}
