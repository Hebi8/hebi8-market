import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "123456:SECRET-token";
const ORIGIN = "http://100.64.0.1:8808";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-notify-"));
const secrets = path.join(dir, "secrets");
const usersFile = path.join(secrets, "notify-users.json");

// ---------------------------------------------------------------------------- a fake Bot API and webhook

interface Update {
  update_id: number;
  message: { chat: { id: number; type: string }; text: string };
}
let updates: Update[] = [];
const calls: { method: string; body: Record<string, unknown> }[] = [];
/** Runs when the bot is asked to confirm its last batch (`timeout: 0`), before it answers */
let onConfirm: (() => Promise<void | number>) | null = null;
const hooks: string[] = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (req.url === "/hook") {
      hooks.push(raw);
      res.end("ok");
      return;
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const reply = (result: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(status === 200 ? { ok: true, result } : { ok: false, description: "Unauthorized" }));
    };
    if (!m || m[1] !== TOKEN) return reply(null, 401);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: m[2], body });
    if (m[2] === "getMe") return reply({ id: 1, is_bot: true, username: "hebi8_test_bot" });
    if (m[2] === "sendMessage") return reply({ message_id: 1 });
    if (m[2] === "getUpdates") {
      if (body.timeout === 0 && onConfirm) {
        const hook = onConfirm;
        onConfirm = null;
        const status = await hook();
        if (status) return reply(null, status);
      }
      // like Telegram: an offset confirms everything before it; hold briefly when there is nothing
      const offset = Number(body.offset ?? 0);
      updates = updates.filter((u) => u.update_id >= offset);
      if (updates.length === 0) await new Promise((r) => setTimeout(r, 50));
      return reply(updates);
    }
    reply(null, 404);
  });
});

const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let api: string;
let sessions: Record<string, string>;
const writeRoot = (owner: string | null) =>
  fs.writeFileSync(path.join(dir, "vault", "hebi8.yaml"), `${owner ? `owner: ${owner}\n` : ""}groups:\n  - { name: 加密, symbols: [binance:BTCUSDT] }\n`);
const writeNotify = (value: unknown) => fs.writeFileSync(path.join(secrets, "notify.json"), JSON.stringify(value));

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HEBI8_VAULT = path.join(dir, "vault");
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = secrets;
  fs.mkdirSync(path.join(dir, "vault"));
  writeRoot("Owner");
  const { createSession } = await import("@/lib/secrets");
  const as = (login: string) => createSession({ login, avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
  sessions = { owner: as("owner"), alice: as("Alice"), bob: as("bob") };
});

afterAll(() => {
  server.close();
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(usersFile, { force: true });
  writeNotify({ telegram: { token: TOKEN, chat: "1000001", api }, webhook: `${api}/file-hook`, link: ORIGIN });
});

// ---------------------------------------------------------------------------- notify-users.json

describe("per-person channels", () => {
  it("are written atomically with mode 600 under the lower-case login; an empty entry goes away", async () => {
    const { readNotifyUsers, setUserChannel } = await import("@/lib/notify");
    setUserChannel("Alice", "telegram", { chat: "42" });
    setUserChannel("alice", "webhook", { url: "https://ntfy.sh/a", format: "json" });
    expect(readNotifyUsers()).toEqual({ alice: { telegram: { chat: "42" }, webhook: { url: "https://ntfy.sh/a", format: "json" } } });
    expect(fs.statSync(usersFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(secrets).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    setUserChannel("ALICE", "telegram", null);
    setUserChannel("alice", "webhook", null);
    expect(readNotifyUsers()).toEqual({});
  });

  it("the root vault falls back to notify.json per channel; the owner's own binding wins", async () => {
    const { channelsFor, setUserChannel } = await import("@/lib/notify");
    expect(channelsFor("", "Owner").config).toEqual({
      telegram: { token: TOKEN, chat: "1000001", apis: [api] },
      webhook: { url: `${api}/file-hook`, format: "text" },
      link: ORIGIN,
    });
    setUserChannel("owner", "telegram", { chat: "2002" });
    expect(channelsFor("", "Owner").config.telegram?.chat).toBe("2002");
    expect(channelsFor("", "Owner").config.webhook?.url).toBe(`${api}/file-hook`);
    // single-user mode has no owner: notify.json only
    expect(channelsFor("", null).config.telegram?.chat).toBe("1000001");
  });

  it("anyone else gets only what they bound, through the instance's bot", async () => {
    const { channelNames, channelsFor, setUserChannel } = await import("@/lib/notify");
    expect(channelsFor("alice", "Owner").config).toEqual({ link: ORIGIN });
    setUserChannel("alice", "telegram", { chat: "3003" });
    expect(channelsFor("alice", "Owner").config).toEqual({ telegram: { token: TOKEN, chat: "3003", apis: [api] }, link: ORIGIN });
    expect(channelsFor("bob", "Owner").config).toEqual({ link: ORIGIN });
    // no bot in notify.json: a bound chat cannot be reached
    writeNotify({ link: ORIGIN });
    expect(channelNames(channelsFor("alice", "Owner").config)).toEqual([]);
  });

  it("are summarised without the chat id or the webhook path", async () => {
    const { channelSummary, setUserChannel } = await import("@/lib/notify");
    setUserChannel("alice", "webhook", { url: "https://ntfy.sh/alice-secret-topic", format: "text" });
    setUserChannel("alice", "telegram", { chat: "987654321" });
    expect(channelSummary("alice", "Owner")).toEqual({
      bot: true,
      telegram: { chat: "…4321", fromFile: false },
      webhook: { host: "ntfy.sh", format: "text", fromFile: false },
      push: { key: expect.any(String), devices: [], publicUrl: "https://market-hebi8.dreaife.tokyo" },
    });
    expect(channelSummary("", "Owner")).toMatchObject({ telegram: { chat: "…0001", fromFile: true }, webhook: { host: "127.0.0.1:" + api.split(":")[2], fromFile: true } });
  });
});

// ---------------------------------------------------------------------------- Telegram binding

describe("Telegram binding", () => {
  it("links to the bot with a one-time code, binds the private /start and confirms it, then stops polling", async () => {
    const { startBinding, bindingStatus } = await import("@/lib/telegram");
    const { readNotifyUsers } = await import("@/lib/notify");
    const logs = vi.spyOn(console, "log");
    calls.length = 0;

    const { url, expiresAt } = await startBinding("Alice");
    const code = /^https:\/\/t\.me\/hebi8_test_bot\?start=([A-Za-z0-9_-]{12})$/.exec(url)?.[1];
    expect(code).toBeTruthy();
    expect(expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(bindingStatus("alice")).toEqual({ status: "pending" });
    await until(() => calls.some((c) => c.method === "getUpdates"));
    expect(calls.find((c) => c.method === "getUpdates")!.body).toMatchObject({ timeout: 25, allowed_updates: ["message"] });

    updates.push(
      { update_id: 10, message: { chat: { id: -5, type: "group" }, text: `/start ${code}` } },
      { update_id: 11, message: { chat: { id: 666, type: "private" }, text: "/start wrongcode" } },
      { update_id: 12, message: { chat: { id: 777, type: "private" }, text: `/start ${code}` } },
    );
    let status = bindingStatus("Alice");
    await until(() => (status = bindingStatus("Alice")).status !== "pending");
    expect(status).toEqual({ status: "bound", chat: "777" });
    expect(readNotifyUsers()).toEqual({ alice: { telegram: { chat: "777" } } });
    expect(calls.filter((c) => c.method === "sendMessage").map((c) => c.body)).toEqual([
      { chat_id: "777", text: "已绑定 hebi8/market：Alice", disable_web_page_preview: true },
    ]);
    // reported once; the code cannot be used again
    expect(bindingStatus("alice")).toEqual({ status: "expired" });

    // the offset confirms what was read, and with no code waiting the bot is left alone
    await until(() => calls.some((c) => c.method === "getUpdates" && c.body.offset === 13 && c.body.timeout === 0));
    const polls = calls.filter((c) => c.method === "getUpdates").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.method === "getUpdates").length).toBe(polls);
    expect(calls.filter((c) => c.method === "getMe")).toHaveLength(1);
    expect(logs.mock.calls.flat().join("\n")).not.toContain("SECRET");
    logs.mockRestore();
  });

  it("keeps polling for a new binding after the final acknowledgement returns 502", async () => {
    const { startBinding, bindingStatus } = await import("@/lib/telegram");
    const codeOf = (url: string) => new URL(url).searchParams.get("start")!;
    const grace = codeOf((await startBinding("grace")).url);
    let heidi: string | null = null;
    onConfirm = async () => {
      heidi = codeOf((await startBinding("heidi")).url);
      return 502;
    };
    updates.push({ update_id: 20, message: { chat: { id: 201, type: "private" }, text: `/start ${grace}` } });
    await until(() => heidi !== null);
    expect(bindingStatus("grace")).toEqual({ status: "bound", chat: "201" });
    updates.push({ update_id: 21, message: { chat: { id: 202, type: "private" }, text: `/start ${heidi}` } });
    let status = bindingStatus("heidi");
    await until(() => (status = bindingStatus("heidi")).status !== "pending", 8000);
    expect(status).toEqual({ status: "bound", chat: "202" });
    await until(() => calls.some((c) => c.method === "getUpdates" && c.body.offset === 22 && c.body.timeout === 0));
  }, 10_000);

  it("cancelling makes the link useless, and a new run does not reuse an old offset", async () => {
    const { startBinding, bindingStatus, cancelBinding } = await import("@/lib/telegram");
    const { readNotifyUsers } = await import("@/lib/notify");
    const codeOf = (url: string) => new URL(url).searchParams.get("start")!;

    const carol = codeOf((await startBinding("carol")).url);
    await until(() => calls.some((c) => c.method === "getUpdates" && c.body.timeout === 25 && c.body.offset === undefined));
    cancelBinding("Carol");
    expect(bindingStatus("carol")).toEqual({ status: "expired" });

    // nobody waits: the bot is left alone
    await new Promise((r) => setTimeout(r, 200));
    const polls = calls.filter((c) => c.method === "getUpdates").length;
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.filter((c) => c.method === "getUpdates").length).toBe(polls);

    // the next run starts without an offset (update ids may have restarted) and ignores carol's old link
    calls.length = 0;
    const dave = codeOf((await startBinding("dave")).url);
    await until(() => calls.some((c) => c.method === "getUpdates"));
    expect(calls.find((c) => c.method === "getUpdates")!.body.offset).toBeUndefined();
    updates.push(
      { update_id: 30, message: { chat: { id: 301, type: "private" }, text: `/start ${carol}` } },
      { update_id: 31, message: { chat: { id: 302, type: "private" }, text: `/start ${dave}` } },
    );
    await until(() => readNotifyUsers().dave !== undefined);
    expect(readNotifyUsers()).toEqual({ dave: { telegram: { chat: "302" } } });
    await until(() => bindingStatus("dave").status === "bound");
  });

  it("keeps polling for a code started while the last batch is being confirmed", async () => {
    const { startBinding, bindingStatus } = await import("@/lib/telegram");
    const codeOf = (url: string) => new URL(url).searchParams.get("start")!;
    const erin = codeOf((await startBinding("erin")).url);
    let frank: string | null = null;
    onConfirm = async () => {
      frank = codeOf((await startBinding("frank")).url);
    };
    updates.push({ update_id: 40, message: { chat: { id: 401, type: "private" }, text: `/start ${erin}` } });
    await until(() => frank !== null);
    expect(bindingStatus("erin")).toEqual({ status: "bound", chat: "401" });
    updates.push({ update_id: 41, message: { chat: { id: 402, type: "private" }, text: `/start ${frank}` } });
    let status = bindingStatus("frank");
    await until(() => (status = bindingStatus("frank")).status !== "pending");
    expect(status).toEqual({ status: "bound", chat: "402" });
  });

  it("refuses without a bot in notify.json", async () => {
    const { startBinding } = await import("@/lib/telegram");
    writeNotify({});
    await expect(startBinding("bob")).rejects.toThrow(/没有配置 Telegram bot/);
  });
});

// ---------------------------------------------------------------------------- /api/notify

const req = (url: string, init: { method?: string; session?: string; body?: unknown; origin?: string } = {}) => {
  const headers = new Headers({ host: "100.64.0.1:8808" });
  if (init.session) headers.set("cookie", `hebi8m_session=${init.session}`);
  if (init.origin) headers.set("origin", init.origin);
  return new NextRequest(`${ORIGIN}${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};

describe("/api/notify", () => {
  it("refuses visitors who are not logged in, and single-user mode", async () => {
    const { GET } = await import("@/app/api/notify/route");
    const telegram = await import("@/app/api/notify/telegram/route");
    const poll = await import("@/app/api/notify/telegram/poll/route");
    const cancel = await import("@/app/api/notify/telegram/cancel/route");
    const webhook = await import("@/app/api/notify/webhook/route");
    const test = await import("@/app/api/notify/test/route");
    for (const res of [
      await cancel.POST(req("/api/notify/telegram/cancel", { method: "POST" })),
      await GET(req("/api/notify")),
      await telegram.POST(req("/api/notify/telegram", { method: "POST" })),
      await telegram.DELETE(req("/api/notify/telegram", { method: "DELETE" })),
      await poll.POST(req("/api/notify/telegram/poll", { method: "POST" })),
      await webhook.PUT(req("/api/notify/webhook", { method: "PUT", body: { url: "https://ntfy.sh/x" } })),
      await webhook.DELETE(req("/api/notify/webhook", { method: "DELETE" })),
      await test.POST(req("/api/notify/test", { method: "POST" })),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "请先登录" });
    }
    expect(fs.existsSync(usersFile)).toBe(false);

    writeRoot(null);
    try {
      expect((await GET(req("/api/notify", { session: sessions.alice }))).status).toBe(409);
    } finally {
      writeRoot("Owner");
    }
  });

  it("works on the viewer's own channels only", async () => {
    const { GET } = await import("@/app/api/notify/route");
    const webhook = await import("@/app/api/notify/webhook/route");
    const test = await import("@/app/api/notify/test/route");
    const { readNotifyUsers } = await import("@/lib/notify");

    expect(await (await GET(req("/api/notify", { session: sessions.alice }))).json()).toMatchObject({ bot: true, telegram: null, webhook: null, push: { devices: [] } });
    expect((await test.POST(req("/api/notify/test", { method: "POST", session: sessions.alice }))).status).toBe(409);

    const bad = await webhook.PUT(req("/api/notify/webhook", { method: "PUT", session: sessions.alice, body: { url: "ftp://x" } }));
    expect(bad.status).toBe(400);
    expect((await webhook.PUT(req("/api/notify/webhook", { method: "PUT", session: sessions.alice, body: { url: "https://x", format: "xml" } }))).status).toBe(400);
    expect((await webhook.PUT(req("/api/notify/webhook", { method: "PUT", session: sessions.alice, body: { url: `${api}/hook` }, origin: "http://evil.example" }))).status).toBe(403);

    // a login in the body is not who it is for
    const ok = await webhook.PUT(req("/api/notify/webhook", { method: "PUT", session: sessions.alice, body: { url: `${api}/hook`, login: "bob" } }));
    expect(await ok.json()).toMatchObject({ bot: true, telegram: null, webhook: { host: api.slice(7), format: "text", fromFile: false } });
    expect(readNotifyUsers()).toEqual({ alice: { webhook: { url: `${api}/hook`, format: "text" } } });

    hooks.length = 0;
    const sent = await test.POST(req("/api/notify/test", { method: "POST", session: sessions.alice }));
    expect(await sent.json()).toEqual({ sent: ["webhook"], failed: [] });
    expect(hooks[0]).toContain("通知通道可用");

    expect(await (await webhook.DELETE(req("/api/notify/webhook", { method: "DELETE", session: sessions.alice }))).json()).toMatchObject({ webhook: null });
    expect(readNotifyUsers()).toEqual({});
  });

  it("binds Telegram through the routes", async () => {
    const telegram = await import("@/app/api/notify/telegram/route");
    const poll = await import("@/app/api/notify/telegram/poll/route");
    const { readNotifyUsers } = await import("@/lib/notify");

    const start = await telegram.POST(req("/api/notify/telegram", { method: "POST", session: sessions.bob }));
    const { url } = (await start.json()) as { url: string };
    const code = new URL(url).searchParams.get("start");
    expect(await (await poll.POST(req("/api/notify/telegram/poll", { method: "POST", session: sessions.bob }))).json()).toEqual({ status: "pending" });
    updates.push({ update_id: 20, message: { chat: { id: 888, type: "private" }, text: `/start ${code}` } });
    let reply: unknown;
    await until(async () => {
      reply = await (await poll.POST(req("/api/notify/telegram/poll", { method: "POST", session: sessions.bob }))).json();
      return (reply as { status: string }).status !== "pending";
    });
    // the chat id stays on the server
    expect(reply).toEqual({ status: "bound" });
    expect(readNotifyUsers()).toEqual({ bob: { telegram: { chat: "888" } } });

    // 取消 through the route: the code stops working
    expect((await telegram.POST(req("/api/notify/telegram", { method: "POST", session: sessions.bob }))).status).toBe(200);
    const cancel = await import("@/app/api/notify/telegram/cancel/route");
    expect(await (await cancel.POST(req("/api/notify/telegram/cancel", { method: "POST", session: sessions.bob }))).json()).toEqual({ ok: true });
    expect(await (await poll.POST(req("/api/notify/telegram/poll", { method: "POST", session: sessions.bob }))).json()).toEqual({ status: "expired" });
    // a chat already bound survives 取消; 解除绑定 removes it
    expect(readNotifyUsers()).toEqual({ bob: { telegram: { chat: "888" } } });

    const after = await telegram.DELETE(req("/api/notify/telegram", { method: "DELETE", session: sessions.bob }));
    expect(await after.json()).toMatchObject({ telegram: null });
    expect(readNotifyUsers()).toEqual({});

    writeNotify({ link: ORIGIN });
    expect((await telegram.POST(req("/api/notify/telegram", { method: "POST", session: sessions.bob }))).status).toBe(409);
  });
});
