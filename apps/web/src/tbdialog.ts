/**
 * Map this sheet as a trial balance: pick what each column is (guessed for
 * you), see whether it balances, and make a standard TB sheet with code,
 * name, current, prior and movement.
 */
import type { Action } from "@cellforge/actions";
import { buildTb, formatValue, readTb, TB_ROLES, type ColumnData, type TbResult, type TbRole } from "@cellforge/core";
import { namedHeader, sheetText } from "./cleanup";
import { EditableSource } from "./editable";
import "./openitems.css";
import { addResultSheets, el, headline, notice, plural, report, section, toolDialog } from "./toolkit";
import { renderTable } from "./ui/table";

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

/** A first value as it reads: numbers formatted (414,756.36), text as it is. Pure. */
export function sampleText(v: string): string {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return formatValue(Number(t), t.includes(".") ? "#,##0.00;(#,##0.00)" : "0").text;
  return t;
}

/** Debits (positive lines) and credits (negative lines) of a TB, each as a positive total. Pure. */
export function tbSides(tb: Pick<TbResult, "lines">): { debits: number; credits: number } {
  let dr = 0;
  let cr = 0;
  for (const l of tb.lines) {
    if (l.current > 0) dr += l.current;
    else cr -= l.current;
  }
  return { debits: Math.round(dr * 100) / 100, credits: Math.round(cr * 100) / 100 };
}

type TbLineRow = TbResult["lines"][number];

export function openTbMapper(d: TbDeps): void {
  const src = d.source();
  const shift = namedHeader(src) ? 1 : 0;
  const read = readTb(sheetText(src));
  const roles = [...read.roles];

  const dlg = toolDialog({ title: "Map as a trial balance", subtitle: `${d.sheetName()} as a standard TB sheet: code, name, current, prior and movement`, size: "lg", closeLabel: "Cancel", className: "tb-dialog", onClose: () => d.focusGrid() });
  const body = dlg.body;

  // what each column is: one row per column, with its first values
  const map = el("table", { className: "data-table data-table--dense tb-map" });
  const head = map.createTHead().insertRow();
  for (const h of ["Column", "Is", "First values"]) head.append(el("th", { scope: "col", textContent: h }));
  const tbody = map.createTBody();
  read.header.forEach((header, c) => {
    const name = header || `Column ${c + 1}`;
    const sample = read.rows
      .slice(0, 3)
      .map((r) => sampleText(r[c] ?? ""))
      .filter(Boolean)
      .join(" · ");
    const tr = tbody.insertRow();
    const sel = el("select");
    sel.setAttribute("aria-label", `What ${name} is`);
    for (const role of TB_ROLES) sel.append(new Option(ROLE_LABEL[role], role, false, role === roles[c]));
    sel.addEventListener("change", () => {
      roles[c] = sel.value as TbRole;
      tr.classList.toggle("tb-map--unused", sel.value === "ignore");
      update();
    });
    tr.classList.toggle("tb-map--unused", roles[c] === "ignore");
    tr.append(el("td", { className: "tb-map__name", textContent: name }), el("td", {}, sel), el("td", { className: "tb-map__sample", textContent: sample }));
  });
  const result = el("div", { className: "tb-result" });
  result.setAttribute("aria-live", "polite");
  body.append(section("Columns", el("p", { className: "tk-muted", textContent: "The guesses are filled in. Debits come out positive and credits negative." }), el("div", { className: "table-wrap" }, map)), section("Result", result));

  let tb: TbResult | null = null;
  const make = dlg.button(
    "Make the trial balance sheet",
    () => {
      if (!tb) return;
      dlg.close();
      const { columns, numFmts } = tbColumns(tb);
      const name = `${d.sheetName()} TB`;
      const lines = tb.lines.length;
      const summary = tb.balances ? `${plural(lines, "account")}; debits equal credits.` : `${plural(lines, "account")}; out of balance by ${money(tb.totalCurrent)}.`;
      void addResultSheets({ run: d.run, putBlob: d.putBlob }, [{ name, columns, numFmts, title: `Trial balance from ${d.sheetName()}`, summary, origin: `Mapped from ${d.sheetName()}` }]).then(() => report(d.status, `Trial balance: ${plural(lines, "account")}`));
    },
    { kind: "primary", disabled: true },
  );

  function update() {
    const hasMoney = roles.some((r) => r === "debit" || r === "credit" || r === "balance");
    const hasLabel = roles.some((r) => r === "code" || r === "name" || r === "code+name");
    if (!hasMoney || !hasLabel) {
      tb = null;
      make.disabled = true;
      result.replaceChildren(notice("Pick at least an account (code or name) and a debit, credit or balance column.", "info"));
      return;
    }
    const t = buildTb(read.rows, roles);
    tb = t;
    make.disabled = !t.lines.length;
    const { debits, credits } = tbSides(t);
    const kids: Node[] = [
      headline({
        value: money(t.totalCurrent),
        unit: "debits less credits",
        tone: t.balances ? "match" : "mismatch",
        caption: t.balances ? `It balances: debits equal credits across ${plural(t.lines.length, "account")}.` : `It doesn't balance: debits and credits differ by ${money(t.totalCurrent)}.`,
        lines: [
          { label: "Accounts", value: t.lines.length.toLocaleString("en-US") },
          { label: "Debits", value: money(debits) },
          { label: "Credits", value: money(credits) },
          ...(t.priorBalances !== null ? [{ label: "Prior period", value: t.priorBalances ? "Balances" : `Out by ${money(t.totalPrior ?? 0)}`, tone: t.priorBalances ? ("match" as const) : ("mismatch" as const) }] : []),
          ...(t.skipped.length ? [{ label: "Rows left out (totals, headings)", value: t.skipped.length.toLocaleString("en-US") }] : []),
        ],
      }),
    ];
    if (t.duplicates.length) kids.push(notice(`Account codes used more than once: ${t.duplicates.slice(0, 8).join(", ")}${t.duplicates.length > 8 ? "…" : ""}`, "warning"));
    if (t.bad.length) {
      const links = el("span");
      links.append(`${plural(t.bad.length, "value")} in the number columns ${t.bad.length === 1 ? "is not a number" : "are not numbers"}: `);
      for (const b of t.bad.slice(0, 5)) {
        const row = read.sourceRows[b.row] - shift;
        const btn = el("button", { type: "button", className: "tk-kv__link", textContent: `"${b.value}"`, title: "Show it in the sheet" });
        btn.addEventListener("click", () => {
          dlg.close();
          d.goTo(row, b.col);
        });
        links.append(btn, " ");
      }
      kids.push(notice(links, "warning"));
    }
    const prior = t.totalPrior !== null;
    const preview = renderTable<TbLineRow>({
      columns: [
        { key: "code", label: "Code" },
        { key: "name", label: "Name" },
        { key: "current", label: "Current", format: "amount" },
        ...(prior ? [{ key: "prior", label: "Prior", format: "amount" as const }, { key: "move", label: "Movement", format: "amount" as const, value: (l: TbLineRow) => Math.round((l.current - (l.prior ?? 0)) * 100) / 100 }] : []),
      ],
      rows: t.lines,
      dense: true,
      maxHeight: "30vh",
    });
    kids.push(section(`The TB sheet (${plural(t.lines.length, "account")})`, preview.element));
    result.replaceChildren(...kids);
  }
  update();
  make.focus();
}
