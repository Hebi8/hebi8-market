#!/usr/bin/env node
/**
 * Runs on the live machine, from the live checkout (`cd ~/dev/hebi8-market && node export.mjs`), for
 * the dev instance's daily copy (scripts/dev-instance/hebi8-dev.sh sync). Reads only:
 * - the root vault without `users/`: on a shared instance that is the owner's; nobody else's vault leaves;
 * - a snapshot of the cache without anyone else's rows: `stats` and `alert_state` keep vault '' only,
 *   traffic, visitors and upstream counts are dropped; bars, symbols, quotes, profiles stay;
 * - the manifest and the listed CSVs of each local dataset (remote ones the dev instance clones itself).
 * Only regular files and directories are copied: a symbolic link inside the vault or a dataset is left out
 * (listed on stderr), whatever it points to, so nothing outside them or under `users/` comes along. The vault
 * and each dataset directory are resolved once, as where they are. Writes the result to stdout as a base64
 * tar.gz between marker lines, so a banner around it does no harm.
 * Never touches the secrets directory.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const live = process.cwd();
const load = createRequire(path.join(live, "package.json"));
const Database = load("better-sqlite3");
const YAML = load("yaml");

const vault = path.resolve(process.env.HEBI8_VAULT ?? path.join(live, "vault"));
const dbFile = path.resolve(process.env.HEBI8_DB ?? path.join(live, "data", "hebi8.db"));
const isRemote = (location) => /^(https:\/\/|ssh:\/\/|file:\/\/|git@[^:]+:)/.test(location);
const localDir = (location) => (location.startsWith("~/") ? path.join(os.homedir(), location.slice(2)) : path.resolve(vault, location));
const inside = (dir, file) => !path.relative(dir, path.resolve(dir, file)).startsWith("..");
const skipped = [];

// Regular files and directories under <from>, without the top-level names in <leave>; links are skipped.
function copyTree(from, to, rel, leave = []) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (leave.includes(entry.name)) continue;
    const name = path.join(rel, entry.name);
    if (entry.isSymbolicLink()) skipped.push(name);
    else if (entry.isDirectory()) copyTree(path.join(from, entry.name), path.join(to, entry.name), name);
    else if (entry.isFile()) fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-dev-export-"));
  try {
    const out = path.join(tmp, "out");
    copyTree(fs.realpathSync(vault), path.join(out, "vault"), "vault", ["users"]);

    const snapshot = path.join(out, "hebi8.db");
    const src = new Database(dbFile, { readonly: true, fileMustExist: true });
    await src.backup(snapshot);
    src.close();
    const db = new Database(snapshot);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
    for (const t of ["stats", "alert_state"]) if (tables.has(t)) db.prepare(`DELETE FROM ${t} WHERE vault <> ''`).run();
    for (const t of ["traffic", "visitors", "upstream", "usage_alerts"]) if (tables.has(t)) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma("journal_mode = DELETE");
    db.exec("VACUUM");
    db.close();

    const config = YAML.parse(fs.readFileSync(path.join(vault, "hebi8.yaml"), "utf8")) ?? {};
    const datasets = [];
    for (const [name, location] of Object.entries(config.datasets ?? {})) {
      if (typeof location !== "string" || isRemote(location) || !/^[\w.-]+$/.test(name)) continue;
      if (!fs.existsSync(localDir(location))) continue;
      const dir = fs.realpathSync(localDir(location));
      const manifest = path.join(dir, "hebi8-dataset.yaml");
      if (!fs.existsSync(manifest)) continue;
      const files = ["hebi8-dataset.yaml"];
      for (const s of YAML.parse(fs.readFileSync(manifest, "utf8"))?.series ?? []) {
        const file = typeof s?.file === "string" && s.file.trim() ? s.file.trim() : `${s?.id}.csv`;
        if (inside(dir, file) && fs.existsSync(path.join(dir, file))) files.push(file);
      }
      let copied = 0;
      for (const file of files) {
        const from = path.join(dir, file);
        // a link anywhere on the way (the file, or a directory above it in the dataset) is skipped
        if (fs.realpathSync(from) !== from || !fs.statSync(from).isFile()) {
          skipped.push(path.join("datasets", name, file));
          continue;
        }
        fs.mkdirSync(path.dirname(path.join(out, "datasets", name, file)), { recursive: true });
        fs.copyFileSync(from, path.join(out, "datasets", name, file));
        copied++;
      }
      datasets.push({ name, files: copied });
    }

    for (const name of skipped) console.error(`export.mjs: skipped symbolic link ${name}`);
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: live, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(out, "export.json"), JSON.stringify({ at: new Date().toISOString(), commit, datasets }, null, 2));
    const archive = path.join(tmp, "export.tgz");
    execFileSync("tar", ["czf", archive, "-C", out, "."]);
    process.stdout.write(`HEBI8-DEV-EXPORT-BEGIN\n${fs.readFileSync(archive).toString("base64")}\nHEBI8-DEV-EXPORT-END\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`export.mjs: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
