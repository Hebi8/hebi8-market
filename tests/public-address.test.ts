import crypto from "node:crypto";
import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, publicPost, requirePublicUrl } from "@/lib/public-address";

// Narrow the overload used by the address policy.
const resolver = dns as { lookup: (host: string, options: { all: true }) => Promise<LookupAddress[]> };

const ranges = [
  ["0.0.0.0", "0.255.255.255", null, "1.0.0.0"],
  ["10.0.0.0", "10.255.255.255", "9.255.255.255", "11.0.0.0"],
  ["100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0"],
  ["127.0.0.0", "127.255.255.255", "126.255.255.255", "128.0.0.0"],
  ["169.254.0.0", "169.254.255.255", "169.253.255.255", "169.255.0.0"],
  ["172.16.0.0", "172.31.255.255", "172.15.255.255", "172.32.0.0"],
  ["192.0.0.0", "192.0.0.255", "191.255.255.255", "192.0.1.0"],
  ["192.168.0.0", "192.168.255.255", "192.167.255.255", "192.169.0.0"],
  ["198.18.0.0", "198.19.255.255", "198.17.255.255", "198.20.0.0"],
  ["224.0.0.0", "255.255.255.255", "223.255.255.255", null],
] as const;

describe("public unicast addresses", () => {
  it.each(ranges)("checks both edges and neighbours of %s, including mapped IPv6", (start, end, before, after) => {
    for (const address of [start, end]) {
      expect(isPublicAddress(address)).toBe(false);
      expect(isPublicAddress(`::ffff:${address}`)).toBe(false);
    }
    for (const address of [before, after].filter((v) => v !== null)) {
      expect(isPublicAddress(address)).toBe(true);
      expect(isPublicAddress(`::ffff:${address}`)).toBe(true);
    }
  });
  it.each(["::", "::1", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "::ffff:7f00:1", "::ffff:c0a8:1", "", "example.com", "999.1.1.1"])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::2", "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::", "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fec0::", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "::ffff:808:808"])("accepts %s under the address policy", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-public-address-"));
const ORIGIN = "https://market.example";
const hits: { url: string; host: string; body: string }[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    hits.push({ url: req.url!, host: req.headers.host!, body });
    const status = Number(req.url!.slice(1)) || 200;
    res.writeHead(status, { location: "/target" });
    res.end("PRIVATE RESPONSE CONTENT");
  });
});
let port: number;
let sessions: Record<string, string>;
const keys = () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
};
const req = (channel: string, session: string, body: unknown) => new NextRequest(`${ORIGIN}/api/notify/${channel}`, {
  method: "PUT", headers: { host: "market.example", cookie: `hebi8m_session=${session}` }, body: JSON.stringify(body),
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  process.env.HEBI8_VAULT = path.join(dir, "vault");
  process.env.HEBI8_DB = path.join(dir, "cache.db");
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  fs.mkdirSync(process.env.HEBI8_VAULT);
  fs.writeFileSync(path.join(process.env.HEBI8_VAULT, "hebi8.yaml"), "owner: [Owner, SecondOwner]\ngroups: []\n");
  const { createSession } = await import("@/lib/secrets");
  sessions = Object.fromEntries(["Owner", "SecondOwner", "alice"].map((login) => [login, createSession({ login, avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null })]));
});
afterAll(() => {
  server.close();
  delete process.env.HEBI8_VAULT;
  delete process.env.HEBI8_DB;
  delete process.env.HEBI8_SECRETS;
  fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  hits.length = 0;
  fs.rmSync(path.join(dir, "secrets", "notify-users.json"), { force: true });
  vi.spyOn(resolver, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

describe("saving notification addresses", () => {
  it.each(["http://127.0.0.1/hook", "http://2130706433/hook", "http://[::1]/hook", "http://[::ffff:192.168.1.1]/hook", "https://100.64.0.1/hook"])("rejects a user's webhook %s before writing", async (url) => {
    const { PUT } = await import("@/app/api/notify/webhook/route");
    const res = await PUT(req("webhook", sessions.alice, { url }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "webhook 地址必须是公网地址" });
    expect(fs.existsSync(path.join(dir, "secrets", "notify-users.json"))).toBe(false);
    expect(dns.lookup).not.toHaveBeenCalled();
  });
  it.each(["webhook", "push"])("rejects any non-public DNS answer for %s and accepts all-public answers", async (channel) => {
    const route = channel === "webhook" ? await import("@/app/api/notify/webhook/route") : await import("@/app/api/notify/push/route");
    const body = channel === "webhook" ? { url: "https://notify.example/path" } : { endpoint: "https://notify.example/path", keys: keys() };
    vi.mocked(resolver.lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "fd00::1", family: 6 }]);
    const bad = await route.PUT(req(channel, sessions.alice, body));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("必须是公网地址");
    expect(dns.lookup).toHaveBeenCalledWith("notify.example", { all: true });
    vi.mocked(resolver.lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    const unresolved = await route.PUT(req(channel, sessions.alice, body));
    expect(unresolved.status).toBe(400);
    expect((await unresolved.json()).error).toContain("无法解析");
    vi.mocked(resolver.lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]);
    expect((await route.PUT(req(channel, sessions.alice, body))).status).toBe(200);
  });
  it("requires HTTPS and public IPs for push, and exempts both owners from the address restriction", async () => {
    const push = await import("@/app/api/notify/push/route");
    const webhook = await import("@/app/api/notify/webhook/route");
    for (const endpoint of ["https://127.0.0.1/push", "https://[::1]/push", "https://[::ffff:10.0.0.1]/push", "http://8.8.8.8/push"]) {
      expect((await push.PUT(req("push", sessions.alice, { endpoint, keys: keys() }))).status).toBe(400);
    }
    for (const session of [sessions.Owner, sessions.SecondOwner]) {
      expect((await webhook.PUT(req("webhook", session, { url: "http://127.0.0.1/topic" }))).status).toBe(200);
      expect((await push.PUT(req("push", session, { endpoint: "https://[::1]/push", keys: keys() }))).status).toBe(200);
    }
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});

/** Exercise the real HTTP transport locally, mapping only the checked answers to our test server. */
function localTransport(all: boolean) {
  const original = http.request;
  const checked: unknown[] = [];
  const optionsSeen: http.RequestOptions[] = [];
  const transport = (url: URL, options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
    optionsSeen.push(options);
    const lookup: LookupFunction = (host, _options, callback) => {
      options.lookup!(host, { all }, (error, address, family) => {
        if (error) return callback(error, "", 0);
        checked.push(address);
        if (all) callback(null, (address as { address: string; family: number }[]).map(() => ({ address: "127.0.0.1", family: 4 })));
        else callback(null, "127.0.0.1", family);
      });
    };
    return original({ ...options, hostname: url.hostname, port, path: url.pathname, lookup, family: all ? 0 : 4 }, cb);
  };
  vi.spyOn(http, "request").mockImplementation(transport as typeof http.request);
  vi.spyOn(https, "request").mockImplementation(transport as typeof https.request);
  return { checked, optionsSeen };
}

describe("delivery uses checked addresses", () => {
  it.each([false, true])("passes checked DNS results into the connection (all=%s)", async (all) => {
    const { checked, optionsSeen } = localTransport(all);
    expect(await publicPost("http://notify.example/200", { "content-type": "text/plain" }, "hello", AbortSignal.timeout(1000))).toBe(200);
    expect(checked).toEqual(all ? [[{ address: "8.8.8.8", family: 4 }]] : ["8.8.8.8"]);
    expect(optionsSeen[0].agent).toBe(false);
    expect(hits).toEqual([{ url: "/200", host: `notify.example:${port}`, body: "hello" }]);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(dns.lookup).toHaveBeenCalledWith("notify.example", { all: true });
  });
  it("refuses a changed or mixed DNS result after a successful save-time check", async () => {
    await requirePublicUrl("https://notify.example/path", "webhook 地址");
    vi.mocked(resolver.lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    localTransport(true);
    await expect(publicPost("https://notify.example/200", {}, "hello", AbortSignal.timeout(1000))).rejects.toThrow("必须是公网地址");
    expect(hits).toEqual([]);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });
  it.each(["127.0.0.1", "[::1]", "[::ffff:7f00:1]"])("checks literal %s before Node can skip lookup", async (host) => {
    localTransport(true);
    await expect(publicPost(`http://${host}/200`, {}, "hello", AbortSignal.timeout(1000))).rejects.toThrow("必须是公网地址");
    expect(http.request).not.toHaveBeenCalled();
    expect(hits).toEqual([]);
  });
  it.each([301, 302, 307, 308, 500])("treats %s as failure without following redirects or exposing the response body", async (status) => {
    localTransport(true);
    const { addPushDevice, channelsFor, deliver, setUserChannel } = await import("@/lib/notify");
    setUserChannel("alice", "webhook", { url: `http://notify.example/${status}`, format: "json" });
    addPushDevice("alice", { endpoint: `https://notify.example/${status}`, keys: keys(), label: "phone", added: 1 });
    const result = await deliver(channelsFor("alice", "Owner").config, "title", "text");
    expect(result).toEqual({ sent: [], failed: [{ channel: "webhook", error: `webhook ${status}` }, { channel: "push", error: `notify.example ${status}` }] });
    expect(hits.map((hit) => hit.url)).toEqual([`/${status}`, `/${status}`]);
    expect(JSON.parse(hits.find((hit) => hit.body.startsWith("{"))!.body)).toEqual({ title: "title", text: "text", events: [] });
  });
  it("sends ordinary users' public webhooks and encrypted push notifications", async () => {
    localTransport(true);
    const { addPushDevice, channelsFor, deliver, setUserChannel } = await import("@/lib/notify");
    setUserChannel("alice", "webhook", { url: "https://notify.example/201", format: "text" });
    addPushDevice("alice", { endpoint: "https://notify.example/201", keys: keys(), label: "phone", added: 1 });
    expect(await deliver(channelsFor("alice", "Owner").config, "title", "text")).toEqual({ sent: ["webhook", "push"], failed: [] });
    expect(hits).toHaveLength(2);
  });
  it("keeps owner and single-user fetch delivery and response-body errors", async () => {
    const { channelsFor, deliver, setUserChannel } = await import("@/lib/notify");
    const url = `http://127.0.0.1:${port}/500`;
    fs.writeFileSync(path.join(dir, "secrets", "notify.json"), JSON.stringify({ webhook: url }));
    try {
      for (const owner of [null, "Owner"]) {
        expect((await deliver(channelsFor("", owner).config, "t", "x")).failed).toEqual([{ channel: "webhook", error: "webhook 500：PRIVATE RESPONSE CONTENT" }]);
      }
      setUserChannel("owner", "webhook", { url, format: "text" });
      expect((await deliver(channelsFor("", "Owner").config, "t", "x")).failed[0].error).toContain("PRIVATE RESPONSE CONTENT");
      expect(hits).toHaveLength(3);
      expect(dns.lookup).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(path.join(dir, "secrets", "notify.json"));
    }
  });
});
