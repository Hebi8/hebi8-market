import { describe, expect, it } from "vitest";
import { indicatorLines, styleRows } from "@/components/indicator-style";

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

describe("styleRows", () => {
  const ma = {
    figures: [1, 2, 3].map((i) => ({ key: `ma${i}`, title: `MA${[10, 40, 200][i - 1]}: `, type: "line" })),
    regenerateFigures: (params: number[]) => [...params.map((p, i) => ({ key: `ma${i + 1}`, title: `MA${p}: `, type: "line" })), { key: "volume", title: "VOLUME: ", type: "bar" }],
  };

  it("lists the lines an indicator draws now, by their legend titles, in their default look", () => {
    const rows = styleRows(DEFAULTS, ma);
    expect(rows.map((r) => r.title)).toEqual(["MA10", "MA40", "MA200"]);
    expect(rows[1]).toEqual({ title: "MA40", color: "#935EBD", size: 1, dash: "solid" });
  });

  it("follows periods typed but not saved yet, bars left out", () => {
    expect(styleRows(DEFAULTS, ma, [5, 10, 20, 40, 200]).map((r) => r.title)).toEqual(["MA5", "MA10", "MA20", "MA40", "MA200"]);
    expect(styleRows(DEFAULTS, ma, [])).toEqual([]);
  });

  it("keeps fixed lines when the indicator does not regenerate them", () => {
    const macd = { figures: [{ key: "dif", title: "DIF: ", type: "line" }, { key: "dea", title: "DEA: ", type: "line" }, { key: "macd", title: "MACD: ", type: "bar" }], regenerateFigures: null };
    expect(styleRows(DEFAULTS, macd, [12, 26, 9]).map((r) => r.title)).toEqual(["DIF", "DEA"]);
  });
});
