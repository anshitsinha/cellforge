import { describe, expect, it } from "vitest";
import { analyze, argAt } from "./formulaassist";

const at = (s: string) => {
  const caret = s.indexOf("|");
  return analyze(s.replace("|", ""), caret);
};

describe("formula assist", () => {
  it("suggests function names while typing them", () => {
    const a = at("=SU|");
    expect(a?.kind).toBe("names");
    if (a?.kind === "names") {
      const names = a.matches.map((f) => f.name);
      expect(names[0]).toBe("SUM");
      expect(names).toContain("SUMIFS");
      expect(names.every((n) => n.startsWith("SU"))).toBe(true);
    }
    expect(at("=1+co|")?.kind).toBe("names");
  });

  it("leaves references and plain text alone", () => {
    expect(at("=A1|")).toBeNull();
    expect(at("=Sheet2!B|")).toBeNull();
    expect(at("hello SU|")).toBeNull();
    expect(at('="SU|"')).toBeNull();
  });

  it("knows which argument the caret is on, through nested calls and strings", () => {
    const a = at('=SUMIF(B1:B5, "a,b", |');
    expect(a?.kind).toBe("args");
    if (a?.kind === "args") {
      expect(a.fn.name).toBe("SUMIF");
      expect(a.index).toBe(2);
    }
    const b = at("=IF(ROUND(A1, 2|), 1, 0)");
    expect(b?.kind === "args" && [b.fn.name, b.index]).toEqual(["ROUND", 1]);
    const after = at("=IF(ROUND(A1, 2)|, 1, 0)");
    expect(after?.kind === "args" && [after.fn.name, after.index]).toEqual(["IF", 0]);
    const c = at("=IF(ROUND(A1, 2), |1, 0)");
    expect(c?.kind === "args" && [c.fn.name, c.index]).toEqual(["IF", 1]);
  });

  it("repeating arguments cover the rest", async () => {
    const { FUNCTION_INFO } = await import("@cellforge/core");
    expect(argAt(FUNCTION_INFO.SUM, 5)).toBe(1);
    expect(argAt(FUNCTION_INFO.ROUND, 5)).toBe(-1);
  });
});
