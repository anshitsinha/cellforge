/**
 * The clean-up dialog: what the tool found in the sheet (header, rows to
 * drop and why, each column's type and how sure it is, the values that
 * don't fit) before it makes the clean sheet.
 */
import type { Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import { namedHeader, planCleanup, sheetText } from "./cleanup";
import type { EditableSource } from "./editable";
import { el, headline, notice } from "./toolkit";
import { openDialog } from "./ui/dialog";
import { toast } from "./ui/toast";

export interface CleanupDeps {
  source: () => EditableSource;
  run: (a: Action) => Promise<unknown>;
  goTo: (row: number, col: number) => void;
  focusGrid: () => void;
}

const REASONS: Record<string, string> = { title: "title rows", blank: "blank rows", total: "subtotal / total rows", footer: "page footers", "repeated header": "repeated headers" };
const TYPES: Record<string, string> = { number: "Numbers", date: "Dates", text: "Text", empty: "Empty" };

export function openCleanup(d: CleanupDeps): void {
  let plan;
  try {
    const src = d.source();
    plan = planCleanup(sheetText(src), true, namedHeader(src) ? 1 : 0).plan;
  } catch (e) {
    toast({ kind: "error", title: "Couldn't read this sheet for clean-up", text: (e as Error).message });
    return;
  }
  const counts = new Map<string, number>();
  for (const r of plan.dropped) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const droppedText = [...counts].map(([k, n]) => `${n.toLocaleString()} ${REASONS[k] ?? k}`).join(", ");
  const misfitCols = plan.profiles.filter((p) => p.type !== "empty" && p.misfits.length).length;

  let dlg: ReturnType<typeof openDialog> | null = null;
  const table = el("table", { className: "data-table" });
  const head = table.createTHead().insertRow();
  for (const [t, num] of [
    ["Column", false],
    ["Becomes", false],
    ["Fits", true],
    ["Values that don't fit", false],
  ] as const) {
    const th = el("th", { scope: "col", textContent: t });
    if (num) th.className = "num";
    head.append(th);
  }
  const body = table.createTBody();
  plan.profiles.forEach((p, c) => {
    if (p.type === "empty") return;
    const tr = body.insertRow();
    tr.insertCell().textContent = plan.header[c];
    tr.insertCell().textContent = TYPES[p.type] + (p.type === "number" && p.numberStyle === "comma" ? " (1.234,56)" : "") + (p.type === "date" ? ` (${p.dateOrder === "mdy" ? "month first" : p.dateOrder === "ymd" ? "year first" : "day first"})` : "");
    const conf = tr.insertCell();
    conf.className = "num";
    conf.append(el("span", { className: `cf-badge ${p.confidence < 0.98 ? "cf-badge--warning" : "cf-badge--success"}`, textContent: `${Math.round(p.confidence * 100)}%` }));
    const misfits = tr.insertCell();
    for (const m of p.misfits.slice(0, 4)) {
      const row = plan.sourceRows[m.row];
      const b = el("button", { type: "button", className: "btn-ghost btn-sm", textContent: `${columnLetter(c)}${row + 1}: ${m.value.slice(0, 18)}`, title: "Show it in the sheet" });
      b.addEventListener("click", () => {
        dlg?.close();
        d.goTo(row, c);
      });
      misfits.append(b);
    }
    if (p.misfits.length > 4) misfits.append(el("span", { className: "tk-muted", textContent: ` and ${p.misfits.length - 4} more` }));
  });
  const wrap = el("div", { className: "table-wrap" });
  wrap.append(table);

  dlg = openDialog({
    title: "Clean up this sheet",
    subtitle: "A clean copy on a new sheet; this one stays as it is",
    size: "lg",
    body: [
      headline({
        value: plan.dataRows.toLocaleString(),
        unit: "rows of data",
        tone: misfitCols ? "unmatched" : "match",
        caption:
          (plan.headerRow < 0 ? "Header: the column names." : `Header found on row ${plan.headerRow + 1}.`) +
          (droppedText ? ` Leaving out ${droppedText}.` : " Nothing to leave out.") +
          (plan.filledDown.length ? ` Filling down group labels in ${plan.filledDown.map((c) => `"${plan.header[c]}"`).join(", ")}.` : ""),
      }),
      wrap,
      misfitCols ? notice("Values that don't fit keep their original text, so nothing is lost. Click one to see it in the sheet.", "info") : el("span"),
    ],
    actions: [
      { label: "Cancel", dismiss: true },
      { label: "Make the clean sheet", kind: "primary", onClick: () => void d.run({ type: "data.cleanup", params: {} }).then(() => d.focusGrid()) },
    ],
    initialFocus: "primary",
    onClose: (r) => {
      if (r === "dismiss") d.focusGrid();
    },
  });
}
