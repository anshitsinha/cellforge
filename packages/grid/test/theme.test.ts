import { describe, expect, it } from "vitest";
import { contrastRatio, DARK, isDarkTheme, LIGHT, ROLE_COLORS, themedColor } from "../src/theme";

describe("cell colours by theme", () => {
  it("paints stored colours unchanged on a light grid", () => {
    expect(isDarkTheme(LIGHT)).toBe(false);
    expect(themedColor("#e8eaed", "fill", LIGHT)).toBe("#e8eaed");
    expect(themedColor("#202124", "ink", LIGHT)).toBe("#202124");
  });

  it("maps the templates' header grey and Excel's flag fills to dark twins", () => {
    expect(isDarkTheme(DARK)).toBe(true);
    expect(themedColor("#e8eaed", "fill", DARK)).toBe("#2f3237");
    expect(themedColor("#FFC7CE", "fill", DARK)).toBe("#4d2329");
    expect(themedColor("#ffeb9c", "fill", DARK)).toBe("#4a3b12");
  });

  it("turns any other pale fill into a deep tint, never a bright band", () => {
    const out = themedColor("#ffe0f0", "fill", DARK);
    expect(contrastRatio(out, DARK.text)).toBeGreaterThan(4.5);
    expect(contrastRatio(out, DARK.background)).toBeLessThan(2);
  });

  it("keeps text readable: near-black becomes the theme's text, dark colours are lifted", () => {
    expect(themedColor("#202124", "ink", DARK)).toBe(DARK.text);
    const red = themedColor("#9c0006", "ink", DARK);
    expect(contrastRatio(red, DARK.background)).toBeGreaterThan(4.5);
  });

  it("gives every role readable ink on its fill in both themes", () => {
    for (const t of ["light", "dark"] as const) for (const [role, c] of Object.entries(ROLE_COLORS[t])) expect(contrastRatio(c.ink, c.fill), `${t} ${role}`).toBeGreaterThan(4.5);
  });
});
