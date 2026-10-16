/**
 * The instance bot's Bot API addresses (design §2.5). `telegram.api` in notify.json may list
 * several, e.g. a self-hosted server and Telegram's own. `probe` times getMe on each (the 5-minute
 * timer is in `telegram.ts`); a call goes to the fastest address that answered, then the ones not
 * measured yet in the configured order, then the ones that failed. What was measured lives in
 * memory only.
 *
 * A call moves on to the next address only when it certainly did not reach that server: the name
 * did not resolve, or the connection was never made (refused, unreachable or timed out while
 * connecting). Anything else may have gone out: our own timeout, a connection dropped or timed out
 * after it was made, an answer whose body did not arrive in full, and a 5xx (a gateway answers
 * 504 when the server behind it is slow, and that server may still send). Then a sendMessage is
 * not repeated elsewhere, since the chat could get it twice; that address counts as failed until
 * the next probe and the error is reported. getMe and getUpdates change nothing, so they move on
 * after those too. Telegram's own answers (4xx: chat not found, bot blocked, 429) would be the
 * same on every address and come back as they are.
 */

export interface Bot {
  token: string;
  /** In the configured order, at least one */
  apis: string[];
}

const TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3000;
/** Methods that change nothing, safe to ask again elsewhere whatever happened */
const READ_ONLY = new Set(["getMe", "getUpdates"]);

interface Cause {
  code?: unknown;
  syscall?: unknown;
  /** Each address tried, when the name has several */
  errors?: Cause[];
}

/** The error's code (or name) for the message, never the URL, which carries the token. */
const errorName = (err: unknown) => {
  const code = (err as { cause?: Cause }).cause?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "error";
};

/**
 * Nothing was sent: undici's connect timeout, or every attempt failed while resolving the name or
 * connecting. A code alone does not say so (ETIMEDOUT and EHOSTUNREACH also come from a socket
 * that was already sending); the syscall does.
 */
function notConnected(err: unknown): boolean {
  const cause = (err as { cause?: Cause }).cause;
  if (!cause) return false;
  if (cause.code === "UND_ERR_CONNECT_TIMEOUT") return true;
  const attempts = cause.errors?.length ? cause.errors : [cause];
  return attempts.every((e) => e.syscall === "connect" || e.syscall === "getaddrinfo");
}

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

/** One request to one address. */
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
    throw new BotApiError(`Telegram ${method} 请求失败（${errorName(err)}）`, notConnected(err) ? "unsent" : "unknown");
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new BotApiError(`Telegram ${method} ${res.status} 回应没收完（${errorName(err)}）`, "unknown");
  }
  let json: { ok?: boolean; result?: T; description?: string } | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok || !json?.ok) throw new BotApiError(`Telegram ${method} ${res.status}${json?.description ? `：${json.description}` : ""}`, res.status >= 500 ? "unknown" : "answer");
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
