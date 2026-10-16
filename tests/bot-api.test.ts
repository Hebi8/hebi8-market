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
const calls: { host: string; method: string; body: Record<string, unknown> }[] = [];

const ok = (result: unknown) => Response.json({ ok: true, result });
const fail = (status: number, description: string) => Response.json({ ok: false, error_code: status, description }, { status });
/** What undici throws when something went wrong under fetch */
const netError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
const after = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)));
  });
const getMe: Handler = (method) => (method === "getMe" ? ok({ username: "hebi8_test_bot" }) : ok({ message_id: 1 }));
const refused: Handler = () => {
  throw netError("ECONNREFUSED");
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
    const method = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname)![1];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ host: u.host, method, body });
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
    expect(apis(["http://100.92.194.31:18081", "https://api.telegram.org"])).toEqual(["http://100.92.194.31:18081", "https://api.telegram.org"]);
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

  it("a DNS failure, a connect timeout and a 5xx move on too", async () => {
    const { sendTelegram } = await import("@/lib/notify");
    hosts.set("dns.test", () => {
      throw netError("ENOTFOUND");
    });
    hosts.set("connect.test", () => {
      throw netError("UND_ERR_CONNECT_TIMEOUT");
    });
    hosts.set("bad.test", () => fail(502, "Bad Gateway"));
    hosts.set("good.test", getMe);
    await sendTelegram({ token: TOKEN, chat: "42", apis: ["http://dns.test", "http://connect.test", "http://bad.test", "http://good.test"] }, "x");
    expect(calls.map((c) => c.host)).toEqual(["dns.test", "connect.test", "bad.test", "good.test"]);
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
  const writeNotify = (api: string[]) => fs.writeFileSync(path.join(secrets, "notify.json"), JSON.stringify({ telegram: { token: TOKEN, api } }));
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
});
