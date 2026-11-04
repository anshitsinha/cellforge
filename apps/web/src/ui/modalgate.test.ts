import { describe, expect, it } from "vitest";
import { canOpenOver, gateKey, type KeyInfo } from "./modalgate";
import { escBelongsToSelect, pickerAfter } from "./selectpicker";
import { pickFirstFocus } from "./dialog";

const k = (key: string, more: Partial<KeyInfo> = {}): KeyInfo => ({ key, ctrl: false, meta: false, alt: false, shift: false, editable: false, inside: true, ...more });

describe("one modal at a time", () => {
  it("lets everything through when no modal is open", () => {
    expect(gateKey(false, k("k", { ctrl: true }))).toBe("pass");
    expect(gateKey(false, k("F1"))).toBe("pass");
  });

  it("blocks the app's global shortcuts while a modal is open", () => {
    expect(gateKey(true, k("k", { ctrl: true }))).toBe("block"); // palette
    expect(gateKey(true, k("/", { ctrl: true }))).toBe("block"); // ask bar
    expect(gateKey(true, k("F1"))).toBe("block"); // guide
    expect(gateKey(true, k("F10"))).toBe("block"); // menu bar
    expect(gateKey(true, k("f", { ctrl: true }))).toBe("block"); // find
    expect(gateKey(true, k("k", { meta: true, inside: false }))).toBe("block");
  });

  it("always lets Esc through so the top modal can close", () => {
    expect(gateKey(true, k("Escape"))).toBe("pass");
    expect(gateKey(true, k("Escape", { inside: false }))).toBe("pass");
  });

  it("keeps typing and copy/paste working inside a field, away from the app", () => {
    expect(gateKey(true, k("a"))).toBe("stop");
    expect(gateKey(true, k("Enter"))).toBe("stop");
    expect(gateKey(true, k("Tab"))).toBe("stop");
    expect(gateKey(true, k("v", { ctrl: true, editable: true }))).toBe("stop");
    expect(gateKey(true, k("z", { ctrl: true, editable: true }))).toBe("stop");
    // Ctrl+Z outside a field must not undo the workbook behind the dialog
    expect(gateKey(true, k("z", { ctrl: true }))).toBe("block");
  });

  it("refuses to open a palette or command dialog over a modal", () => {
    expect(canOpenOver(0)).toBe(true);
    expect(canOpenOver(1)).toBe(false);
  });
});

describe("dialog focus and dropdowns", () => {
  const isSel = (s: string) => s.startsWith("select");
  it("starts on the first field that isn't a dropdown", () => {
    expect(pickFirstFocus(["select#kind", "input#name", "button"], isSel)).toBe("input#name");
  });
  it("starts on the dialog itself when it only has dropdowns", () => {
    expect(pickFirstFocus(["select#a", "select#b"], isSel)).toBe("dialog");
    expect(pickFirstFocus([], isSel)).toBe(null);
  });
  it("follows a select's picker so a closed select never swallows Esc", () => {
    let open = false;
    expect(escBelongsToSelect(open)).toBe(false); // focused, closed: Esc closes the dialog
    open = pickerAfter(open, "pointerdown");
    expect(escBelongsToSelect(open)).toBe(true); // open: Esc closes the picker
    open = pickerAfter(open, "escape");
    expect(escBelongsToSelect(open)).toBe(false); // the next Esc closes the dialog
    open = pickerAfter(pickerAfter(false, "open-key"), "change");
    expect(open).toBe(false);
    expect(pickerAfter(true, "pointerdown")).toBe(false); // a second click closes it
  });
});
