import { afterEach, describe, expect, it } from "vitest";
import { iconLabel, isIconOnly, nextFocus, planActions } from "./a11y";
import { chooseLocale, currentLocale, initialLocale, LOCALE_CHOICES, savedLocaleId, startLocale } from "./locale";
import { formatValue } from "@cellforge/core";

describe("focus trap", () => {
  it("wraps at the ends and leaves the middle to the browser", () => {
    expect(nextFocus(2, 3, false)).toBe(0);
    expect(nextFocus(0, 3, true)).toBe(2);
    expect(nextFocus(0, 3, false)).toBeNull();
    expect(nextFocus(1, 3, true)).toBeNull();
  });

  it("pulls focus in from outside", () => {
    expect(nextFocus(-1, 3, false)).toBe(0);
    expect(nextFocus(-1, 3, true)).toBe(2);
  });

  it("handles one and none", () => {
    expect(nextFocus(0, 1, false)).toBe(0);
    expect(nextFocus(0, 1, true)).toBe(0);
    expect(nextFocus(-1, 0, false)).toBeNull();
  });
});

describe("icon-only buttons", () => {
  it("spots buttons with no words", () => {
    for (const t of ["×", "✕", "↑", "↓", " + ", "⋯"]) expect(isIconOnly(t)).toBe(true);
    for (const t of ["Close", "OK", "2", "", "  ", "Add a level", "Über"]) expect(isIconOnly(t)).toBe(false);
  });

  it("names them from the tooltip, else the symbol", () => {
    expect(iconLabel("↑", "Higher priority")).toBe("Higher priority");
    expect(iconLabel("×", "")).toBe("Close");
    expect(iconLabel("×", null)).toBe("Close");
    expect(iconLabel("↓")).toBe("Move down");
    expect(iconLabel("☃")).toBeNull();
  });
});

describe("locale setting", () => {
  afterEach(() => {
    chooseLocale("en-US");
  });

  it("offers each locale with a sample", () => {
    const ids = LOCALE_CHOICES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["en-US", "en-GB", "en-IN", "de-DE", "fr-FR"]));
    expect(LOCALE_CHOICES.find((c) => c.id === "de-DE")?.sample).toBe("1.234.567,89 · 14.03.2024");
    expect(LOCALE_CHOICES.find((c) => c.id === "en-IN")?.sample).toBe("12,34,567.89 · 14/03/2024");
    expect(LOCALE_CHOICES.find((c) => c.id === "en-US")?.sample).toBe("1,234,567.89 · 3/14/2024");
  });

  it("works without localStorage (node, private mode)", () => {
    expect(savedLocaleId()).toBeNull();
    expect(chooseLocale("de-DE").id).toBe("de-DE");
    expect(currentLocale().id).toBe("de-DE");
    expect(startLocale().id).toBe("en-US"); // nothing could be saved
  });

  it("picks the saved locale, then the browser's language, then en-US", () => {
    expect(initialLocale("fr-FR", ["de-DE"]).id).toBe("fr-FR");
    expect(initialLocale(null, ["de-AT", "en-US"]).id).toBe("de-DE");
    expect(initialLocale(null, ["ja-JP", "en-GB"]).id).toBe("en-GB");
    expect(initialLocale(null, ["ja-JP"]).id).toBe("en-US");
    expect(initialLocale(null, []).id).toBe("en-US");
  });

  it("changes what formatValue shows app-wide", () => {
    expect(formatValue(1234.5, "#,##0.00").text).toBe("1,234.50");
    chooseLocale("de-DE");
    expect(formatValue(1234.5, "#,##0.00").text).toBe("1.234,50");
  });
});

describe("dialog footer buttons", () => {
  const plan = (...b: { text: string; styled?: boolean; hidden?: boolean; disabled?: boolean }[]) => planActions(b);

  it("makes the last action primary and marks Cancel / Close", () => {
    expect(plan({ text: "Cancel" }, { text: "Add the result sheet" })).toEqual(["dismiss", "primary"]);
    expect(plan({ text: "Add" }, { text: "Run" }, { text: "Close" })).toEqual(["plain", "primary", "dismiss"]);
    expect(plan({ text: "Close" })).toEqual(["dismiss"]);
  });

  it("prefers the last action you can press now", () => {
    expect(plan({ text: "Close" }, { text: "Match" }, { text: "Add result sheets", disabled: true })).toEqual(["dismiss", "primary", "plain"]);
    expect(plan({ text: "Close" }, { text: "Add", disabled: true })).toEqual(["dismiss", "primary"]);
    expect(plan({ text: "Go" }, { text: "Later", hidden: true })).toEqual(["primary", "plain"]);
  });

  it("makes a destructive main action red", () => {
    expect(plan({ text: "Cancel" }, { text: "Delete 3 rows" })).toEqual(["dismiss", "danger"]);
  });

  it("leaves rows that already chose a style", () => {
    expect(plan({ text: "Cancel" }, { text: "Run", styled: true }, { text: "Save" })).toEqual(["dismiss", "plain", "plain"]);
  });
});
