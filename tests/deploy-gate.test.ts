import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/deploy-gate.sh, the forced command of the live machine's deploy key, in a sandbox: an "origin" bare
// repository and a live checkout cloned from it, whose deploy.sh only says how it was called.
const GATE = path.resolve("scripts/deploy-gate.sh");
let root: string;
let live: string;
let onMaster: string;
let elsewhere: string;
let failing: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// <dir>: a commit whose deploy.sh prints its arguments and HEBI8_LIVE and leaves a mark, exiting with <status>
function commit(dir: string, message: string, status = 0): string {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(GATE, path.join(dir, "scripts/deploy-gate.sh"));
  writeFileSync(
    path.join(dir, "scripts/deploy.sh"),
    `echo "deploy.sh $* in $HEBI8_LIVE (${message})"\ntouch "$HEBI8_LIVE/../ran"\nexit ${status}\n`,
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

function gate(request: string | undefined) {
  rmSync(path.join(root, "ran"), { force: true });
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: root };
  if (request !== undefined) env.SSH_ORIGINAL_COMMAND = request;
  const r = spawnSync("bash", [path.join(live, "scripts/deploy-gate.sh")], { env, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr, ran: existsSync(path.join(root, "ran")) };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "hebi8-gate-"));
  const work = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  live = path.join(root, "live");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(root, "init", "-q", "-b", "master", work);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  commit(work, "first");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "master");
  git(root, "clone", "-q", origin, live);
  onMaster = commit(work, "second");
  failing = commit(work, "third", 3);
  git(work, "push", "-q", "origin", "master");
  git(work, "switch", "-q", "-c", "other");
  elsewhere = commit(work, "not on master");
  git(work, "push", "-q", "origin", "other");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("deploy-gate.sh", () => {
  it("runs the deployed commit's deploy.sh for `live <commit>` on origin's master", () => {
    const r = gate(`live ${onMaster}`);
    expect(r.status).toBe(0);
    expect(r.out).toBe(`deploy.sh live ${onMaster} in ${live} (second)\n`);
  });

  it("passes deploy.sh's exit status through", () => {
    const r = gate(`live ${failing}`);
    expect(r.status).toBe(3);
    expect(r.out).toContain("(third)");
  });

  it("answers `status <commit>` with HEAD's deploy.sh, whatever the commit", () => {
    expect(gate(`status ${onMaster}`).out).toBe(`deploy.sh status ${onMaster} in ${live} (first)\n`);
    const unknown = "0123456789abcdef0123456789abcdef01234567";
    const r = gate(`status ${unknown}`);
    expect(r.status).toBe(0);
    expect(r.out).toBe(`deploy.sh status ${unknown} in ${live} (first)\n`);
  });

  it("never runs a commit that is here but not on master, for status or live", () => {
    // a commit the live checkout has in its object store without it being on origin's master
    git(live, "fetch", "-q", "origin", "other");
    git(live, "cat-file", "-e", `${elsewhere}^{commit}`);
    const s = gate(`status ${elsewhere}`);
    expect(s.status).toBe(0);
    expect(s.out).toBe(`deploy.sh status ${elsewhere} in ${live} (first)\n`);
    const l = gate(`live ${elsewhere}`);
    expect(l.status).toBe(2);
    expect(l.ran).toBe(false);
  });

  it("refuses a commit that is not on origin's master", () => {
    const r = gate(`live ${elsewhere}`);
    expect(r.status).toBe(2);
    expect(r.err).toContain("not on origin's master");
    expect(r.ran).toBe(false);
  });

  it.each([
    ["no command", undefined],
    ["an empty command", ""],
    ["a short commit", `live ${"a".repeat(7)}`],
    ["39 characters", `live ${"a".repeat(39)}`],
    ["41 characters", `live ${"a".repeat(41)}`],
    ["capital hex", `live ${"A".repeat(40)}`],
    ["another command", `rollback ${"a".repeat(40)}`],
    ["a bare live", "live"],
    ["an extra argument", `live ${"a".repeat(40)} x`],
    ["two spaces", `live  ${"a".repeat(40)}`],
    ["a leading space", ` live ${"a".repeat(40)}`],
    ["a trailing newline", `live ${"a".repeat(40)}\n`],
    ["a second line", `live ${"a".repeat(40)}\ntouch /tmp/x`],
    ["a semicolon", `live ${"a".repeat(40)}; touch /tmp/x`],
    ["a substitution", `live $(touch /tmp/x)`],
    ["a shell", "bash -i"],
    ["git-upload-pack", "git-upload-pack 'dev/hebi8-market'"],
  ])("refuses %s and runs nothing", (_, request) => {
    const r = gate(request);
    expect(r.status).toBe(2);
    expect(r.err).toContain("refused");
    expect(r.out).toBe("");
    expect(r.ran).toBe(false);
  });
});
