import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "123456:SECRET-token";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-bot-api-"));
const secrets = path.join(dir, "secrets");

// ---------------------------------------------------------------------------- a fake fetch, one handler per host

type Handler = (method: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<Response> | Response;
const hosts = new Map<string, Handler>();
const calls: { host: string; token: string; method: string; body: Record<string, unknown> }[] = [];

const ok = (result: unknown) => Response.json({ ok: true, result });
const fail = (status: number, description: string) => Response.json({ ok: false, error_code: status, description }, { status });
/** What undici throws when something went wrong under fetch; `syscall` says in which step */
const netError = (code: string, syscall?: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code, syscall }) });
/** A 200 whose body breaks off after the first bytes */
const cutOff = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"ok":'));
        // as undici's body does when the socket closes
        c.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const after = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)));
  });
const getMe: Handler = (method) => (method === "getMe" ? ok({ username: "hebi8_test_bot" }) : ok({ message_id: 1 }));
const refused: Handler = () => {
  throw netError("ECONNREFUSED", "connect");
};
const sent = (host: string, method = "sendMessage") => calls.filter((c) => c.host === host && c.method === method).length;

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(() => {
  process.env.HEBI8_SECRETS = secrets;
  fs.mkdirSync(secrets);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const [, token, method] = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname)!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ host: u.host, token, method, body });
    return hosts.get(u.host)!(method, body, init.signal!);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  hosts.clear();
});

// ---------------------------------------------------------------------------- notify.json

describe("telegram.api", () => {
  it("is one address as before, a list, or Telegram's own when left out", async () => {
    const { parseNotifyConfig } = await import("@/lib/notify");
    const apis = (api: unknown) => parseNotifyConfig({ telegram: { token: TOKEN, api } }).telegram?.apis;
    expect(apis("http://127.0.0.1:18081/")).toEqual(["http://127.0.0.1:18081"]);
    expect(apis(["http://100.64.0.1:18081", "https://api.telegram.org"])).toEqual(["http://100.64.0.1:18081", "https://api.telegram.org"]);
    expect(apis(undefined)).toEqual(["https://api.telegram.org"]);
    expect(apis([])).toEqual(["https://api.telegram.org"]);
    expect(() => apis(["https://api.telegram.org", "ftp://x"])).toThrow("telegram.api 只支持 http 或 https");
  });
});

// ---------------------------------------------------------------------------- choosing and moving on

describe("Bot API addresses", () => {
  it("go in the configured order until timed, then the fastest that answered first and a failed one last", async () => {
    const { probe, routeOrder } = await import("@/lib/bot-api");
    hosts.set("slow.test", async (m, b, signal) => (await after(40, signal), getMe(m, b, signal)));
    hosts.set("fast.test", getMe);
    hosts.set("down.test", refused);
    const apis = ["http://down.test", "http://slow.test", "http://fast.test"];
    expect(routeOrder(apis)).toEqual(apis);
    await probe({ token: TOKEN, apis });
    expect(routeOrder(apis)).toEqual(["http://fast.test", "http://slow.test", "http://down.test"]);
    expect(calls.map((c) => c.method)).toEqual(["getMe", "getMe", "getMe"]);
  });

  it("a send that never connected moves on, and that address waits for the next probe", async () => {
    const { sendTelegram } = await import("@/lib/notify");
    const { probe } = await import("@/lib/bot-api");
    hosts.set("local.test", refused);
    hosts.set("cloud.test", getMe);
    const cfg = { token: TOKEN, chat: "42", apis: ["http://local.test", "http://cloud.test"] };
    await sendTelegram(cfg, "一");
    expect(calls.map((c) => c.host)).toEqual(["local.test", "cloud.test"]);
    expect(calls[1].body).toEqual({ chat_id: "42", text: "一", disable_web_page_preview: true });

    calls.length = 0;
    await sendTelegram(cfg, "二");
    expect(calls.map((c) => c.host)).toEqual(["cloud.test"]);

    // it is back and faster
    hosts.set("local.test", getMe);
    hosts.set("cloud.test", async (m, b, signal) => (await after(30, signal), getMe(m, b, signal)));
    await probe(cfg);
    calls.length = 0;
    await sendTelegram(cfg, "三");
    expect(calls.map((c) => c.host)).toEqual(["local.test"]);
  });

  it("a DNS failure, a refused or timed-out connect, and every address of a name failing to connect move on", async () => {
    const { sendTelegram } = await import("@/lib/notify");
    hosts.set("dns.test", () => {
      throw netError("ENOTFOUND", "getaddrinfo");
    });
    hosts.set("connect.test", () => {
      throw netError("UND_ERR_CONNECT_TIMEOUT");
    });
    hosts.set("connect2.test", () => {
      throw netError("ETIMEDOUT", "connect");
    });
    hosts.set("both.test", () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new AggregateError([netError("ECONNREFUSED", "connect").cause, netError("ENETUNREACH", "connect").cause]), { code: "ECONNREFUSED" }),
      });
    });
    hosts.set("good.test", getMe);
    await sendTelegram({ token: TOKEN, chat: "42", apis: ["http://dns.test", "http://connect.test", "http://connect2.test", "http://both.test", "http://good.test"] }, "x");
    expect(calls.map((c) => c.host)).toEqual(["dns.test", "connect.test", "connect2.test", "both.test", "good.test"]);
  });

  it("a 5xx, a timeout on a connected socket and a body that broke off may have been sent: a send stops there, getMe moves on", async () => {
    const { sendTelegram } = await import("@/lib/notify");
    const { callBot, routeOrder } = await import("@/lib/bot-api");
    const broken: [string, Handler, string][] = [
      ["gateway", () => fail(504, "Gateway Timeout"), "Telegram sendMessage 504：Gateway Timeout"],
      ["sending", () => Promise.reject(netError("ETIMEDOUT", "write")), "Telegram sendMessage 请求失败（ETIMEDOUT）"],
      ["nocall", () => Promise.reject(netError("EHOSTUNREACH")), "Telegram sendMessage 请求失败（EHOSTUNREACH）"],
      ["cut", cutOff, "Telegram sendMessage 200 回应没收完（UND_ERR_SOCKET）"],
    ];
    for (const [name, handler, message] of broken) {
      hosts.set(`${name}.test`, handler);
      hosts.set(`${name}-ok.test`, getMe);
      const apis = [`http://${name}.test`, `http://${name}-ok.test`];
      calls.length = 0;
      await expect(sendTelegram({ token: TOKEN, chat: "42", apis }, "x")).rejects.toThrow(`${name}.test ${message}`);
      expect(calls.map((c) => c.host)).toEqual([`${name}.test`]);
      // failed until the next probe
      expect(routeOrder(apis)).toEqual(apis.toReversed());

      hosts.set(`${name}-me.test`, handler);
      calls.length = 0;
      await expect(callBot({ token: TOKEN, apis: [`http://${name}-me.test`, `http://${name}-ok.test`] }, "getMe", {})).resolves.toEqual({ username: "hebi8_test_bot" });
      expect(calls.map((c) => c.host)).toEqual([`${name}-me.test`, `${name}-ok.test`]);
    }
  });

  it("Telegram's own errors come back as they are, without asking another address", async () => {
    const { sendTelegram } = await import("@/lib/notify");
    const { routeOrder } = await import("@/lib/bot-api");
    hosts.set("blocked.test", () => fail(403, "Forbidden: bot was blocked by the user"));
    hosts.set("other.test", getMe);
    const apis = ["http://blocked.test", "http://other.test"];
    await expect(sendTelegram({ token: TOKEN, chat: "42", apis }, "x")).rejects.toThrow("Telegram sendMessage 403：Forbidden: bot was blocked by the user");
    expect(calls.map((c) => c.host)).toEqual(["blocked.test"]);
    // the address itself works
    expect(routeOrder(apis)).toEqual(apis);
  });

  it("a send that may have gone out is not repeated, but the next one avoids that address; getMe moves on", async () => {
    const { sendTelegram } = await import("@/lib/notify");
    const { callBot } = await import("@/lib/bot-api");
    hosts.set("dropped.test", () => {
      throw netError("UND_ERR_SOCKET");
    });
    hosts.set("other.test", getMe);
    const cfg = { token: TOKEN, chat: "42", apis: ["http://dropped.test", "http://other.test"] };
    const err = await sendTelegram(cfg, "x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("dropped.test Telegram sendMessage 请求失败（UND_ERR_SOCKET）");
    expect((err as Error).message).not.toContain("SECRET");
    expect(sent("other.test")).toBe(0);
    await sendTelegram(cfg, "y");
    expect(calls.map((c) => c.host)).toEqual(["dropped.test", "other.test"]);

    // our own timeout: the request may be on its way, so a send stops, a getMe asks the next address
    hosts.set("hangs.test", (_m, _b, signal) => after(10_000, signal).then(() => ok(null)));
    calls.length = 0;
    await expect(callBot({ token: TOKEN, apis: ["http://hangs.test", "http://other2.test"] }, "sendMessage", {}, 50)).rejects.toThrow("hangs.test Telegram sendMessage 请求失败（TimeoutError）");
    expect(calls.map((c) => c.host)).toEqual(["hangs.test"]);
    hosts.set("hangs2.test", hosts.get("hangs.test")!);
    hosts.set("other3.test", getMe);
    calls.length = 0;
    await expect(callBot({ token: TOKEN, apis: ["http://hangs2.test", "http://other3.test"] }, "getMe", {}, 50)).resolves.toEqual({ username: "hebi8_test_bot" });
    expect(calls.map((c) => c.host)).toEqual(["hangs2.test", "other3.test"]);
  });
});

// ---------------------------------------------------------------------------- binding through two addresses

/** A Bot API server's getUpdates: an offset confirms everything before it; held briefly when there is nothing */
function updatesServer(queue: { update_id: number; message: unknown }[]): Handler {
  return async (method, body, signal) => {
    if (method !== "getUpdates") return getMe(method, body, signal);
    const offset = Number(body.offset ?? 0);
    queue.splice(0, queue.length, ...queue.filter((u) => u.update_id >= offset));
    if (queue.length === 0 && body.timeout) await after(30, signal);
    return ok(queue);
  };
}

describe("binding with two addresses", () => {
  const writeNotify = (api: string[], token = TOKEN) => fs.writeFileSync(path.join(secrets, "notify.json"), JSON.stringify({ telegram: { token, api } }));
  const polls = (host: string, token = TOKEN) => calls.filter((c) => c.host === host && c.token === token && c.method === "getUpdates").length;
  /** No more getUpdates on these hosts, over a while longer than a few held polls */
  const quiet = async (...keys: string[]) => {
    const count = () => keys.map((k) => calls.filter((c) => c.method === "getUpdates" && `${c.host} ${c.token}`.startsWith(k)).length).join();
    const before = count();
    await new Promise((r) => setTimeout(r, 200));
    return count() === before;
  };
  const codeOf = (url: string) => new URL(url).searchParams.get("start")!;

  beforeEach(async () => {
    const { resetBindings } = await import("@/lib/telegram");
    resetBindings();
    fs.rmSync(path.join(secrets, "notify-users.json"), { force: true });
  });

  it("reads both, and the same /start arriving on both binds once with one confirmation", async () => {
    const { bindingStatus, startBinding } = await import("@/lib/telegram");
    const { readNotifyUsers } = await import("@/lib/notify");
    const local: { update_id: number; message: unknown }[] = [];
    const cloud: { update_id: number; message: unknown }[] = [];
    hosts.set("local.bind", updatesServer(local));
    hosts.set("cloud.bind", updatesServer(cloud));
    writeNotify(["http://local.bind", "http://cloud.bind"]);

    const code = codeOf((await startBinding("alice")).url);
    await until(() => sent("local.bind", "getUpdates") > 0 && sent("cloud.bind", "getUpdates") > 0);
    // each server numbers its own updates
    const message = { chat: { id: 777, type: "private" }, text: `/start ${code}` };
    local.push({ update_id: 5, message });
    cloud.push({ update_id: 900, message });
    let status = bindingStatus("alice");
    await until(() => (status = bindingStatus("alice")).status !== "pending");
    expect(status).toEqual({ status: "bound", chat: "777" });
    expect(readNotifyUsers()).toEqual({ alice: { telegram: { chat: "777" } } });
    // both batches are confirmed on their own server, then both are left alone
    await until(() => calls.some((c) => c.host === "local.bind" && c.body.offset === 6) && calls.some((c) => c.host === "cloud.bind" && c.body.offset === 901));
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    const polls = calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.length).toBe(polls);
  });

  it("binds through the one that answers, shows no error while one does, and shows both when neither does", async () => {
    const { bindingStatus, cancelBinding, startBinding } = await import("@/lib/telegram");
    const cloud: { update_id: number; message: unknown }[] = [];
    hosts.set("down.bind", refused);
    hosts.set("cloud2.bind", updatesServer(cloud));
    writeNotify(["http://down.bind", "http://cloud2.bind"]);

    const code = codeOf((await startBinding("bob")).url);
    await until(() => sent("down.bind", "getUpdates") > 0 && sent("cloud2.bind", "getUpdates") > 1);
    expect(bindingStatus("bob")).toEqual({ status: "pending" });
    cloud.push({ update_id: 1, message: { chat: { id: 888, type: "private" }, text: `/start ${code}` } });
    await until(() => bindingStatus("bob").status === "bound");

    hosts.set("cloud2.bind", refused);
    void startBinding("carol");
    let status = bindingStatus("carol");
    await until(() => "error" in (status = bindingStatus("carol")));
    expect(status).toEqual({
      status: "pending",
      error: "down.bind Telegram getUpdates 请求失败（ECONNREFUSED）；cloud2.bind Telegram getUpdates 请求失败（ECONNREFUSED）",
    });
    cancelBinding("carol");
  });

  it("follows notify.json while it waits: addresses added and taken out, and a token changed by hand voids the codes", async () => {
    const { bindingStatus, startBinding } = await import("@/lib/telegram");
    for (const h of ["a.follow", "b.follow", "c.follow"]) hosts.set(h, updatesServer([]));
    writeNotify(["http://a.follow", "http://b.follow"]);
    await startBinding("dan");
    await until(() => polls("a.follow") > 0 && polls("b.follow") > 0);

    writeNotify(["http://c.follow"]);
    await until(() => polls("c.follow") > 0);
    expect(await quiet("a.follow", "b.follow")).toBe(true);
    expect(await quiet("c.follow")).toBe(false);

    // a second code does not bring the old addresses back
    await startBinding("erin");
    expect(await quiet("a.follow", "b.follow")).toBe(true);

    // a new token written by hand: the codes were for the old bot, and nothing reads it any more
    const NEW = "654321:OTHER-token";
    writeNotify(["http://c.follow"], NEW);
    await until(() => bindingStatus("dan").status === "expired");
    expect(bindingStatus("erin")).toEqual({ status: "expired" });
    expect(await quiet("c.follow")).toBe(true);
    expect(polls("c.follow", NEW)).toBe(0);

    await startBinding("frank");
    await until(() => polls("c.follow", NEW) > 0);
    expect(await quiet(`c.follow ${TOKEN}`)).toBe(true);
    expect(bindingStatus("frank")).toEqual({ status: "pending" });
  });

  it("two people starting at once on a fresh process both get a code", async () => {
    const { bindingStatus, startBinding } = await import("@/lib/telegram");
    const FRESH = "111222:FRESH-token";
    hosts.set("fresh.bind", async (m, b, signal) => (m === "getMe" ? (await after(30, signal), getMe(m, b, signal)) : updatesServer([])(m, b, signal)));
    writeNotify(["http://fresh.bind"], FRESH);
    const [a, b] = await Promise.all([startBinding("gina"), startBinding("hank")]);
    expect(a.url).toMatch(/start=/);
    expect(b.url).toMatch(/start=/);
    expect(bindingStatus("gina")).toEqual({ status: "pending" });
    expect(bindingStatus("hank")).toEqual({ status: "pending" });
  });

  it("drops an answer that comes back after the token was changed by hand", async () => {
    const { bindingStatus, startBinding } = await import("@/lib/telegram");
    const { readNotifyUsers } = await import("@/lib/notify");
    let answer: ((updates: unknown[]) => void) | null = null;
    hosts.set("held.bind", (m, b, signal) =>
      m === "getUpdates" ? new Promise<Response>((resolve) => (answer = (u) => resolve(ok(u)))) : getMe(m, b, signal),
    );
    writeNotify(["http://held.bind"]);
    const code = codeOf((await startBinding("ivan")).url);
    await until(() => answer !== null);
    writeNotify(["http://held.bind"], "999888:HAND-token");
    answer!([{ update_id: 1, message: { chat: { id: 901, type: "private" }, text: `/start ${code}` } }]);
    await until(() => bindingStatus("ivan").status === "expired");
    expect(readNotifyUsers()).toEqual({});
    expect(calls.filter((c) => c.method === "sendMessage")).toEqual([]);
  });

  it("stops in the middle of a batch when the token changes while one update is handled", async () => {
    const { bindingStatus, startBinding } = await import("@/lib/telegram");
    const { readNotifyUsers } = await import("@/lib/notify");
    const queue: { update_id: number; message: unknown }[] = [];
    const server = updatesServer(queue);
    // the owner edits the token while the first confirmation is on its way
    hosts.set("mid.bind", (m, b, signal) => {
      if (m === "sendMessage") writeNotify(["http://mid.bind"], "999777:MID-token");
      return server(m, b, signal);
    });
    writeNotify(["http://mid.bind"]);
    const jill = codeOf((await startBinding("jill")).url);
    const kent = codeOf((await startBinding("kent")).url);
    await until(() => polls("mid.bind") > 0);
    queue.push(
      { update_id: 1, message: { chat: { id: 1001, type: "private" }, text: `/start ${jill}` } },
      { update_id: 2, message: { chat: { id: 1002, type: "private" }, text: `/start ${kent}` } },
    );
    await until(() => bindingStatus("kent").status === "expired");
    expect(bindingStatus("jill")).toEqual({ status: "bound", chat: "1001" });
    expect(readNotifyUsers()).toEqual({ jill: { telegram: { chat: "1001" } } });
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("waits out a notify.json that does not parse right now, keeping the codes", async () => {
    const { bindingStatus, startBinding } = await import("@/lib/telegram");
    const queue: { update_id: number; message: unknown }[] = [];
    hosts.set("edit.bind", updatesServer(queue));
    writeNotify(["http://edit.bind"]);
    const code = codeOf((await startBinding("lena")).url);
    await until(() => polls("edit.bind") > 0);
    fs.writeFileSync(path.join(secrets, "notify.json"), '{ "telegram": { "token": ');
    // a /start read while the file is broken waits too
    queue.push({ update_id: 1, message: { chat: { id: 1101, type: "private" }, text: `/start ${code}` } });
    await new Promise((r) => setTimeout(r, 300));
    expect(bindingStatus("lena")).toEqual({ status: "pending" });
    writeNotify(["http://edit.bind"]);
    let status = bindingStatus("lena");
    await until(() => (status = bindingStatus("lena")).status !== "pending", 12_000);
    expect(status).toEqual({ status: "bound", chat: "1101" });
  }, 15_000);
});
