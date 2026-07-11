/**
 * The tutorials' sample files and worked numbers, checked against the real
 * engine: the files on disk are the generated ones, cellforge reads them
 * the way the tutorials describe, and every formula a tutorial asks you to
 * type gives the result it says.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  benford,
  buildTb,
  cellDate,
  CellError,
  CsvParser,
  evaluate,
  findDuplicates,
  firstOf,
  footRange,
  guessFootLayout,
  jeLines,
  musSample,
  pageLines,
  parseFormula,
  parseStatement,
  readPdfText,
  readTb,
  reconcile,
  runJeTests,
  sequenceGaps,
  unwrapReport,
  type EvalContext,
  type RangeRef,
  type Scalar,
} from "@cellforge/core";
import * as S from "../scripts/samples.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const tutorial = (name: string) => read(`docs/tutorials/${name}.md`).toString("utf8");

function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  const p = new CsvParser((r: string[]) => rows.push(r), delimiter);
  p.push(text);
  p.end();
  return rows;
}

// ---------------------------------------------------- a tiny workbook --

type Input = string | number | null; // a string starting with = is a formula

/** Sheets of typed-in cells, row by row, with formulas worked out by the real evaluator. */
function workbook(sheets: Record<string, Input[][]>) {
  const contexts = new Map<string, EvalContext>();
  for (const [name, rows] of Object.entries(sheets)) {
    const memo = new Map<string, Scalar>();
    const ctx: EvalContext = {
      cell: (r, c) => {
        const input = rows[r]?.[c] ?? null;
        if (typeof input !== "string" || !input.startsWith("=")) return input;
        const key = `${r},${c}`;
        if (!memo.has(key)) memo.set(key, firstOf(evaluate(parseFormula(input), ctx)));
        return memo.get(key)!;
      },
      eachInRange: (range: RangeRef, visit) => {
        for (let r = range.top; r <= Math.min(range.bottom, rows.length - 1); r++) for (let c = range.left; c <= range.right; c++) visit(ctx.cell(r, c));
      },
      sheet: (n) => contexts.get(n.toLowerCase()) ?? null,
      rowCount: rows.length,
    };
    contexts.set(name.toLowerCase(), ctx);
  }
  return (sheet: string, ref: string) => {
    const m = /^([A-Z])(\d+)$/.exec(ref)!;
    const v = contexts.get(sheet.toLowerCase())!.cell(Number(m[2]) - 1, m[1].charCodeAt(0) - 65);
    return v instanceof CellError ? v.code : v;
  };
}

const near = (v: unknown, want: number) => expect(Math.round((v as number) * 100) / 100).toBe(want);

// -------------------------------------------------------------- files --

describe("the sample files", () => {
  it("on disk are exactly what scripts/samples.ts makes (run npm run samples -w @cellforge/docs)", () => {
    for (const [name, content] of Object.entries(S.sampleFiles())) {
      const want = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      expect(read(`apps/docs/public/samples/${name}`).equals(want), name).toBe(true);
    }
  });

  it("are linked from the tutorials, and the paste blocks are in them word for word", () => {
    const all = ["01-monthly-close", "02-bank-reconciliation", "03-audit-tests"].map(tutorial).join("\n");
    for (const name of Object.keys(S.sampleFiles())) expect(all, name).toContain(`(samples/${name})`);
    expect(tutorial("01-monthly-close")).toContain(S.tbSeptemberTsv());
    expect(tutorial("03-audit-tests")).toContain(S.footingTsv());
  });
});

// ------------------------------------------------------ monthly close --

describe("tutorial: monthly close", () => {
  const rows = parseCsv(S.tbOctober());

  it("Clean up leaves out the titles, the total and the footer", () => {
    const u = unwrapReport(rows);
    expect(u.header).toEqual(["Account", "Account name", "Debit", "Credit"]);
    expect(u.rows).toHaveLength(18);
    expect(u.dropped.map((d) => d.reason)).toEqual(["title", "title", "title", "total", "blank", "footer"]);
  });

  it("opened with 4 rows skipped, Clean up still drops the total, the blank row and the footer", () => {
    // the column names shown in the grid come first in what Clean up reads
    const u = unwrapReport(rows.slice(4));
    expect(u.header).toEqual(["Account", "Account name", "Debit", "Credit"]);
    expect(u.rows).toHaveLength(18);
    expect(u.dropped.map((d) => d.reason)).toEqual(["total", "blank", "footer"]);
    const tb = readTb(rows.slice(4));
    expect(buildTb(tb.rows, tb.roles).lines).toHaveLength(18);
  });

  it("the trial balance mapper reads the columns and the TB balances", () => {
    const tb = readTb(rows);
    expect(tb.roles).toEqual(["code", "name", "debit", "credit"]);
    const built = buildTb(tb.rows, tb.roles);
    expect(built.lines).toHaveLength(18);
    expect(built.balances).toBe(true);
    expect(S.ACCOUNTS.reduce((s, a) => s + a[2], 0)).toBeCloseTo(0, 6); // September balances too
  });

  it("the flux formulas give the numbers in the tutorial", () => {
    const n = S.ACCOUNTS.length;
    const sep = S.tbSeptemberTsv().split("\n").map((l, i) => l.split("\t").map((v) => (i === 0 ? v : Number(v))));
    const oct: Input[][] = S.ACCOUNTS.map(([code, name, , cur], i) => {
      const r = i + 1;
      return [
        code, // the TB sheet keeps codes as text
        name,
        cur,
        `=XLOOKUP(VALUE(A${r}), Sep!$A$2:$A$19, Sep!$B$2:$B$19, 0)`,
        `=C${r}-D${r}`,
        `=IF(D${r}=0, 0, E${r}/ABS(D${r}))`,
        `=CHOOSE(VALUE(LEFT(A${r}, 1)), "Assets", "Liabilities", "Equity", "Income", "Expenses", "Expenses")`,
        `=AND(ABS($E${r})>10000, ABS($F${r})>0.1)`, // the conditional formatting rule
      ];
    });
    const types = ["Assets", "Liabilities", "Equity", "Income", "Expenses"];
    const byType: Input[][] = [
      ["Type", "Last month", "This month", "Movement"],
      ...types.map((t, i) => [t, `=SUMIF(Oct!$G$1:$G$18, A${i + 2}, Oct!$D$1:$D$18)`, `=SUMIF(Oct!$G$1:$G$18, A${i + 2}, Oct!$C$1:$C$18)`, `=C${i + 2}-B${i + 2}`]),
      ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)"],
    ];
    const at = workbook({ Oct: oct, Sep: sep, "By type": byType });

    // the rows the rule highlights
    const flagged = S.ACCOUNTS.filter((_, i) => at("Oct", `H${i + 1}`) === true).map((a) => a[0]);
    expect(flagged).toEqual(["1100", "2200", "4000", "5000", "6300"]);
    near(at("Oct", "E2"), 16550); // trade debtors
    near(at("Oct", "F2"), 0.15);
    near(at("Oct", "E8"), -12000); // accruals
    near(at("Oct", "F8"), -1.85);
    near(at("Oct", "E17"), 15559.75); // marketing
    expect(at("Oct", "G13")).toBe("Expenses");
    expect(n).toBe(18);

    const want = [
      ["Assets", 365950, 384680.5, 18730.5],
      ["Liabilities", -79600, -98760.25, -19160.25],
      ["Equity", -170000, -170000, 0],
      ["Income", -543600, -605950, -62350],
      ["Expenses", 427250, 490029.75, 62779.75],
      ["Total", 0, 0, 0],
    ] as const;
    want.forEach(([t, b, c, d], i) => {
      expect(at("By type", `A${i + 2}`)).toBe(t);
      near(at("By type", `B${i + 2}`), b);
      near(at("By type", `C${i + 2}`), c);
      near(at("By type", `D${i + 2}`), d);
    });
  });
});

// ------------------------------------------------- bank reconciliation --

const pdfPages = await readPdfText(S.bankPdf());

describe("tutorial: bank reconciliation", () => {
  const st = parseStatement(pdfPages.flatMap((p, i) => pageLines(p).map((cells) => ({ page: i + 1, cells }))));

  it("the PDF statement reads cleanly: 13 transactions, no breaks, closing balance agrees", () => {
    expect(st.columns).toEqual(["date", "description", "debit", "credit", "balance"]);
    expect(st.transactions.map((t) => [t.description, t.amount, t.check])).toEqual(S.BANK.map(([, t, a]) => [t, a, "ok"]));
    expect(st.opening).toBe(S.OPENING_BALANCE);
    expect(st.closing).toBe(13715.27);
    expect(S.bankClosing()).toBe(13715.27);
    expect(st.closingMatches).toBe(true);
    expect(st.breaks).toBe(0);
  });

  it("the CSV version of the statement reads the same", () => {
    const csv = parseStatement(parseCsv(S.bankCsv()).map((r) => ({ page: 1, cells: r.flatMap((text, c) => (text.trim() ? [{ x: c, x2: c + 0.9, text: text.trim() }] : [])) })));
    expect(csv.transactions.map((t) => [t.date, t.amount])).toEqual(st.transactions.map((t) => [t.date, t.amount]));
    expect(csv.breaks).toBe(0);
  });

  const book = S.CASH_BOOK.map(([d, ref, text, amount], i) => ({ row: i + 1, key: ref, amount, date: cellDate(d) ?? undefined, text }));
  const bank = st.transactions.map((t, i) => ({ row: i + 1, amount: t.amount ?? undefined, date: t.date ?? undefined, text: t.description }));
  const rec = reconcile(book, bank); // default settings, no reference on the bank side

  it("matching leaves exactly the items the tutorial explains", () => {
    expect(rec.summary.byRule["amount+date"]).toBe(9);
    expect(rec.summary.byRule["many-to-one"]).toBe(1);
    const sum = rec.matches.find((m) => m.rule === "many-to-one")!;
    expect(sum.a.map((i) => book[i].key)).toEqual(["RCP-3102", "RCP-3103"]);
    expect(rec.unmatchedA.map((i) => book[i].text)).toEqual([
      "Payment - Coastal Packaging",
      "Cheque 100245 - Bright Signs",
      "Cheque 100246 - Lakeside Printing",
      "Receipt - Riverside Hotel",
    ]);
    expect(rec.unmatchedB.map((j) => bank[j].text)).toEqual(["FPO COASTAL PACKAGING", "ACCOUNT FEE OCTOBER", "INTEREST PAID"]);
    expect(rec.flags).toEqual([expect.objectContaining({ a: 5, b: 4, field: "amount", kind: "transposition" })]);
  });

  it("the rec statement formulas agree to zero", () => {
    const explain: Record<string, string> = {
      "Payment - Coastal Packaging": "Keying error",
      "Cheque 100245 - Bright Signs": "Outstanding cheque",
      "Cheque 100246 - Lakeside Printing": "Outstanding cheque",
      "Receipt - Riverside Hotel": "Deposit in transit",
      "FPO COASTAL PACKAGING": "Keying error",
      "ACCOUNT FEE OCTOBER": "Bank charge",
      "INTEREST PAID": "Interest",
    };
    // Rec unmatched sheets: Sheet row, Reference, Date, Amount, Description, Note, then the explanation you type in G
    const unmatched = (recs: typeof book | typeof bank, ids: number[]): Input[][] =>
      ids.map((i) => [recs[i].row, "", recs[i].date ?? null, recs[i].amount ?? null, recs[i].text ?? "", "", explain[recs[i].text ?? ""]]);
    const A = "'Rec unmatched A'!";
    const B = "'Rec unmatched B'!";
    const sumif = (side: string, what: string) => `SUMIF(${side}$G$1:$G$10, "${what}", ${side}$D$1:$D$10)`;
    const at = workbook({
      Book: S.CASH_BOOK.map(([d, r, t, a]) => [d, r, t, a]),
      Bank: st.transactions.map((t) => [t.date, t.description, t.amount, t.balance, 1, "ok"]),
      "Rec unmatched A": unmatched(book, rec.unmatchedA),
      "Rec unmatched B": unmatched(bank, rec.unmatchedB),
      "Rec statement": [
        ["Balance per bank statement", "=Bank!D13"],
        ["Less cheques not yet cleared", `=${sumif(A, "Outstanding cheque")}`],
        ["Add deposits not yet credited", `=${sumif(A, "Deposit in transit")}`],
        ["Adjusted bank balance", "=SUM(B1:B3)"],
        [null, null],
        ["Balance per cash book", "=24615.32+SUM(Book!D1:D15)"],
        ["Less bank charges", `=${sumif(B, "Bank charge")}`],
        ["Add interest received", `=${sumif(B, "Interest")}`],
        ["Correct the Coastal Packaging payment", `=${sumif(B, "Keying error")}-${sumif(A, "Keying error")}`],
        ["Adjusted cash book balance", "=SUM(B6:B9)"],
        [null, null],
        ["Difference", "=B4-B10"],
      ],
    });
    const want: [string, number][] = [["B1", 13715.27], ["B2", -2080.4], ["B3", 4500], ["B4", 16134.87], ["B6", 16148.39], ["B7", -35], ["B8", 12.48], ["B9", 9], ["B10", 16134.87], ["B12", 0]];
    for (const [ref, v] of want) near(at("Rec statement", ref), v);
    expect(S.bookClosing()).toBe(16148.39);
  });
});

// ------------------------------------------------------------ audit tests --

describe("tutorial: audit tests", () => {
  const inv = parseCsv(S.sampleFiles()["purchase-invoices-2024.csv"] as string).slice(1);
  const col = (c: number) => inv.map((r) => r[c]);

  it("gaps: INV-10213 to INV-10215 missing, INV-10301 used twice, nothing out of order", () => {
    const s = sequenceGaps(col(0)).series;
    expect(s).toHaveLength(1);
    expect(s[0].count).toBe(418);
    expect(s[0].missing).toEqual([{ from: 10213, to: 10215, count: 3 }]);
    expect(s[0].duplicates.map((d) => d.number)).toEqual([10301]);
    expect(s[0].outOfOrder).toEqual([]);
  });

  it("duplicates: one pair with the same vendor and amount", () => {
    const d = findDuplicates([{ values: col(2) }, { values: col(3).map(Number) }]);
    expect(d.groups.map((g) => g.rows.map((r) => inv[r][0]))).toEqual([[...S.DUPLICATE_PAIR]]);
  });

  it("near-duplicate vendors: one pair in the list of distinct vendors at 90%", () => {
    const vendors = [...new Set(col(2))];
    expect(vendors).toHaveLength(21); // what Remove duplicates on Vendor leaves
    const d = findDuplicates([{ values: vendors, match: "text", similarity: 0.9 }]);
    expect(d.groups.map((g) => g.rows.map((r) => vendors[r]).sort())).toEqual([[...S.MISSPELT_VENDOR]]);
  });

  it("Benford: first digits acceptable, first two digits too few values to conform", () => {
    expect(benford(col(3)).conformity).toBe("acceptable");
    const two = benford(col(3), "firstTwo");
    expect(two.n).toBe(418);
    expect(two.conformity).toBe("nonconformity");
  });

  it("a sample with a recorded seed picks the same items again", () => {
    const a = musSample(col(3), { size: 25, seed: 20241031 });
    const b = musSample(col(3), { size: 25, seed: 20241031 });
    expect(a.items.map((i) => i.row)).toEqual(b.items.map((i) => i.row));
    expect(a.items.length).toBe(25);
    expect(Math.round(a.interval! * 100) / 100).toBe(178272.99);
  });

  it("journal entry tests put the four planted entries on top", () => {
    const j = parseCsv(S.sampleFiles()["journals-2024-10.csv"] as string).slice(1);
    const c = (k: number) => j.map((r) => r[k] || null);
    const r = runJeTests(jeLines({ entry: c(0), date: c(1), posted: c(2), user: c(3), account: c(4), description: c(5), debit: c(6), credit: c(7) }), { limits: [10000] });
    expect(r.ranked.slice(0, 4).map((e) => e.id).sort()).toEqual(Object.values(S.FLAGGED_ENTRIES).sort());
    expect(r.ranked[0].id).toBe(S.FLAGGED_ENTRIES.weekend);
    expect(r.ranked[0].flags.map((f) => f.test).sort()).toEqual(["afterHours", "keywords", "rareUser", "round", "seldomAccount", "weekend"]);
    expect(r.ranked.slice(0, 4).map((e) => e.score)).toEqual([9, 6, 5, 5]);
    expect(r.ranked[4].score).toBe(2);
  });

  it("footing finds the Q3 total keyed 900 too high", () => {
    const cells = S.footingTsv().split("\n").map((l) => l.split("\t").map((v) => (Number.isNaN(Number(v)) ? v : Number(v))));
    const layout = guessFootLayout(cells);
    expect(layout).toEqual({ headerRows: 1, labelCols: 1 });
    const f = footRange(cells, layout);
    expect(f.issues).toBe(3);
    expect(f.columns.filter((l) => !l.ok).map((l) => [l.label, l.computed, l.stated])).toEqual([["Q3", 42050, 42950]]);
    expect(f.rows.filter((l) => !l.ok).map((l) => l.label)).toEqual(["Total"]);
  });
});
