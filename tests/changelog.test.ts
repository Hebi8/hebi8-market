import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogBody, newerMinor } from "@/lib/changelog";

describe("newerMinor", () => {
  it("counts a later minor or major release, not a patch", () => {
    expect(newerMinor("0.3.0", "0.2.0")).toBe(true);
    expect(newerMinor("0.3.1", "0.2.4")).toBe(true);
    expect(newerMinor("1.0.0", "0.9.3")).toBe(true);
    expect(newerMinor("0.2.1", "0.2.0")).toBe(false);
    expect(newerMinor("0.2.0", "0.2.0")).toBe(false);
    expect(newerMinor("0.2.0", "0.3.0")).toBe(false);
    expect(newerMinor("0.10.0", "0.9.0")).toBe(true);
  });

  it("ignores what is not a version", () => {
    expect(newerMinor("0.3.0", "")).toBe(false);
    expect(newerMinor("0.3.0", "garbage")).toBe(false);
  });
});

describe("CHANGELOG.md", () => {
  it("starts with a version section after the page drops its title", () => {
    const body = changelogBody(readFileSync("CHANGELOG.md", "utf8"));
    expect(body.startsWith("每个版本")).toBe(true);
    expect(body).toMatch(/^## v\d+\.\d+\.\d+ — /m);
  });
});
