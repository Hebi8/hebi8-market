import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The dev instance's daily copy (scripts/dev-instance/hebi8-dev.sh unit-sync) in a sandbox: a fake live checkout
// whose vault has symbolic links, synced into a fake dev root. A stub systemctl stands in for the units, so the
// machine's own dev instance is never touched.
const SCRIPTS = path.resolve("scripts/dev-instance");
let root: string;

function sh(cwd: string, cmd: string, ...args: string[]) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
}

// Every path under <dir> with its type, link target and content hash.
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (name === "node_modules") continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${p} link`);
      else if (st.isDirectory()) {
        out.push(`${p} dir`);
        walk(p);
      } else out.push(`${p} ${crypto.createHash("sha256").update(readFileSync(p)).digest("hex")} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

function links(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => lstatSync(path.join(dir, p)).isSymbolicLink());
}

// A live checkout whose vault (or, with vaultIsLink, the real directory a `vault` link points to) has links: to
// its own yaml, to a secrets directory outside it, to its own users/ (someone else's vault); and a dataset with a
// plain CSV, a CSV that is a link into the secrets and one under a linked directory.
function live(dir: string, vaultIsLink = false): string {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  copyFileSync("package.json", path.join(dir, "package.json"));
  symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));
  sh(dir, "git", "init", "-q");
  sh(dir, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  const vault = path.join(dir, vaultIsLink ? "realvault" : "vault");
  if (vaultIsLink) symlinkSync("realvault", path.join(dir, "vault"));
  for (const d of ["notes", "charts", "users/someone", "../secrets", "../ds"]) mkdirSync(path.join(vault, d), { recursive: true });
  const secrets = path.join(dir, "secrets");
  const ds = path.join(dir, "ds");
  writeFileSync(path.join(secrets, "notify.json"), '{"token":"SECRET-TOKEN"}\n');
  writeFileSync(path.join(secrets, "c.csv"), "SECRET-CSV\n");
  writeFileSync(path.join(vault, "users/someone/hebi8.yaml"), "THEIRS: true\n");
  writeFileSync(path.join(vault, "hebi8.yaml"), `owner: someone\nsync:\n  at: [ "07:30", "17:30" ]\n  tz: Asia/Tokyo\ndatasets:\n  ds: ${ds}\n  bare: ${secrets}\n  remote: https://example.com/remote.git\n`);
  writeFileSync(path.join(vault, "notes/a.md"), "note\n");
  symlinkSync("../hebi8.yaml", path.join(vault, "notes/link.md"));
  symlinkSync(secrets, path.join(vault, "charts/outside"));
  symlinkSync("../users", path.join(vault, "charts/others"));
  writeFileSync(path.join(ds, "hebi8-dataset.yaml"), "series:\n  - id: a\n  - id: b\n  - id: c\n    file: sub/c.csv\n");
  writeFileSync(path.join(ds, "a.csv"), "date,close\n2026-01-01,1\n");
  symlinkSync(path.join(secrets, "notify.json"), path.join(ds, "b.csv"));
  symlinkSync(secrets, path.join(ds, "sub"));
  const db = new Database(path.join(dir, "data/hebi8.db"));
  db.exec("CREATE TABLE stats (vault TEXT, k TEXT); INSERT INTO stats VALUES ('', 'a'), ('x', 'b')");
  db.close();
  return dir;
}

// Everything the dev root got, as text.
function devText(dev: string): string {
  return ["vault", "datasets"]
    .flatMap((d) => readdirSync(path.join(dev, d), { recursive: true, encoding: "utf8" }).map((p) => path.join(dev, d, p)))
    .filter((p) => lstatSync(p).isFile())
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

// A dev root whose `current` is this checkout (prepare-vault takes `yaml` from it); config lines are added as given.
function devRoot(dir: string, config: string): string {
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  for (const f of ["hebi8-dev.sh", "export.mjs", "prepare-vault.mjs"]) copyFileSync(path.join(SCRIPTS, f), path.join(dir, "bin", f));
  symlinkSync(path.resolve("."), path.join(dir, "current"));
  writeFileSync(path.join(dir, "config.env"), `PORT=1\n${config}\n`);
  return dir;
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function sync(dev: string) {
  const r = spawnSync("bash", [path.join(dev, "bin/hebi8-dev.sh"), "unit-sync"], {
    cwd: root,
    env: { NODE_ENV: "test", PATH: `${path.join(root, "stub")}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: root, HEBI8_DEV_ROOT: dev },
    encoding: "utf8",
  });
  return { status: r.status, log: r.stderr };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "hebi8-devsync-"));
  mkdirSync(path.join(root, "stub"));
  // `is-active` says no, so the health check gives up at once; stop and start do nothing
  writeFileSync(path.join(root, "stub/systemctl"), '#!/bin/sh\n[ "$2" = is-active ] && exit 3\nexit 0\n');
  chmodSync(path.join(root, "stub/systemctl"), 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("hebi8-dev.sh sync", () => {
  for (const vaultIsLink of [false, true]) {
    it(`leaves links out and the live data as it was${vaultIsLink ? " (the vault itself a link)" : ""}`, () => {
      const L = live(path.join(root, `live-${vaultIsLink}`), vaultIsLink);
      const D = devRoot(path.join(root, `dev-${vaultIsLink}`), `LIVE_DIR=${q(L)}\nLIVE_NODE=${q(process.execPath)}`);
      const before = fingerprint(L);
      const r = sync(D);
      expect(r.log).toContain("sync: done");
      expect(fingerprint(L)).toBe(before);
      expect(links(path.join(D, "vault"))).toEqual([]);
      expect(lstatSync(path.join(D, "vault")).isSymbolicLink()).toBe(false);
      const yaml = readFileSync(path.join(D, "vault/hebi8.yaml"), "utf8");
      expect(yaml).not.toMatch(/^owner:/m);
      expect(yaml).toContain('at: [ "08:00" ]');
      // every local dataset points into the dev root, one without a manifest (nothing copied) too
      expect(yaml).not.toContain(L);
      expect(yaml).toContain(`ds: ${path.join(D, "datasets/ds")}`);
      expect(yaml).toContain(`bare: ${path.join(D, "datasets/bare")}`);
      expect(yaml).toContain("remote: https://example.com/remote.git");
      expect(readFileSync(path.join(D, "vault/notes/a.md"), "utf8")).toBe("note\n");
      for (const skipped of ["vault/notes/link.md", "vault/charts/outside", "vault/charts/others", "datasets/ds/b.csv", "datasets/ds/sub/c.csv"]) {
        expect(r.log).toContain(`sync: skipped symbolic link ${skipped}`);
        expect(existsSync(path.join(D, skipped))).toBe(false);
      }
      expect(existsSync(path.join(D, "vault/users"))).toBe(false);
      expect(readdirSync(path.join(D, "datasets/ds")).sort()).toEqual(["a.csv", "hebi8-dataset.yaml"]);
      expect(devText(D)).not.toMatch(/SECRET|THEIRS/);
      const db = new Database(path.join(D, "data/hebi8.db"), { readonly: true });
      expect(db.prepare("SELECT vault, k FROM stats").all()).toEqual([{ vault: "", k: "a" }]);
      db.close();
    });
  }

  it("refuses an export with a symbolic link in it and swaps nothing in", () => {
    const L = live(path.join(root, "live-raw"));
    // a "node" that ignores export.mjs and sends the vault as it is, links and all
    const fake = path.join(root, "raw-export");
    writeFileSync(
      fake,
      `#!/bin/bash\nd=$(mktemp -d)\ncp -a vault "$d/vault" && cp data/hebi8.db "$d/"\necho HEBI8-DEV-EXPORT-BEGIN\ntar czf - -C "$d" . | base64 -w0\necho\necho HEBI8-DEV-EXPORT-END\nrm -rf "$d"\n`,
    );
    chmodSync(fake, 0o755);
    const D = devRoot(path.join(root, "dev-raw"), `LIVE_DIR=${q(L)}\nLIVE_NODE=${q(fake)}`);
    const before = fingerprint(L);
    const r = sync(D);
    expect(r.status).toBe(1);
    expect(r.log).toContain("sync: the export has symbolic links, nothing changed");
    expect(fingerprint(L)).toBe(before);
    expect(existsSync(path.join(D, "vault/hebi8.yaml"))).toBe(false);
  });

  it("fails the whole sync when a dataset's manifest is a link, keeping the dev data as it was", () => {
    const L = live(path.join(root, "live-manifest"));
    const D = devRoot(path.join(root, "dev-manifest"), `LIVE_DIR=${q(L)}\nLIVE_NODE=${q(process.execPath)}`);
    expect(sync(D).log).toContain("sync: done");
    // the manifest now a link to one that lists a secret
    writeFileSync(path.join(L, "secrets/manifest.yaml"), "series:\n  - id: notify\n    file: ../secrets/notify.json\n");
    rmSync(path.join(L, "ds/hebi8-dataset.yaml"));
    symlinkSync(path.join(L, "secrets/manifest.yaml"), path.join(L, "ds/hebi8-dataset.yaml"));
    const live0 = fingerprint(L);
    const dev0 = fingerprint(path.join(D, "vault")) + fingerprint(path.join(D, "datasets")) + fingerprint(path.join(D, "data"));
    const r = sync(D);
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/sync: export failed: .*datasets\.ds: .*hebi8-dataset\.yaml is a symbolic link or not a file; nothing exported/);
    expect(r.log).not.toContain("sync: done");
    expect(fingerprint(L)).toBe(live0);
    expect(fingerprint(path.join(D, "vault")) + fingerprint(path.join(D, "datasets")) + fingerprint(path.join(D, "data"))).toBe(dev0);
    expect(devText(D)).not.toMatch(/SECRET|THEIRS/);
  });

  it("quotes LIVE_DIR and LIVE_NODE for the remote shell", () => {
    const L = live(path.join(root, "live dir;touch pwned"));
    mkdirSync(path.join(root, "my node"));
    symlinkSync(process.execPath, path.join(root, "my node/node"));
    const D = devRoot(path.join(root, "dev-remote"), `LIVE_SHELL=(bash -c)\nLIVE_DIR=${q(L)}\nLIVE_NODE=${q(path.join(root, "my node/node"))}`);
    const r = sync(D);
    expect(r.log).toContain("sync: done");
    expect(readFileSync(path.join(D, "vault/hebi8.yaml"), "utf8")).not.toMatch(/^owner:/m);
    expect(existsSync(path.join(root, "pwned"))).toBe(false);
  });
});
