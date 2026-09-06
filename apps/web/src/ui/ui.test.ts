import { describe, expect, it } from "vitest";
import { actionResult, dialogSizeClass, orderActions } from "./dialog";
import { confirmActions } from "./confirm";
import { defaultDuration, MAX_TOASTS, ToastQueue } from "./toast";
import { clampPanelWidth, GRID_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, PanelStack } from "./sidepanel";
import { cellText, defaultAlign, formatCell, serialToIso } from "./table";
import { ICON_NAMES, iconSvg, resolveIcon } from "./icons";

describe("table formatting", () => {
  it("formats amounts with two places and brackets for negatives", () => {
    expect(formatCell(1234.5, "amount", "en-US")).toBe("1,234.50");
    expect(formatCell(-1234.5, "amount", "en-US")).toBe("(1,234.50)");
    expect(formatCell(0, "amount", "en-US")).toBe("0.00");
    expect(formatCell("8039.5", "amount", "en-US")).toBe("8,039.50");
  });

  it("formats integers, numbers and percents", () => {
    expect(formatCell(1234567.8, "integer", "en-US")).toBe("1,234,568");
    expect(formatCell(25152.5625, "number", "en-US")).toBe("25,152.56");
    expect(formatCell(0.125, "percent", "en-US")).toBe("12.5%");
  });

  it("follows the locale", () => {
    expect(formatCell(1234.5, "amount", "de-DE")).toBe("1.234,50");
  });

  it("turns spreadsheet serials, Dates and ISO text into dates", () => {
    expect(serialToIso(46023)).toBe("2026-01-01");
    expect(formatCell(46023, "date")).toBe("2026-01-01");
    expect(formatCell(new Date(Date.UTC(2026, 1, 8)), "date")).toBe("2026-02-08");
    expect(formatCell("2026-03-15", "date")).toBe("2026-03-15");
  });

  it("leaves blanks blank and non-numbers as text", () => {
    expect(formatCell(null, "amount")).toBe("");
    expect(formatCell(undefined)).toBe("");
    expect(formatCell("n/a", "amount")).toBe("n/a");
    expect(formatCell(Number.NaN, "number")).toBe("NaN");
    expect(formatCell("ACME", "text")).toBe("ACME");
  });

  it("aligns numbers right and the rest left", () => {
    for (const f of ["number", "integer", "amount", "percent"] as const) expect(defaultAlign(f)).toBe("right");
    for (const f of ["text", "date", undefined] as const) expect(defaultAlign(f)).toBe("left");
    expect(defaultAlign(() => "")).toBe("left");
  });

  it("reads a cell through value() or the key, and custom formats", () => {
    const row = { vendor: "Initech", amt: -5 };
    expect(cellText({ key: "vendor", label: "Vendor" }, row)).toBe("Initech");
    expect(cellText({ key: "x", label: "Amount", format: "amount", value: (r: typeof row) => r.amt }, row, "en-US")).toBe("(5.00)");
    expect(cellText({ key: "vendor", label: "V", format: (v) => String(v).toUpperCase() }, row)).toBe("INITECH");
  });
});

describe("toast queue", () => {
  it("keeps errors until closed and times the rest by kind", () => {
    expect(defaultDuration("error")).toBe(0);
    expect(defaultDuration("info")).toBe(4000);
    expect(defaultDuration("success")).toBe(4000);
    expect(defaultDuration("warning")).toBe(6000);
    expect(defaultDuration("info", true)).toBe(6000);
  });

  it("counts a repeated message instead of stacking it", () => {
    const q = new ToastQueue();
    const a = q.push({ text: "Saved" });
    const b = q.push({ text: "Saved" });
    expect(b.repeat).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.count).toBe(2);
    expect(q.items).toHaveLength(1);
    // same text, different kind: a new toast
    expect(q.push({ text: "Saved", kind: "error" }).repeat).toBe(false);
    expect(q.items).toHaveLength(2);
  });

  it("pushes out the oldest non-error when full", () => {
    const q = new ToastQueue();
    q.push({ text: "e1", kind: "error" });
    const first = q.push({ text: "i1" });
    q.push({ text: "i2" });
    q.push({ text: "i3" });
    expect(q.items).toHaveLength(MAX_TOASTS);
    const r = q.push({ text: "i4" });
    expect(r.evicted.map((t) => t.id)).toEqual([first.item.id]);
    expect(q.items.map((t) => t.text)).toEqual(["e1", "i2", "i3", "i4"]);
  });

  it("drops the oldest error when only errors are left", () => {
    const q = new ToastQueue(2);
    q.push({ text: "a", kind: "error" });
    q.push({ text: "b", kind: "error" });
    const r = q.push({ text: "c", kind: "error" });
    expect(r.evicted.map((t) => t.text)).toEqual(["a"]);
  });

  it("takes an explicit duration and removes by id", () => {
    const q = new ToastQueue();
    const { item } = q.push({ text: "Working…", duration: 0 });
    expect(item.duration).toBe(0);
    expect(q.remove(item.id)?.text).toBe("Working…");
    expect(q.remove(item.id)).toBeUndefined();
  });
});

describe("side panel", () => {
  it("clamps the width and always leaves the grid some room", () => {
    expect(clampPanelWidth(380, 1440)).toBe(380);
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, 1440)).toBe(PANEL_MAX);
    expect(clampPanelWidth(600, 800)).toBe(800 - GRID_MIN);
    expect(clampPanelWidth(500, 400)).toBe(PANEL_MIN);
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(PANEL_DEFAULT);
  });

  it("shows one panel at a time, with Back", () => {
    const s = new PanelStack<{ id: string }>();
    expect(s.open({ id: "history" }).left).toBeNull();
    expect(s.open({ id: "explain" }).left?.id).toBe("history");
    expect(s.canGoBack).toBe(true);
    expect(s.back()?.id).toBe("history");
    expect(s.current?.id).toBe("history");
    expect(s.back()).toBeNull();
    expect(s.current).toBeNull();
  });

  it("refreshes the same panel in place and never loops", () => {
    const s = new PanelStack<{ id: string }>();
    s.open({ id: "a" });
    expect(s.open({ id: "a" }).left).toBeNull();
    expect(s.history).toEqual([]);
    s.open({ id: "b" });
    s.open({ id: "a" });
    expect(s.history.map((h) => h.id)).toEqual(["b"]);
    s.open({ id: "c" });
    expect(s.history.map((h) => h.id)).toEqual(["b", "a"]);
    expect(s.close()?.id).toBe("c");
    expect(s.history).toEqual([]);
  });

  it("keeps a bounded history", () => {
    const s = new PanelStack<{ id: string }>(3);
    for (const id of ["1", "2", "3", "4", "5"]) s.open({ id });
    expect(s.history.map((h) => h.id)).toEqual(["2", "3", "4"]);
  });
});

describe("dialog", () => {
  it("puts the main action at the far right and tertiary ones at the left", () => {
    const acts = [
      { label: "Run", kind: "primary" as const },
      { label: "Close", dismiss: true },
      { label: "Reset", start: true },
      { label: "Preview" },
    ];
    const { start, end } = orderActions(acts);
    expect(start.map((a) => a.label)).toEqual(["Reset"]);
    expect(end.map((a) => a.label)).toEqual(["Close", "Preview", "Run"]);
  });

  it("names sizes and results", () => {
    expect(dialogSizeClass("lg")).toBe("cf-dialog--lg");
    expect(dialogSizeClass(undefined)).toBe("cf-dialog--md");
    expect(dialogSizeClass("huge")).toBe("cf-dialog--md");
    expect(actionResult({ label: "Add sheet" })).toBe("Add sheet");
    expect(actionResult({ label: "Add sheet", id: "add" })).toBe("add");
    expect(actionResult({ label: "Cancel", id: "cancel", dismiss: true })).toBe("dismiss");
  });

  it("builds confirmations with a danger button when asked", () => {
    expect(confirmActions({})).toEqual([
      { label: "Cancel", id: "cancel", dismiss: true },
      { label: "OK", id: "confirm", kind: "primary" },
    ]);
    const d = confirmActions({ confirm: "Delete", cancel: "Keep", danger: true });
    expect(d[0].label).toBe("Keep");
    expect(d[1]).toEqual({ label: "Delete", id: "confirm", kind: "danger" });
  });
});

describe("icons", () => {
  it("covers what the toolbar, menus and rail need", () => {
    for (const n of ["undo", "redo", "search", "sparkles", "upload", "open", "save", "download", "export", "share", "filter", "sort", "chart", "pivot", "table", "reconcile", "check", "audit", "shield", "signoff", "report", "settings", "help", "close", "chevron-down", "plus", "more", "play", "document", "database", "scale", "history"]) {
      expect(ICON_NAMES).toContain(n);
    }
  });

  it("draws in currentColor at the asked size, hidden from screen readers unless labelled", () => {
    const s = iconSvg("undo", { size: 20 });
    expect(s).toContain('width="20"');
    expect(s).toContain('stroke="currentColor"');
    expect(s).toContain('aria-hidden="true"');
    const l = iconSvg("search", { label: 'Find "x"' });
    expect(l).toContain('role="img"');
    expect(l).toContain('aria-label="Find &quot;x&quot;"');
  });

  it("knows the aliases and survives unknown names", () => {
    expect(resolveIcon("ai")).toBe("sparkles");
    expect(resolveIcon("evidence")).toBe("shield");
    expect(resolveIcon("nope")).toBeUndefined();
    expect(iconSvg("nope")).toContain("cf-icon-missing");
  });

  it("every icon is well-formed markup", () => {
    for (const n of ICON_NAMES) {
      const s = iconSvg(n);
      const opens = (s.match(/<(path|circle|rect|ellipse)\b/g) ?? []).length;
      const closes = (s.match(/\/>/g) ?? []).length;
      expect(opens, n).toBeGreaterThan(0);
      expect(closes, n).toBe(opens);
      expect(s, n).not.toMatch(/NaN|undefined/);
    }
  });
});
