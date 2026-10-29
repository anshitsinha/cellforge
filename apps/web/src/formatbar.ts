import type { Action } from "@cellforge/actions";
import { adjustDecimals, getLocale } from "@cellforge/core";
import { currencyCode, currencySymbol, formatName } from "./numfmtname";
import { iconSvg } from "./ui/icons";
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

const ACCOUNTING = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';

/** The number format menu: label, code, example. */
export const NUMBER_FORMATS: [string, string, string][] = [
  ["General", "", "1234.5"],
  ["Number", "#,##0.00", "1,234.50"],
  ["Currency", "$#,##0.00", "$1,234.50"],
  ["Accounting", ACCOUNTING, "$ 1,234.50"],
  ["Negatives in red", "#,##0.00;[Red](#,##0.00)", "(1,234.50)"],
  ["Thousands", '#,##0,"K"', "1K"],
  ["Millions", '#,##0.0,,"M"', "1.2M"],
  ["Percent", "0.00%", "12.50%"],
  ["Scientific", "0.00E+00", "1.23E+03"],
  ["Short date", "m/d/yyyy", "1/15/2024"],
  ["ISO date", "yyyy-mm-dd", "2024-01-15"],
  ["Long date", "dddd, mmmm d, yyyy", "Monday, January 15, 2024"],
  ["Time", "h:mm AM/PM", "6:30 PM"],
  ["Date and time", "yyyy-mm-dd h:mm", "2024-01-15 18:30"],
  ["Duration", "[h]:mm:ss", "36:15:00"],
  ["Text", "@", "keeps what you type"],
];

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const icon = (path: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${path}</svg>`;

const ICONS = {
  left: icon(`<path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8"/>`),
  center: icon(`<path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8"/>`),
  right: icon(`<path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8"/>`),
  wrap: icon(`<path d="M2 3h12M2 7h9a2.5 2.5 0 0 1 0 5H8m1.5-1.8L8 12l1.5 1.8M2 12h3"/>`),
  painter: icon(`<rect x="2" y="2" width="10" height="4" rx="1"/><path d="M12 4h2v4H7.5v2.5M6.5 10.5h2V14h-2z"/>`),
  merge: icon(`<path d="M2 3v10M14 3v10M5 8h6M9.5 6.5 11 8 9.5 9.5M6.5 6.5 5 8l1.5 1.5"/>`),
  clear: icon(`<path d="M3 13h6M5.5 3h7M9 3l-3 10M11 9l3 3m0-3-3 3"/>`),
};

export function setupFormatBar(d: FormatBarDeps): { sync: () => void } {
  const { root, grid } = d;
  // the locale's currency (£ on UK books), for the button, the menu and Ctrl+Shift+4
  const locale = getLocale().id;
  const sym = currencySymbol(locale);
  const curCode = currencyCode(locale);
  const swap = (t: string) => t.split("$").join(sym);
  const formats = NUMBER_FORMATS.map(([name, code, ex]): [string, string, string] =>
    name === "Currency" ? [name, curCode, sym === "€" ? "1,234.50 €" : `${sym}1,234.50`] : name === "Accounting" ? [name, swap(code), swap(ex)] : [name, code, ex],
  );
  root.innerHTML = `
    <button type="button" data-toggle="bold" title="Bold (Ctrl+B)" aria-pressed="false"><b>B</b></button>
    <button type="button" data-toggle="italic" title="Italic (Ctrl+I)" aria-pressed="false"><i>I</i></button>
    <button type="button" data-toggle="underline" title="Underline (Ctrl+U)" aria-pressed="false"><u>U</u></button>
    <button type="button" data-toggle="strike" title="Strikethrough (Ctrl+5)" aria-pressed="false"><s>S</s></button>
    <select id="fmt-size" title="Font size">
      ${SIZES.map((n) => `<option value="${n}"${n === 10 ? " selected" : ""}>${n}</option>`).join("")}
    </select>
    <span class="toolbar-sep"></span>
    <select id="fmt-number" title="Number format">
      ${formats.map(([name, code, ex]) => `<option value="${escapeAttr(code)}">${name}${code ? " · " + ex : ""}</option>`).join("")}
      <option value="__custom" id="fmt-number-custom">Custom…</option>
    </select>
    <button type="button" id="fmt-currency" title="Currency, ${sym} (Ctrl+Shift+4)" aria-label="Currency format">${sym}</button>
    <button type="button" id="fmt-percent" title="Percent (Ctrl+Shift+5)">%</button>
    <button type="button" id="fmt-comma" title="Thousands separator (Ctrl+Shift+1)">,</button>
    <button type="button" id="fmt-dec-more" class="fmt-dec" title="Increase decimal places (.0 → .00)" aria-label="Increase decimal places">${iconSvg("decimal-more", { size: 20 })}</button>
    <button type="button" id="fmt-dec-less" class="fmt-dec" title="Decrease decimal places (.00 → .0)" aria-label="Decrease decimal places">${iconSvg("decimal-less", { size: 20 })}</button>
    <span class="toolbar-sep"></span>
    <label class="fmt-swatch" title="Text colour"><span class="fmt-swatch__a">A</span><i id="fmt-color-bar"></i><input type="color" id="fmt-color" value="#c00000" aria-label="Text colour" /></label>
    <label class="fmt-swatch" title="Fill colour"><span class="fmt-swatch__fill"></span><i id="fmt-fill-bar"></i><input type="color" id="fmt-fill" value="#fff2cc" aria-label="Fill colour" /></label>
    <span class="toolbar-sep"></span>
    <button type="button" data-align="left" title="Align left" aria-pressed="false">${ICONS.left}</button>
    <button type="button" data-align="center" title="Centre" aria-pressed="false">${ICONS.center}</button>
    <button type="button" data-align="right" title="Align right" aria-pressed="false">${ICONS.right}</button>
    <button type="button" data-toggle="wrap" title="Wrap text" aria-pressed="false">${ICONS.wrap}</button>
    <button type="button" id="fmt-merge" title="Merge and centre (click again to unmerge)" aria-pressed="false">${ICONS.merge}</button>
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
  const numberSel = $<HTMLSelectElement>("#fmt-number");
  const customOpt = $<HTMLOptionElement>("#fmt-number-custom");

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

  // --- merge and centre: toggles like Excel's button
  const mergeBtn = $<HTMLButtonElement>("#fmt-merge");
  const mergedHere = () => {
    const r = grid.range;
    return d.source().getMerges().some((m) => m.top <= r.bottom && r.top <= m.bottom && m.left <= r.right && r.left <= m.right);
  };
  mergeBtn.addEventListener("click", () => {
    const range = grid.range;
    const action: Action = mergedHere()
      ? { type: "cells.unmerge", params: { range } }
      : { type: "cells.merge", params: { range, center: true } };
    void d.run(action).then(after);
  });

  // --- number formats
  const setCode = (code: string) => format({ numFmt: code || null });
  numberSel.addEventListener("change", () => {
    const v = numberSel.value;
    if (v === "__custom") openCustom();
    else void setCode(v).then(after);
  });
  $<HTMLButtonElement>("#fmt-currency").addEventListener("click", () => void setCode(curCode).then(after));
  $<HTMLButtonElement>("#fmt-percent").addEventListener("click", () => void setCode("0%").then(after));
  $<HTMLButtonElement>("#fmt-comma").addEventListener("click", () => void setCode("#,##0.00").then(after));
  const decimals = (delta: 1 | -1) => {
    const { row, col } = grid.selection;
    const v = d.source().getCell(row, col);
    void setCode(adjustDecimals(current().numFmt, delta, typeof v === "number" ? v : 0)).then(after);
  };
  $<HTMLButtonElement>("#fmt-dec-more").addEventListener("click", () => decimals(1));
  $<HTMLButtonElement>("#fmt-dec-less").addEventListener("click", () => decimals(-1));

  /** A small box to type any Excel format code, with a live preview. */
  function openCustom() {
    document.querySelector(".numfmt-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "tab-menu numfmt-pop";
    const { row, col } = grid.selection;
    const sample = d.source().getCell(row, col);
    pop.innerHTML = `
      <label>Format code<input type="text" spellcheck="false" placeholder="#,##0.00;[Red](#,##0.00)" /></label>
      <div class="numfmt-preview"></div>
      <div class="numfmt-actions"><button type="button" data-act="cancel">Cancel</button><button type="button" data-act="ok">Apply</button></div>`;
    document.body.append(pop);
    const r = numberSel.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 320))}px`;
    pop.style.top = `${r.bottom + 4}px`;
    const input = pop.querySelector("input")!;
    input.value = current().numFmt ?? "";
    const preview = pop.querySelector<HTMLElement>(".numfmt-preview")!;
    const show = () => {
      const v = typeof sample === "number" ? sample : 1234.5;
      const out = d.source().formatValue(v, { numFmt: input.value || undefined });
      preview.textContent = out.text || " ";
      preview.style.color = out.color ?? "";
    };
    const close = () => {
      pop.remove();
      sync();
      grid.focus();
    };
    const ok = () => {
      const code = input.value.trim();
      pop.remove();
      void setCode(code).then(after);
    };
    input.addEventListener("input", show);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok();
      else if (e.key === "Escape") close();
    });
    pop.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "ok") ok();
      else if (act === "cancel") close();
    });
    show();
    input.focus();
    input.select();
  }

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
    } else if (e.shiftKey && (e.code === "Digit5" || e.code === "Digit4" || e.code === "Digit1")) {
      // Excel: Ctrl+Shift+% percent, Ctrl+Shift+$ currency, Ctrl+Shift+! number
      e.preventDefault();
      void setCode(e.code === "Digit5" ? "0%" : e.code === "Digit4" ? curCode : "#,##0.00");
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
    mergeBtn.setAttribute("aria-pressed", String(mergedHere()));
    const code = st.numFmt ?? "";
    const known = formats.find(([, c]) => c === code);
    // a friendly name for any common format; the code itself only in the tooltip
    const named = formatName(code);
    customOpt.textContent = known ? "Custom…" : named.custom ? "Custom" : named.name;
    numberSel.value = known ? code : "__custom";
    numberSel.title = code ? `Number format: ${known ? known[0] : named.name} (${code})` : "Number format: General";
  }
  return { sync };
}
