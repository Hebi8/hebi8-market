import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, normalizeConfig } from "@/lib/config";
import { directKey, groupLabel, rankExternal } from "@/lib/search";
import { parseCsv, parseManifest } from "@/lib/sources/dataset";
import { fileKey, isValidKey, parseKey } from "@/lib/symbols";

const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 1000;

describe("data keys", () => {
  it("are dataset/series with file-name-safe parts", () => {
    expect(parseKey("data:gpu/4090-xianyu")).toEqual({ source: "data", ticker: "gpu/4090-xianyu" });
    expect(isValidKey("data:gpu")).toBe(false);
    expect(isValidKey("data:gpu/a/b")).toBe(false);
    expect(isValidKey("data:../x")).toBe(false);
    expect(isValidKey("data:gpu/..")).toBe(false);
    expect(fileKey("data:gpu/4090-xianyu")).toBe("data_gpu_4090-xianyu");
  });

  it("keep their case when typed into search and get their own group", () => {
    expect(directKey("data:gpu/RTX4090", {})).toBe("data:gpu/RTX4090");
    expect(directKey("yahoo:aapl", {})).toBe("yahoo:AAPL");
    expect(groupLabel("data:gpu/4090-jd")).toBe("数据");
  });

  it("rank first when the series id matches", () => {
    const rows = rankExternal(
      "4090-jd",
      { yahoo: [], binance: [], tv: [], data: [{ key: "data:gpu/4090-jd", name: "RTX 4090 京东", exchange: "显卡", kind: "dataset" }] },
      { watchlist: [], aliases: {}, groups: ["加密", "数据"] },
    );
    expect(rows[0]).toMatchObject({ key: "data:gpu/4090-jd", source: "data", suggestedGroup: "数据" });
  });
});

describe("datasets in hebi8.yaml", () => {
  it("accepts remote and local locations", () => {
    const cfg = normalizeConfig({ datasets: { gpu: "https://github.com/x/gpu-prices", local: "~/data/x", rel: "./data", ssh: "git@github.com:x/y.git" } });
    expect(cfg.datasets.gpu).toBe("https://github.com/x/gpu-prices");
    expect(Object.keys(cfg.datasets)).toEqual(["gpu", "local", "rel", "ssh"]);
    expect(normalizeConfig({}).datasets).toEqual({});
  });

  it("rejects bad names and locations", () => {
    expect(() => normalizeConfig({ datasets: { "a/b": "./x" } })).toThrow(ConfigError);
    expect(() => normalizeConfig({ datasets: { "..": "https://github.com/x/y" } })).toThrow(ConfigError);
    expect(() => normalizeConfig({ datasets: { gpu: "github.com/x" } })).toThrow(/https/);
    expect(() => normalizeConfig({ datasets: { gpu: "http://insecure/x" } })).toThrow(ConfigError);
  });
});

describe("parseManifest", () => {
  it("defaults the name and the file, keeps the currency", () => {
    expect(parseManifest("name: 显卡\nseries:\n  - { id: 4090-jd, name: RTX 4090 京东, currency: CNY, file: series/4090-jd.csv }\n  - { id: 5090 }\n")).toEqual({
      name: "显卡",
      series: [
        { id: "4090-jd", name: "RTX 4090 京东", currency: "CNY", file: "series/4090-jd.csv" },
        { id: "5090", name: "5090", file: "5090.csv" },
      ],
    });
  });

  it("a series and the dataset may say what they are and where to read more", () => {
    const manifest = parseManifest(`name: 显卡
description: " 每天从闲鱼和京东抓取的显卡价格 "
links:
  - { name: 数据出处, url: https://github.com/someone/gpu-prices }
series:
  - id: 4090-xianyu
    description: 闲鱼上 RTX 4090 的每日中位成交价
    links:
      - { name: 闲鱼搜索页, url: " https://www.goofish.com/search?q=4090 " }
      - { url: http://example.org/no-name }
  - { id: 4090-jd }
`);
    expect(manifest.description).toBe("每天从闲鱼和京东抓取的显卡价格");
    expect(manifest.links).toEqual([{ name: "数据出处", url: "https://github.com/someone/gpu-prices" }]);
    expect(manifest.series[0]).toEqual({
      id: "4090-xianyu",
      name: "4090-xianyu",
      description: "闲鱼上 RTX 4090 的每日中位成交价",
      links: [
        { name: "闲鱼搜索页", url: "https://www.goofish.com/search?q=4090" },
        // without a name it goes by its host
        { name: "example.org", url: "http://example.org/no-name" },
      ],
      file: "4090-xianyu.csv",
    });
    // none given: no field at all
    expect(manifest.series[1]).toEqual({ id: "4090-jd", name: "4090-jd", file: "4090-jd.csv" });
    expect(parseManifest("series:\n  - { id: a }\n")).toEqual({ name: "", series: [{ id: "a", name: "a", file: "a.csv" }] });
  });

  it("a link that is not http(s) is dropped: the manifest is someone else's file and a url becomes an href", () => {
    const manifest = parseManifest(`links:
  - { name: 脚本, url: "javascript:alert(document.cookie)" }
  - { name: 数据, url: "data:text/html,<script>alert(1)</script>" }
  - { name: 文件, url: "file:///etc/passwd" }
  - { name: 相对, url: "/usage" }
  - { name: 没有地址 }
  - 只是一个字符串
  - { name: 正常, url: "https://example.org/ok" }
series:
  - id: a
    links: [{ name: x, url: "vbscript:msgbox(1)" }, { name: ftp, url: "ftp://example.org/x" }]
  - { id: b, links: 不是列表 }
`);
    expect(manifest.links).toEqual([{ name: "正常", url: "https://example.org/ok" }]);
    expect(manifest.series[0]).toEqual({ id: "a", name: "a", file: "a.csv" });
    expect(manifest.series[1]).toEqual({ id: "b", name: "b", file: "b.csv" });
  });

  it("refuses files outside the repo and duplicate ids", () => {
    expect(() => parseManifest("series:\n  - { id: a, file: ../../etc/passwd }\n")).toThrow(/相对路径/);
    expect(() => parseManifest("series:\n  - { id: a, file: /etc/passwd }\n")).toThrow(/相对路径/);
    expect(() => parseManifest("series:\n  - { id: a }\n  - { id: a }\n")).toThrow(/重复/);
    expect(() => parseManifest("name: x\n")).toThrow(/series/);
  });
});

describe("parseCsv", () => {
  it("reads full rows and fills what is missing", () => {
    const bars = parseCsv("date,open,high,low,close,volume\n2026-10-05,,15800,11200,12900,184\n2026-10-06,12900,,,12650,\n");
    expect(bars).toEqual([
      { t: day("2026-10-05"), o: 12900, h: 15800, l: 11200, c: 12900, v: 184, adj: 1 },
      { t: day("2026-10-06"), o: 12900, h: 12900, l: 12650, c: 12650, v: null, adj: 1 },
    ]);
  });

  it("takes date and close alone, in any column order, skipping blanks and comments", () => {
    const bars = parseCsv("﻿# scraped daily\nClose,Date\n\n12650,2026-10-06\n12900,2026-10-05\n12700,2026-10-06\n");
    expect(bars.map((b) => [b.t, b.o, b.h, b.l, b.c])).toEqual([
      [day("2026-10-05"), 12900, 12900, 12900, 12900],
      [day("2026-10-06"), 12700, 12700, 12700, 12700], // a repeated date keeps the later row
    ]);
  });

  it("reports the line of a bad row", () => {
    expect(() => parseCsv("date,close\n2026-10-05,1\n2026/10/06,2\n")).toThrow(/第 3 行.*YYYY-MM-DD/);
    expect(() => parseCsv("date,close\n2026-02-30,1\n")).toThrow(/第 2 行/);
    expect(() => parseCsv("date,close\n2026-10-05,abc\n")).toThrow(/第 2 行.*不是数字/);
    expect(() => parseCsv("date,close\n2026-10-05,\n")).toThrow(/缺少 close/);
    expect(() => parseCsv("day,price\n")).toThrow(/date 和 close/);
    expect(() => parseCsv("")).toThrow(/空/);
  });
});

describe("dataset source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hebi8-dataset-"));
  const repo = path.join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
  };

  beforeAll(() => {
    fs.mkdirSync(repo);
    git("init", "-q", "-b", "main");
    write("hebi8-dataset.yaml", "name: 显卡二手与零售价\nseries:\n  - { id: 4090-xianyu, name: RTX 4090 咸鱼, currency: CNY, file: series/4090-xianyu.csv }\n");
    write("series/4090-xianyu.csv", "date,high,low,close,volume\n2026-10-05,15800,11200,12900,184\n");
    commit("first");
    process.env.HEBI8_DB = path.join(dir, "data", "hebi8.db");
    process.env.HEBI8_VAULT = path.join(dir, "vault");
    fs.mkdirSync(process.env.HEBI8_VAULT);
    fs.writeFileSync(
      path.join(process.env.HEBI8_VAULT, "hebi8.yaml"),
      `datasets:\n  gpu: file://${repo}\n  here: ../repo\ngroups:\n  - name: 数据\n    symbols: [data:gpu/4090-xianyu]\n`,
    );
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("clones a repo into the cache and syncs a series into bars", async () => {
    const { syncOne } = await import("@/lib/sync");
    const { getSymbol, readDaily } = await import("@/lib/store");
    const outcome = await syncOne("data:gpu/4090-xianyu", true);
    expect(outcome).toEqual({ key: "data:gpu/4090-xianyu", ok: true, bars: 1 });
    expect(fs.existsSync(path.join(dir, "data", "datasets", "gpu", "hebi8-dataset.yaml"))).toBe(true);
    expect(readDaily("data:gpu/4090-xianyu")).toEqual([{ t: day("2026-10-05"), o: 12900, h: 15800, l: 11200, c: 12900, v: 184, adj: 1 }]);
    expect(getSymbol("data:gpu/4090-xianyu")).toMatchObject({ name: "RTX 4090 咸鱼", currency: "CNY", exchange: "显卡二手与零售价", kind: "dataset" });
  });

  it("pulls new commits", async () => {
    const { pull } = await import("@/lib/sources/dataset");
    write("series/4090-xianyu.csv", "date,close\n2026-10-05,12900\n2026-10-06,12650\n");
    commit("second");
    const root = await pull("gpu", `file://${repo}`);
    expect(fs.readFileSync(path.join(root, "series/4090-xianyu.csv"), "utf8")).toContain("2026-10-06");
  });

  it("reads a local directory relative to the vault, and reports missing series on the key", async () => {
    const { adapters } = await import("@/lib/sources");
    const result = await adapters.data.fetchDaily("here/4090-xianyu", null);
    expect(result.bars.map((b) => b.c)).toEqual([12900, 12650]);
    await expect(adapters.data.fetchDaily("here/nope", null)).rejects.toThrow(/没有序列「nope」/);
    await expect(adapters.data.fetchDaily("other/x", null)).rejects.toThrow(/datasets 里没有「other」/);
  });

  it("a series' profile is what the manifest says, and follows the manifest with every sync instead of once a week", async () => {
    const { profileView, readProfile } = await import("@/lib/profiles");
    const { adapters } = await import("@/lib/sources");
    const { syncOne } = await import("@/lib/sync");
    const { readConfig } = await import("@/lib/vault");
    const key = "data:here/4090-xianyu";
    const cfg = readConfig(process.env.HEBI8_VAULT!);
    const series = "  - { id: 4090-xianyu, name: RTX 4090 咸鱼, currency: CNY, file: series/4090-xianyu.csv";

    // a manifest that says nothing: bars, and a profile with nothing in it
    expect(await syncOne(key, true)).toMatchObject({ ok: true });
    expect(readProfile(key)).toMatchObject({ profile: {}, error: null });
    expect(profileView(key, cfg)).toMatchObject({ profile: {}, links: [], pending: false });

    // the dataset's own words and links, for a series that has none of its own
    write("hebi8-dataset.yaml", `name: 显卡二手与零售价\ndescription: 每天抓取的显卡价格\nlinks:\n  - { name: 数据出处, url: https://example.org/gpu }\nseries:\n${series} }\n`);
    expect(await syncOne(key, true)).toMatchObject({ ok: true });
    expect(readProfile(key)!.profile).toEqual({ description: "每天抓取的显卡价格", links: [{ name: "数据出处", url: "https://example.org/gpu" }] });

    // the series' own come first; the same address is listed once; a bad protocol never gets in
    write(
      "hebi8-dataset.yaml",
      `name: 显卡二手与零售价\ndescription: 每天抓取的显卡价格\nlinks:\n  - { name: 数据出处, url: https://example.org/gpu }\n  - { name: 坏的, url: "javascript:alert(1)" }\nseries:\n${series}, description: 闲鱼上 RTX 4090 的每日中位成交价, links: [{ name: 闲鱼, url: "https://www.goofish.com/search?q=4090" }, { name: 出处, url: https://example.org/gpu }] }\n`,
    );
    // minutes later, not a week: the next sync reads it
    expect(await syncOne(key, true)).toMatchObject({ ok: true });
    expect(await adapters.data.profile!("here/4090-xianyu")).toEqual({
      description: "闲鱼上 RTX 4090 的每日中位成交价",
      links: [
        { name: "闲鱼", url: "https://www.goofish.com/search?q=4090" },
        { name: "出处", url: "https://example.org/gpu" },
      ],
    });
    expect(profileView(key, cfg)).toMatchObject({
      profile: { description: "闲鱼上 RTX 4090 的每日中位成交价" },
      links: [
        { label: "闲鱼", url: "https://www.goofish.com/search?q=4090" },
        { label: "出处", url: "https://example.org/gpu" },
      ],
    });
  });

  it("searches series that are on disk", async () => {
    const { adapters } = await import("@/lib/sources");
    const hits = await adapters.data.search!("咸鱼");
    expect(hits.map((h) => h.key).sort()).toEqual(["data:gpu/4090-xianyu", "data:here/4090-xianyu"]);
    expect((await adapters.data.search!("gpu")).map((h) => h.key)).toEqual(["data:gpu/4090-xianyu"]);
    expect(await adapters.data.search!("btc")).toEqual([]);
  });
});
