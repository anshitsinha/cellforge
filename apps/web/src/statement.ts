/**
 * Bank statements into a sheet: read the PDF (or CSV) as positioned lines,
 * parse the transactions, show the checks, and add the sheet.
 */
import type { Action } from "@cellforge/actions";
import { formatValue, pageLines, parseStatement, previewCsv, readPdfText, rowsToLines, Table, type ColumnData, type Statement, type StatementLine } from "@cellforge/core";
import { EditableSource } from "./editable";
import { noteFileRead } from "./evidence";

export async function statementLines(file: File): Promise<StatementLine[]> {
  noteFileRead(file, "statement");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.pdf$/i.test(file.name)) {
    const pages = await readPdfText(bytes);
    if (!pages.some((p) => p.items.length)) throw new Error("This PDF has no text in it (it may be a scan). Scanned statements can't be read yet.");
    return pages.flatMap((p, i) => pageLines(p).map((cells) => ({ page: i + 1, cells })));
  }
  if (bytes.length > 256 * 1024) throw new Error("This file is too big to be one statement; open it as a normal CSV instead.");
  return rowsToLines(previewCsv(bytes, {}, 1_000_000).rows);
}

const money = (n: number) => formatValue(n, "#,##0.00").text;

/** The transactions as sheet columns. */
export function statementColumns(s: Statement): { columns: ColumnData[]; numFmts: string[] } {
  const n = s.transactions.length;
  const date = new Float64Array(n).fill(NaN);
  const amount = new Float64Array(n).fill(NaN);
  const balance = new Float64Array(n).fill(NaN);
  const page = new Float64Array(n);
  const text = (values: string[]): ColumnData & { kind: "string" } => {
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
    return { kind: "string", name: "", codes, dict };
  };
  s.transactions.forEach((t, i) => {
    if (t.date !== null) date[i] = t.date;
    if (t.amount !== null) amount[i] = t.amount;
    if (t.balance !== null) balance[i] = t.balance;
    page[i] = t.page;
  });
  const dateText = s.transactions.map((t) => (t.date === null ? t.dateText : ""));
  const checks = s.transactions.map((t) =>
    t.check === "break" ? `break: expected ${money(t.expected ?? 0)}` : t.check === "ok" ? (t.signFromBalance ? "ok (sign from balance)" : "ok") : "",
  );
  const columns: ColumnData[] = [
    { kind: "number", name: "Date", values: date },
    { ...text(s.transactions.map((t) => t.description)), name: "Description" },
    { kind: "number", name: "Amount", values: amount },
    { kind: "number", name: "Balance", values: balance },
    { kind: "number", name: "Page", values: page },
    { ...text(checks), name: "Balance check" },
  ];
  if (dateText.some(Boolean)) columns.push({ ...text(dateText), name: "Date as printed" });
  return { columns, numFmts: ["yyyy-mm-dd", "", "#,##0.00", "#,##0.00", "", "", ""] };
}

export interface StatementDeps {
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

export async function importStatement(file: File, d: StatementDeps): Promise<void> {
  d.status(`Reading ${file.name}…`);
  let s: Statement;
  try {
    s = parseStatement(await statementLines(file));
  } catch (e) {
    d.status(`Couldn't read ${file.name}: ${(e as Error).message}`);
    return;
  }
  d.status("Ready");
  showStatement(file.name, s, d);
}

export function showStatement(fileName: string, s: Statement, d: StatementDeps): void {
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog" role="dialog" aria-label="Bank statement"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const h = document.createElement("h3");
  h.textContent = `Bank statement: ${fileName}`;
  body.append(h);
  const p = (text: string, cls?: string) => {
    const el = document.createElement("p");
    el.textContent = text;
    if (cls) el.className = cls;
    body.append(el);
    return el;
  };
  if (!s.transactions.length) {
    p("No transactions found. cellforge looks for a header line with a date column and money columns (Paid out / Paid in, Debit / Credit, or Amount) and a balance.", "cleanup-warn");
  } else {
    const fmt = (n: number | null) => (n === null ? "not shown" : money(n));
    p(`${s.transactions.length} transactions on ${s.pages.length} page${s.pages.length === 1 ? "" : "s"}. Opening balance ${fmt(s.opening)}, closing ${fmt(s.closing)}.`);
    if (s.breaks) p(`${s.breaks} balance${s.breaks === 1 ? " doesn't" : "s don't"} follow from the one before; they're marked "break" in the Balance check column.`, "cleanup-warn");
    else if (s.transactions.some((t) => t.check === "ok")) p("Every balance follows from the one before.");
    else p("There are no balances to check the transactions against.", "hp-muted");
    if (s.closingMatches === false) p(`The closing balance printed on the statement (${fmt(s.statedClosing)}) doesn't match the transactions (${fmt(s.closing)}).`, "cleanup-warn");
    const undated = s.transactions.filter((t) => t.date === null).length;
    if (undated) p(`${undated} date${undated === 1 ? "" : "s"} couldn't be read; the text is kept in "Date as printed".`, "cleanup-warn");

    const table = document.createElement("table");
    table.className = "cleanup-cols";
    table.innerHTML = "<tr><th>Page</th><th>Opening</th><th>Closing</th><th>Transactions</th><th>Breaks</th></tr>";
    for (const pg of s.pages) {
      const tr = document.createElement("tr");
      for (const v of [String(pg.page), fmt(pg.opening), fmt(pg.closing), String(pg.transactions), String(pg.breaks)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      if (pg.breaks) tr.lastElementChild!.className = "cleanup-warn";
      table.append(tr);
    }
    const wrap = document.createElement("div");
    wrap.className = "import-preview";
    wrap.append(table);
    body.append(wrap);
    p(`Dates read ${s.dateOrder === "mdy" ? "month first" : "day first"}; dates without a year take it from the statement.`, "hp-muted");
  }
  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  actions.innerHTML = `<button type="button" data-act="cancel">Cancel</button>` + (s.transactions.length ? `<button type="button" data-act="ok">Add the transactions</button>` : "");
  body.append(actions);
  const close = () => {
    back.remove();
    d.focusGrid();
  };
  actions.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "cancel") close();
    else if (act === "ok") {
      back.remove();
      const { columns, numFmts } = statementColumns(s);
      const source = new EditableSource(new Table(columns), 10);
      const name = fileName.replace(/\.[^.]+$/, "").slice(0, 31) || "Statement";
      void d.run({ type: "sheet.insert", params: { name, source: d.putBlob(source), numFmts, origin: `Bank statement read from ${fileName} (the Page column says which page)` } }).then(() => {
        d.status(`Added ${s.transactions.length} transactions from ${fileName}`);
        d.focusGrid();
      });
    }
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(back);
  (actions.querySelector<HTMLButtonElement>("[data-act=ok]") ?? actions.querySelector<HTMLButtonElement>("button"))!.focus();
}

/** Ask for a statement file. */
export function pickStatement(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.csv,.txt,.tsv";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
