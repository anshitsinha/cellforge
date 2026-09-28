/**
 * "Fix spelling variants in this column": "ACME LTD." / "Acme Ltd" /
 * " acme ltd" become one spelling. Variants that differ only in case,
 * spacing and punctuation are found by rules; a local model, when loaded,
 * can add ones the rules can't see ("Intl Business Machines" / "IBM"),
 * restricted to values already in the column. Nothing changes until the
 * ticked merges are written, as one undoable step.
 */
import type { Action } from "@cellforge/actions";
import { suggestMerges, type Model, type ValueMerge } from "@cellforge/ai";
import { columnLetter } from "@cellforge/grid";
import { setCells } from "./actions";
import { columnKinds, readSheet, sheetSamples } from "./audittools";
import { nameColumn } from "./colguess";
import { button, count, el, emptyState, field, headline, navigator, notice, plural, report, section } from "./toolkit";
import { openSidePanel } from "./ui/sidepanel";
import { renderTable } from "./ui/table";
import { categoryInput } from "./checksui";
import type { EditableSource } from "./editable";

/** The text values of a column's data rows (non-text values left as ""). */
export function columnTexts(src: EditableSource, col: number): { first: number; values: string[] } {
  const data = readSheet(src);
  const v = data.col(col);
  return { first: data.first, values: Array.from({ length: data.rows }, (_, i) => (typeof v[i] === "string" ? (v[i] as string) : "")) };
}

/** The cells to write for the chosen merges. */
export function mergeCells(values: readonly string[], first: number, col: number, merges: readonly ValueMerge[]): { row: number; col: number; input: string }[] {
  const to = new Map<string, string>();
  for (const m of merges) for (const f of m.from) to.set(f, m.to);
  const cells: { row: number; col: number; input: string }[] = [];
  values.forEach((v, i) => {
    const t = to.get(v);
    if (t !== undefined) cells.push({ row: i + first, col, input: categoryInput(t) });
  });
  return cells;
}

export interface VariantsDeps {
  source: () => EditableSource;
  activeSheet: () => string;
  /** the selected column */
  col: () => number;
  run: (a: Action) => Promise<unknown>;
  status: (t: string) => void;
  focusGrid: () => void;
  model?: () => Model | null;
  /** show a cell (makes the result rows links); optional */
  goTo?: (sheetId: string, row: number, col: number) => void;
}

/**
 * The column to start on: the selected one when it holds text, else the
 * most name-like column (vendor, customer, payee…). Pure apart from reading the sheet.
 */
export function startColumn(src: EditableSource, selected: number): number {
  const data = readSheet(src);
  if (!data.names.length) return selected;
  const kinds = columnKinds(data);
  if (kinds[selected] === "text") return selected;
  const guess = nameColumn(sheetSamples(data));
  return guess >= 0 ? guess : selected;
}

export async function openVariants(d: VariantsDeps): Promise<void> {
  const sheet = d.activeSheet();
  const src = d.source();
  const data = readSheet(src);
  const kinds = columnKinds(data);
  let col = startColumn(src, d.col());
  const goTo = navigator(d.goTo);
  const model = d.model?.() ?? null;
  let run = 0;

  openSidePanel({
    id: "variants",
    title: "Fix spelling variants",
    subtitle: "One spelling per name, as one undoable change",
    onClose: () => d.focusGrid(),
    render: (p) => {
      if (!data.names.length || !data.rows) {
        p.body.append(emptyState({ icon: "search", title: "Nothing to tidy yet", text: "Open or paste a list first, such as invoices with a Vendor column. This tool finds spellings of the same name (ACME LTD., Acme Ltd, acme ltd) and makes them one." }));
        return;
      }
      const pick = el("select");
      data.names.forEach((n, c) => {
        if (kinds[c] === "empty") return;
        const o = new Option(n.replace(/^[A-Z]+: /, "") + (kinds[c] === "text" ? "" : ` (${kinds[c]})`), String(c), false, c === col);
        pick.append(o);
      });
      const result = el("div", { className: "var-result" });
      result.setAttribute("aria-live", "polite");
      p.body.append(
        el("p", { className: "tk-muted", textContent: "Names typed several ways split totals in pivots, duplicate tests and joins. Pick the column; nothing changes until you press Change." }),
        section("Column", field("Look for variants in", pick, "Usually the vendor, customer or payee column")),
        section("Variants found", result),
      );
      const apply = button("Change the ticked spellings", () => undefined, "primary");
      apply.disabled = true;
      p.footer.append(apply);
      let onApply: () => Promise<void> = async () => undefined;
      apply.onclick = () => void onApply();

      const find = async () => {
        const mine = ++run;
        col = Number(pick.value);
        apply.disabled = true;
        const { first, values } = columnTexts(src, col);
        const texts = values.filter(Boolean).length;
        result.replaceChildren(el("p", { className: "tk-muted", textContent: model ? "Looking for variants (rules, then the local model)…" : "Looking for variants…" }));
        if (!texts) {
          result.replaceChildren(notice(`${data.names[col].replace(/^[A-Z]+: /, "")} has no text to tidy (it holds ${kinds[col] === "date" ? "dates" : "numbers"}). Pick a column of names.`, "warning"));
          return;
        }
        const { merges, rejected } = await suggestMerges(values, model);
        if (mine !== run) return;
        const extra: HTMLElement[] = [];
        if (rejected) extra.push(notice(`The local model's answer wasn't used: ${rejected}.`, "warning"));
        if (!merges.length) {
          result.replaceChildren(headline({ value: "0", unit: "variants", tone: "match", caption: `Every name in ${plural(texts, "cell")} is already spelled one way.` }), ...extra);
          return;
        }
        merges.sort((a, b) => b.cells - a.cells);
        const cellsTotal = merges.reduce((t, m) => t + m.cells, 0);
        type Row = { from: string; to: string; cells: number; by: string; m: ValueMerge };
        // spaces at either end are invisible: show them as ␣
        const shown = (v: string) => v.replace(/^\s+|\s+$/g, (m) => "␣".repeat(m.length));
        const rows: Row[] = merges.map((m) => ({ from: m.from.map(shown).join(" · "), to: m.to, cells: m.cells, by: m.by === "model" ? "Local model" : "Rules", m }));
        const t = renderTable<Row>({
          columns: [
            { key: "from", label: "Spellings found" },
            { key: "to", label: "Becomes" },
            { key: "cells", label: "Cells", format: "integer" },
            { key: "by", label: "Found by" },
          ],
          rows,
          select: {
            initial: (r) => r.m.by === "rules",
            onChange: (idx) => {
              apply.disabled = !idx.length;
              apply.textContent = idx.length ? `Change ${plural(idx.length, "name")}` : "Tick the names to change";
            },
            label: (r) => `Change ${r.from} to ${r.to}`,
          },
          onRowClick: goTo
            ? (r) => {
                const i = values.findIndex((v) => r.m.from.includes(v) && v !== r.m.to);
                if (i >= 0) goTo(sheet, i + first, col);
              }
            : undefined,
          maxHeight: "50vh",
        });
        const ticked = () => t.selected();
        apply.disabled = !ticked().length;
        apply.textContent = ticked().length ? `Change ${plural(ticked().length, "name")}` : "Tick the names to change";
        result.replaceChildren(
          headline({
            value: count(merges.length),
            unit: merges.length === 1 ? "name spelled several ways" : "names spelled several ways",
            tone: "unmatched",
            caption: `${plural(cellsTotal, "cell")} would change to the commonest spelling. ${model ? "Names found by the local model are not ticked: check them first." : "Load a local AI model to also catch abbreviations and typos."}`,
          }),
          ...extra,
          t.element,
        );
        onApply = async () => {
          const chosen = ticked().map((i) => merges[i]);
          const cells = mergeCells(values, first, col, chosen);
          if (!cells.length) return;
          apply.disabled = true;
          try {
            await d.run(setCells(cells, `merge ${chosen.length} spelling variant${chosen.length === 1 ? "" : "s"} in column ${columnLetter(col)}`, sheet));
            report(d.status, `Changed ${plural(cells.length, "cell")} to one spelling. Ctrl+Z undoes it.`);
            void find();
          } catch (e) {
            result.prepend(notice((e as Error).message, "danger"));
            apply.disabled = false;
          }
        };
      };
      pick.addEventListener("change", () => void find());
      void find();
      pick.focus();
      return () => void ++run;
    },
  });
}
