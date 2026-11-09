import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertEvent } from "@/lib/notify";
import type { PushDevice } from "@/lib/push";

// Narrow the overload used by the address policy.
const resolver = dns as { lookup: (host: string, options: { all: true }) => Promise<LookupAddress[]> };

// web-push's own decoder, to read what a device would receive
const ece = createRequire(import.meta.url)("http_ece") as { decrypt: (body: Buffer, params: Record<string, unknown>) => Buffer };

const TOKEN = "123456:SECRET-token";
const ORIGIN = "https://market.example";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-push-"));
const secrets = path.join(dir, "secrets");
const usersFile = path.join(secrets, "notify-users.json");

// ---------------------------------------------------------------------------- a fake push service, Bot API and webhook

/** Status each push endpoint answers with, by its last path segment; 201 when not set */
const status: Record<string, number> = {};
const pushed: { device: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
const telegram: Record<string, unknown>[] = [];
const hooks: string[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const push = /^\/push\/(\w+)$/.exec(req.url ?? "");
    if (push) {
      pushed.push({ device: push[1], headers: req.headers, body });
      res.statusCode = status[push[1]] ?? 201;
      res.end(res.statusCode >= 400 ? "push service says no" : "");
    } else if (req.url === `/bot${TOKEN}/sendMessage`) {
      telegram.push(JSON.parse(body.toString()));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    } else {
      hooks.push(body.toString());
      res.end("ok");
    }
  });
});

let api: string;
let sessions: Record<string, string>;

/** A browser's subscription: the push service's endpoint and the keys only that browser can decrypt with. */
function browser(name: string) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString("base64url");
  const sub = { endpoint: `${api}/push/${name}`, keys: { p256dh: ecdh.getPublicKey("base64url"), auth } };
  const device: PushDevice = { ...sub, label: name, added: 1 };
  const read = (body: Buffer) => JSON.parse(ece.decrypt(body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString());
  return { sub, device, read };
}

const req = (url: string, init: { method?: string; session?: string; body?: unknown; origin?: string } = {}) => {
  const headers = new Headers({ host: "market.example", "user-agent": ANDROID });
  if (init.session) headers.set("cookie", `hebi8m_session=${init.session}`);
  if (init.origin) headers.set("origin", init.origin);
  return new NextRequest(`${ORIGIN}${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HEBI8_VAULT = path.join(dir, "vault");
  process.env.HEBI8_DB = path.join(dir, "hebi8.db");
  process.env.HEBI8_SECRETS = secrets;
  process.env.HEBI8_PUBLIC_URL = ORIGIN;
  fs.mkdirSync(path.join(dir, "vault"));
  fs.writeFileSync(path.join(dir, "vault", "hebi8.yaml"), "owner: Owner\ngroups:\n  - { name: 加密, symbols: [binance:BTCUSDT] }\n");
  const { createSession } = await import("@/lib/secrets");
  const as = (login: string) => createSession({ login, avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
  sessions = { owner: as("owner"), alice: as("Alice"), bob: as("bob") };
});

afterAll(() => {
  server.close();
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  delete process.env.HEBI8_PUBLIC_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  fs.rmSync(usersFile, { force: true });
  fs.writeFileSync(path.join(secrets, "notify.json"), JSON.stringify({ telegram: { token: TOKEN, api }, link: ORIGIN }));
  for (const k of Object.keys(status)) delete status[k];
  pushed.length = 0;
  telegram.length = 0;
  hooks.length = 0;
});

// ---------------------------------------------------------------------------- keys and devices

describe("push devices", () => {
  it("are kept per lower-case login: the same endpoint replaces, removing the last drops the entry", async () => {
    const { addPushDevice, pushDeviceId, readNotifyUsers, removePushDevices, setUserChannel } = await import("@/lib/notify");
    const a = browser("a").device;
    const b = browser("b").device;
    setUserChannel("alice", "webhook", { url: "https://ntfy.sh/a", format: "text" });
    addPushDevice("Alice", a);
    addPushDevice("alice", b);
    addPushDevice("ALICE", { ...a, label: "again", added: 2 });
    expect(readNotifyUsers().alice.push?.map((d) => d.label)).toEqual(["b", "again"]);
    expect(fs.statSync(usersFile).mode & 0o777).toBe(0o600);

    removePushDevices("alice", [pushDeviceId(b.endpoint)]);
    expect(readNotifyUsers().alice.push?.map((d) => d.label)).toEqual(["again"]);
    removePushDevices("alice", [pushDeviceId(a.endpoint)]);
    expect(readNotifyUsers()).toEqual({ alice: { webhook: { url: "https://ntfy.sh/a", format: "text" } } });
  });

  it("belong to whoever turned push on last in that browser", async () => {
    const { addPushDevice, readNotifyUsers, setUserChannel } = await import("@/lib/notify");
    const shared = browser("shared").device;
    const own = browser("own").device;
    setUserChannel("bob", "telegram", { chat: "7" });
    addPushDevice("alice", shared);
    addPushDevice("alice", own);
    addPushDevice("bob", shared);
    addPushDevice("carol", own);
    expect(readNotifyUsers()).toEqual({ bob: { telegram: { chat: "7" }, push: [shared] }, carol: { push: [own] } });
  });

  it("go where the vault's alerts go: the root vault's under the owner, nobody else's", async () => {
    const { addPushDevice, channelNames, channelsFor } = await import("@/lib/notify");
    const a = browser("a").device;
    addPushDevice("owner", a);
    expect(channelsFor("", "Owner").config.push).toEqual({ login: "owner", devices: [a] });
    expect(channelNames(channelsFor("", "Owner").config)).toEqual(["push"]);
    expect(channelsFor("alice", "Owner").config.push).toBeUndefined();
  });

  it("are signed with VAPID keys made once, on first use, in the secrets dir", async () => {
    const { channelSummary } = await import("@/lib/notify");
    const vapid = path.join(secrets, "vapid.json");
    fs.rmSync(vapid, { force: true });
    const key = channelSummary("alice", "Owner").push.key;
    expect(fs.statSync(vapid).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(vapid, "utf8")).publicKey).toBe(key);
    expect(channelSummary("bob", "Owner").push.key).toBe(key);
  });
});

// ---------------------------------------------------------------------------- the route

describe("/api/notify/push", () => {
  it("adds the viewer's subscription, lists it by id and device name only, and removes it", async () => {
    const route = await import("@/app/api/notify/push/route");
    const { pushDeviceId, readNotifyUsers } = await import("@/lib/notify");
    const { sub } = browser("phone");

    expect((await route.PUT(req("/api/notify/push", { method: "PUT", body: sub }))).status).toBe(401);
    expect((await route.PUT(req("/api/notify/push", { method: "PUT", session: sessions.alice, body: sub, origin: "https://evil.example" }))).status).toBe(403);
    for (const body of [{}, { ...sub, endpoint: "not a url" }, { ...sub, keys: { auth: sub.keys.auth } }, { ...sub, keys: { ...sub.keys, auth: "a b" } }]) {
      expect((await route.PUT(req("/api/notify/push", { method: "PUT", session: sessions.alice, body }))).status).toBe(400);
    }
    // push services are https; the fake one here is not, so this one is refused too
    expect((await route.PUT(req("/api/notify/push", { method: "PUT", session: sessions.alice, body: sub }))).status).toBe(400);
    expect(readNotifyUsers()).toEqual({});

    vi.spyOn(resolver, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const https = { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/abc" };
    const res = await route.PUT(req("/api/notify/push", { method: "PUT", session: sessions.alice, body: https }));
    const id = pushDeviceId(https.endpoint);
    const summary = await res.json();
    expect(summary.push.devices).toEqual([{ id, label: "Chrome · Android", added: expect.any(Number) }]);
    expect(summary.push.publicUrl).toBe(ORIGIN);
    expect(JSON.stringify(summary)).not.toContain("fcm.googleapis.com");
    expect(readNotifyUsers().alice.push?.[0]).toMatchObject({ endpoint: https.endpoint, keys: sub.keys });

    // someone else's id does nothing to alice
    await route.DELETE(req(`/api/notify/push?id=${id}`, { method: "DELETE", session: sessions.bob }));
    expect(readNotifyUsers().alice.push).toHaveLength(1);
    const removed = await route.DELETE(req(`/api/notify/push?id=${id}`, { method: "DELETE", session: sessions.alice }));
    expect((await removed.json()).push.devices).toEqual([]);
    expect(readNotifyUsers()).toEqual({});
  });
});

// ---------------------------------------------------------------------------- delivery

const btc: AlertEvent = { rule: "r1", key: "binance:BTCUSDT", name: "比特币", label: "站上 100", tf: "D", close: 102 };
const eth: AlertEvent = { rule: "r2", key: "binance:ETHUSDT", name: "以太坊", label: "站上 5", tf: "W", close: 6 };

describe("delivery", () => {
  it("goes to push alongside Telegram and the webhook, with the same lines, opening the chart", async () => {
    const { addPushDevice, channelsFor, deliver, formatDigest, setUserChannel } = await import("@/lib/notify");
    const phone = browser("phone");
    const laptop = browser("laptop");
    setUserChannel("owner", "telegram", { chat: "42" });
    setUserChannel("owner", "webhook", { url: `${api}/hook`, format: "text" });
    addPushDevice("owner", phone.device);
    addPushDevice("owner", laptop.device);

    const { config } = channelsFor("", "Owner");
    const { title, text } = formatDigest([btc], config.link);
    expect(await deliver(config, title, text, [btc])).toEqual({ sent: ["telegram", "webhook", "push"], failed: [] });
    expect(telegram[0].text).toBe(text);
    expect(hooks).toEqual([text]);

    expect(pushed.map((p) => p.device).sort()).toEqual(["laptop", "phone"]);
    const got = pushed.find((p) => p.device === "phone")!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(phone.read(got.body)).toEqual({ title: "hebi8/market · 1 条新提醒", body: "• 比特币：站上 100（日线）  收 102.00", url: "/chart/binance%3ABTCUSDT" });
  });

  it("opens the overview for several symbols and drops the links from the text", async () => {
    const { formatDigest, pushPayload } = await import("@/lib/notify");
    const { title, text } = formatDigest([btc, eth], ORIGIN);
    expect(text).toContain(`${ORIGIN}/chart/`);
    expect(pushPayload(title, text, [btc, eth])).toEqual({ title, body: "• 比特币：站上 100（日线）  收 102.00\n• 以太坊：站上 5（周线）  收 6.000", url: "/" });
    expect(pushPayload(title, text, [btc, { ...btc, rule: "r3" }]).url).toBe("/chart/binance%3ABTCUSDT");
  });

  it("stays within a push message's 3993 bytes, cutting whole lines from the end and saying how many", async () => {
    const { formatDigest, pushPayload } = await import("@/lib/notify");
    const events = Array.from({ length: 50 }, (_, i): AlertEvent => ({ ...btc, rule: `r${i}`, key: `tv:SSE:6000${i}`, name: `上海浦东发展银行股份有限公司${i}`, label: `周线收盘站上二十周均线并且放量突破前高${i}` }));
    const { title, text } = formatDigest(events, ORIGIN);
    const payload = pushPayload(title, text, events);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(3993);
    const lines = payload.body.split("\n");
    const kept = lines.length - 1;
    expect(kept).toBeGreaterThan(10);
    expect(lines.at(-1)).toBe(`…还有 ${50 - kept} 条`);
    expect(lines[kept - 1]).toBe(`• ${events[kept - 1].name}：${events[kept - 1].label}（日线）  收 102.00`);
    // one line more would not have fitted
    expect(Buffer.byteLength(JSON.stringify({ ...payload, body: [...lines.slice(0, kept), `• ${events[kept].name}：${events[kept].label}（日线）  收 102.00`, `…还有 ${49 - kept} 条`].join("\n") }))).toBeGreaterThan(3993);
  });

  it("names the repo as the VAPID contact when the public address is not https", async () => {
    const { addPushDevice, channelsFor, deliver } = await import("@/lib/notify");
    const { REPO_URL } = await import("@/lib/app-info");
    const subject = () => JSON.parse(Buffer.from(/^vapid t=([^,]+),/.exec(String(pushed.at(-1)!.headers.authorization))![1].split(".")[1], "base64url").toString()).sub;
    addPushDevice("owner", browser("phone").device);
    expect((await deliver(channelsFor("", "Owner").config, "t", "t\n\nx", [btc])).sent).toEqual(["push"]);
    expect(subject()).toBe(ORIGIN);
    process.env.HEBI8_PUBLIC_URL = "http://localhost:3000";
    try {
      expect(await deliver(channelsFor("", "Owner").config, "t", "t\n\nx", [btc])).toEqual({ sent: ["push"], failed: [] });
      expect(subject()).toBe(REPO_URL);
    } finally {
      process.env.HEBI8_PUBLIC_URL = ORIGIN;
    }
  });

  it("removes a device the push service no longer knows; the channel counts as sent while one device got it", async () => {
    const { addPushDevice, channelsFor, deliver, readNotifyUsers } = await import("@/lib/notify");
    for (const name of ["kept", "gone", "missing"]) addPushDevice("owner", browser(name).device);
    status.gone = 410;
    status.missing = 404;
    expect(await deliver(channelsFor("", "Owner").config, "t", "t\n\nx", [btc])).toEqual({ sent: ["push"], failed: [] });
    expect(readNotifyUsers().owner.push?.map((d) => d.label)).toEqual(["kept"]);
  });

  it("fails push alone when no device got it: an error keeps the device, a gone one is removed", async () => {
    const { addPushDevice, channelNames, channelsFor, deliver, readNotifyUsers, setUserChannel } = await import("@/lib/notify");
    setUserChannel("owner", "webhook", { url: `${api}/hook`, format: "text" });
    addPushDevice("owner", browser("down").device);
    addPushDevice("owner", browser("gone").device);
    status.down = 500;
    status.gone = 410;
    const delivery = await deliver(channelsFor("", "Owner").config, "t", "t\n\nx", [btc]);
    expect(delivery.sent).toEqual(["webhook"]);
    expect(delivery.failed).toEqual([{ channel: "push", error: `${api.slice(7)} 500：push service says no；1 台设备的订阅已失效，已移除` }]);
    expect(readNotifyUsers().owner.push?.map((d) => d.label)).toEqual(["down"]);

    status.down = 410;
    expect((await deliver(channelsFor("", "Owner").config, "t", "t\n\nx", [btc])).failed[0].channel).toBe("push");
    expect(readNotifyUsers().owner.push).toBeUndefined();
    expect(channelNames(channelsFor("", "Owner").config)).toEqual(["webhook"]);
  });
});

describe("deviceLabel", () => {
  it("names the browser and the system", async () => {
    const { deviceLabel } = await import("@/lib/push");
    expect(deviceLabel(ANDROID)).toBe("Chrome · Android");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toBe("Safari · iPhone");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox · Windows");
    expect(deviceLabel("")).toBe("浏览器");
  });
});
