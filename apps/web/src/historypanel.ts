/**
 * The history panel (in the shared side panel): every change this session
 * (click one to go back to it, and forward again), the history of the
 * selected cell, and named versions (save, compare, go back).
 */
import type { Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import "./analysis.css";
import "./historypanel.css";
import type { EditableSource } from "./editable";
import { confirmDialog } from "./ui/confirm";
import { makeButton } from "./ui/dialog";
import { icon, iconButton } from "./ui/icons";
import { closeSidePanel, currentSidePanel, onSidePanelChange, openSidePanel, type SidePanelContext } from "./ui/sidepanel";
import { toast } from "./ui/toast";
import { compareWorkbooks, versionWorkbook, type Comparison, type Version } from "./versions";
import type { Workbook } from "./workbook";

export interface TrailEntry {
  at: number;
  text: string;
}

export interface HistoryPanelDeps {
  /** the old fixed panel element; kept hidden (the side panel is used instead) */
  root?: HTMLElement;
  workbook: () => Workbook;
  activeSheet: () => string;
  selection: () => { row: number; col: number };
  timeline: () => { done: { label: string; at: number }[]; undone: { label: string; at: number }[] };
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
  run: (action: Action) => Promise<unknown>;
  /** select a cell, switching sheet if needed */
  goTo: (sheet: string, row: number, col: number) => void;
  /** what was typed into this cell this session, by row identity */
  trail: (sheet: string, rowId: number, col: number) => TrailEntry[];
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const date = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(parent: HTMLElement, title: string, ...extra: HTMLElement[]): HTMLElement {
  const s = el("section", "an-section");
  const head = el("div", "an-section__head");
  head.append(el("h3", "an-section__title", title), ...extra);
  s.append(head);
  parent.append(s);
  return s;
}

export const HISTORY_PANEL = "history";

export function setupHistoryPanel(d: HistoryPanelDeps): { toggle: () => void; render: () => void; readonly open: boolean } {
  if (d.root) d.root.hidden = true;
  let comparison: { name: string; result: Comparison } | null = null;
  let ctx: SidePanelContext | null = null;
  // versions as workbooks, built once (versions never change)
  const built = new WeakMap<Version, Workbook>();
  const asWorkbook = (v: Version) => {
    let wb = built.get(v);
    if (!wb) {
      wb = versionWorkbook(v);
      built.set(v, wb);
    }
    return wb;
  };
  const isOpen = () => currentSidePanel() === HISTORY_PANEL;
  onSidePanelChange((id) => {
    if (id !== HISTORY_PANEL) ctx = null;
    document.body.classList.toggle("history-open", id === HISTORY_PANEL);
  });

  async function jump(steps: number) {
    for (let i = 0; i < Math.abs(steps); i++) await (steps < 0 ? d.undo() : d.redo());
  }

  function fill(p: SidePanelContext) {
    const body = p.body;
    const scroll = body.scrollTop;
    const root = el("div", "an-stack an-stack--loose hist");
    const wb = d.workbook();

    // --- this session (first: it's what people open history for)
    const { done, undone } = d.timeline();
    const tl = section(root, "This session", el("span", "an-hint", done.length ? `${done.length} change${done.length === 1 ? "" : "s"}` : ""));
    if (!done.length && !undone.length) {
      const empty = el("div", "an-empty");
      empty.append(el("p", undefined, "Every change you make shows here, newest at the bottom. Click one to go back to just after it; click a later one to go forward again."));
      tl.append(empty);
    } else {
      const list = el("ol", "hist-timeline");
      list.setAttribute("aria-label", "Changes this session");
      const item = (label: string, at: number | null, state: "done" | "current" | "undone", steps: number) => {
        const li = el("li", `hist-step is-${state}`);
        const b = el("button", "hist-step__btn");
        b.type = "button";
        b.append(el("span", "hist-dot"), el("span", "hist-step__label", label));
        if (at) b.append(el("small", "hist-step__time", time(at)));
        b.title = state === "current" ? "You are here" : steps < 0 ? "Go back to just after this" : "Go forward to this";
        if (state === "current") b.setAttribute("aria-current", "step");
        b.disabled = state === "current";
        b.addEventListener("click", () => void jump(steps));
        li.append(b);
        list.append(li);
      };
      item("Opened", null, done.length ? "done" : "current", -done.length);
      done.forEach((e, i) => item(e.label, e.at, i === done.length - 1 ? "current" : "done", -(done.length - 1 - i)));
      undone.forEach((e, i) => item(e.label, e.at, "undone", i + 1));
      tl.append(list);
    }

    // --- this cell
    const sheetId = d.activeSheet();
    if (wb.has(sheetId)) {
      const src: EditableSource = wb.get(sheetId).source;
      const { row, col } = d.selection();
      const cellSec = section(root, `Cell ${columnLetter(col)}${row + 1}`);
      const show = (s: EditableSource, r: number) => {
        if (r < 0) return "(row not there)";
        const t = s.getEditText(r, col);
        const v = s.getCell(r, col);
        return t.startsWith("=") ? `${t} → ${v ?? ""}` : t || "(empty)";
      };
      const rowId = src.toBase(row);
      const cellList = el("ol", "hist-cell");
      const entry = (when: string, what: string, cls = "") => {
        const li = el("li", cls);
        li.append(el("small", undefined, when), el("span", undefined, what));
        cellList.append(li);
      };
      for (const v of wb.versions) {
        const vw = asWorkbook(v);
        const vsSheet = vw.sheets.find((s) => s.id === sheetId);
        entry(`Version "${v.name}"`, vsSheet ? show(vsSheet.source, vsSheet.source.rowIdToView()(rowId)) : "(sheet not there)");
      }
      for (const t of d.trail(sheetId, rowId, col)) entry(`Typed at ${time(t.at)}`, t.text || "(cleared)");
      entry("Now", show(src, row), "is-now");
      cellSec.append(cellList);
    }

    // --- named versions
    const vs = section(root, "Versions");
    const form = el("form", "an-row");
    const input = el("input");
    input.placeholder = "Name, e.g. Sent to auditor";
    input.maxLength = 80;
    input.setAttribute("aria-label", "Name for this version");
    const save = makeButton("Save version", "secondary");
    save.type = "submit";
    save.classList.add("an-fit");
    form.append(input, save);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      void d.run({ type: "version.save", params: { name } }).then(() => toast({ kind: "success", text: `Saved the version "${name}"` }));
    });
    vs.append(form);
    if (!wb.versions.length) vs.append(el("p", "an-hint", "Save a version before you send the file to someone. Later you can see exactly which cells changed since then, or go back to it."));
    const vlist = el("ul", "an-list hist-versions");
    for (const v of [...wb.versions].reverse()) {
      const li = el("li");
      const main = el("div", "an-list__main");
      main.append(el("strong", undefined, v.name), el("span", "an-list__sub", date(v.at)));
      const cmp = makeButton("Compare", "ghost");
      cmp.classList.add("btn-sm");
      cmp.title = "Which cells changed since this version";
      cmp.addEventListener("click", () => {
        comparison = { name: v.name, result: compareWorkbooks(asWorkbook(v), d.workbook()) };
        render();
      });
      const back = iconButton("undo", `Go back to "${v.name}"`, {
        size: "sm",
        onClick: async () => {
          if (!(await confirmDialog({ title: `Go back to "${v.name}"?`, text: "Every sheet becomes what it was then. You can undo this.", confirm: "Go back" }))) return;
          void d.run({ type: "version.restore", params: { name: v.name } });
        },
      });
      const del = iconButton("trash", `Delete the version "${v.name}"`, {
        size: "sm",
        onClick: () => void d.run({ type: "version.delete", params: { name: v.name } }).then(() => toast({ text: `Deleted the version "${v.name}". Undo (Ctrl+Z) brings it back.` })),
      });
      li.append(main, cmp, back, del);
      vlist.append(li);
    }
    if (wb.versions.length) vs.append(vlist);

    // --- comparison result (on top while it's there)
    if (comparison) {
      const hide = iconButton("close", "Hide the comparison", {
        size: "sm",
        onClick: () => {
          comparison = null;
          render();
        },
      });
      const cs = section(root, `Changes since "${comparison.name}"`, hide);
      const { changes, notes, truncated } = comparison.result;
      for (const n of notes) {
        const note = el("div", "an-note");
        note.append(icon("info"), el("span", undefined, n));
        cs.append(note);
      }
      if (!changes.length && !notes.length) cs.append(el("p", "an-hint", "Nothing has changed since then."));
      const list = el("ul", "hist-changes");
      for (const c of changes) {
        const li = el("li");
        const where = el("button", "hist-ref", `${c.sheet}!${c.cell}`);
        where.type = "button";
        where.title = "Go to this cell";
        where.addEventListener("click", () => {
          const sheet = d.workbook().sheets.find((s) => s.name === c.sheet);
          if (sheet) d.goTo(sheet.id, c.row, c.col);
        });
        const diff = el("span", "hist-diff");
        diff.append(el("del", undefined, c.before || "(empty)"), el("ins", undefined, c.after || "(empty)"));
        li.append(where, diff);
        list.append(li);
      }
      cs.append(list);
      if (truncated) cs.append(el("p", "an-hint", `Showing the first ${changes.length.toLocaleString()} changes.`));
      root.insertBefore(cs, root.firstChild);
    }

    body.replaceChildren(root);
    body.scrollTop = scroll;
    const here = root.querySelector<HTMLElement>(".hist-step.is-current");
    const tlist = root.querySelector<HTMLElement>(".hist-timeline");
    if (here && tlist) tlist.scrollTop = here.offsetTop - tlist.clientHeight / 2;
  }

  function render() {
    if (ctx && isOpen()) fill(ctx);
  }

  function toggle() {
    if (isOpen()) {
      closeSidePanel();
      return;
    }
    openSidePanel({
      id: HISTORY_PANEL,
      title: "History",
      subtitle: "Changes, this cell's past and saved versions",
      render: (p) => {
        ctx = p;
        fill(p);
        return () => {
          ctx = null;
        };
      },
    });
  }

  return {
    toggle,
    render,
    get open() {
      return isOpen();
    },
  };
}
