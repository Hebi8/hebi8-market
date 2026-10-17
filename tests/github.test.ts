import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackGET } from "@/app/api/github/callback/route";
import { POST as redeemPOST } from "@/app/api/github/claim/redeem/route";
import { DELETE as claimDELETE, POST as claimPOST } from "@/app/api/github/claim/route";
import { DELETE as deviceDELETE, POST as devicePOST } from "@/app/api/github/device/route";
import { POST as pollPOST } from "@/app/api/github/device/poll/route";
import { GET as issuesGET, POST as issuesPOST } from "@/app/api/github/issues/route";
import { GET as loginGET } from "@/app/api/github/login/route";
import { POST as logoutPOST } from "@/app/api/github/logout/route";
import { GITHUB_APP_CLIENT_ID, feedbackRepo, githubClientId } from "@/lib/app-info";
import { createClaim, dropClaims, peekClaim, resetClaims, takeClaim } from "@/lib/claim";
import { MAX_WEB_URL, TRUNCATED_NOTE, buildIssueBody, feedbackContext, parseFeedbackInput, parseIssueContext, reportablePage, webIssueUrl, type FeedbackContext, type PageInfo } from "@/lib/feedback";
import { GitHubError, LOGIN_COOKIE, SESSION_COOKIE, pollDeviceFlow, requestOrigin, resetGitHubCaches, safeNext, startDeviceFlow, userToken, webLoginClient } from "@/lib/github";
import { createSession, getSession, liveSessions, touchSession, writeJson } from "@/lib/secrets";
import { proxy } from "@/proxy";

const ORIGIN = "http://100.64.0.1:8809";
const CLIENT_ID = "Iv23_test";

const page: PageInfo = {
  app: { version: "0.1.0", commit: "abc1234", builtAt: null },
  page: "/chart/yahoo%3ASPY",
  chart: { symbol: "yahoo:SPY", tf: "W", style: "candle_solid", log: true, prices: "split", indicators: ["MA"], compares: [{ key: "yahoo:QQQ", mode: "percent" }] },
  viewport: { width: 1440, height: 900, dpr: 1 },
  colorScheme: "dark",
  fullscreen: false,
  userAgent: "test",
  errors: [{ t: "2026-10-06T00:00:00.000Z", kind: "error", message: "TypeError: x", source: "/_next/a.js:1:2" }],
  at: "2026-10-06T00:00:00.000Z",
};
const ctx: FeedbackContext = feedbackContext("data", true, page);

describe("issue body", () => {
  it("puts the description first, then the context block (with type and autoFix) in a details, then the footer", () => {
    const body = buildIssueBody("  周线不对  ", ctx);
    expect(body.startsWith('周线不对\n\n---\n\n<details><summary>页面信息</summary>\n\n```json hebi8-context\n{\n  "v": 1,\n  "type": "data",\n  "autoFix": true,')).toBe(true);
    expect(body.endsWith("```\n</details>\n\n<sub>来自 hebi8/market 应用内反馈</sub>\n")).toBe(true);
    expect(parseIssueContext(body)).toEqual(ctx);
  });

  it("keeps type and autoFix even without page info", () => {
    const body = buildIssueBody("", feedbackContext("bug", false, null));
    expect(body).toContain("<summary>反馈信息</summary>");
    expect(body.startsWith("（没有描述）")).toBe(true);
    expect(parseIssueContext(body)).toEqual({ v: 1, type: "bug", autoFix: false });
    expect(parseIssueContext(buildIssueBody("x", ctx, { compact: true }))).toEqual(ctx);
    expect(parseIssueContext("no block")).toBeNull();
    expect(parseIssueContext("```json hebi8-context\n{oops\n```")).toBeNull();
  });

  it("validates submissions and stamps type and autoFix from the form into the context", () => {
    expect(() => parseFeedbackInput({ type: "bug", title: "  " })).toThrow("标题不能为空");
    expect(() => parseFeedbackInput({ type: "nope", title: "x" })).toThrow("反馈类型不对");
    const input = parseFeedbackInput({ type: "ux", title: " 慢 ", description: "d", context: { ...ctx, type: "bug", autoFix: false }, autoFix: true });
    expect(input).toMatchObject({ type: "ux", title: "慢", autoFix: true });
    expect(input.context).toMatchObject({ v: 1, type: "ux", autoFix: true, page: "/chart/yahoo%3ASPY" });
    expect(parseFeedbackInput({ type: "idea", title: "x", context: null }).context).toEqual({ v: 1, type: "idea", autoFix: false });
    expect(() => parseFeedbackInput({ type: "idea", title: "x", context: { junk: "x".repeat(30000) } })).toThrow("太大");
  });
});

describe("reported page address", () => {
  const CODE = "FkjZSQzabJX3x0YaZeUavZuSGJI6c7HSwcaSClqIhTU";

  it("keeps the path and query, minus the drawer's own parameter and the login code of /claim", () => {
    expect(reportablePage("/chart/yahoo%3ASPY")).toBe("/chart/yahoo%3ASPY");
    expect(reportablePage("/chart/yahoo%3ASPY?tf=W&help=feedback")).toBe("/chart/yahoo%3ASPY?tf=W");
    expect(reportablePage(`/claim?c=${CODE}`)).toBe("/claim");
    expect(reportablePage(`/claim/?help=feedback&c=${CODE}&x=1`)).toBe("/claim/?x=1");
    // `c` means nothing anywhere else
    expect(reportablePage("/review?c=1")).toBe("/review?c=1");
  });

  it("the preview, the github.com form and the in-app body all come from a context without the code", () => {
    const context = feedbackContext("bug", false, { ...page, page: `/claim?c=${CODE}&help=feedback` });
    expect(context.page).toBe("/claim");
    expect(JSON.stringify(context)).not.toContain(CODE);
    expect(decodeURIComponent(webIssueUrl("Hebi8/hebi8-market", "登录页有问题", "按钮点不了", context))).not.toContain(CODE);
    expect(buildIssueBody("按钮点不了", context)).not.toContain(CODE);
  });

  it("the server drops the code from whatever context a client submits", () => {
    const input = parseFeedbackInput({ type: "bug", title: "x", context: { v: 1, type: "bug", autoFix: false, page: `/claim?c=${CODE}`, userAgent: "old tab" } });
    expect(input.context).toMatchObject({ page: "/claim", userAgent: "old tab" });
    expect(buildIssueBody("", input.context)).not.toContain(CODE);
  });
});

describe("github.com fallback link", () => {
  const params = (url: string) => new URL(url).searchParams;

  it("prefills title and the same body as the in-app issue", () => {
    const url = webIssueUrl("Hebi8/hebi8-market", "图表空白", "打开就空", ctx);
    expect(url.startsWith("https://github.com/Hebi8/hebi8-market/issues/new?")).toBe(true);
    expect(params(url).get("title")).toBe("图表空白");
    expect(params(url).get("body")).toBe(buildIssueBody("打开就空", ctx));
  });

  it("shrinks the context before it touches the description, and stays under the limit", () => {
    const many = feedbackContext("bug", false, { ...page, errors: Array.from({ length: 10 }, (_, i) => ({ t: "t", kind: "error" as const, message: `E${i} `.repeat(250) })) });
    const url = webIssueUrl("o/r", "t", "说明", many);
    expect(url.length).toBeLessThanOrEqual(MAX_WEB_URL);
    const back = parseIssueContext(params(url).get("body")!)!;
    expect(back).toMatchObject({ v: 1, type: "bug", autoFix: false, page: page.page });
    expect(back.errors).toBeUndefined();
    expect(params(url).get("body")!.startsWith("说明")).toBe(true);
  });

  it("truncates a huge description last, keeping type and autoFix", () => {
    const long = "很长的描述".repeat(2000);
    const url = webIssueUrl("o/r", "t", long, ctx);
    expect(url.length).toBeLessThanOrEqual(MAX_WEB_URL);
    expect(url.length).toBeGreaterThan(MAX_WEB_URL - 200);
    const body = params(url).get("body")!;
    expect(body).toContain(TRUNCATED_NOTE.trim());
    expect(parseIssueContext(body)).toEqual({ v: 1, type: "data", autoFix: true });
  });
});

describe("configuration", () => {
  afterEach(() => {
    delete process.env.HEBI8_GITHUB_CLIENT_ID;
    delete process.env.HEBI8_FEEDBACK_REPO;
  });

  it("defaults to the upstream repo and no client id; env overrides when well-formed", () => {
    delete process.env.HEBI8_GITHUB_CLIENT_ID;
    expect(feedbackRepo()).toBe("Hebi8/hebi8-market");
    expect(githubClientId()).toBe(GITHUB_APP_CLIENT_ID);
    process.env.HEBI8_GITHUB_CLIENT_ID = " Iv23_fork ";
    process.env.HEBI8_FEEDBACK_REPO = "someone/hebi8-fork";
    expect(githubClientId()).toBe("Iv23_fork");
    expect(feedbackRepo()).toBe("someone/hebi8-fork");
    process.env.HEBI8_FEEDBACK_REPO = "../../evil";
    expect(feedbackRepo()).toBe("Hebi8/hebi8-market");
    process.env.HEBI8_GITHUB_CLIENT_ID = "off";
    expect(githubClientId()).toBe("");
  });

  it("ships a well-formed client id for the upstream App", () => {
    expect(GITHUB_APP_CLIENT_ID).toMatch(/^Iv[0-9A-Za-z]+$/);
  });

  it("derives the origin from Host and X-Forwarded-Proto", () => {
    expect(requestOrigin(new Headers({ host: "100.64.0.1:8809" }))).toBe(ORIGIN);
    expect(requestOrigin(new Headers({ host: "a.ts.net", "x-forwarded-proto": "https" }))).toBe("https://a.ts.net");
    expect(() => requestOrigin(new Headers({ host: "evil/<x>" }))).toThrow();
  });
});

// ---------------------------------------------------------------------------- a fake GitHub

type Handler = (url: URL, body: Record<string, string> | unknown) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let routes: Record<string, Handler>;
let calls: { method: string; url: string; auth?: string; body?: unknown }[];
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-secrets-"));
  process.env.HEBI8_SECRETS = path.join(dir, "secrets");
  process.env.HEBI8_GITHUB_CLIENT_ID = CLIENT_ID;
  resetGitHubCaches();
  resetClaims();
  routes = {};
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const raw = init.body ? String(init.body) : undefined;
    const body = raw === undefined ? undefined : headers.get("content-type")?.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    calls.push({ method, url: url.toString(), auth: headers.get("authorization") ?? undefined, body });
    const handler = routes[`${method} ${url.origin}${url.pathname}`];
    if (!handler) return json({ message: "Not Found" }, 404);
    return handler(url, body);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HEBI8_SECRETS;
  delete process.env.HEBI8_GITHUB_CLIENT_ID;
  delete process.env.HEBI8_PUBLIC_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (url: string, init: { method?: string; cookies?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) => {
  const headers = new Headers({ host: "100.64.0.1:8809", ...init.headers });
  if (init.cookies) headers.set("cookie", Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  return new NextRequest(`${ORIGIN}${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
};

const DEVICE_CODE = "https://github.com/login/device/code";
const TOKEN = "https://github.com/login/oauth/access_token";

function deviceCode(reply: Record<string, unknown> = {}) {
  routes[`POST ${DEVICE_CODE}`] = () => json({ device_code: "dc_secret", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5, ...reply });
}

const tokenReplies = (...replies: Record<string, unknown>[]) => {
  let i = 0;
  routes[`POST ${TOKEN}`] = () => json(replies[Math.min(i++, replies.length - 1)]);
};

const T0 = 1_800_000_000_000;

describe("device flow", () => {
  it("start asks GitHub with the client id only and keeps the device code on the server", async () => {
    deviceCode();
    const start = await startDeviceFlow(CLIENT_ID, T0);
    expect(start).toEqual({ flowId: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/), user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    expect(JSON.stringify(start)).not.toContain("dc_secret");
    expect(calls).toEqual([{ method: "POST", url: DEVICE_CODE, auth: undefined, body: { client_id: CLIENT_ID } }]);
  });

  it("never sends people anywhere but github.com", async () => {
    deviceCode({ verification_uri: "https://evil.example/login" });
    expect((await startDeviceFlow(CLIENT_ID, T0)).verification_uri).toBe("https://github.com/login/device");
  });

  it("maps a disabled device flow", async () => {
    routes[`POST ${DEVICE_CODE}`] = () => json({ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" }, 400);
    await expect(startDeviceFlow(CLIENT_ID, T0)).rejects.toThrow("Enable Device Flow");
  });

  it("an unknown client id: the person is told to ask whoever runs the instance, the log says which setting to check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const shown = "GitHub 不认识这个应用，请联系部署的人检查登录配置";
    for (const reply of [() => json({ error: "Not Found" }, 404), () => json({ error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." })]) {
      warn.mockClear();
      routes[`POST ${DEVICE_CODE}`] = reply;
      const err = await startDeviceFlow(CLIENT_ID, T0).catch((e) => e);
      expect(err).toBeInstanceOf(GitHubError);
      // nothing about files or environment variables in what the drawer shows
      expect(err.message).toBe(shown);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^\[hebi8m\] github: GitHub 不认识 client id：检查 app-info\.ts 的 GITHUB_APP_CLIENT_ID 或 HEBI8_GITHUB_CLIENT_ID；网页登录检查 github-oauth\.json/);
    }
    warn.mockRestore();
  });

  it("polls at most once per interval, waits on authorization_pending and adds 5 s on slow_down", async () => {
    deviceCode();
    const { flowId } = await startDeviceFlow(CLIENT_ID, T0);
    tokenReplies({ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { error: "authorization_pending" });

    // too early: no request to GitHub at all
    expect(await pollDeviceFlow(flowId, T0 + 1000)).toEqual({ status: "pending", interval: 5 });
    expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(0);

    expect(await pollDeviceFlow(flowId, T0 + 5000)).toEqual({ status: "pending", interval: 5 });
    const poll = calls.find((c) => c.url === TOKEN)!;
    expect(poll.body).toEqual({ client_id: CLIENT_ID, device_code: "dc_secret", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    expect(poll.body).not.toHaveProperty("client_secret");

    expect(await pollDeviceFlow(flowId, T0 + 10_000)).toEqual({ status: "pending", interval: 10, slowDown: true });
    // the new interval holds: 9 s later is still too early
    expect(await pollDeviceFlow(flowId, T0 + 19_000)).toEqual({ status: "pending", interval: 10 });
    expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(2);
    await pollDeviceFlow(flowId, T0 + 20_000);
    expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(3);
  });

  it("slow_down without an interval in the reply still adds 5 s", async () => {
    deviceCode();
    const { flowId } = await startDeviceFlow(CLIENT_ID, T0);
    tokenReplies({ error: "slow_down" });
    expect(await pollDeviceFlow(flowId, T0 + 5000)).toEqual({ status: "pending", interval: 10, slowDown: true });
  });

  it("ends on expired_token, access_denied, its own expiry and unknown flow ids", async () => {
    deviceCode();
    const a = await startDeviceFlow(CLIENT_ID, T0);
    tokenReplies({ error: "expired_token" });
    expect(await pollDeviceFlow(a.flowId, T0 + 5000)).toEqual({ status: "expired" });
    expect(await pollDeviceFlow(a.flowId, T0 + 20_000)).toEqual({ status: "expired" });

    const b = await startDeviceFlow(CLIENT_ID, T0);
    tokenReplies({ error: "access_denied" });
    expect(await pollDeviceFlow(b.flowId, T0 + 5000)).toEqual({ status: "denied" });

    const c = await startDeviceFlow(CLIENT_ID, T0);
    const before = calls.length;
    expect(await pollDeviceFlow(c.flowId, T0 + 901_000)).toEqual({ status: "expired" });
    expect(calls).toHaveLength(before);
    expect(await pollDeviceFlow("nope", T0)).toEqual({ status: "expired" });
  });

  it("poll route: success looks up the user, writes the session (mode 600) and sets a 30-day HttpOnly cookie", async () => {
    deviceCode();
    const start = await devicePOST(req("/api/github/device", { method: "POST", headers: { origin: ORIGIN } }));
    const { flowId, user_code } = await start.json();
    expect(user_code).toBe("WDJB-MJHT");
    tokenReplies({ access_token: "ghu_a", expires_in: 28800, refresh_token: "ghr_r", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" });
    routes["GET https://api.github.com/user"] = () => json({ login: "someone", avatar_url: "https://avatars.githubusercontent.com/u/1" });

    // the route enforces the interval with the real clock: pretend 5 s have passed
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
    const res = await pollPOST(req("/api/github/device/poll", { method: "POST", body: { flowId }, headers: { origin: ORIGIN } }));
    vi.restoreAllMocks();
    expect(await res.json()).toEqual({ status: "done", user: { login: "someone", avatarUrl: "https://avatars.githubusercontent.com/u/1" } });
    expect(calls.find((c) => c.url === "https://api.github.com/user")!.auth).toBe("Bearer ghu_a");

    const cookie = res.cookies.get(SESSION_COOKIE)!;
    expect(cookie.maxAge).toBe(30 * 86400);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(getSession(cookie.value)).toMatchObject({ login: "someone", access_token: "ghu_a", refresh_token: "ghr_r" });
    const file = path.join(process.env.HEBI8_SECRETS!, "sessions.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(process.env.HEBI8_SECRETS!).mode & 0o777).toBe(0o700);
  });

  it("start route: 409 without a client id, 403 cross-site; cancel forgets the flow", async () => {
    process.env.HEBI8_GITHUB_CLIENT_ID = "off";
    expect((await devicePOST(req("/api/github/device", { method: "POST" }))).status).toBe(409);
    process.env.HEBI8_GITHUB_CLIENT_ID = CLIENT_ID;
    expect((await devicePOST(req("/api/github/device", { method: "POST", headers: { origin: "http://evil.example" } }))).status).toBe(403);

    deviceCode();
    const { flowId } = await (await devicePOST(req("/api/github/device", { method: "POST" }))).json();
    await deviceDELETE(req("/api/github/device", { method: "DELETE", body: { flowId } }));
    const res = await pollPOST(req("/api/github/device/poll", { method: "POST", body: { flowId } }));
    expect(await res.json()).toEqual({ status: "expired" });
  });
});

// ---------------------------------------------------------------------------- web login

const WEB_ORIGIN = "https://m.example";
const WEB_ID = "Ov23_web";
const WEB_SECRET = "s3cret_never_shown";
const AUTHORIZE = "https://github.com/login/oauth/authorize";

/** `github-oauth.json` as the instance's owner writes it. */
function oauthFile(extra: Record<string, unknown> = {}) {
  fs.mkdirSync(process.env.HEBI8_SECRETS!, { recursive: true });
  fs.writeFileSync(path.join(process.env.HEBI8_SECRETS!, "github-oauth.json"), JSON.stringify({ client_id: WEB_ID, client_secret: WEB_SECRET, ...extra }));
}

/** A request through the tunnel to the public host. */
const webReq = (url: string, cookies?: Record<string, string>) => req(url, { cookies, headers: { host: "m.example", "x-forwarded-proto": "https" } });

describe("web login", () => {
  beforeEach(() => {
    process.env.HEBI8_PUBLIC_URL = WEB_ORIGIN;
  });

  it("returns only to a path on this site", () => {
    expect(safeNext("/chart/yahoo%3ASPY?tf=W&help=feedback")).toBe("/chart/yahoo%3ASPY?tf=W&help=feedback");
    for (const bad of [null, "", "review", "https://evil.example/", "//evil.example", "/\\evil.example", "/a\\b", "/\t/evil.example", "/..//evil.example", "/%2e%2e//evil.example", `/${"x".repeat(1000)}`]) {
      expect(safeNext(bad)).toBe("/");
    }
  });

  it("is offered only with an id and a secret, and only on the origins whose callback is registered", () => {
    const pub = new Headers({ host: "m.example", "x-forwarded-proto": "https" });
    const tailnet = new Headers({ host: "100.64.0.1:8809" });
    expect(webLoginClient(pub)).toBeNull();
    oauthFile({ client_secret: "" });
    expect(webLoginClient(pub)).toBeNull();

    // no `origins`: the public address
    oauthFile();
    expect(webLoginClient(pub)).toEqual({ clientId: WEB_ID, clientSecret: WEB_SECRET, scope: "", origins: [WEB_ORIGIN] });
    expect(webLoginClient(tailnet)).toBeNull();
    expect(webLoginClient(new Headers({ host: "m.example" }))).toBeNull();

    // the file is read on every use
    oauthFile({ scope: "public_repo", origins: [`${ORIGIN}/`] });
    expect(webLoginClient(tailnet)).toMatchObject({ scope: "public_repo", origins: [ORIGIN] });
    expect(webLoginClient(pub)).toBeNull();

    process.env.HEBI8_GITHUB_CLIENT_ID = "off";
    expect(webLoginClient(tailnet)).toBeNull();
  });

  it("login route: off to github.com with state and a PKCE challenge, both kept in a 10-minute HttpOnly cookie with the page to return to", async () => {
    oauthFile();
    const res = await loginGET(webReq("/api/github/login?next=%2Fchart%2Fyahoo%253ASPY%3Ftf%3DW"));
    expect(res.status).toBe(302);
    const cookie = res.cookies.get(LOGIN_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, maxAge: 600, path: "/" });
    const pending = JSON.parse(cookie.value);
    expect(pending).toEqual({ state: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/), verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,}$/), next: "/chart/yahoo%3ASPY?tf=W" });

    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(AUTHORIZE);
    expect(Object.fromEntries(to.searchParams)).toEqual({
      client_id: WEB_ID,
      redirect_uri: `${WEB_ORIGIN}/api/github/callback`,
      state: pending.state,
      scope: "",
      code_challenge: crypto.createHash("sha256").update(pending.verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    expect(res.headers.get("location")).not.toContain(WEB_SECRET);
    expect(calls).toHaveLength(0);

    // somewhere else is not a place to return to
    const evil = await loginGET(webReq("/api/github/login?next=%2F%2Fevil.example"));
    expect(JSON.parse(evil.cookies.get(LOGIN_COOKIE)!.value).next).toBe("/");
  });

  it("login route: an origin without the web login never leaves for github.com", async () => {
    oauthFile();
    const res = await loginGET(req("/api/github/login?next=%2Freview"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/review?login=unavailable");
    expect(res.cookies.get(LOGIN_COOKIE)).toBeUndefined();
  });

  /** Start a login and hand back what the browser now holds. */
  async function started(next = "/chart/yahoo%3ASPY?tf=W") {
    const res = await loginGET(webReq(`/api/github/login?next=${encodeURIComponent(next)}`));
    const value = res.cookies.get(LOGIN_COOKIE)!.value;
    return { cookies: { [LOGIN_COOKIE]: encodeURIComponent(value) }, ...(JSON.parse(value) as { state: string; verifier: string }) };
  }

  it("callback: trades the code with the secret and the verifier, opens a session that remembers its client, and returns to the page", async () => {
    oauthFile();
    const { cookies, state, verifier } = await started();
    tokenReplies({ access_token: "gho_web", token_type: "bearer", scope: "" });
    routes["GET https://api.github.com/user"] = () => json({ login: "someone", avatar_url: "https://avatars.githubusercontent.com/u/1" });

    const res = await callbackGET(webReq(`/api/github/callback?code=c0de&state=${state}`, cookies));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/chart/yahoo%3ASPY?tf=W&login=ok");
    expect(calls[0]).toEqual({
      method: "POST",
      url: TOKEN,
      auth: undefined,
      body: { client_id: WEB_ID, client_secret: WEB_SECRET, code: "c0de", redirect_uri: `${WEB_ORIGIN}/api/github/callback`, code_verifier: verifier },
    });
    expect(calls[1]).toMatchObject({ url: "https://api.github.com/user", auth: "Bearer gho_web" });

    const cookie = res.cookies.get(SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, maxAge: 30 * 86400 });
    // an OAuth App's token has no expiry and no refresh token
    expect(getSession(cookie.value)).toMatchObject({ login: "someone", access_token: "gho_web", access_expires_at: null, refresh_token: null, web_client: WEB_ID });
    expect(res.cookies.get(LOGIN_COOKIE)).toMatchObject({ value: "", expires: new Date(0) });
  });

  it("callback: a state that is not this browser's goes no further", async () => {
    oauthFile();
    const { cookies } = await started();
    const res = await callbackGET(webReq("/api/github/callback?code=c0de&state=someone-elses", cookies));
    expect(res.headers.get("location")).toBe("/chart/yahoo%3ASPY?tf=W&login=state");
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.cookies.get(LOGIN_COOKIE)).toMatchObject({ value: "", expires: new Date(0) });

    // no cookie at all (the ten minutes ran out, or the link was opened in another browser)
    const none = await callbackGET(webReq("/api/github/callback?code=c0de&state=x"));
    expect(none.headers.get("location")).toBe("/?login=state");
    expect(calls).toHaveLength(0);
  });

  it("callback: 拒绝 on github.com and a failed exchange come back with the reason and no session", async () => {
    oauthFile();
    let { cookies, state } = await started("/review");
    const denied = await callbackGET(webReq(`/api/github/callback?error=access_denied&error_description=x&state=${state}`, cookies));
    expect(denied.headers.get("location")).toBe("/review?login=denied");
    expect(calls).toHaveLength(0);

    ({ cookies, state } = await started("/review"));
    tokenReplies({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = await callbackGET(webReq(`/api/github/callback?code=old&state=${state}`, cookies));
    expect(failed.headers.get("location")).toBe("/review?login=failed");
    expect(failed.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toContain("授权码无效或已过期");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(WEB_SECRET);

    // a callback address GitHub does not have: what to check is in the log, never the secret
    ({ cookies, state } = await started("/review"));
    warn.mockClear();
    tokenReplies({ error: "redirect_uri_mismatch", error_description: "The redirect_uri MUST match the registered callback URL for this application." });
    const mismatch = await callbackGET(webReq(`/api/github/callback?code=c0de&state=${state}`, cookies));
    expect(mismatch.headers.get("location")).toBe("/review?login=failed");
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("[hebi8m] github: 回调地址和 GitHub 上登记的不一致：检查 github-oauth.json 的 origins 和 App 的 Callback URL");
    expect(logged).not.toContain(WEB_SECRET);
    warn.mockRestore();
  });
});

describe("user token refresh", () => {
  it("refreshes a nearly expired token with the client id alone and stores the new pair", async () => {
    const id = createSession({ login: "u", avatar_url: "", access_token: "old", access_expires_at: Date.now() + 60_000, refresh_token: "ghr_1", refresh_expires_at: Date.now() + 86400_000 });
    tokenReplies({ access_token: "new", expires_in: 28800, refresh_token: "ghr_2", refresh_token_expires_in: 15897600 });
    const { token } = await userToken(CLIENT_ID, id);
    expect(token).toBe("new");
    expect(calls[0].body).toEqual({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "ghr_1" });
    expect(getSession(id)).toMatchObject({ access_token: "new", refresh_token: "ghr_2" });
  });

  it("a web login's tokens refresh with its client and the secret; a replaced client cannot renew them", async () => {
    oauthFile();
    const id = createSession({ login: "u", avatar_url: "", access_token: "old", access_expires_at: Date.now() + 60_000, refresh_token: "ghr_1", refresh_expires_at: Date.now() + 86400_000, web_client: WEB_ID });
    tokenReplies({ access_token: "new", expires_in: 28800, refresh_token: "ghr_2", refresh_token_expires_in: 15897600 });
    expect((await userToken(CLIENT_ID, id)).token).toBe("new");
    expect(calls[0].body).toEqual({ client_id: WEB_ID, client_secret: WEB_SECRET, grant_type: "refresh_token", refresh_token: "ghr_1" });
    expect(getSession(id)).toMatchObject({ access_token: "new", refresh_token: "ghr_2", web_client: WEB_ID });

    const other = createSession({ login: "u", avatar_url: "", access_token: "old", access_expires_at: Date.now() - 1000, refresh_token: "ghr_1", refresh_expires_at: null, web_client: "Ov23_gone" });
    const err = await userToken(CLIENT_ID, other).catch((e) => e);
    expect(err.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("requests that find the token expired together renew it once, and the login stays", async () => {
    const id = createSession({ login: "u", avatar_url: "", access_token: "old", access_expires_at: Date.now() - 1000, refresh_token: "ghr_1", refresh_expires_at: Date.now() + 86400_000 });
    // GitHub takes a refresh token once: a second renewal with `ghr_1` is refused
    tokenReplies({ access_token: "new", expires_in: 28800, refresh_token: "ghr_2", refresh_token_expires_in: 15897600 }, { error: "bad_refresh_token" });
    routes["POST https://api.github.com/repos/Hebi8/hebi8-market/issues"] = () => json({ number: 1, html_url: "u", title: "t" }, 201);
    const submit = () => issuesPOST(req("/api/github/issues", { method: "POST", cookies: { [SESSION_COOKIE]: id }, body: { type: "bug", title: "x" }, headers: { origin: ORIGIN } }));
    const [a, b] = await Promise.all([submit(), submit()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/issues")).map((c) => c.auth)).toEqual(["Bearer new", "Bearer new"]);
    expect(getSession(id)).toMatchObject({ access_token: "new", refresh_token: "ghr_2" });

    // the next expiry renews again, with the new refresh token
    writeJson("sessions.json", { [id]: { ...getSession(id)!, access_expires_at: Date.now() - 1000 } });
    tokenReplies({ access_token: "newer", expires_in: 28800, refresh_token: "ghr_3", refresh_token_expires_in: 15897600 });
    expect((await userToken(CLIENT_ID, id)).token).toBe("newer");
    expect(calls.filter((c) => c.url === TOKEN).map((c) => (c.body as { refresh_token: string }).refresh_token)).toEqual(["ghr_1", "ghr_2"]);
  });

  it("keeps a token that is not close to expiry", async () => {
    const id = createSession({ login: "u", avatar_url: "", access_token: "fresh", access_expires_at: Date.now() + 3600_000, refresh_token: "ghr_1", refresh_expires_at: null });
    expect((await userToken(CLIENT_ID, id)).token).toBe("fresh");
    expect(calls).toHaveLength(0);
  });

  it("a failed refresh means logging in again (401)", async () => {
    const id = createSession({ login: "u", avatar_url: "", access_token: "old", access_expires_at: Date.now() - 1000, refresh_token: "ghr_1", refresh_expires_at: Date.now() + 86400_000 });
    tokenReplies({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
    const err = await userToken(CLIENT_ID, id).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(401);
  });

  it("logout forgets the session", async () => {
    const id = createSession({ login: "u", avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
    const res = await logoutPOST(req("/api/github/logout", { method: "POST", cookies: { [SESSION_COOKIE]: id } }));
    expect(res.status).toBe(200);
    expect(getSession(id)).toBeNull();
  });
});

describe("sessions", () => {
  const DAY = 86400_000;
  const tokens = { access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null };
  const seenAt = (id: string) => getSession(id)!.seen_at;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("last 30 days from their last use, stamped at most once a day", () => {
    vi.useFakeTimers({ now: T0 });
    const id = createSession({ login: "u", avatar_url: "", ...tokens });
    expect(getSession(id)).toMatchObject({ created_at: T0, seen_at: T0 });

    // within a day nothing is written
    const file = path.join(process.env.HEBI8_SECRETS!, "sessions.json");
    const before = fs.readFileSync(file, "utf8");
    expect(touchSession(id, T0 + DAY - 1)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);

    expect(touchSession(id, T0 + 20 * DAY)).toBe(true);
    expect(seenAt(id)).toBe(T0 + 20 * DAY);
    expect(touchSession(id, T0 + 20 * DAY + 1000)).toBe(false);

    // 45 days after the login it still stands, 30 days after the last use it does not
    vi.setSystemTime(T0 + 45 * DAY);
    expect(getSession(id)).not.toBeNull();
    expect(Object.keys(liveSessions())).toEqual([id]);
    vi.setSystemTime(T0 + 50 * DAY + 1);
    expect(getSession(id)).toBeNull();
    expect(liveSessions()).toEqual({});
    expect(touchSession(id)).toBe(false);
    expect(touchSession("no-such-session-id-0123456789")).toBe(false);
    expect(touchSession(undefined)).toBe(false);
  });

  it("from before `seen_at` existed go by `created_at`", () => {
    vi.useFakeTimers({ now: T0 });
    const old = "old-session-id-0123456789-abcdefghijklmnop";
    const gone = "gone-session-id-0123456789-abcdefghijklmno";
    writeJson("sessions.json", {
      [old]: { login: "u", avatar_url: "", ...tokens, created_at: T0 - 29 * DAY },
      [gone]: { login: "v", avatar_url: "", ...tokens, created_at: T0 - 31 * DAY },
    });
    expect(getSession(gone)).toBeNull();
    expect(getSession(old)).toMatchObject({ login: "u" });
    expect(touchSession(old)).toBe(true);
    expect(seenAt(old)).toBe(T0);
    // the write dropped the dead one
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.HEBI8_SECRETS!, "sessions.json"), "utf8")))).toEqual([old]);
  });

  it("do not end with their GitHub tokens: only in-app feedback needs those", async () => {
    const id = createSession({ login: "u", avatar_url: "", access_token: "old", access_expires_at: Date.now() - 2 * DAY, refresh_token: "ghr_1", refresh_expires_at: Date.now() - DAY });
    expect(getSession(id)).toMatchObject({ login: "u" });
    expect(Object.keys(liveSessions())).toEqual([id]);
    const err = await userToken(CLIENT_ID, id).catch((e) => e);
    expect(err.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("proxy: a session in use gets its cookie for another 30 days once a day; nothing is read without a cookie", () => {
    vi.useFakeTimers({ now: T0 });
    const id = createSession({ login: "u", avatar_url: "", ...tokens });
    const page = (cookies?: Record<string, string>, url = "/") => req(url, { cookies, headers: { "x-forwarded-proto": "https" } });
    expect(proxy(page({ [SESSION_COOKIE]: id }))).toBeUndefined();

    vi.setSystemTime(T0 + 3 * DAY);
    // the routes that set or clear the cookie themselves are left alone
    expect(proxy(page({ [SESSION_COOKIE]: id }, "/api/github/logout"))).toBeUndefined();
    const res = proxy(page({ [SESSION_COOKIE]: id }))!;
    expect(res.cookies.get(SESSION_COOKIE)).toMatchObject({ value: id, maxAge: 30 * 86400, httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(seenAt(id)).toBe(T0 + 3 * DAY);
    expect(proxy(page({ [SESSION_COOKIE]: id }))).toBeUndefined();

    expect(proxy(page({ [SESSION_COOKIE]: "made-up-session-id-0123456789" }))).toBeUndefined();
    const read = vi.spyOn(fs, "readFileSync");
    expect(proxy(page())).toBeUndefined();
    expect(read.mock.calls.filter(([file]) => String(file).endsWith("sessions.json"))).toHaveLength(0);
    read.mockRestore();
  });
});

describe("login on another device", () => {
  const alice = { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/1" };
  const loggedIn = () => createSession({ login: "alice", avatar_url: alice.avatarUrl, access_token: "ghu_alice", access_expires_at: Date.now() + 3600_000, refresh_token: "ghr_alice", refresh_expires_at: null });
  const redeem = (code: string, init: { cookies?: Record<string, string>; origin?: string } = {}) => {
    const headers = new Headers({ host: "100.64.0.1:8809", origin: init.origin ?? ORIGIN, "content-type": "application/x-www-form-urlencoded" });
    if (init.cookies) headers.set("cookie", Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
    return redeemPOST(new NextRequest(`${ORIGIN}/api/github/claim/redeem`, { method: "POST", headers, body: new URLSearchParams({ c: code }).toString() }));
  };

  it("a code shows whose it is without being used, works once, and lasts two minutes", () => {
    const code = createClaim(alice, T0)!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(peekClaim(code, T0 + 1000)).toMatchObject(alice);
    expect(peekClaim(code, T0 + 119_000)).toMatchObject(alice);
    expect(takeClaim(code, T0 + 119_000)).toMatchObject(alice);
    expect(peekClaim(code, T0 + 119_000)).toBeNull();
    expect(takeClaim(code, T0 + 119_000)).toBeNull();

    const late = createClaim(alice, T0)!;
    expect(peekClaim(late, T0 + 120_000)).toBeNull();
    expect(takeClaim(late, T0 + 120_000)).toBeNull();
    expect(peekClaim(undefined)).toBeNull();
    expect(peekClaim("nope")).toBeNull();
  });

  it("a person has one code at a time, and only so many wait at once", () => {
    const first = createClaim(alice, T0)!;
    const second = createClaim(alice, T0 + 1000)!;
    expect(peekClaim(first, T0 + 1000)).toBeNull();
    expect(peekClaim(second, T0 + 1000)).not.toBeNull();
    dropClaims("alice");
    expect(peekClaim(second, T0 + 1000)).toBeNull();

    for (let i = 0; i < 20; i++) expect(createClaim({ login: `u${i}`, avatarUrl: "" }, T0)).not.toBeNull();
    expect(createClaim(alice, T0)).toBeNull();
    // expired ones make room
    expect(createClaim(alice, T0 + 120_000)).not.toBeNull();
  });

  it("claim route: only for someone logged in, from this site; the link goes to this origin's /claim with a QR drawn here", async () => {
    expect((await claimPOST(req("/api/github/claim", { method: "POST" }))).status).toBe(401);
    const id = loggedIn();
    expect((await claimPOST(req("/api/github/claim", { method: "POST", cookies: { [SESSION_COOKIE]: id }, headers: { origin: "http://evil.example" } }))).status).toBe(403);

    const res = await claimPOST(req("/api/github/claim", { method: "POST", cookies: { [SESSION_COOKIE]: id }, headers: { origin: ORIGIN } }));
    const body = await res.json();
    expect(body).toEqual({ url: expect.stringMatching(new RegExp(`^${ORIGIN}/claim\\?c=[A-Za-z0-9_-]{43}$`)), qr: expect.stringMatching(/^<svg [^]*<\/svg>$/), expires_in: 120 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const code = new URL(body.url).searchParams.get("c")!;
    expect(peekClaim(code)).toMatchObject(alice);
    expect(calls).toHaveLength(0);

    // 关闭: the link stops working
    await claimDELETE(req("/api/github/claim", { method: "DELETE", cookies: { [SESSION_COOKIE]: id }, headers: { origin: ORIGIN } }));
    expect(peekClaim(code)).toBeNull();
  });

  it("redeem: a session of its own without the tokens, once; a cross-site post does not use the code up", async () => {
    const id = loggedIn();
    const code = createClaim(alice)!;

    const cross = await redeem(code, { origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    expect(peekClaim(code)).not.toBeNull();

    const res = await redeem(code);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?login=ok");
    const cookie = res.cookies.get(SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 30 * 86400 });
    expect(cookie.value).not.toBe(id);
    expect(getSession(cookie.value)).toMatchObject({ login: "alice", avatar_url: alice.avatarUrl, access_token: null, refresh_token: null });
    // the device it came from keeps its own session and tokens
    expect(getSession(id)).toMatchObject({ access_token: "ghu_alice", refresh_token: "ghr_alice" });

    const again = await redeem(code);
    expect(again.headers.get("location")).toBe("/claim");
    expect(again.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("redeem: replaces the session this browser had", async () => {
    const mine = createSession({ login: "bob", avatar_url: "", access_token: "t", access_expires_at: null, refresh_token: null, refresh_expires_at: null });
    const res = await redeem(createClaim(alice)!, { cookies: { [SESSION_COOKIE]: mine } });
    expect(getSession(mine)).toBeNull();
    expect(getSession(res.cookies.get(SESSION_COOKIE)!.value)).toMatchObject({ login: "alice" });
  });

  it("a carried-over login is who it says, but in-app feedback asks for a GitHub login and keeps the session", async () => {
    const res = await redeem(createClaim(alice)!);
    const id = res.cookies.get(SESSION_COOKIE)!.value;
    const submit = await issuesPOST(req("/api/github/issues", { method: "POST", cookies: { [SESSION_COOKIE]: id }, body: { type: "bug", title: "x" }, headers: { origin: ORIGIN } }));
    expect(submit.status).toBe(403);
    expect(await submit.json()).toEqual({ error: expect.stringMatching(/^这台设备的登录是从其他设备带过来的.*用 GitHub 登录一次/), webFallback: true });
    expect(getSession(id)).not.toBeNull();
    expect(calls).toHaveLength(0);

    // the list of recent reports is read anonymously
    routes["GET https://api.github.com/repos/Hebi8/hebi8-market/issues"] = () => json([]);
    await issuesGET(req("/api/github/issues", { cookies: { [SESSION_COOKIE]: id } }));
    expect(calls.map((c) => c.auth)).toEqual([undefined]);
  });
});

describe("issues", () => {
  const ISSUES = "https://api.github.com/repos/Hebi8/hebi8-market/issues";
  const submit = (cookies: Record<string, string>, body: unknown) => issuesPOST(req("/api/github/issues", { method: "POST", cookies, body, headers: { origin: ORIGIN } }));
  const login = () => createSession({ login: "someone", avatar_url: "", access_token: "ghu_user", access_expires_at: Date.now() + 3600_000, refresh_token: null, refresh_expires_at: null });

  it("opens the issue with the user's token, no labels, type and autoFix in the context block", async () => {
    routes[`POST ${ISSUES}`] = () => json({ number: 123, html_url: "https://github.com/Hebi8/hebi8-market/issues/123", title: "t" }, 201);
    const res = await submit({ [SESSION_COOKIE]: login() }, { type: "bug", title: "图表空白", description: "打开就空", context: null, autoFix: true });
    expect(await res.json()).toEqual({ number: 123, html_url: "https://github.com/Hebi8/hebi8-market/issues/123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe("Bearer ghu_user");
    expect(calls[0].body).toEqual({ title: "图表空白", body: buildIssueBody("打开就空", { v: 1, type: "bug", autoFix: true }) });
  });

  it("goes to HEBI8_FEEDBACK_REPO when a fork sets it", async () => {
    process.env.HEBI8_FEEDBACK_REPO = "someone/fork";
    routes["POST https://api.github.com/repos/someone/fork/issues"] = () => json({ number: 1, html_url: "u", title: "t" }, 201);
    const res = await submit({ [SESSION_COOKIE]: login() }, { type: "idea", title: "x" });
    delete process.env.HEBI8_FEEDBACK_REPO;
    expect(res.status).toBe(200);
  });

  it("maps 403 and 404 to Chinese messages that offer the web form", async () => {
    const id = login();
    routes[`POST ${ISSUES}`] = () => json({ message: "Resource not accessible by integration" }, 403);
    let res = await submit({ [SESSION_COOKIE]: id }, { type: "bug", title: "x" });
    expect(res.status).toBe(403);
    let body = await res.json();
    expect(body.error).toMatch(/^GitHub 返回 403：你的账号不能在 Hebi8\/hebi8-market 上开 issue/);
    expect(body.webFallback).toBe(true);

    routes[`POST ${ISSUES}`] = () => json({ message: "Not Found" }, 404);
    res = await submit({ [SESSION_COOKIE]: id }, { type: "bug", title: "x" });
    body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toMatch(/GitHub App 没有安装到这个仓库/);
    expect(body.webFallback).toBe(true);
    // the login itself is fine
    expect(getSession(id)).not.toBeNull();
  });

  it("a report sent from /claim does not carry the login code into the issue", async () => {
    const code = "FkjZSQzabJX3x0YaZeUavZuSGJI6c7HSwcaSClqIhTU";
    routes[`POST ${ISSUES}`] = () => json({ number: 9, html_url: "u", title: "t" }, 201);
    const res = await submit({ [SESSION_COOKIE]: login() }, { type: "bug", title: "登录页有问题", description: "", context: { ...ctx, page: `/claim?c=${code}` }, autoFix: false });
    expect(res.status).toBe(200);
    const sent = calls[0].body as { title: string; body: string };
    expect(JSON.stringify(sent)).not.toContain(code);
    expect(parseIssueContext(sent.body)).toMatchObject({ page: "/claim" });
  });

  it("a web login through the feedback App is refused for the same reasons as the device flow's", async () => {
    const id = createSession({ login: "someone", avatar_url: "", access_token: "ghu_web", access_expires_at: Date.now() + 3600_000, refresh_token: "ghr_web", refresh_expires_at: null, web_client: CLIENT_ID });
    routes[`POST ${ISSUES}`] = () => json({ message: "Resource not accessible by integration" }, 403);
    let body = await (await submit({ [SESSION_COOKIE]: id }, { type: "bug", title: "x" })).json();
    expect(body.error).toMatch(/^GitHub 返回 403：你的账号不能在 Hebi8\/hebi8-market 上开 issue（hebi8\/market 的 GitHub App 没装在这个仓库/);
    routes[`POST ${ISSUES}`] = () => json({ message: "Not Found" }, 404);
    body = await (await submit({ [SESSION_COOKIE]: id }, { type: "bug", title: "x" })).json();
    expect(body.error).toMatch(/GitHub App 没有安装到这个仓库/);
    expect(body.webFallback).toBe(true);
  });

  it("a web login through another client only says who someone is: the reason says so, and the github.com form is offered", async () => {
    const id = createSession({ login: "someone", avatar_url: "", access_token: "gho_web", access_expires_at: null, refresh_token: null, refresh_expires_at: null, web_client: "Ov23_web" });
    for (const [status, message] of [[404, "Not Found"], [403, "Resource not accessible by integration"]] as const) {
      routes[`POST ${ISSUES}`] = () => json({ message }, status);
      const res = await submit({ [SESSION_COOKIE]: id }, { type: "bug", title: "x" });
      const body = await res.json();
      expect(res.status).toBe(status);
      expect(body.error).toMatch(new RegExp(`^GitHub 返回 ${status}：这次登录的授权不能在 Hebi8/hebi8-market 上开 issue（网页登录只确认身份`));
      expect(body.error).not.toContain("GitHub App");
      expect(body.webFallback).toBe(true);
    }
    expect(getSession(id)).not.toBeNull();
  });

  it("a 401 drops the session; no session is 401; cross-site is refused; no client id is 409", async () => {
    const id = login();
    routes[`POST ${ISSUES}`] = () => json({ message: "Bad credentials" }, 401);
    const res = await submit({ [SESSION_COOKIE]: id }, { type: "bug", title: "x" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("GitHub 返回 401：登录已过期，请重新登录");
    expect(getSession(id)).toBeNull();

    const none = await submit({}, { type: "bug", title: "x" });
    expect(none.status).toBe(401);
    expect((await none.json()).error).toBe("还没有登录 GitHub");

    const cross = await issuesPOST(req("/api/github/issues", { method: "POST", body: { type: "bug", title: "x" }, headers: { origin: "http://evil.example" } }));
    expect(cross.status).toBe(403);

    process.env.HEBI8_GITHUB_CLIENT_ID = "off";
    const off = await submit({}, { type: "bug", title: "x" });
    expect(off.status).toBe(409);
    expect((await off.json()).webFallback).toBe(true);
  });

  it("lists the latest from-app issues without pull requests, anonymously when logged out, cached 60 s", async () => {
    routes[`GET ${ISSUES}`] = (url) => {
      expect(url.searchParams.get("labels")).toBe("from-app");
      expect(url.searchParams.get("state")).toBe("all");
      return json([
        { number: 3, title: "c", state: "open", html_url: "u3", created_at: "t", body: "x" },
        { number: 2, title: "pr", state: "open", html_url: "u2", created_at: "t", pull_request: {} },
        { number: 1, title: "a", state: "closed", html_url: "u1", created_at: "t" },
      ]);
    };
    const res = await issuesGET(req("/api/github/issues"));
    expect(await res.json()).toEqual({
      issues: [
        { number: 3, title: "c", state: "open", html_url: "u3", created_at: "t" },
        { number: 1, title: "a", state: "closed", html_url: "u1", created_at: "t" },
      ],
    });
    expect(calls[0].auth).toBeUndefined();
    await issuesGET(req("/api/github/issues"));
    expect(calls).toHaveLength(1);
  });

  it("lists with the user's token when logged in, falling back to anonymous if GitHub refuses it", async () => {
    let n = 0;
    routes[`GET ${ISSUES}`] = () => (n++ === 0 ? json({ message: "Forbidden" }, 403) : json([]));
    const res = await issuesGET(req("/api/github/issues", { cookies: { [SESSION_COOKIE]: login() } }));
    expect(await res.json()).toEqual({ issues: [] });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer ghu_user", undefined]);
  });
});
