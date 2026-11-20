import { describe, expect, it } from "vitest";
import { applyOp, groupNames, mergeTarget, opError, stepGroup, stepSymbol, type ListGroup } from "@/lib/watchlist";

const list = (): ListGroup<{ key: string }>[] => [
  { name: "美股", items: [{ key: "a" }, { key: "b" }, { key: "c" }] },
  { name: "宏观", items: [] },
  { name: "加密", items: [{ key: "x" }] },
];
const keys = (groups: ListGroup<{ key: string }>[]) => groups.map((g) => `${g.name}:${g.items.map((i) => i.key).join("")}`);

describe("watchlist edits (what the page shows before the yaml is written)", () => {
  it("moves a symbol within its group and into another, counting without the moved one", () => {
    expect(keys(applyOp(list(), { type: "moveSymbol", key: "a", group: "美股", index: 2 }))).toEqual(["美股:bca", "宏观:", "加密:x"]);
    expect(keys(applyOp(list(), { type: "moveSymbol", key: "c", group: "美股", index: 0 }))).toEqual(["美股:cab", "宏观:", "加密:x"]);
    expect(keys(applyOp(list(), { type: "moveSymbol", key: "b", group: "宏观", index: 0 }))).toEqual(["美股:ac", "宏观:b", "加密:x"]);
    expect(keys(applyOp(list(), { type: "moveSymbol", key: "x", group: "新组", index: 0 }))).toEqual(["美股:abc", "宏观:", "加密:", "新组:x"]);
  });

  it("removes a symbol and leaves its group in place, even when that empties it", () => {
    expect(keys(applyOp(list(), { type: "removeSymbol", key: "b" }))).toEqual(["美股:ac", "宏观:", "加密:x"]);
    expect(keys(applyOp(list(), { type: "removeSymbol", key: "x" }))).toEqual(["美股:abc", "宏观:", "加密:"]);
    expect(keys(applyOp(list(), { type: "removeSymbol", key: "nope" }))).toEqual(keys(list()));
  });

  it("moves, adds, renames and deletes groups; a deleted group's symbols join the one above, or below for the first", () => {
    expect(keys(applyOp(list(), { type: "moveGroup", name: "加密", index: 0 }))).toEqual(["加密:x", "美股:abc", "宏观:"]);
    expect(keys(applyOp(list(), { type: "addGroup", name: "港 A" })).at(-1)).toBe("港 A:");
    expect(keys(applyOp(list(), { type: "renameGroup", name: "宏观", next: "指数" }))[1]).toBe("指数:");
    expect(keys(applyOp(list(), { type: "deleteGroup", name: "加密" }))).toEqual(["美股:abc", "宏观:x"]);
    expect(keys(applyOp(list(), { type: "deleteGroup", name: "美股" }))).toEqual(["宏观:abc", "加密:x"]);
    expect(mergeTarget(list(), "美股")).toBe("宏观");
    expect(mergeTarget(list(), "加密")).toBe("宏观");
    expect(mergeTarget([{ name: "only", items: [] }], "only")).toBeNull();
  });

  it("refuses what the server refuses, with its message, and changes nothing then", () => {
    const only = [{ name: "全部", items: [{ key: "a" }] }];
    expect(opError(only, { type: "deleteGroup", name: "全部" })).toBe("这是唯一的分组，先移除里面的标的");
    expect(applyOp(only, { type: "deleteGroup", name: "全部" })).toBe(only);
    expect(opError(list(), { type: "addGroup", name: " 宏观 " })).toBe("已经有「宏观」分组了");
    expect(opError(list(), { type: "renameGroup", name: "宏观", next: "加密" })).toBe("已经有「加密」分组了");
    expect(opError(list(), { type: "moveSymbol", key: "nope", group: "宏观", index: 0 })).toBe("nope 不在自选里");
    expect(opError(list(), { type: "moveGroup", name: "nope", index: 0 })).toBe("没有「nope」这个分组");
    expect(opError(list(), { type: "removeSymbol", key: "nope" })).toBeNull();
    // an empty only group can go
    expect(applyOp([{ name: "空", items: [] }], { type: "deleteGroup", name: "空" })).toEqual([]);
  });

  it("names every group uniquely: written names first, unnamed ones by position, numbered when taken", () => {
    expect(groupNames(["美股", null, null])).toEqual(["美股", "组 2", "组 3"]);
    expect(groupNames(["组 2", null])).toEqual(["组 2", "组 2 (2)"]);
    expect(groupNames([null, "组 1"])).toEqual(["组 1 (2)", "组 1"]);
    expect(groupNames(["美股", "美股", "美股 (2)"])).toEqual(["美股", "美股 (3)", "美股 (2)"]);
  });

  it("steps with the keyboard across group edges, and stops at either end", () => {
    expect(stepSymbol(list(), "b", -1)).toEqual({ group: "美股", index: 0 });
    expect(stepSymbol(list(), "c", 1)).toEqual({ group: "宏观", index: 0 });
    expect(stepSymbol(list(), "x", -1)).toEqual({ group: "宏观", index: 0 });
    expect(stepSymbol(list(), "a", -1)).toBeNull();
    expect(stepSymbol(list(), "x", 1)).toBeNull();
    expect(stepGroup(list(), "宏观", -1)).toBe(0);
    expect(stepGroup(list(), "加密", 1)).toBeNull();
  });
});
