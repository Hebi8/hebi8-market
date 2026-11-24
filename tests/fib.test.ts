import { describe, expect, it } from "vitest";
import {
  FIB_DEFAULTS,
  FIB_LEVELS,
  FIB_PRESETS,
  activeFibLevels,
  applyFibTemplate,
  cleanFibSettings,
  fibBands,
  fibLevelsOf,
  fibPrice,
  fibSettingsOf,
  fibSpan,
  fibTemplateFrom,
  isDefaultFibLevels,
  isPresetFibTemplate,
  normalizeFibLevels,
} from "@/components/fib";

describe("fibonacci levels", () => {
  it("has TradingView's default levels in order, past 1 too", () => {
    expect(FIB_LEVELS.map((l) => l.level)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236]);
    for (const l of FIB_LEVELS) expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("extends a retracement past its first point", () => {
    // drawn from a high of 200 down to a low of 100: 0 at the low, 1 at the high, 1.618 above it
    const price = (level: number) => fibPrice("linear", [200, 100], level, false);
    expect(price(0)).toBe(100);
    expect(price(1)).toBe(200);
    expect(price(0.618)).toBeCloseTo(161.8);
    expect(price(1.618)).toBeCloseTo(261.8);
    // on a log drawing the extension is a ratio
    expect(fibPrice("log", [200, 100], 2.618, false)).toBeCloseTo(100 * 2 ** 2.618);
  });

  it("runs a reversed retracement past its second point, the points where they were", () => {
    // drawn from a low of 100 up to a high of 200: as drawn the extension goes down, reversed it goes up
    expect(fibPrice("linear", [100, 200], 1.618, false)).toBeCloseTo(38.2);
    const price = (level: number) => fibPrice("linear", [100, 200], level, true);
    expect(price(0)).toBe(100);
    expect(price(1)).toBe(200);
    expect(price(0.618)).toBeCloseTo(161.8);
    expect(price(1.618)).toBeCloseTo(261.8);
    expect(fibPrice("log", [100, 200], 2.618, true)).toBeCloseTo(100 * 2 ** 2.618);
  });

  it("counts an extension's move from the third point, and the other way when reversed", () => {
    // A 100 → B 200, pulled back to C 150
    expect(fibPrice("linear", [100, 200, 150], 0, false)).toBe(150);
    expect(fibPrice("linear", [100, 200, 150], 1, false)).toBe(250);
    expect(fibPrice("linear", [100, 200, 150], 1.618, false)).toBeCloseTo(311.8);
    expect(fibPrice("linear", [100, 200, 150], 0, true)).toBe(150);
    expect(fibPrice("linear", [100, 200, 150], 1, true)).toBe(50);
    // in a log drawing the move is a ratio: doubled from C, halved when reversed
    expect(fibPrice("log", [100, 200, 150], 1, false)).toBeCloseTo(300);
    expect(fibPrice("log", [100, 200, 150], 1, true)).toBeCloseTo(75);
    expect(fibPrice("log", [100, 200, 150], 4.236, true)).toBeGreaterThan(0);
  });
});

describe("fibonacci settings", () => {
  it("gives a drawing saved without any the defaults", () => {
    expect(fibSettingsOf(undefined)).toEqual({ background: true, transparency: 80, extendLeft: false, extendRight: false, oneColor: false, reverse: false });
    // ...and so has one saved before a setting was added
    expect(fibSettingsOf({ background: false, transparency: 60, extendLeft: false, extendRight: true, oneColor: false })).toMatchObject({ background: false, extendRight: true, reverse: false });
    expect(fibSettingsOf(undefined)).not.toBe(FIB_DEFAULTS);
  });

  it("reads what the drawing keeps", () => {
    expect(fibSettingsOf({ ...FIB_DEFAULTS, background: false, extendRight: true })).toMatchObject({ background: false, transparency: 80, extendRight: true });
  });
});

describe("fibonacci geometry", () => {
  it("runs the level lines between the two points, whichever came first", () => {
    expect(fibSpan(300, 120, FIB_DEFAULTS, 800)).toEqual([120, 300]);
    expect(fibSpan(120, 300, FIB_DEFAULTS, 800)).toEqual([120, 300]);
  });

  it("extends them to the pane's edge on the side asked for", () => {
    expect(fibSpan(120, 300, { extendLeft: true, extendRight: false }, 800)).toEqual([0, 300]);
    expect(fibSpan(120, 300, { extendLeft: false, extendRight: true }, 800)).toEqual([120, 800]);
    expect(fibSpan(120, 300, { extendLeft: true, extendRight: true }, 800)).toEqual([0, 800]);
    // points scrolled off the pane still bound the lines
    expect(fibSpan(-50, 900, { extendLeft: true, extendRight: true }, 800)).toEqual([-50, 900]);
  });

  it("fills between neighbouring levels in the colour of the further one", () => {
    const levels = [
      { y: 400, color: "grey" },
      { y: 350, color: "red" },
      { y: 320, color: "orange" },
    ];
    expect(fibBands(levels)).toEqual([
      { y: 350, height: 50, color: "red" },
      { y: 320, height: 30, color: "orange" },
    ]);
    // the same bands when the levels run down the pane
    expect(fibBands(levels.map((l) => ({ ...l, y: 800 - l.y })))).toEqual([
      { y: 400, height: 50, color: "red" },
      { y: 450, height: 30, color: "orange" },
    ]);
    expect(fibBands(FIB_LEVELS.map((l, i) => ({ ...l, y: i }))).length).toBe(FIB_LEVELS.length - 1);
  });
});

describe("custom fibonacci levels and templates", () => {
  it("ships 默认, 精简回撤 and Rule of 7 built-in presets", () => {
    expect(FIB_PRESETS.map((p) => p.name)).toEqual(["默认", "精简回撤", "Rule of 7"]);
    const compact = FIB_PRESETS.find((p) => p.name === "精简回撤")!;
    expect(compact.levels.map((l) => l.level)).toEqual([0, 0.382, 0.5, 0.618, 0.786, 1, 1.618]);
    const r7 = FIB_PRESETS.find((p) => p.name === "Rule of 7")!;
    expect(r7.levels.map((l) => l.level)).toEqual([0, 1, 1.75, 2.333, 3.5, 7]);
    expect(isPresetFibTemplate("Rule of 7")).toBe(true);
    expect(isPresetFibTemplate("我的模板")).toBe(false);
  });

  it("sorts active custom levels ascending, skips disabled ones, and falls back to defaults when none are enabled", () => {
    const custom = [
      { level: 1.618, color: "#2962ff" },
      { level: 0.236, color: "#f23645", enabled: false },
      { level: -0.272, color: "#00bcd4" },
      { level: 0.618, color: "#089981" },
    ];
    expect(activeFibLevels({ levels: custom }).map((l) => l.level)).toEqual([-0.272, 0.618, 1.618]);
    expect(activeFibLevels({})).toEqual(FIB_LEVELS);
    expect(activeFibLevels({ levels: [{ level: 0.5, color: "#4caf50", enabled: false }] })).toEqual(FIB_LEVELS);
  });

  it("omits levels when matching defaults, and keeps backward compatibility on legacy extendData", () => {
    expect(isDefaultFibLevels(undefined)).toBe(true);
    expect(isDefaultFibLevels(FIB_LEVELS.map((l) => ({ ...l })))).toBe(true);
    expect(isDefaultFibLevels(FIB_LEVELS.map((l, i) => (i === 1 ? { ...l, enabled: false } : { ...l })))).toBe(false);

    const def = applyFibTemplate(FIB_PRESETS[0]);
    expect(def).toEqual(FIB_DEFAULTS);
    expect("levels" in def).toBe(false);

    const r7 = applyFibTemplate(FIB_PRESETS[2]);
    expect(r7.levels?.map((l) => l.level)).toEqual([0, 1, 1.75, 2.333, 3.5, 7]);

    // Legacy object with no levels field still resolves cleanly
    expect(fibSettingsOf({ background: false, transparency: 70 })).toEqual({ ...FIB_DEFAULTS, background: false, transparency: 70 });
    expect(fibLevelsOf(fibSettingsOf(undefined)).map((l) => l.level)).toEqual(FIB_LEVELS.map((l) => l.level));
    // All-disabled levels in corrupt extendData are dropped so the drawing stays visible
    expect("levels" in fibSettingsOf({ levels: [{ level: 0.5, color: "#4caf50", enabled: false }] })).toBe(false);
  });

  it("normalizes levels and round-trips personal templates via fibTemplateFrom / applyFibTemplate", () => {
    expect(normalizeFibLevels([{ level: "0.5", color: "#ABC" }, { level: "bad", color: "#111" }, { level: 1, color: "nope", enabled: false }])).toEqual([
      { level: 0.5, color: "#aabbcc" },
      { level: 1, color: "#787b86", enabled: false },
    ]);

    const settings = cleanFibSettings({
      ...FIB_DEFAULTS,
      background: false,
      transparency: 90,
      extendRight: true,
      reverse: true,
      levels: [
        { level: 0, color: "#787b86" },
        { level: 1, color: "#787b86" },
        { level: 1.75, color: "#2962ff" },
      ],
    });
    const tpl = fibTemplateFrom("  我的规则  ", settings, { color: "#ff9800", size: 2, dash: "dashed" });
    expect(tpl).toEqual({
      name: "我的规则",
      levels: [
        { level: 0, color: "#787b86" },
        { level: 1, color: "#787b86" },
        { level: 1.75, color: "#2962ff" },
      ],
      background: false,
      transparency: 90,
      extendRight: true,
      reverse: true,
      color: "#ff9800",
      size: 2,
      dash: "dashed",
    });
    expect(applyFibTemplate(tpl)).toEqual(settings);

    // Explicit solid dash is preserved so a solid template resets a dashed Fib drawing back to solid
    const solidTpl = fibTemplateFrom("实线模板", settings, { color: "#2962ff", size: 1, dash: "solid" });
    expect(solidTpl.dash).toBe("solid");
  });
});
