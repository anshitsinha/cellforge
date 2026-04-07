import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./palette";

describe("palette fuzzy matching", () => {
  it("matches letters in order and ranks word starts and prefixes higher", () => {
    expect(fuzzyScore("bld", "Bold")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "Bold")).toBe(-1);
    expect(fuzzyScore("bold", "Bold")).toBeGreaterThan(fuzzyScore("bold", "Number format: Long date"));
    expect(fuzzyScore("fr", "Freeze top row")).toBeGreaterThan(fuzzyScore("fr", "Clear formatting"));
    expect(fuzzyScore("ur", "Unfreeze panes")).toBeGreaterThan(0);
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});
