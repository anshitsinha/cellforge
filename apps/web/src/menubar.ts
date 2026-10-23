/**
 * The menu bar (File Edit View … Help) and the top bar's drop-down menus,
 * built from the command registry, so every menu item is also in the
 * palette and the other way round.
 *
 * Keyboard, as in desktop apps: Alt (pressed and released on its own) or
 * F10 focuses the bar; Left/Right move between menus; Down, Enter or Space
 * opens one; Up/Down/Home/End move in it, Right opens a submenu and Left
 * closes it; a letter jumps to the next item starting with it; Esc closes
 * (a second Esc returns to the sheet).
 */
import { COMMAND_GROUPS, type AppCommand, type CommandGroup } from "./commands";
import { icon } from "./ui/icons";
import { isModalOpen } from "./ui/modalgate";

// ---------------------------------------------------------------- model --

export interface MenuCommandItem {
  kind: "item";
  id: string;
  title: string;
  keys?: string;
  icon?: string;
  disabled?: boolean;
  run: () => unknown;
}
export interface MenuSubmenu {
  kind: "submenu";
  title: string;
  items: MenuCommandItem[];
}
export interface MenuSeparator {
  kind: "sep";
}
export type MenuEntry = MenuCommandItem | MenuSubmenu | MenuSeparator;

export interface Menu {
  name: string;
  items: MenuEntry[];
}

/** The menus, left to right, and the registry groups each one shows. */
export const MENUS: { name: string; groups: CommandGroup[] }[] = [
  { name: "File", groups: ["File"] },
  { name: "Edit", groups: ["Edit"] },
  { name: "View", groups: ["View"] },
  { name: "Insert", groups: ["Insert"] },
  { name: "Format", groups: ["Format"] },
  { name: "Data", groups: ["Data", "Analyse"] },
  { name: "Reconcile", groups: ["Reconcile"] },
  { name: "Audit", groups: ["Audit"] },
  { name: "Review", groups: ["Evidence & review"] },
  { name: "Reports", groups: ["Reports"] },
  { name: "AI", groups: ["AI"] },
  { name: "Help", groups: ["Help"] },
];

// every group has a menu
for (const g of COMMAND_GROUPS) if (!MENUS.some((m) => m.groups.includes(g))) throw new Error(`no menu shows the ${g} group`);

// a generic icon ("settings") adds nothing in a menu, so menus leave it out
const toItem = (c: AppCommand, title = c.title): MenuCommandItem => ({ kind: "item", id: c.id, title, keys: c.keys, icon: c.icon === "settings" ? undefined : c.icon, disabled: c.disabled, run: c.run });

/** "Number format: Percent" inside the Number format submenu is just "Percent". */
function shortTitle(title: string, submenu: string): string {
  const prefix = `${submenu}: `;
  if (!title.toLowerCase().startsWith(prefix.toLowerCase())) return title;
  const rest = title.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Menu entries for a list of commands, in their order: a separator between
 * sections (and groups), and commands that share a submenu collected into
 * one submenu where the first of them appears.
 */
export function menuEntries(commands: readonly AppCommand[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  const subs = new Map<string, MenuSubmenu>();
  let lastKey: string | null = null;
  for (const c of commands) {
    if (c.menu === false) continue;
    const key = `${c.group}/${c.section ?? ""}`;
    if (lastKey !== null && key !== lastKey && out.length && out[out.length - 1].kind !== "sep") {
      // a submenu continuing in a later section stays where it is
      if (!(c.submenu && subs.has(`${c.group}/${c.submenu}`))) out.push({ kind: "sep" });
    }
    lastKey = key;
    if (c.submenu) {
      const sk = `${c.group}/${c.submenu}`;
      let sub = subs.get(sk);
      if (!sub) {
        sub = { kind: "submenu", title: c.submenu, items: [] };
        subs.set(sk, sub);
        out.push(sub);
      }
      sub.items.push(toItem(c, shortTitle(c.title, c.submenu)));
    } else out.push(toItem(c));
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

/** The whole menu bar, from the registry. Pure. */
export function buildMenuModel(commands: readonly AppCommand[]): Menu[] {
  return MENUS.map((m) => ({ name: m.name, items: menuEntries(m.groups.flatMap((g) => commands.filter((c) => c.group === g))) }));
}

// ------------------------------------------------------------- dropdown --

let openDrop: { el: HTMLElement; close: (focusAnchor: boolean) => void } | null = null;

/** Close whatever drop-down menu is open. */
export function closeMenus(focusAnchor = false): void {
  openDrop?.close(focusAnchor);
}

export interface DropdownOptions {
  /** where it hangs from */
  anchor: HTMLElement;
  items: MenuEntry[];
  /** after an item ran or the menu was dismissed */
  onDone?: (how: "run" | "dismiss" | "left" | "right") => void;
  /** focus the first item (keyboard) rather than the menu itself */
  focusFirst?: boolean;
  align?: "start" | "end";
  /** a submenu: hangs to the side */
  side?: boolean;
  className?: string;
}

function itemButton(entry: MenuCommandItem | MenuSubmenu): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cf-menu__item";
  b.setAttribute("role", "menuitem");
  b.tabIndex = -1;
  const ic = document.createElement("span");
  ic.className = "cf-menu__icon";
  if (entry.kind === "item" && entry.icon) ic.append(icon(entry.icon));
  const label = document.createElement("span");
  label.className = "cf-menu__label";
  label.textContent = entry.title;
  b.append(ic, label);
  if (entry.kind === "submenu") {
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    const chev = icon("chevron-right");
    chev.classList.add("cf-menu__chev");
    b.append(chev);
  } else if (entry.keys) {
    const k = document.createElement("kbd");
    k.textContent = entry.keys;
    b.append(k);
  }
  if (entry.kind === "item" && entry.disabled) b.setAttribute("aria-disabled", "true");
  return b;
}

/** Show a drop-down menu under (or beside) an element. Returns its element. */
export function openDropdown(o: DropdownOptions): HTMLElement {
  if (!o.side) closeMenus();
  const menu = document.createElement("div");
  menu.className = `cf-menu${o.className ? ` ${o.className}` : ""}`;
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  const label = o.anchor.getAttribute("aria-label") ?? o.anchor.textContent?.trim() ?? "";
  menu.setAttribute("aria-label", label);
  const buttons: { b: HTMLButtonElement; entry: MenuCommandItem | MenuSubmenu }[] = [];
  let child: HTMLElement | null = null;
  let childOf: HTMLButtonElement | null = null;

  const closeChild = () => {
    child?.remove();
    child = null;
    childOf?.setAttribute("aria-expanded", "false");
    childOf?.classList.remove("is-open");
    childOf = null;
  };

  const finish = (how: "run" | "dismiss" | "left" | "right", focusAnchor: boolean) => {
    closeChild();
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
    if (!o.side && openDrop?.el === menu) openDrop = null;
    o.anchor.setAttribute("aria-expanded", "false");
    o.anchor.classList.remove("is-open");
    if (focusAnchor) o.anchor.focus();
    o.onDone?.(how);
  };
  const dismiss = () => finish("dismiss", false);
  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (menu.contains(t) || child?.contains(t)) return;
    if (!o.side && o.anchor.contains(t)) return; // the anchor toggles itself
    if (o.side) return;
    finish("dismiss", false);
  };

  const openSub = (b: HTMLButtonElement, sub: MenuSubmenu, focus: boolean) => {
    if (childOf === b) {
      if (focus) child?.querySelector<HTMLElement>(".cf-menu__item:not([aria-disabled])")?.focus();
      return;
    }
    closeChild();
    childOf = b;
    b.setAttribute("aria-expanded", "true");
    b.classList.add("is-open");
    child = openDropdown({
      anchor: b,
      items: sub.items,
      side: true,
      focusFirst: focus,
      onDone: (how) => {
        child = null;
        childOf?.setAttribute("aria-expanded", "false");
        childOf?.classList.remove("is-open");
        childOf = null;
        if (how === "run") finish("run", false);
        else if (how === "left" || how === "dismiss") b.focus();
      },
    });
  };

  for (const entry of o.items) {
    if (entry.kind === "sep") {
      const s = document.createElement("div");
      s.className = "cf-menu__sep";
      s.setAttribute("role", "separator");
      menu.append(s);
      continue;
    }
    const b = itemButton(entry);
    buttons.push({ b, entry });
    b.addEventListener("click", () => {
      if (entry.kind === "submenu") return openSub(b, entry, true);
      if (entry.disabled) return;
      finish("run", false);
      void Promise.resolve(entry.run());
    });
    b.addEventListener("pointerenter", () => {
      b.focus({ preventScroll: true });
      if (entry.kind === "submenu") openSub(b, entry, false);
      else closeChild();
    });
    menu.append(b);
  }

  menu.addEventListener("keydown", (e) => {
    const list = buttons.map((x) => x.b);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      const n = list.length;
      if (!n) return;
      list[((to % n) + n) % n].focus();
    };
    const cur = i >= 0 ? buttons[i] : null;
    switch (e.key) {
      case "ArrowDown":
        move(i + 1);
        break;
      case "ArrowUp":
        move(i < 0 ? list.length - 1 : i - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(list.length - 1);
        break;
      case "ArrowRight":
        if (cur?.entry.kind === "submenu") openSub(cur.b, cur.entry, true);
        else if (!o.side) finish("right", false);
        break;
      case "ArrowLeft":
        finish(o.side ? "left" : "left", false);
        break;
      case "Escape":
        finish("dismiss", !o.side);
        break;
      case "Tab":
        finish("dismiss", false);
        return;
      case "Enter":
      case " ":
        cur?.b.click();
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const k = e.key.toLowerCase();
          for (let j = 1; j <= list.length; j++) {
            const at = (Math.max(i, 0) + j) % list.length;
            if (buttons[at].entry.title.toLowerCase().startsWith(k)) {
              list[at].focus();
              break;
            }
          }
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  document.body.append(menu);
  // place it: under the anchor, or to its right for a submenu; kept on screen
  const a = o.anchor.getBoundingClientRect();
  const r = menu.getBoundingClientRect();
  let left = o.side ? a.right - 4 : o.align === "end" ? a.right - r.width : a.left;
  let top = o.side ? a.top - 5 : a.bottom + 4;
  if (o.side && left + r.width > innerWidth - 8) left = a.left - r.width + 4;
  left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
  top = Math.max(8, Math.min(top, innerHeight - r.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  o.anchor.setAttribute("aria-expanded", "true");
  o.anchor.classList.add("is-open");
  if (!o.side) {
    openDrop = { el: menu, close: (f) => finish("dismiss", f) };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
  }
  if (o.focusFirst) (buttons.find((x) => x.b.getAttribute("aria-disabled") !== "true")?.b ?? menu).focus();
  else menu.focus();
  return menu;
}

/** A button that opens a menu of commands (the top bar's Save, Share and Help). */
export function menuButton(button: HTMLButtonElement, items: () => MenuEntry[], align: "start" | "end" = "end"): void {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const show = (focusFirst: boolean) => openDropdown({ anchor: button, items: items(), align, focusFirst });
  button.addEventListener("click", (e) => {
    if (button.classList.contains("is-open")) return closeMenus();
    show(e.detail === 0);
  });
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      show(true);
    }
  });
}

// --------------------------------------------------------------- menubar --

export interface MenuBarDeps {
  commands: () => AppCommand[];
  focusGrid: () => void;
}

export function setupMenuBar(root: HTMLElement, d: MenuBarDeps): { focus: () => void } {
  root.setAttribute("role", "menubar");
  root.setAttribute("aria-label", "Menu");
  const tops: HTMLButtonElement[] = [];
  let active = -1; // the menu showing, if any

  const open = (i: number, focusFirst: boolean) => {
    const model = buildMenuModel(d.commands());
    const m = model[i];
    active = i;
    openDropdown({
      anchor: tops[i],
      items: m.items,
      focusFirst,
      className: "cf-menu--bar",
      onDone: (how) => {
        if (active === i) active = -1;
        if (how === "right") open((i + 1) % tops.length, true);
        else if (how === "left") open((i - 1 + tops.length) % tops.length, true);
        else if (how === "dismiss" && root.contains(document.activeElement)) tops[i].focus();
      },
    });
  };

  MENUS.forEach((m, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cf-menubar__item";
    b.textContent = m.name;
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.tabIndex = i === 0 ? 0 : -1;
    b.addEventListener("click", (e) => {
      if (b.classList.contains("is-open")) return closeMenus();
      open(i, e.detail === 0);
    });
    // moving across the bar while a menu is open switches menus
    b.addEventListener("pointerenter", () => {
      if (active >= 0 && active !== i) {
        open(i, false);
        b.focus({ preventScroll: true });
      }
    });
    b.addEventListener("keydown", (e) => {
      const go = (j: number) => {
        const n = tops.length;
        const t = tops[((j % n) + n) % n];
        tops.forEach((x) => (x.tabIndex = x === t ? 0 : -1));
        t.focus();
      };
      if (e.key === "ArrowRight") go(i + 1);
      else if (e.key === "ArrowLeft") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(tops.length - 1);
      else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") open(i, true);
      else if (e.key === "Escape") d.focusGrid();
      else if (e.key.length === 1 && /\w/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const j = MENUS.findIndex((x) => x.name.toLowerCase().startsWith(e.key.toLowerCase()));
        if (j < 0) return;
        go(j);
        open(j, true);
      } else return;
      e.preventDefault();
    });
    tops.push(b);
    root.append(b);
  });

  const focus = () => {
    closeMenus();
    const t = tops.find((x) => x.tabIndex === 0) ?? tops[0];
    t.focus();
  };

  // Alt on its own (pressed and released with nothing else) or F10 focuses the bar
  let altAlone = false;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Alt") {
        altAlone = !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
        return;
      }
      altAlone = false;
      if (e.key === "F10" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !isModalOpen()) {
        e.preventDefault();
        if (root.contains(document.activeElement)) d.focusGrid();
        else focus();
      }
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key !== "Alt" || !altAlone) return;
      altAlone = false;
      if (isModalOpen()) return; // a dialog owns the keyboard
      e.preventDefault();
      if (root.contains(document.activeElement)) d.focusGrid();
      else focus();
    },
    true,
  );
  document.addEventListener("pointerdown", () => (altAlone = false), true);

  return { focus };
}
