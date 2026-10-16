import { describe, expect, it } from "vitest";
import { indicatorLines } from "@/components/indicator-style";

const DEFAULTS = ["#FF9600", "#935EBD", "#1677FF"].map((color) => ({ style: "solid" as const, smooth: false, size: 1, dashedValue: [2, 2], color }));

describe("indicatorLines", () => {
  it("is null when nothing is styled, so the chart keeps its own", () => {
    expect(indicatorLines(DEFAULTS, [], 3)).toBeNull();
    expect(indicatorLines(DEFAULTS, undefined, 3)).toBeNull();
  });

  it("puts each line's own color, width and dash over the default it would cycle to", () => {
    const lines = indicatorLines(DEFAULTS, [{ color: "#f23645" }, {}, { size: 3, dash: "dashed" }], 5)!;
    expect(lines.map((l) => l.color)).toEqual(["#f23645", "#935EBD", "#1677FF", "#FF9600", "#935EBD"]);
    expect(lines.map((l) => l.size)).toEqual([1, 1, 3, 1, 1]);
    expect(lines[2]).toMatchObject({ style: "dashed", dashedValue: [6, 4] });
    expect(lines[0]).toMatchObject({ style: "solid", smooth: false });
  });

  it("covers every line, so a sixth MA does not take the first one's style", () => {
    const lines = indicatorLines(DEFAULTS, [{ color: "#000000" }], 4)!;
    expect(lines).toHaveLength(4);
    expect(lines[3].color).toBe("#FF9600");
  });
});
