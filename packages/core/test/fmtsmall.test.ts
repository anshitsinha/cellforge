import { describe, expect, it } from "vitest";
import { formatValue } from "../src";

describe("formatting tiny and whole numbers", () => {
  it.each([
    [1e-12, "#,##0.00"],
    [-1e-12, "#,##0.00;(#,##0.00)"],
    [1e-12, "General"],
    [6000, "#,##0.##"],
    [5e-7, "0.00"],
  ])("%s with %s", (v, code) => {
    const t = formatValue(v, code).text;
    expect(t).not.toMatch(/NaN/);
    if (code === "#,##0.##") expect(t).toBe("6,000."); // as Excel shows it
    if (code !== "General" && Math.abs(v) < 1e-6) expect(t.replace(/[()]/g, "")).toMatch(/^-?0(\.00)?$/);
  });
});
