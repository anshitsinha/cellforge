import { describe, expect, it } from "vitest";
import { buildCommands, COMMAND_GROUPS, devMode, GROUP_ICONS, sheetContext, sheetIsBlank, suggestedCommandIds, type AppCommand, type CommandDeps } from "./commands";
import { buildMenuModel, fitMenus, MENUS, menuEntries, overflowEntries, type MenuEntry, placeMenu } from "./menubar";
import { commandScore, paletteView, WEAK_MATCH } from "./palette";
import { classifyMessage, createNotifier } from "./messages";
import { ICON_NAMES } from "./ui/icons";
import { Workbook } from "./workbook";

/** Registry deps for tests: a real empty workbook; every action is a no-op. */
function fakeDeps(): CommandDeps {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const grid = { selection: { row: 0, col: 0 }, range: { top: 0, left: 0, bottom: 0, right: 0 } };
  const known: Partial<CommandDeps> = {
    workbook: () => wb,
    activeSheet: () => id,
    source: () => wb.sheets[0].source,
    grid: grid as unknown as CommandDeps["grid"],
    canUndo: () => false,
    canRedo: () => true,
    filterShowing: () => false,
    historyOpen: () => false,
    theme: () => "system",
    railCollapsed: () => false,
    names: { makeTable: () => 0, defineName: () => 0, manager: () => 0 },
    recorder: { steps: [] } as unknown as CommandDeps["recorder"],
  };
  return new Proxy(known, { get: (t, k: string) => (k in t ? t[k as keyof CommandDeps] : () => undefined) }) as CommandDeps;
}

const commands = buildCommands(fakeDeps());

describe("command registry", () => {
  it("has unique ids", () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every command a group, a title, a description and a known icon", () => {
    for (const c of commands) {
      expect(COMMAND_GROUPS, c.id).toContain(c.group);
      expect(c.title.trim(), c.id).not.toBe("");
      expect(c.description.trim().length, `${c.id} needs a description`).toBeGreaterThan(8);
      expect(c.description, `${c.id}: a description is one line`).not.toMatch(/\n/);
      expect(ICON_NAMES, `${c.id} icon ${c.icon}`).toContain(c.icon);
    }
    for (const g of COMMAND_GROUPS) expect(ICON_NAMES).toContain(GROUP_ICONS[g]);
  });

  it("never shows raw engine actions or developer wording", () => {
    for (const c of commands) {
      expect(c.title, c.id).not.toMatch(/^Action:|\b[a-z]+\.[a-z]+[A-Z]?\w*\b/);
      expect(c.id).not.toMatch(/^action:/);
      expect(c.description, c.id).not.toMatch(/spec null|params|\bundefined\b/);
    }
  });

  it("covers every group and keeps the ids the ask bar and the guide use", () => {
    for (const g of COMMAND_GROUPS) expect(commands.some((c) => c.group === g), g).toBe(true);
    for (const id of ["undo", "redo", "pivot", "reconcile", "explain", "ask", "ai-panel", "ask-guide", "categorise", "variants", "je-journal"]) expect(commands.some((c) => c.id === id), id).toBe(true);
  });

  it("knows what can't be done right now", () => {
    expect(commands.find((c) => c.id === "undo")?.disabled).toBe(true);
    expect(commands.find((c) => c.id === "redo")?.disabled).toBe(false);
  });

  it("developer mode is off unless asked for", () => {
    expect(devMode("")).toBe(false);
    expect(devMode("?dev=1")).toBe(true);
    expect(devMode("?a=b&dev=1")).toBe(true);
  });

  it("reads a sheet cheaply for suggestions", () => {
    const wb = new Workbook();
    expect(sheetIsBlank(wb.sheets[0].source)).toBe(true);
    expect(sheetContext(wb, wb.sheets[0].source)).toMatchObject({ empty: true, sheetCount: 1, headers: [] });
  });

  it("suggests what fits the sheet", () => {
    expect(suggestedCommandIds({ sheetCount: 1, empty: true, headers: [], rows: 0 })[0]).toBe("open");
    const gl = suggestedCommandIds({ sheetCount: 1, empty: false, headers: ["entry", "date", "account", "user", "amount"], rows: 900 });
    expect(gl[0]).toBe("je-journal");
    expect(gl).toContain("audit-duplicates");
    expect(suggestedCommandIds({ sheetCount: 2, empty: false, headers: ["date", "amount"], rows: 9 })[0]).toBe("reconcile");
    for (const ids of [gl]) for (const id of ids) expect(commands.some((c) => c.id === id), id).toBe(true);
  });
});

const flat = (items: MenuEntry[]): string[] => items.flatMap((e) => (e.kind === "item" ? [e.id] : e.kind === "submenu" ? e.items.map((i) => i.id) : []));

describe("menu bar model", () => {
  const menus = buildMenuModel(commands);

  it("has the menus in desktop order, all built from the registry", () => {
    expect(menus.map((m) => m.name)).toEqual(["File", "Edit", "View", "Insert", "Format", "Data", "Analyse", "Reconcile", "Audit", "Review", "Reports", "AI", "Help"]);
    const inMenus = new Set(menus.flatMap((m) => flat(m.items)));
    for (const c of commands) expect(inMenus.has(c.id), c.id).toBe(c.menu !== false);
    expect(MENUS.flatMap((m) => m.groups).sort()).toEqual([...COMMAND_GROUPS].sort());
  });

  it("puts each command in its group's menu", () => {
    const file = flat(menus.find((m) => m.name === "File")!.items);
    expect(file).toContain("save");
    expect(file).toContain("open");
    expect(flat(menus.find((m) => m.name === "Review")!.items)).toContain("evidence-pack");
    expect(flat(menus.find((m) => m.name === "Analyse")!.items)).toContain("pivot");
    expect(flat(menus.find((m) => m.name === "Data")!.items)).not.toContain("pivot");
  });

  it("keeps every menu short enough to fit a laptop screen", () => {
    for (const m of menus) {
      const rows = m.items.filter((e) => e.kind !== "sep").length;
      expect(rows, m.name).toBeLessThanOrEqual(20);
    }
  });

  it("never uses a check mark as a command icon (it reads as 'this option is on')", () => {
    for (const c of commands) expect(c.icon, c.id).not.toBe("check");
  });

  it("collects submenus and separates sections without doubled or trailing separators", () => {
    const format = menus.find((m) => m.name === "Format")!.items;
    const sub = format.find((e) => e.kind === "submenu" && e.title === "Number format");
    expect(sub && sub.kind === "submenu" && sub.items.length).toBeGreaterThan(5);
    for (const m of menus) {
      expect(m.items[0]?.kind, m.name).not.toBe("sep");
      expect(m.items[m.items.length - 1]?.kind, m.name).not.toBe("sep");
      m.items.forEach((e, i) => i && e.kind === "sep" && expect(m.items[i - 1].kind, m.name).not.toBe("sep"));
    }
  });

  it("menuEntries works on any list (the top bar's Save menu)", () => {
    const pick = (id: string, section: string): AppCommand => ({ ...commands.find((c) => c.id === id)!, section, submenu: undefined });
    const items = menuEntries([pick("save", "a"), pick("save-as", "a"), pick("export-xlsx", "b")]);
    expect(items.map((e) => e.kind)).toEqual(["item", "item", "sep", "item"]);
  });
});

describe("palette ranking", () => {
  const groups = COMMAND_GROUPS;

  it("shows Recent, then Suggested, then every group when the query is empty", () => {
    const v = paletteView(commands, "", { recent: ["pivot", "nope", "save"], suggested: ["reconcile", "pivot"], groups });
    expect(v.sections[0].title).toBe("Recent");
    expect(v.sections[0].items.map((c) => c.id)).toEqual(["pivot", "save"]);
    expect(v.sections[1].title).toBe("Suggested for this sheet");
    expect(v.sections[1].items.map((c) => c.id)).toEqual(["reconcile"]); // pivot is already in Recent
    expect(v.sections.slice(2).map((s) => s.title)).toEqual([...groups]);
    expect(v.askAi).toBeNull();
  });

  it("groups results under their group, best group first", () => {
    const v = paletteView(commands, "reconcile", { groups });
    expect(v.sections[0].title).toBe("Reconcile");
    expect(v.sections[0].items[0].id).toBe("reconcile");
    for (const s of v.sections) for (const c of s.items) expect(c.group).toBe(s.title);
  });

  it("ranks whole words above word starts: 'ai' finds AI before Align", () => {
    const v = paletteView(commands, "ai", { groups });
    expect(v.sections[0].title).toBe("AI");
    const align = commands.find((c) => c.id === "align-left")!;
    const ai = commands.find((c) => c.id === "ai-panel")!;
    expect(commandScore("ai", ai)).toBeGreaterThan(commandScore("ai", align));
  });

  it("matches hints by whole words, not scattered letters", () => {
    expect(commandScore("bank rec", commands.find((c) => c.id === "openitems-bankstatement")!)).toBeGreaterThan(0);
    expect(commandScore("benford", commands.find((c) => c.id === "audit-benford")!)).toBeGreaterThan(WEAK_MATCH);
    expect(commandScore("zqx", commands.find((c) => c.id === "audit-benford")!)).toBeLessThan(0);
    expect(paletteView(commands, "duplicate payments", { groups }).sections[0].items[0].id).toBe("audit-duplicates");
  });

  it("ends with an Ask AI row, selected first when nothing matches well", () => {
    const good = paletteView(commands, "pivot", { groups });
    expect(good.askAi).toBe("pivot");
    expect(good.initial).toBe(0);
    const none = paletteView(commands, "what were sales in march", { groups });
    expect(none.askAi).toBe("what were sales in march");
    expect(none.initial).toBe(none.count); // the Ask AI row
    expect(paletteView(commands, "pivot", { groups, askAi: false }).askAi).toBeNull();
  });

  it("doesn't let the locale entries answer for the word 'region'", () => {
    const v = paletteView(commands, "region", { groups });
    expect(v.sections.flatMap((s) => s.items).some((c) => c.id.startsWith("locale-"))).toBe(false);
  });
});

describe("messages", () => {
  it("sorts status text into toasts", () => {
    expect(classifyMessage("Couldn't open bank.xlsx: it's password-protected")).toBe("error");
    expect(classifyMessage("Autosave failed: quota")).toBe("error");
    expect(classifyMessage("Importing gl.csv — 40% (4 MB of 10 MB, 9 rows)")).toBe("progress");
    expect(classifyMessage("Opening bank.xlsx…")).toBe("progress");
    expect(classifyMessage("Reconciling needs two sheets: add the bank statement first.")).toBe("warning");
    expect(classifyMessage("Nothing to export yet — the sheet is empty.")).toBe("warning");
    expect(classifyMessage("Saved Bank rec Oct.cellforge")).toBe("success");
    expect(classifyMessage("Ready")).toBe("ignore");
  });

  it("shows progress in one toast and closes it with the result", () => {
    const shown: { kind: string; text: string; closed: boolean; updates: string[] }[] = [];
    const notify = createNotifier((o) => {
      const t = { ...o, closed: false, updates: [] as string[] };
      shown.push(t);
      return { id: shown.length, close: () => (t.closed = true), update: (x: string) => t.updates.push(x) };
    });
    notify("Exporting… 10%");
    notify("Exporting… 60%");
    expect(shown).toHaveLength(1);
    expect(shown[0].updates).toEqual(["Exporting… 60%"]);
    notify("Downloaded gl.csv");
    expect(shown[0].closed).toBe(true);
    expect(shown[1]).toMatchObject({ kind: "success", text: "Downloaded gl.csv" });
    notify.error("Invalid range");
    expect(shown[2]).toMatchObject({ kind: "error", text: "Invalid range" });
    notify.endProgress();
  });
});

describe("menu placement", () => {
  const bar = { left: 300, right: 360, top: 28, bottom: 52 };
  it("hangs a tall menu under the bar and scrolls inside it", () => {
    const p = placeMenu({ anchor: bar, width: 280, height: 884, side: false, alignEnd: false, viewW: 1440, viewH: 900 });
    expect(p.top).toBe(56);
    expect(p.maxHeight).toBe(900 - 56 - 8);
  });
  it("leaves a short menu at its height", () => {
    expect(placeMenu({ anchor: bar, width: 280, height: 300, side: false, alignEnd: false, viewW: 1440, viewH: 900 })).toEqual({ left: 300, top: 56, maxHeight: null });
  });
  it("keeps a menu on a narrow screen", () => {
    expect(placeMenu({ anchor: { left: 350, right: 380, top: 28, bottom: 52 }, width: 280, height: 300, side: false, alignEnd: false, viewW: 390, viewH: 844 }).left).toBe(102);
  });
  it("flips a submenu left at the right edge and lifts it only as far as needed", () => {
    const p = placeMenu({ anchor: { left: 1200, right: 1430, top: 800, bottom: 830 }, width: 240, height: 200, side: true, alignEnd: false, viewW: 1440, viewH: 900 });
    expect(p.left).toBe(1200 - 240 + 4);
    expect(p.top).toBe(900 - 200 - 8);
  });
});

describe("menu bar overflow", () => {
  const w = [40, 40, 44, 48, 56, 44, 60, 72, 48, 58, 60, 28, 46];
  it("shows every menu when they fit", () => {
    expect(fitMenus(w, 2000, 56)).toBe(w.length);
  });
  it("puts the menus that don't fit under More", () => {
    expect(fitMenus(w, 300, 56)).toBe(5); // 56 + 40+40+44+48+56 = 284
  });
  it("uses one Menu button when only a couple would fit (phones)", () => {
    expect(fitMenus(w, 150, 56)).toBe(0);
  });
  it("lists hidden menus as submenus with their own submenus flattened", () => {
    const menus = buildMenuModel(commands);
    const more = overflowEntries(menus.slice(-2));
    expect(more.map((e) => e.kind === "submenu" && e.title)).toEqual(["AI", "Help"]);
    for (const e of more) if (e.kind === "submenu") for (const it of e.items) expect(it.kind).toBe("item");
  });
});
