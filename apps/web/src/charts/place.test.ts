import { describe, expect, it } from "vitest";
import { compactNumber, tickLabel } from "./axes";
import { placeChart } from "./place";

const view = { left: 72, top: 128, right: 1430, bottom: 860 };
const overlaps = (f: { x: number; y: number; w: number; h: number }, d: { left: number; top: number; right: number; bottom: number }) => f.x < d.right && f.x + f.w > d.left && f.y < d.bottom && f.y + f.h > d.top;

describe("placing a new chart", () => {
  it("goes to the right of narrow data", () => {
    const data = { left: 112, top: 152, right: 600, bottom: 840 };
    const f = placeChart(view, data);
    expect(f.clear).toBe(true);
    expect(f.x).toBeGreaterThanOrEqual(600);
    expect(overlaps(f, data)).toBe(false);
    expect(f.x + f.w).toBeLessThanOrEqual(view.right);
  });
  it("goes below wide, short data", () => {
    const data = { left: 112, top: 152, right: 1400, bottom: 400 };
    const f = placeChart(view, data);
    expect(f.clear).toBe(true);
    expect(f.y).toBeGreaterThanOrEqual(400);
    expect(overlaps(f, data)).toBe(false);
    expect(f.y + f.h).toBeLessThanOrEqual(view.bottom);
  });
  it("falls back to a small chart in the corner when the data fills the screen", () => {
    const f = placeChart(view, { left: 112, top: 152, right: 1420, bottom: 2000 });
    expect(f.clear).toBe(false);
    expect(f.w).toBeLessThanOrEqual(380);
  });
});

describe("axis labels", () => {
  it("are short for amounts", () => {
    const fmt = "#,##0.00;(#,##0.00)";
    expect([-500_000, 0, 500_000, 1_000_000].map((v) => tickLabel(v, fmt, 500_000))).toEqual(["(500k)", "0", "500k", "1M"]);
    expect(tickLabel(1_500_000, "#,##0.00", 500_000)).toBe("1.5M");
    expect(tickLabel(50, fmt, 10)).toBe("50");
    expect(tickLabel(0.25, "0.0%", 0.05)).toBe("25.0%");
    expect(compactNumber(-2500, "£#,##0;-£#,##0")).toBe("-£2.5k");
  });
});
