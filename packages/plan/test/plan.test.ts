import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { counts, parsePlan } from "../src";

const sample = `# Plan

## Now

### Multiple sheets
- [x] Workbook model
- [ ] Tab bar with drag
  to reorder

## Milestones

### M1: Core 🔨
- ✅ Actions
- 🔨 Multiple sheets
- ⬜ Styles: font, size,
  colours

### M2: Formulas
- ⬜ Registry

## Quality bars
- ⬜ not a milestone item
`;

describe("parsePlan", () => {
  it("reads milestones, statuses and wrapped items", () => {
    const plan = parsePlan(sample);
    expect(plan.milestones.map((m) => [m.id, m.title, m.status])).toEqual([
      ["M1", "Core", "doing"],
      ["M2", "Formulas", "todo"],
    ]);
    expect(plan.milestones[0].items).toEqual([
      { status: "done", text: "Actions" },
      { status: "doing", text: "Multiple sheets" },
      { status: "todo", text: "Styles: font, size, colours" },
    ]);
  });

  it("reads the Now section", () => {
    const { now } = parsePlan(sample);
    expect(now).toEqual({
      title: "Multiple sheets",
      steps: [
        { done: true, text: "Workbook model" },
        { done: false, text: "Tab bar with drag to reorder" },
      ],
    });
  });

  it("counts progress", () => {
    expect(counts(parsePlan(sample).milestones[0].items)).toEqual({ done: 1, doing: 1, total: 3, percent: 33 });
  });

  it("parses the real plan: ten milestones, the Now item in progress", () => {
    const real = parsePlan(readFileSync(new URL("../../../docs/PLAN.md", import.meta.url), "utf8"));
    expect(real.milestones.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"]);
    const doing = real.milestones.flatMap((m) => m.items).filter((i) => i.status === "doing");
    // several items can be in progress at once (parallel work); the Now section names one of them
    expect(doing.length).toBeGreaterThanOrEqual(1);
    expect(doing.some((i) => i.text.startsWith(real.now!.title))).toBe(true);
    expect(real.milestones.flatMap((m) => m.items).length).toBeGreaterThan(60);
  });
});
