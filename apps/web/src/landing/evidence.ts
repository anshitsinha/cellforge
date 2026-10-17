/**
 * Evidence and review: the bank rec sample's own "Rec" sheet (workpaper
 * B-1), with its outstanding items filled in from the live reconciliation,
 * so its formulas come to a difference of 0.00 by themselves. Pick a figure
 * and "Explain this number" (the app's lineage) traces it; tick marks,
 * review notes and sign-offs are the app's review actions, with its rules
 * (an open review note blocks sign-off).
 */
import { bankRecSample } from "../samples";
import { explainCell, type LineageNode } from "../lineage";
import { openBook } from "./book";
import { runBankRec } from "./compute";
import { h, sheetTabs } from "./frame";
import { LiveSheet } from "./sheet";

const PREPARER = "A. Khan";
const YOU = "You";

/** What the template's Outstanding sheet wants for each reconciling item: its kind and amount, signed as the Rec sheet's SUMIFS expect. */
export function outstandingRows(rec: ReturnType<typeof runBankRec>, dates: { a: string[]; b: string[] }): { kind: string; date: string; description: string; amount: number }[] {
  const out: { kind: string; date: string; description: string; amount: number }[] = [];
  const st = rec.statement;
  const kindOf: Record<string, string> = { dit: "Deposit in transit", outstanding: "Outstanding payment", bankErrors: "Bank error", bankReceipts: "Bank only (fee, interest)", bankPayments: "Bank only (fee, interest)", ledgerErrors: "Ledger error" };
  for (const line of [...st.bankLines, ...st.ledgerLines]) {
    const kind = kindOf[line.id];
    if (!kind) continue;
    for (const it of line.items) {
      const date = it.a.length ? dates.a[it.a[0]] : dates.b[it.b[0]];
      const text = it.a.length ? rec.a[it.a[0]] : rec.b[it.b[0]];
      // deposits in transit and outstanding payments are listed as positive amounts
      const amount = line.id === "outstanding" ? -it.value : it.value;
      out.push({ kind, date, description: `${text.key ? `${text.key} ` : ""}${text.text ?? ""}`.trim(), amount: Math.round(amount * 100) / 100 });
    }
  }
  return out;
}

export async function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const side = frame.querySelector<HTMLElement>(".af-side")!;
  const signs = frame.querySelector<HTMLElement>(".af-signs")!;
  const sample = bankRecSample();
  const book = await openBook("bank-rec");
  const wb = book.wb;
  const recSheet = wb.byName("Rec")!;
  const outSheet = wb.byName("Outstanding")!;

  // fill Outstanding from the reconciliation, as the rec statement tool would
  const rec = runBankRec(sample.ledger, sample.bank);
  const items = outstandingRows(rec, { a: sample.ledger.map((l) => l.date), b: sample.bank.map((l) => l.date) });
  await book.type(
    outSheet.id,
    items.flatMap((it, i) => [
      { row: i + 1, col: 0, input: it.kind },
      { row: i + 1, col: 1, input: it.date },
      { row: i + 1, col: 2, input: it.description },
      { row: i + 1, col: 3, input: it.amount.toFixed(2) },
    ]),
  );
  // the preparer's tick marks and sign-off
  const mark = (top: number, bottom: number, m: string) => book.run({ type: "review.mark", params: { sheet: recSheet.id, range: { top, left: 1, bottom, right: 1 }, mark: m, on: true } });
  await mark(2, 2, "agreed");
  await mark(3, 5, "traced");
  await mark(6, 6, "footed");
  await mark(8, 8, "traced");
  await mark(11, 11, "footed");
  await mark(13, 13, "recalc");
  await book.run({ type: "review.signoff", params: { sheet: recSheet.id, role: "prepared", by: PREPARER } });
  book.history.clear();

  const ids = [outSheet.id, recSheet.id];
  let ready = false;
  let active = 1;
  host.replaceChildren();
  const sheet = new LiveSheet(host, book.view(recSheet.id), {
    label: "The sample's reconciliation sheet, a live cellforge sheet",
    frame,
    idleStatus: () => (active === 1 ? "Workpaper B-1" : `${items.length} outstanding items`),
    onSelect: (r) => ready && explain(ids[active], r.top, r.left),
    onEdit: (cell, text) => {
      void book.type(ids[active], [{ row: cell.row, col: cell.col, input: text }]).then(() => {
        book.show(sheet, ids[active], true);
        explain(ids[active], cell.row, cell.col);
      });
      return false;
    },
  });
  book.show(sheet, recSheet.id);
  const tabs = sheetTabs(frame, ["Outstanding", "B-1 · Rec"], (i) => {
    active = i;
    book.show(sheet, ids[i]);
  }, 1);

  let error = "";
  const review = () => wb.review.sheets[recSheet.id] ?? {};
  const renderSigns = () => {
    const r = review();
    const when = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    signs.replaceChildren(
      r.prepared ? h("span", { class: "sign", textContent: `✓ Prepared · ${r.prepared.by}` }) : h("span", { class: "sign off", textContent: "Not prepared" }),
      r.reviewed ? h("span", { class: "sign", textContent: `✓✓ Reviewed · ${r.reviewed.by} · ${when(r.reviewed.at)}` }) : h("span", { class: "sign off", textContent: "Not reviewed" }),
    );
  };

  const act = async (params: Record<string, unknown>, type: string) => {
    error = "";
    try {
      await book.run({ type, params: { sheet: recSheet.id, ...params } });
    } catch (e) {
      error = (e as Error).message;
    }
    renderSigns();
    book.show(sheet, ids[active], true);
    const r = sheet.range;
    explain(ids[active], r.top, r.left);
  };

  let shown = { id: "", row: -1, col: -1 };
  function explain(id: string, row: number, col: number) {
    shown = { id, row, col };
    const node = explainCell(wb, id, row, col, { depth: 5, expandUpTo: 4, maxNodes: 40 });
    const tree = h("ul", { class: "ex-tree" }, renderNode(node, 0));
    const r = review();
    const note = wb.get(recSheet.id).source.openReviewNotes();
    const actions = h("div", { class: "sp-actions" });
    if (id === recSheet.id) {
      const here = wb.get(id).source.extraAt(row, col)?.review;
      if (here && !here.cleared) actions.append(h("button", { type: "button", class: "af-btn", textContent: "Clear the review note", onclick: () => act({ row, col, by: YOU, clear: true }, "review.note") }));
      else actions.append(h("button", { type: "button", class: "af-btn", textContent: `Add a review note on ${String.fromCharCode(65 + col)}${row + 1}`, onclick: () => act({ row, col, by: YOU, text: "Agree the closing balance to the bank letter." }, "review.note") }));
    }
    if (r.reviewed) actions.append(h("button", { type: "button", class: "af-btn", textContent: "Take back the review", onclick: () => act({ role: "reviewed", by: YOU, remove: true }, "review.signoff") }));
    else actions.append(h("button", { type: "button", class: "af-btn af-btn-primary", textContent: "Sign off as reviewed", onclick: () => act({ role: "reviewed", by: YOU }, "review.signoff") }));
    side.replaceChildren(
      h(
        "div",
        { class: "sp" },
        h("p", { class: "sp-title" }, "Explain this number", h("span", { textContent: `${wb.get(id).name}!${String.fromCharCode(65 + col)}${row + 1}` })),
        h("p", { class: "sp-sub", textContent: "Where this figure comes from, through its formulas to the cells typed in. Pick a line to go there." }),
        tree,
        h("p", { class: "sp-h", textContent: "Review" }),
        h("p", { class: "sp-sub", textContent: note.length ? `${note.length} open review note${note.length === 1 ? "" : "s"} on B-1: sign-off waits until ${note.length === 1 ? "it's" : "they're"} cleared.` : r.reviewed ? "Signed off as reviewed. Changing the sheet after this shows as changed since sign-off in the app." : "Prepared and ticked. Ready for review." }),
        actions,
        error ? h("p", { class: "review-err", role: "alert", textContent: error }) : null,
      ),
    );
  }

  const go = (n: LineageNode) => {
    const i = ids.indexOf(n.sheetId);
    if (i >= 0 && i !== active) tabs.set(i);
    if (i < 0) return;
    const bottom = n.kind === "range" ? Math.min(n.row + (n.range?.cells ?? 1) - 1, Math.max(n.row, wb.get(n.sheetId).source.usedRange().rows - 1)) : n.row;
    sheet.reveal({ top: n.row, left: n.col, bottom, right: n.col }, "#1a73e8");
  };

  function renderNode(n: LineageNode, depth: number): HTMLElement {
    const what = h("span", { class: "ex-what" });
    if (n.kind === "formula") what.append(h("code", { textContent: n.formula ?? "" }), n.words ? ` ${n.words}` : "");
    else if (n.kind === "range") what.append(`${n.range!.numbers.toLocaleString("en-US")} numbers, total ${n.range!.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n.origin ? ` · ${n.origin}` : ""}`);
    else if (n.kind === "typed") what.append(`Typed in${n.origin ? ` · ${n.origin}` : ""}`);
    else if (n.kind === "imported") what.append(`From the data as imported${n.origin ? ` · ${n.origin}` : ""}`);
    else if (n.kind === "empty") what.append("Empty");
    if (n.repeat) what.append(" (explained above)");
    const btn = h("button", { type: "button", class: "ex-node", onclick: () => go(n) }, h("span", { class: "ex-line" }, h("span", { class: "ex-label", textContent: n.label }), h("b", { textContent: n.value })), what);
    const li = h("li", {}, btn);
    if (n.children.length && !n.repeat && depth < 6) li.append(h("ul", {}, ...n.children.map((c) => renderNode(c, depth + 1))));
    return li;
  }

  renderSigns();
  ready = true;
  // start on the difference: the number a reviewer looks at first
  sheet.reveal({ top: 13, left: 1, bottom: 13, right: 1 });
  sheet.grid.setHighlights([]);
  if (shown.row !== 13) explain(recSheet.id, 13, 1);
}
