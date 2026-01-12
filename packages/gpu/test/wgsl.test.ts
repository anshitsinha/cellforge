import { parseFormula } from "@cellforge/core";
import { describe, expect, it } from "vitest";
import { compileWgsl } from "../src/wgsl";

describe("compileWgsl", () => {
  it("generates a shader with one binding per input column", () => {
    const k = compileWgsl(parseFormula("=A1*B1*(1-C1)"), 0)!;
    expect(k.columns.map((c) => c.col)).toEqual([0, 1, 2]);
    expect(k.code).toContain("@binding(5) var<storage, read> in2");
    expect(k.code).toContain("out[k] = ");
  });

  it("anchored refs become scalars, offsets are tracked", () => {
    const k = compileWgsl(parseFormula("=A2-A1+$B$1"), 1)!;
    expect(k.scalars).toEqual([{ col: 1, row: 0 }]);
    expect(k.minOffset).toBe(-1);
    expect(k.maxOffset).toBe(0);
  });

  it("emits float literals WGSL accepts", () => {
    const k = compileWgsl(parseFormula("=A1*2+0.5"), 0)!;
    expect(k.code).toContain("f32(2.0)");
    expect(k.code).toContain("f32(0.5)");
  });

  it("maps IF to select(false, true, cond)", () => {
    const k = compileWgsl(parseFormula("=IF(A1>B1, 1, 2)"), 0)!;
    expect(k.code).toMatch(/select\(f32\(2\.0\), f32\(1\.0\), \(.+ > .+\)\)/);
  });

  it("returns null outside the supported subset", () => {
    expect(compileWgsl(parseFormula('="a"&A1'), 0)).toBeNull();
    expect(compileWgsl(parseFormula("=SUM(A1:A5)"), 0)).toBeNull();
  });
});
