import { describe, expect, it } from "vitest";
import { reconcile, Table, type ColumnData, type RecRecord } from "@cellforge/core";
import { proposeAdjustments, recStatement } from "@cellforge/core";
import { matchOpenItems, rollOutstanding, statementRec, type StatementRecRecord } from "@cellforge/core";
import { EditableSource } from "./editable";
import {
  adjustmentsSheet,
  bankStatementSheet,
  dateText,
  guessExtra,
  latestDate,
  openItemSheets,
  parseAmountInput,
  parseDateInput,
  parseLimits,
  PARTY_RE,
  readExtra,
  rollSheet,
  statementRecSheets,
  totalOf,
  TYPE_RE,
} from "./openitemsdialog";
import { guessMap, readSide, sheetHeader } from "./recondialog";

const str = (name: string, values: string[]): ColumnData => {
  const dict = [...new Set(values.filter(Boolean))];
  return { kind: "string", name, codes: Uint32Array.from(values, (v) => (v ? dict.indexOf(v) + 1 : 0)), dict };
};
const num = (name: string, values: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values) });
const values = (c: ColumnData | undefined): Array<string | number | null> =>
  !c ? [] : c.kind === "number" ? [...c.values].map((v) => (Number.isNaN(v) ? null : v)) : c.kind === "string" ? [...c.codes].map((k) => (k ? c.dict[k - 1] : null)) : [];
const col = (s: { columns: ColumnData[] }, name: string) => values(s.columns.find((c) => c.name === name));
const D = 45600;

describe("open items dialog helpers", () => {
  it("reads typed amounts, dates and bucket limits", () => {
    expect(parseAmountInput(" 1,234.50 ")).toBe(1234.5);
    expect(parseAmountInput("(12.00)")).toBe(-12);
    expect(parseAmountInput("")).toBeNull();
    expect(parseDateInput("2024-02-01")).toBe(45323);
    expect(parseDateInput("01/02/2024")).toBe(45323);
    expect(parseDateInput("nope")).toBeNull();
    expect(dateText(45323)).toBe("2024-02-01");
    expect(dateText(null)).toBe("");
    expect(parseLimits("90, 30;60 x")).toEqual([30, 60, 90]);
    expect(parseLimits("")).toEqual([30, 60, 90]);
    expect(latestDate([{ row: 1, date: 5 }], [{ row: 2, date: 9 }, { row: 3 }])).toBe(9);
    expect(totalOf([{ row: 1, amount: 0.1 }, { row: 2, amount: 0.2 }, { row: 3 }])).toBe(0.3);
  });

  it("guesses and reads the party and document type columns", () => {
    const src = new EditableSource(
      new Table([str("Customer", ["Acme", "Globex", ""]), str("Doc type", ["Invoice", "Payment", ""]), str("Ref", ["INV1", "P1", ""]), num("Amount", [100, -100, NaN])]),
    );
    const map = guessMap(src);
    const names = sheetHeader(src).names;
    const party = guessExtra(names, PARTY_RE, map);
    const type = guessExtra(names, TYPE_RE, map);
    expect([party, type]).toEqual([0, 1]);
    // "Doc type" had been guessed as the reference: it's handed over and "Ref" taken instead
    expect(map.key).toBe(2);
    const side = readSide(src, { ...map, text: -1 });
    expect(readExtra(src, side.records, party)).toEqual(["Acme", "Globex"]);
    expect(readExtra(src, side.records, type)).toEqual(["Invoice", "Payment"]);
    expect(readExtra(src, side.records, -1)).toEqual(["", ""]);
  });

  it("lays out the bank rec statement and the adjusting entries", () => {
    const ledger: RecRecord[] = [
      { row: 2, key: "C1", amount: -100, date: D },
      { row: 3, key: "D1", amount: 300, date: D + 20 },
    ];
    const bank: RecRecord[] = [
      { row: 2, key: "C1", amount: -100, date: D + 1 },
      { row: 3, amount: -12.5, date: D + 30, text: "Service charge" },
    ];
    const r = reconcile(ledger, bank, {});
    const st = recStatement(r, ledger, bank, { bankBalance: 887.5, ledgerBalance: 1200 });
    expect(st.difference).toBe(0);
    const sheet = bankStatementSheet(st, ledger, bank);
    expect(sheet.numFmts.length).toBe(sheet.columns.length);
    expect(col(sheet, "Line")).toEqual([
      "Balance per bank statement",
      "Add: deposits in transit",
      null,
      "Adjusted bank balance",
      null,
      "Balance per ledger",
      "Less: payments on the bank only (fees, direct debits)",
      null,
      "Adjusted ledger balance",
      null,
      "Difference (should be nil)",
    ]);
    expect(col(sheet, "Total")).toEqual([887.5, 300, null, 1187.5, null, 1200, -12.5, null, 1187.5, null, 0]);
    expect(col(sheet, "Ledger row")[2]).toBe("3");
    expect(col(sheet, "Bank row")[7]).toBe("3");
    const adj = adjustmentsSheet(proposeAdjustments(st, ledger, bank), ledger, bank);
    expect(col(adj, "Account")).toEqual(["Bank charges", "Bank"]);
    expect(col(adj, "Debit")).toEqual([12.5, null]);
    expect(col(adj, "Credit")).toEqual([null, 12.5]);
    expect(col(adj, "Source")).toEqual(["bank row 3", null]);
  });

  it("builds the roll-forward, open item and statement rec sheets", () => {
    const prior: RecRecord[] = [
      { row: 2, key: "CHQ1", amount: -50, date: D - 10 },
      { row: 3, key: "CHQ2", amount: -70, date: D - 100 },
    ];
    const current: RecRecord[] = [{ row: 9, key: "CHQ1", amount: -50, date: D + 4 }];
    const roll = rollSheet(rollOutstanding(prior, current, { asOf: D + 30 }), prior, current);
    expect(col(roll, "Status")).toEqual(["Cleared", "Still open"]);
    expect(col(roll, "Cleared by rows")).toEqual(["9", null]);
    expect(col(roll, "Age (days)")).toEqual([null, 130]);

    const items = [
      { row: 2, key: "A", amount: 10, party: "P" },
      { row: 3, key: "A", amount: -10, party: "P" },
      { row: 4, key: "B", amount: 5, party: "P", date: D },
    ];
    const [open, cleared] = openItemSheets(matchOpenItems(items, { asOf: D + 45 }), items);
    expect(col(open, "Sheet row")).toEqual([4]);
    expect(col(open, "Ageing bucket")).toEqual(["31-60"]);
    expect(col(cleared, "Sheet row")).toEqual([2, 3]);
    expect(col(cleared, "Rule")).toEqual(["Same reference and amount", null]);

    const ours: StatementRecRecord[] = [{ row: 2, key: "INV-1", amount: 100, date: D }];
    const theirs: StatementRecRecord[] = [
      { row: 2, key: "1", amount: -100, date: D },
      { row: 3, key: "2", amount: -40, date: D + 3 },
    ];
    const [stmt, matched] = statementRecSheets(statementRec(ours, theirs), ours, theirs);
    expect(col(stmt, "Line")).toEqual([
      "Balance per their statement",
      "Invoices on their statement not in our ledger",
      null,
      "Balance per our ledger (calculated)",
      null,
      "Balance per our ledger (stated)",
      "Unexplained difference",
    ]);
    expect(col(stmt, "Total")).toEqual([140, -40, null, 100, null, 100, 0]);
    expect(col(stmt, "Their row")[2]).toBe("3");
    expect(matched.name).toBe("Statement rec matched");
  });
});

describe("bank rec sample, end to end", () => {
  it("reaches a nil difference by its own steps: balances from Rec, items onto Outstanding, every check green", async () => {
    const { ActionHistory, BlobStore } = await import("@cellforge/actions");
    const { setCells, sheetActions } = await import("./actions");
    const { runWorkbookChecks } = await import("./checksui");
    const { guessMap } = await import("./recondialog");
    const { bankRecSample, sampleWorkbook } = await import("./samples");
    const { outstandingCells, prepareBankRec, recTargets } = await import("./openitemsdialog");
    const { workbook: wb } = await sampleWorkbook("bank-rec");
    const s = bankRecSample();
    // the statement starts from the closing balances already on Rec
    const t = recTargets(wb);
    expect(t.rec?.name).toBe("Rec");
    expect(t.outstanding?.name).toBe("Outstanding");
    expect(t.bankBalance).toBe(s.bankClosing);
    expect(t.ledgerBalance).toBe(s.ledgerClosing);
    const ledger = wb.byName("Cash book")!.source;
    const bank = wb.byName("Bank statement")!.source;
    const x = prepareBankRec({ ledger, bank, ledgerMap: guessMap(ledger), bankMap: guessMap(bank), bankBalance: t.bankBalance!, ledgerBalance: t.ledgerBalance! });
    expect(x.st.difference).toBe(0);
    // the items found are the planted ones, by kind
    const byKind = (list: { kind: string; amount: number }[]) => {
      const m: Record<string, number> = {};
      for (const i of list) m[i.kind] = Math.round(((m[i.kind] ?? 0) + i.amount) * 100) / 100;
      return m;
    };
    expect(byKind(x.rows)).toEqual(byKind(s.planted));
    // "Fill Outstanding and Rec", then Rec shows 0.00 and the checks pass
    const ctx = { workbook: wb, activeSheet: wb.byName("Cash book")!.id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(setCells(outstandingCells(x.rows, t.outstanding!.source), "fill", t.outstanding!.id));
    expect(wb.byName("Rec")!.source.getCell(13, 1)).toBe(0);
    const results = runWorkbookChecks(wb, wb.checks);
    expect(results.map((r) => [r.name, r.status])).toEqual(results.map((r) => [r.name, "pass"]));
    const nil = results.find((r) => r.name === "The reconciliation has no difference")!;
    expect(nil.message).toBe("B14 is 0.00, as it should be");
    expect(results.find((r) => r.name === "Every outstanding item has a kind")!.checked).toBe(x.rows.length);
    // filling again replaces the list rather than adding to it
    await h.run(setCells(outstandingCells(x.rows.slice(0, 2), t.outstanding!.source), "fill", t.outstanding!.id));
    expect(wb.byName("Outstanding")!.source.getCell(3, 0)).toBe(null);
  });

  it("before the items are listed, the nil-difference check says which cell is off and by how much", async () => {
    const { runWorkbookChecks } = await import("./checksui");
    const { sampleWorkbook } = await import("./samples");
    const { workbook: wb } = await sampleWorkbook("bank-rec");
    const r = runWorkbookChecks(wb, wb.checks).find((x) => x.name === "The reconciliation has no difference")!;
    expect(r.status).toBe("fail");
    expect(r.checked).toBe(1);
    expect(r.message).toMatch(/^B14 is \([\d,]+\.\d\d\); it should be 0\.00$/);
    expect(r.failures).toHaveLength(1);
    const kinds = runWorkbookChecks(wb, wb.checks).find((x) => x.name === "Every outstanding item has a kind")!;
    expect(kinds.message).toBe("Nothing to check yet: no rows");
  });
});
