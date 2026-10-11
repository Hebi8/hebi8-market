/**
 * User-defined daily series: a git repo (or a local directory) with a `hebi8-dataset.yaml`
 * manifest at the root and one CSV per series. hebi8 only reads; whatever writes the CSVs (a
 * scraper, a spreadsheet export) lives elsewhere. Remote repos are shallow clones under
 * `data/datasets/<name>/`, a cache like the database.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { isRemoteDataset } from "../config";
import { dataDir } from "../db";
import { dedupeBars, type Bar } from "../series";
import { DATA_ID, DATA_TICKER } from "../symbols";
import { countUpstream } from "../traffic";
import { readConfig, readConfigSafe, vaultDir } from "../vault";
import type { SearchHit, SourceAdapter } from "./types";

export const MANIFEST = "hebi8-dataset.yaml";

export interface DatasetSeries {
  id: string;
  name: string;
  currency?: string;
  /** What the series is, shown in the chart's 商品详情 panel */
  description?: string;
  file: string;
}

export interface Manifest {
  name: string;
  series: DatasetSeries[];
}

/** The manifest, validated; `file` must stay inside the repo. */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`${MANIFEST} 解析失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  const root = (raw ?? {}) as { name?: unknown; series?: unknown };
  if (!Array.isArray(root.series)) throw new Error(`${MANIFEST} 缺少 series 列表`);
  const seen = new Set<string>();
  const series = root.series.map((s, i): DatasetSeries => {
    const d = (s ?? {}) as Record<string, unknown>;
    const id = typeof d.id === "string" || typeof d.id === "number" ? String(d.id) : "";
    if (!DATA_ID.test(id)) throw new Error(`${MANIFEST} series[${i}]：id 只能用字母、数字、点、下划线、横线，并以字母或数字开头`);
    if (seen.has(id)) throw new Error(`${MANIFEST} series[${i}]：id「${id}」重复`);
    seen.add(id);
    const file = typeof d.file === "string" && d.file.trim() ? d.file.trim() : `${id}.csv`;
    if (path.isAbsolute(file) || path.normalize(file).split(path.sep).includes("..")) {
      throw new Error(`${MANIFEST} series[${i}]：file「${file}」必须是仓库内的相对路径`);
    }
    return {
      id,
      name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : id,
      ...(typeof d.currency === "string" && d.currency.trim() ? { currency: d.currency.trim() } : {}),
      ...(typeof d.description === "string" && d.description.trim() ? { description: d.description.trim() } : {}),
      file,
    };
  });
  return { name: typeof root.name === "string" && root.name.trim() ? root.name.trim() : "", series };
}

const COLUMNS = ["date", "open", "high", "low", "close", "volume"] as const;
type Column = (typeof COLUMNS)[number];

/**
 * `date,open,high,low,close,volume`, any column order, only `date` and `close` required. Empty
 * open falls back to close, empty high/low to the larger/smaller of open and close. Dates are
 * calendar days, stored as UTC midnight; a repeated date keeps the later row.
 */
export function parseCsv(text: string): Bar[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let header: Partial<Record<Column, number>> | null = null;
  const bars: Bar[] = [];
  lines.forEach((line, i) => {
    const at = `第 ${i + 1} 行`;
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const cells = line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
    if (!header) {
      header = {};
      cells.forEach((name, col) => {
        const key = name.toLowerCase() as Column;
        if ((COLUMNS as readonly string[]).includes(key)) header![key] = col;
      });
      if (header.date === undefined || header.close === undefined) throw new Error(`CSV 表头需要 date 和 close 列`);
      return;
    }
    const cols = header;
    const num = (col: Column): number | null => {
      const idx = cols[col];
      const cell = idx === undefined ? "" : (cells[idx] ?? "");
      if (cell === "") return null;
      const n = Number(cell);
      if (!Number.isFinite(n)) throw new Error(`${at}：${col}「${cell}」不是数字`);
      return n;
    };
    const date = cells[cols.date!] ?? "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 : NaN;
    if (!m || new Date(t * 1000).toISOString().slice(0, 10) !== date) throw new Error(`${at}：日期「${date}」应为 YYYY-MM-DD`);
    const c = num("close");
    if (c === null) throw new Error(`${at}：缺少 close`);
    const o = num("open") ?? c;
    bars.push({ t, o, h: num("high") ?? Math.max(o, c), l: num("low") ?? Math.min(o, c), c, v: num("volume"), adj: 1 });
  });
  if (!header) throw new Error("CSV 是空的");
  return dedupeBars(bars);
}

// ---------------------------------------------------------------------------- where the files are

const run = promisify(execFile);
const GIT_TIMEOUT = 120_000;
/** One pull serves every series of a dataset during a sync. */
const PULL_TTL = 10 * 60 * 1000;

/** Credentials written into an https URL never reach logs or the page. */
const redact = (text: string) => text.replace(/(\/\/)[^@/\s]+@/g, "$1***@");

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") throw new Error("找不到 git 命令");
    if (e.killed) throw new Error(`git ${args[0]} 超时`);
    const detail = (e.stderr ?? e.message).trim().split("\n").filter(Boolean).slice(-2).join(" ");
    throw new Error(redact(`git ${args[0]} 失败：${detail}`));
  }
}

export const cloneDir = (name: string) => path.join(dataDir(), "datasets", name);

/** Local directories: absolute, `~/`, or relative to the vault. */
export function localDir(location: string): string {
  if (location.startsWith("~/")) return path.join(os.homedir(), location.slice(2));
  return path.resolve(vaultDir(), location);
}

/** Clone or fast-forward a remote dataset into the cache; exported for tests. */
export async function pull(name: string, url: string): Promise<string> {
  const dir = cloneDir(name);
  if (fs.existsSync(path.join(dir, ".git"))) {
    const origin = await git(["remote", "get-url", "origin"], dir).catch(() => "");
    if (origin === url) {
      await git(["fetch", "--depth", "1", "origin"], dir);
      await git(["reset", "--hard", "FETCH_HEAD"], dir);
      return dir;
    }
  }
  // first time, or the yaml now points somewhere else
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(["clone", "--depth", "1", "--single-branch", url, tmp]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

const pulls = new Map<string, { url: string; at: number; job: Promise<string> }>();

/** The directory holding a dataset, fetching a remote one at most once per `PULL_TTL`. */
async function datasetRoot(name: string, location: string): Promise<string> {
  if (!isRemoteDataset(location)) {
    const dir = localDir(location);
    if (!fs.existsSync(dir)) throw new Error(`数据集目录不存在：${dir}`);
    return dir;
  }
  const cached = pulls.get(name);
  if (cached && cached.url === location && Date.now() - cached.at < PULL_TTL) return cached.job;
  const job = countUpstream("data", () => pull(name, location));
  pulls.set(name, { url: location, at: Date.now(), job });
  job.catch(() => pulls.delete(name));
  return job;
}

/** What is on disk already, for search: no network. */
function rootOnDisk(name: string, location: string): string | null {
  const dir = isRemoteDataset(location) ? cloneDir(name) : localDir(location);
  return fs.existsSync(path.join(dir, MANIFEST)) ? dir : null;
}

function readManifest(root: string): Manifest {
  const file = path.join(root, MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`数据集根目录没有 ${MANIFEST}`);
  return parseManifest(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------- adapter

export const dataset: SourceAdapter = {
  async fetchDaily(ticker) {
    const m = DATA_TICKER.exec(ticker);
    if (!m) throw new Error(`无效的数据集 key「data:${ticker}」`);
    const [, name, id] = m;
    // datasets are an instance setting: only the root vault's yaml names them
    const location = readConfig(vaultDir()).datasets[name];
    if (!location) throw new Error(`hebi8.yaml 的 datasets 里没有「${name}」`);
    const root = await datasetRoot(name, location);
    const manifest = readManifest(root);
    const series = manifest.series.find((s) => s.id === id);
    if (!series) throw new Error(`数据集「${name}」里没有序列「${id}」`);
    const file = path.join(root, series.file);
    if (!fs.existsSync(file)) throw new Error(`找不到 ${series.file}`);
    let bars: Bar[];
    try {
      bars = parseCsv(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${series.file}：${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      bars,
      meta: { name: series.name, exchange: manifest.name || name, currency: series.currency, timezone: "UTC", kind: "dataset" },
      mode: "replace",
    };
  },

  /** The series' `description` in the manifest as it is on disk after the last sync: no network. */
  async profile(ticker) {
    const m = DATA_TICKER.exec(ticker);
    if (!m) throw new Error(`无效的数据集 key「data:${ticker}」`);
    const [, name, id] = m;
    const location = readConfig(vaultDir()).datasets[name];
    const root = location ? rootOnDisk(name, location) : null;
    if (!root) throw new Error(`数据集「${name}」还没有同步`);
    const description = readManifest(root).series.find((s) => s.id === id)?.description;
    return description ? { description } : {};
  },

  /** Series whose id or name contains the query, or every series of a dataset whose name does. */
  async search(query) {
    const q = query.trim().toLowerCase().replace(/^data:/, "");
    if (!q) return [];
    const datasets = readConfigSafe(vaultDir()).config?.datasets ?? {};
    const hits: SearchHit[] = [];
    for (const [name, location] of Object.entries(datasets)) {
      const root = rootOnDisk(name, location);
      if (!root) continue;
      let manifest: Manifest;
      try {
        manifest = readManifest(root);
      } catch {
        continue;
      }
      const whole = name.toLowerCase().includes(q) || manifest.name.toLowerCase().includes(q);
      for (const s of manifest.series) {
        const key = `data:${name}/${s.id}`;
        if (whole || key.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) {
          hits.push({ key, name: s.name, exchange: manifest.name || name, kind: "dataset" });
        }
      }
    }
    return hits;
  },
};
