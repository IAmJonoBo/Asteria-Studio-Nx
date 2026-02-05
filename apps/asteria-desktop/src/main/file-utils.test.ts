import { describe, expect, it } from "vitest";
import { resolveConcurrency, runWithConcurrency } from "./file-utils.js";

describe("file-utils", () => {
  it("resolves concurrency from numeric strings", () => {
    expect(resolveConcurrency("8", 4)).toBe(8);
  });

  it("caps concurrency to max", () => {
    expect(resolveConcurrency(64, 4, 32)).toBe(32);
  });

  it("falls back for invalid values", () => {
    expect(resolveConcurrency("", 5)).toBe(5);
    expect(resolveConcurrency("nope", 7)).toBe(7);
    expect(resolveConcurrency(0, 3)).toBe(3);
  });

  it("runs workers with concurrency", async () => {
    const items = ["a", "b", "c"];
    const results = await runWithConcurrency(items, 2, async (item, index) => {
      return `${item}:${index}`;
    });
    expect(results).toEqual(["a:0", "b:1", "c:2"]);
  });

  it("returns empty list for no items", async () => {
    const results = await runWithConcurrency([], 4, async () => "noop");
    expect(results).toEqual([]);
  });
});
