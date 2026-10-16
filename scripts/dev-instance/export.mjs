#!/usr/bin/env node
/**
 * Runs on the live machine, from the live checkout (`cd ~/dev/hebi8-market && node export.mjs`), for
 * the dev instance's daily copy (scripts/dev-instance/hebi8-dev.sh sync). Reads only:
 * - the root vault without `users/`: on a shared instance that is the owner's; nobody else's vault leaves;
 * - a snapshot of the cache without anyone else's rows: `stats` and `alert_state` keep vault '' only,
 *   traffic, visitors and upstream counts are dropped; bars, symbols, quotes, profiles stay;
 * - the manifest and the listed CSVs of each local dataset (remote ones the dev instance clones itself).
 * Writes them to stdout as a base64 tar.gz between marker lines, so a banner around it does no harm.
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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-dev-export-"));
  try {
    const out = path.join(tmp, "out");
    fs.cpSync(vault, path.join(out, "vault"), {
      recursive: true,
      filter: (src) => path.relative(vault, src).split(path.sep)[0] !== "users",
    });

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
      const dir = localDir(location);
      const manifest = path.join(dir, "hebi8-dataset.yaml");
      if (!fs.existsSync(manifest)) continue;
      const files = ["hebi8-dataset.yaml"];
      for (const s of YAML.parse(fs.readFileSync(manifest, "utf8"))?.series ?? []) {
        const file = typeof s?.file === "string" && s.file.trim() ? s.file.trim() : `${s?.id}.csv`;
        if (inside(dir, file) && fs.existsSync(path.join(dir, file))) files.push(file);
      }
      for (const file of files) fs.cpSync(path.join(dir, file), path.join(out, "datasets", name, file));
      datasets.push({ name, files: files.length });
    }

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
