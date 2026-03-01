import type { Action } from "@cellforge/actions";
import type { CellStyle, Grid } from "@cellforge/grid";
import type { EditableSource } from "./editable";
import { CLEAR_ALL, type StylePatch } from "./styles";

/**
 * The formatting toolbar: bold / italic / underline / strikethrough, size,
 * text and fill colour, alignment, wrap, borders, clear and the format
 * painter. Every button is a format.* action, so it's undoable and the AI
 * can do the same thing by name.
 */
export interface FormatBarDeps {
  root: HTMLElement;
  grid: Grid;
  source: () => EditableSource;
  run: (action: Action) => Promise<unknown>;
  status: (message: string) => void;
  gridHasFocus: () => boolean;
  sheetElement: HTMLElement;
}

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];

const icon = (path: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${path}</svg>`;

const ICONS = {
  left: icon(`<path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8"/>`),
  center: icon(`<path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8"/>`),
  right: icon(`<path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8"/>`),
  wrap: icon(`<path d="M2 3h12M2 7h9a2.5 2.5 0 0 1 0 5H8m1.5-1.8L8 12l1.5 1.8M2 12h3"/>`),
  painter: icon(`<rect x="2" y="2" width="10" height="4" rx="1"/><path d="M12 4h2v4H7.5v2.5M6.5 10.5h2V14h-2z"/>`),
  clear: icon(`<path d="M3 13h6M5.5 3h7M9 3l-3 10M11 9l3 3m0-3-3 3"/>`),
};

export function setupFormatBar(d: FormatBarDeps): { sync: () => void } {
  const { root, grid } = d;
  root.innerHTML = `
    <button type="button" data-toggle="bold" title="Bold (Ctrl+B)" aria-pressed="false"><b>B</b></button>
    <button type="button" data-toggle="italic" title="Italic (Ctrl+I)" aria-pressed="false"><i>I</i></button>
    <button type="button" data-toggle="underline" title="Underline (Ctrl+U)" aria-pressed="false"><u>U</u></button>
    <button type="button" data-toggle="strike" title="Strikethrough (Ctrl+5)" aria-pressed="false"><s>S</s></button>
    <select id="fmt-size" title="Font size">
      ${SIZES.map((n) => `<option value="${n}"${n === 10 ? " selected" : ""}>${n}</option>`).join("")}
    </select>
    <span class="toolbar-sep"></span>
    <label class="swatch" title="Text colour"><span class="swatch-a">A</span><i id="fmt-color-bar"></i><input type="color" id="fmt-color" value="#c00000" /></label>
    <label class="swatch" title="Fill colour"><span class="swatch-fill"></span><i id="fmt-fill-bar"></i><input type="color" id="fmt-fill" value="#fff2cc" /></label>
    <span class="toolbar-sep"></span>
    <button type="button" data-align="left" title="Align left" aria-pressed="false">${ICONS.left}</button>
    <button type="button" data-align="center" title="Centre" aria-pressed="false">${ICONS.center}</button>
    <button type="button" data-align="right" title="Align right" aria-pressed="false">${ICONS.right}</button>
    <button type="button" data-toggle="wrap" title="Wrap text" aria-pressed="false">${ICONS.wrap}</button>
    <select id="fmt-borders" title="Borders">
      <option value="">Borders</option>
      <option value="all">All borders</option>
      <option value="outline">Outline</option>
      <option value="inner">Inside</option>
      <option value="top">Top</option>
      <option value="bottom">Bottom</option>
      <option value="left">Left</option>
      <option value="right">Right</option>
      <option value="thick-bottom">Thick bottom</option>
      <option value="double-bottom">Double bottom (totals)</option>
      <option value="none">No borders</option>
    </select>
    <span class="toolbar-sep"></span>
    <button type="button" id="fmt-painter" title="Format painter: copy the look of the selected cell, then select where it goes. Double-click to keep painting; Esc stops." aria-pressed="false">${ICONS.painter}</button>
    <button type="button" id="fmt-clear" title="Clear formatting (Ctrl+\\)">${ICONS.clear}</button>
  `;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const size = $<HTMLSelectElement>("#fmt-size");
  const color = $<HTMLInputElement>("#fmt-color");
  const fill = $<HTMLInputElement>("#fmt-fill");
  const colorBar = $<HTMLElement>("#fmt-color-bar");
  const fillBar = $<HTMLElement>("#fmt-fill-bar");
  const borders = $<HTMLSelectElement>("#fmt-borders");
  const painter = $<HTMLButtonElement>("#fmt-painter");

  const current = (): CellStyle => {
    const { row, col } = grid.selection;
    return d.source().getStyle(row, col) ?? {};
  };
  const format = (style: StylePatch) => d.run({ type: "format.set", params: { range: grid.range, style } });
  const toggle = (prop: "bold" | "italic" | "underline" | "strike" | "wrap") => format({ [prop]: current()[prop] ? null : true });
  const after = () => grid.focus();

  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.toggle) void toggle(b.dataset.toggle as "bold").then(after);
    else if (b.dataset.align) {
      const align = b.dataset.align as CellStyle["align"];
      void format({ align: current().align === align ? null : align }).then(after);
    }
  });
  size.addEventListener("change", () => void format({ size: Number(size.value) === 10 ? null : Number(size.value) }).then(after));
  color.addEventListener("change", () => {
    colorBar.style.background = color.value;
    void format({ color: color.value }).then(after);
  });
  fill.addEventListener("change", () => {
    fillBar.style.background = fill.value;
    void format({ fill: fill.value }).then(after);
  });
  colorBar.style.background = color.value;
  fillBar.style.background = fill.value;

  borders.addEventListener("change", () => {
    const v = borders.value;
    borders.value = "";
    if (!v) return;
    const line = { style: "thin", color: "auto" };
    let action: Action;
    if (v === "thick-bottom") action = { type: "format.borders", params: { range: grid.range, which: "bottom", line: { ...line, style: "thick" } } };
    else if (v === "double-bottom") action = { type: "format.borders", params: { range: grid.range, which: "bottom", line: { ...line, style: "double" } } };
    else action = { type: "format.borders", params: { range: grid.range, which: v, line } };
    void d.run(action).then(after);
  });

  $<HTMLButtonElement>("#fmt-clear").addEventListener("click", () => {
    void d.run({ type: "format.clear", params: { range: grid.range } }).then(after);
  });

  // --- format painter: one use on click, sticky on double-click (as in Excel)
  let painting: { style: CellStyle; sticky: boolean } | null = null;
  const setPainting = (next: typeof painting) => {
    painting = next;
    painter.setAttribute("aria-pressed", String(!!next));
    d.sheetElement.classList.toggle("painting", !!next);
    if (next) d.status(next.sticky ? "Format painter on: select cells to paint them. Esc stops." : "Select the cells to paint.");
  };
  painter.addEventListener("click", () => {
    setPainting(painting ? null : { style: current(), sticky: false });
    grid.focus();
  });
  painter.addEventListener("dblclick", () => {
    setPainting({ style: current(), sticky: true });
    grid.focus();
  });
  d.sheetElement.addEventListener("pointerup", () => {
    if (!painting) return;
    const { style, sticky } = painting;
    if (!sticky) setPainting(null);
    // replace the look entirely: clear everything, then set the copied style
    void format({ ...CLEAR_ALL, ...style });
  });

  // --- shortcuts: Ctrl+B / I / U, Ctrl+5 strike, Ctrl+\ clear, Esc stops painting
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && painting) {
      setPainting(null);
      d.status("Ready");
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !d.gridHasFocus()) return;
    const k = e.key.toLowerCase();
    const map: Record<string, "bold" | "italic" | "underline"> = { b: "bold", i: "italic", u: "underline" };
    if (map[k] && !e.shiftKey) {
      e.preventDefault();
      void toggle(map[k]);
    } else if (e.code === "Digit5" && !e.shiftKey) {
      e.preventDefault();
      void toggle("strike");
    } else if (e.key === "\\") {
      e.preventDefault();
      void d.run({ type: "format.clear", params: { range: grid.range } });
    }
  });

  /** Show the active cell's formatting on the buttons. */
  function sync() {
    const st = current();
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
      b.setAttribute("aria-pressed", String(!!st[b.dataset.toggle as keyof CellStyle]));
    }
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-align]")) {
      b.setAttribute("aria-pressed", String(st.align === b.dataset.align));
    }
    size.value = String(st.size ?? 10);
  }
  return { sync };
}
