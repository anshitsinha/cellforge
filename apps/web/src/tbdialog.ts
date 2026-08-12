/**
 * Map this sheet as a trial balance: pick what each column is (guessed for
 * you), see whether it balances, and make a standard TB sheet with code,
 * name, current, prior and movement.
 */
import type { Action } from "@cellforge/actions";
import { buildTb, formatValue, readTb, Table, TB_ROLES, type ColumnData, type TbResult, type TbRole } from "@cellforge/core";
import { namedHeader, sheetText } from "./cleanup";
import { EditableSource } from "./editable";
import { modal } from "./a11y";

export interface TbDeps {
  source: () => EditableSource;
  sheetName: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  goTo: (row: number, col: number) => void;
  status: (text: string) => void;
  focusGrid: () => void;
}

const ROLE_LABEL: Record<TbRole, string> = {
  code: "Account code",
  name: "Account name",
  "code+name": "Code and name together",
  debit: "Debit",
  credit: "Credit",
  balance: "Balance (signed)",
  "prior debit": "Prior debit",
  "prior credit": "Prior credit",
  "prior balance": "Prior balance (signed)",
  ignore: "Not used",
};

const money = (n: number) => formatValue(n, "#,##0.00;(#,##0.00)").text;

/** The TB as sheet columns. */
export function tbColumns(tb: TbResult): { columns: ColumnData[]; numFmts: string[] } {
  const n = tb.lines.length;
  const text = (name: string, values: string[]): ColumnData => {
    const dict: string[] = [];
    const lookup = new Map<string, number>();
    const codes = Uint32Array.from(values, (v) => {
      if (!v) return 0;
      let c = lookup.get(v);
      if (c === undefined) {
        c = dict.push(v);
        lookup.set(v, c);
      }
      return c;
    });
    return { kind: "string", name, codes, dict };
  };
  const nums = (name: string, f: (i: number) => number) => ({ kind: "number" as const, name, values: Float64Array.from({ length: n }, (_, i) => f(i)) });
  const columns: ColumnData[] = [text("Code", tb.lines.map((l) => l.code)), text("Name", tb.lines.map((l) => l.name)), nums("Current", (i) => tb.lines[i].current)];
  const fmt = "#,##0.00;(#,##0.00)";
  const numFmts = ["", "", fmt];
  if (tb.totalPrior !== null) {
    columns.push(nums("Prior", (i) => tb.lines[i].prior ?? 0), nums("Movement", (i) => Math.round((tb.lines[i].current - (tb.lines[i].prior ?? 0)) * 100) / 100));
    numFmts.push(fmt, fmt);
  }
  return { columns, numFmts };
}

export function openTbMapper(d: TbDeps): void {
  const src = d.source();
  const shift = namedHeader(src) ? 1 : 0;
  const read = readTb(sheetText(src));
  const roles = [...read.roles];

  const back = document.createElement("div");
  back.className = "palette-backdrop";
  modal(back);
  back.innerHTML = `<div class="palette import-dialog" role="dialog" aria-label="Trial balance"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const h = document.createElement("h3");
  h.textContent = "Map as a trial balance";
  const intro = document.createElement("p");
  intro.className = "hp-muted";
  intro.textContent = "Say what each column is; the guesses are filled in. Debits come out positive and credits negative.";
  const mapTable = document.createElement("table");
  mapTable.className = "cleanup-cols";
  const result = document.createElement("div");
  body.append(h, intro, mapTable, result);

  mapTable.innerHTML = "<tr><th>Column</th><th>Is</th><th>First values</th></tr>";
  read.header.forEach((name, c) => {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = name;
    const tdRole = document.createElement("td");
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `What ${name} is`);
    for (const r of TB_ROLES) sel.append(new Option(ROLE_LABEL[r], r, false, r === roles[c]));
    sel.addEventListener("change", () => {
      roles[c] = sel.value as TbRole;
      update();
    });
    tdRole.append(sel);
    const tdSample = document.createElement("td");
    tdSample.className = "hp-muted";
    tdSample.textContent = read.rows
      .slice(0, 3)
      .map((r) => r[c])
      .filter(Boolean)
      .join(", ");
    tr.append(tdName, tdRole, tdSample);
    mapTable.append(tr);
  });

  let tb: TbResult | null = null;
  const okBtn = document.createElement("button");
  const update = () => {
    result.replaceChildren();
    const p = (text: string, cls?: string) => {
      const el = document.createElement("p");
      el.textContent = text;
      if (cls) el.className = cls;
      result.append(el);
      return el;
    };
    const hasMoney = roles.some((r) => r === "debit" || r === "credit" || r === "balance");
    const hasLabel = roles.some((r) => r === "code" || r === "name" || r === "code+name");
    if (!hasMoney || !hasLabel) {
      tb = null;
      p("Pick at least an account (code or name) and a debit, credit or balance column.", "cleanup-warn");
      okBtn.disabled = true;
      return;
    }
    tb = buildTb(read.rows, roles);
    okBtn.disabled = !tb.lines.length;
    p(`${tb.lines.length} accounts.` + (tb.skipped.length ? ` ${tb.skipped.length} rows left out (totals and headings).` : ""));
    p(tb.balances ? "Debits equal credits." : `Doesn't balance: debits minus credits is ${money(tb.totalCurrent)}.`, tb.balances ? undefined : "cleanup-warn");
    if (tb.priorBalances !== null) p(tb.priorBalances ? "Prior period balances too." : `Prior period doesn't balance: ${money(tb.totalPrior ?? 0)}.`, tb.priorBalances ? undefined : "cleanup-warn");
    if (tb.duplicates.length) p(`Account codes used more than once: ${tb.duplicates.slice(0, 8).join(", ")}${tb.duplicates.length > 8 ? "…" : ""}`, "cleanup-warn");
    if (tb.bad.length) {
      const el = p("Not numbers: ", "cleanup-warn");
      for (const b of tb.bad.slice(0, 5)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "hp-cell";
        const row = read.sourceRows[b.row] - shift;
        btn.textContent = `"${b.value}"`;
        btn.title = "Show it in the sheet";
        btn.addEventListener("click", () => {
          back.remove();
          d.goTo(row, b.col);
        });
        el.append(btn, " ");
      }
    }
  };

  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  okBtn.type = "button";
  okBtn.textContent = "Make the trial balance sheet";
  actions.append(cancel, okBtn);
  body.append(actions);
  update();

  const close = () => {
    back.remove();
    d.focusGrid();
  };
  cancel.addEventListener("click", close);
  okBtn.addEventListener("click", () => {
    if (!tb) return;
    back.remove();
    const { columns, numFmts } = tbColumns(tb);
    const source = new EditableSource(new Table(columns), 5);
    const name = `${d.sheetName()} TB`.slice(0, 31);
    const lines = tb.lines.length;
    void d.run({ type: "sheet.insert", params: { name, source: d.putBlob(source), numFmts } }).then(() => {
      d.status(`Trial balance: ${lines} accounts`);
      d.focusGrid();
    });
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(back);
  okBtn.focus();
}
