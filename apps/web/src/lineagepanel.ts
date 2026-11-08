/** The "Explain this number" panel: the headline value, the lineage tree with links, and a write-up to copy. */
import { explainFormula, type Model } from "@cellforge/ai";
import { explainCell, writeUp, type LineageNode, type LineageOptions } from "./lineage";
import type { Workbook } from "./workbook";
import "./evidence.css";
import { button, el, headline, navigator, notice, report, section } from "./toolkit";
import { iconButton } from "./ui/icons";
import { openSidePanel } from "./ui/sidepanel";
import { displayValue } from "./inspect";

export interface LineageDeps {
  workbook: () => Workbook;
  sheetId: () => string;
  cell: () => { row: number; col: number };
  lastEdit: LineageOptions["lastEdit"];
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (t: string) => void;
  /** the local model, if one is loaded */
  model?: () => Model | null;
}

const KIND: Record<LineageNode["kind"], string> = { formula: "Formula", typed: "Typed in", imported: "Imported", empty: "Empty", range: "Range", spill: "Part of a formula's result" };

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function openLineage(d: LineageDeps): void {
  const { row, col } = d.cell();
  const root = explainCell(d.workbook(), d.sheetId(), row, col, { lastEdit: d.lastEdit });
  const goTo = navigator(d.goTo);
  const text = writeUp(root);
  const copy = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      report(d.status, "Copied the explanation, ready to paste into your working papers");
    } catch {
      report(d.status, "Couldn't copy: select the write-up text instead.", "error");
    }
  };

  openSidePanel({
    id: "explain",
    title: "Explain this number",
    subtitle: `Where ${root.label} comes from`,
    tools: [iconButton("copy", "Copy the write-up", { onClick: () => void copy() })],
    render: (p) => {
      const node = (n: LineageNode, depth: number): HTMLElement => {
        const li = el("li", { className: `ln-node ln-node--${n.kind}` });
        const go = el("button", { type: "button", className: "ln-cell", textContent: n.label, title: goTo ? "Show it in the sheet" : "" });
        go.disabled = !goTo;
        go.addEventListener("click", () => goTo?.(n.sheetId, n.row, n.col));
        const value = n.kind === "range" ? `${n.range!.cells.toLocaleString("en-US")} cells · total ${displayValue(n.range!.total, "#,##0.00;(#,##0.00)")}` : displayValue(n.value) || "(empty)";
        li.append(el("div", { className: "ln-row" }, go, el("span", { className: "ln-kind", textContent: KIND[n.kind] }), el("span", { className: "ln-value", textContent: value })));
        if (n.words) li.append(el("div", { className: "ln-words", textContent: n.words }));
        if (n.formula) li.append(el("code", { className: "ln-formula", textContent: n.formula }));
        const meta: string[] = [];
        if (n.typed) meta.push(`Typed ${when(n.typed.at)}`);
        if (n.origin) meta.push(n.origin);
        if (n.provenance) meta.push(`This row: ${n.provenance}`);
        if (n.repeat) meta.push("Explained above");
        if (meta.length) li.append(el("div", { className: "ln-meta", textContent: meta.join(" · ") }));
        if (n.children.length && depth < 12) li.append(el("ul", { className: "ln-tree" }, ...n.children.map((c) => node(c, depth + 1))));
        return li;
      };

      const sources = (() => {
        let typed = 0;
        let imported = 0;
        let formulas = 0;
        const walk = (n: LineageNode) => {
          if (n.repeat) return;
          if (n.kind === "typed") typed++;
          else if (n.kind === "imported") imported++;
          else if (n.kind === "formula") formulas++;
          n.children.forEach(walk);
        };
        walk(root);
        return [formulas ? `${formulas} formula${formulas === 1 ? "" : "s"}` : "", imported ? `${imported} imported value${imported === 1 ? "" : "s"}` : "", typed ? `${typed} typed-in value${typed === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
      })();

      const caption =
        root.kind === "formula"
          ? `A formula${sources ? ` built from ${sources}` : ""}. Each step is below, in plain English.`
          : root.kind === "typed"
            ? `Typed in${root.typed ? ` on ${when(root.typed.at)}` : ""}. Nothing feeds it: it's an input.`
            : root.kind === "imported"
              ? `Imported${root.origin ? `: ${root.origin}` : ""}.`
              : `${KIND[root.kind]}.`;
      p.body.append(
        headline({ value: displayValue(root.value) || "(empty)", unit: root.label, tone: "accent", caption }),
        section("How it's built", el("ul", { className: "ln-tree ln-root" }, node(root, 0)), goTo ? el("p", { className: "tk-muted", textContent: "Click a cell to see it in the sheet." }) : null),
      );

      const model = d.model?.() ?? null;
      if (root.kind === "formula" && root.formula && root.words) {
        const said = el("div", { className: "ln-model" });
        said.setAttribute("aria-live", "polite");
        const ask = button(
          model ? "Explain in plain English (local AI)" : "Explain with the local AI (set it up first: AI in the command palette)",
          async () => {
            ask.disabled = true;
            said.replaceChildren(el("p", { className: "tk-muted", textContent: "Asking the local model…" }));
            const r = await explainFormula({ formula: root.formula!, words: root.words!, value: root.value, lineage: text }, model);
            said.replaceChildren(
              el("p", { className: "tk-lead", textContent: r.value }),
              r.by === "model" ? notice("Written by the local model. Every figure and cell it mentions was checked against the formula and its inputs.", "success") : notice(`The model's answer wasn't used (${r.rejected ?? "no answer"}), so this is the plain reading.`, "warning"),
            );
            ask.disabled = false;
          },
          "secondary",
          "sparkles",
        );
        ask.disabled = !model;
        p.body.append(section("In plain English", ask, said));
      }
      p.body.append(section("Write-up for the working papers", el("div", { className: "ln-writeup", textContent: text })));
      p.footer.append(button("Copy the write-up", () => copy(), "primary", "copy"));
    },
  });
}
