import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const GOOD = "777000:GOOD-secret-token";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8m-bot-"));
const secrets = path.join(dir, "secrets");
const notifyFile = path.join(secrets, "notify.json");
const ORIGIN = "http://100.64.0.1:8808";
const calls: string[] = [];

// a Bot API that knows one token
const server = http.createServer((req, res) => {
  const m = /^\/bot([^/]+)\/getMe$/.exec(req.url ?? "");
  calls.push(req.url ?? "");
  res.setHeader("content-type", "application/json");
  if (m && m[1] === GOOD) return res.end(JSON.stringify({ ok: true, result: { id: 777000, is_bot: true, username: "hebi8m_test_bot" } }));
  res.statusCode = 401;
  res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
});

let api: string;
let sessions: Record<string, string>;
const writeRoot = (owner: string | null) => fs.writeFileSync(path.join(dir, "vault", "hebi8.yaml"), `${owner ? `owner: ${owner}\n` : ""}groups: []\n`);
const req = (method: string, init: { session?: string; body?: unknown; origin?: string } = {}) => {
  const headers = new Headers({ host: "100.64.0.1:8808" });
  if (init.session) headers.set("cookie", `hebi8m_session=${init.session}`);
  if (init.origin) headers.set("origin", init.origin);
  return new NextRequest(`${ORIGIN}/api/notify/bot`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HEBI8_VAULT = path.join(dir, "vault");
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = secrets;
  fs.mkdirSync(path.join(dir, "vault"));
  const { createSession } = await import("@/lib/secrets");
  const as = (login: string) => createSession({ login, avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
  sessions = { owner: as("Owner"), alice: as("alice") };
});

afterAll(() => {
  server.close();
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  writeRoot("owner");
  // hand-written fields the page must keep: the root chat, the webhook, the link, a self-hosted API
  fs.writeFileSync(notifyFile, JSON.stringify({ telegram: { chat: "42", api }, webhook: "https://ntfy.sh/x", link: ORIGIN }));
  calls.length = 0;
});

describe("/api/notify/bot", () => {
  it("checks the token with getMe and writes only the telegram section; the token never comes back", async () => {
    const { GET, PUT } = await import("@/app/api/notify/bot/route");
    const bad = await PUT(req("PUT", { session: sessions.owner, body: { token: "1:WRONG" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Telegram 不接受这个 token.*401/);
    expect(JSON.parse(fs.readFileSync(notifyFile, "utf8")).telegram).toEqual({ chat: "42", api });
    expect((await PUT(req("PUT", { session: sessions.owner, body: { token: "not a token" } }))).status).toBe(400);

    const ok = await PUT(req("PUT", { session: sessions.owner, body: { token: ` ${GOOD} ` } }));
    const text = await ok.text();
    expect(ok.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ configured: true, username: "hebi8m_test_bot" });
    expect(text).not.toContain("GOOD");
    expect(JSON.parse(fs.readFileSync(notifyFile, "utf8"))).toEqual({ telegram: { chat: "42", api, token: GOOD }, webhook: "https://ntfy.sh/x", link: ORIGIN });
    expect(fs.statSync(notifyFile).mode & 0o777).toBe(0o600);
    expect(calls).toContain(`/bot${GOOD}/getMe`);

    const got = await GET(req("GET", { session: sessions.owner }));
    const gotText = await got.text();
    expect(JSON.parse(gotText)).toEqual({ configured: true, username: "hebi8m_test_bot" });
    expect(gotText).not.toContain("GOOD");
  });

  it("移除 drops the telegram section and keeps the rest", async () => {
    const { DELETE, GET } = await import("@/app/api/notify/bot/route");
    expect(await (await DELETE(req("DELETE", { session: sessions.owner }))).json()).toEqual({ configured: false, username: null });
    expect(JSON.parse(fs.readFileSync(notifyFile, "utf8"))).toEqual({ webhook: "https://ntfy.sh/x", link: ORIGIN });
    expect(await (await GET(req("GET", { session: sessions.owner }))).json()).toEqual({ configured: false, username: null });
  });

  it("is the owner's: 403 for anyone else and for visitors, and for cross-site writes", async () => {
    const { DELETE, GET, PUT } = await import("@/app/api/notify/bot/route");
    for (const res of [
      await GET(req("GET", { session: sessions.alice })),
      await PUT(req("PUT", { session: sessions.alice, body: { token: GOOD } })),
      await DELETE(req("DELETE", { session: sessions.alice })),
      await PUT(req("PUT", { body: { token: GOOD } })),
      await PUT(req("PUT", { session: sessions.owner, body: { token: GOOD }, origin: "http://evil.example" })),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(notifyFile, "utf8")).telegram).toEqual({ chat: "42", api });
  });

  it("is anyone's in single-user mode", async () => {
    const { PUT } = await import("@/app/api/notify/bot/route");
    writeRoot(null);
    expect((await PUT(req("PUT", { body: { token: GOOD } }))).status).toBe(200);
  });

  it("leaves a broken notify.json alone", async () => {
    const { PUT } = await import("@/app/api/notify/bot/route");
    fs.writeFileSync(notifyFile, "{ not json");
    const res = await PUT(req("PUT", { session: sessions.owner, body: { token: GOOD } }));
    expect(res.status).toBe(409);
    expect(fs.readFileSync(notifyFile, "utf8")).toBe("{ not json");
  });
});
