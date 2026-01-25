/**
 * The sheet tab bar. It only renders the workbook and turns gestures into
 * actions (via `run`); every change it makes is therefore undoable.
 *
 *   click: switch · double-click: rename · drag: reorder ·
 *   right-click: menu (rename, duplicate, colour, hide, delete) ·
 *   "+": new sheet · "≡": find a sheet by name, including hidden ones
 */
import type { Action } from "@cellforge/actions";
import type { Workbook } from "./workbook";

export interface TabsOptions {
  workbook: () => Workbook;
  active: () => string;
  switchTo: (id: string) => void;
  run: (action: Action) => Promise<unknown>;
}

const COLORS = ["#d93025", "#e37400", "#f9ab00", "#188038", "#1a73e8", "#9334e6", "#5f6368"];

export class SheetTabs {
  private menu: HTMLElement | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly opts: TabsOptions,
  ) {
    document.addEventListener("pointerdown", (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  render(): void {
    const wb = this.opts.workbook();
    const active = this.opts.active();
    this.el.replaceChildren();

    const add = button("+", "New sheet", "tab-tool");
    add.addEventListener("click", () => void this.opts.run({ type: "sheet.add", params: {} }));
    const list = button("≡", "All sheets (find by name)", "tab-tool");
    list.addEventListener("click", () => this.openList(list));
    this.el.append(add, list);

    const strip = document.createElement("div");
    strip.className = "tab-strip";
    strip.setAttribute("role", "tablist");
    for (const sheet of wb.visible) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `tab${sheet.id === active ? " active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(sheet.id === active));
      tab.textContent = sheet.name;
      tab.title = `${sheet.name}: double-click to rename, right-click for more`;
      tab.draggable = true;
      if (sheet.color) tab.style.setProperty("--tab-color", sheet.color);
      tab.addEventListener("click", () => this.opts.switchTo(sheet.id));
      tab.addEventListener("dblclick", () => this.rename(tab, sheet.id, sheet.name));
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.opts.switchTo(sheet.id);
        this.openMenu(e.clientX, e.clientY, sheet.id);
      });
      // drag to reorder: drop onto another tab to take its place
      tab.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/x-sheet", sheet.id);
        tab.classList.add("dragging");
      });
      tab.addEventListener("dragend", () => tab.classList.remove("dragging"));
      tab.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes("text/x-sheet")) {
          e.preventDefault();
          tab.classList.add("drop-target");
        }
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("drop-target"));
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        tab.classList.remove("drop-target");
        const moving = e.dataTransfer?.getData("text/x-sheet");
        if (moving && moving !== sheet.id) {
          void this.opts.run({ type: "sheet.move", params: { sheet: moving, index: wb.indexOf(sheet.id) } });
        }
      });
      strip.append(tab);
    }
    this.el.append(strip);
    strip.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Inline rename: the tab turns into a text box. */
  rename(tab: HTMLElement, id: string, current: string): void {
    const input = document.createElement("input");
    input.className = "tab-rename";
    input.value = current;
    input.maxLength = 31;
    input.setAttribute("aria-label", "Sheet name");
    tab.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (commit && name && name !== current) void this.opts.run({ type: "sheet.rename", params: { sheet: id, name } }).then(() => this.render());
      else this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  renameActive(): void {
    const tab = this.el.querySelector<HTMLElement>(".tab.active");
    const sheet = this.opts.workbook().get(this.opts.active());
    if (tab) this.rename(tab, sheet.id, sheet.name);
  }

  private openMenu(x: number, y: number, id: string): void {
    this.closeMenu();
    const wb = this.opts.workbook();
    const sheet = wb.get(id);
    const menu = document.createElement("div");
    menu.className = "tab-menu";
    menu.setAttribute("role", "menu");
    const item = (label: string, action: () => void, disabled = false) => {
      const b = button(label, label, "menu-item");
      b.setAttribute("role", "menuitem");
      b.disabled = disabled;
      b.addEventListener("click", () => {
        this.closeMenu();
        action();
      });
      menu.append(b);
    };
    const onlyOne = wb.visible.length === 1;
    item("Rename", () => this.renameActive());
    item("Duplicate", () => void this.opts.run({ type: "sheet.duplicate", params: { sheet: id } }));
    item("Hide", () => void this.opts.run({ type: "sheet.hide", params: { sheet: id, hidden: true } }), onlyOne);
    item("Delete", () => {
      if (sheet.source.editCount === 0 || confirm(`Delete "${sheet.name}"? You can undo this.`)) {
        void this.opts.run({ type: "sheet.delete", params: { sheet: id } });
      }
    }, onlyOne);
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    swatches.setAttribute("aria-label", "Tab colour");
    for (const color of [null, ...COLORS]) {
      const sw = button(color ? "" : "×", color ? `Colour ${color}` : "No colour", "swatch");
      if (color) sw.style.background = color;
      if ((sheet.color ?? null) === color) sw.classList.add("on");
      sw.addEventListener("click", () => {
        this.closeMenu();
        void this.opts.run({ type: "sheet.color", params: { sheet: id, color } });
      });
      swatches.append(sw);
    }
    menu.append(swatches);
    document.body.append(menu);
    // keep it on screen: tabs sit at the bottom, so the menu usually opens upwards
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    this.menu = menu;
    menu.querySelector<HTMLButtonElement>(".menu-item")?.focus();
  }

  /** The "≡" list: every sheet, filterable by name; hidden sheets can be unhidden from here. */
  private openList(anchor: HTMLElement): void {
    this.closeMenu();
    const wb = this.opts.workbook();
    const menu = document.createElement("div");
    menu.className = "tab-menu sheet-list";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Find a sheet…";
    search.setAttribute("aria-label", "Find a sheet");
    const list = document.createElement("div");
    list.className = "sheet-list-items";
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren();
      for (const sheet of wb.sheets.filter((x) => x.name.toLowerCase().includes(q))) {
        const b = button(sheet.hidden ? `${sheet.name} (hidden)` : sheet.name, sheet.name, "menu-item");
        if (sheet.id === this.opts.active()) b.classList.add("current");
        b.addEventListener("click", async () => {
          this.closeMenu();
          if (sheet.hidden) await this.opts.run({ type: "sheet.hide", params: { sheet: sheet.id, hidden: false } });
          this.opts.switchTo(sheet.id);
        });
        list.append(b);
      }
      if (!list.childElementCount) list.textContent = "No sheet matches.";
    };
    search.addEventListener("input", draw);
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") list.querySelector<HTMLButtonElement>("button")?.click();
      if (e.key === "Escape") this.closeMenu();
    });
    menu.append(search, list);
    draw();
    document.body.append(menu);
    const a = anchor.getBoundingClientRect();
    const r = menu.getBoundingClientRect();
    menu.style.left = `${a.left}px`;
    menu.style.top = `${Math.max(8, a.top - r.height - 6)}px`;
    this.menu = menu;
    search.focus();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}

function button(text: string, title: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}
