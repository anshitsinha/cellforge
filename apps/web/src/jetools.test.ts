import { describe, expect, it } from "vitest";
import { Table, type ColumnData } from "@cellforge/core";
import { readSheet } from "./audittools";
import { EditableSource } from "./editable";
import {
  bare,
  buildSafeCopy,
  footSheet,
  guessDateOrder,
  guessJeMap,
  guessPartyMap,
  guessRollMap,
  guessSign,
  journalSheets,
  numberList,
  Out,
  parseDateList,
  readBlock,
  readJournal,
  readParties,
  sheetSource,
} from "./jetools";
import { footRange, redFlagOverlaps, runJeTests } from "@cellforge/core";

type Cell = number | string | null;

/** A sheet with named columns; a column of numbers (and blanks) is a number column, anything else text. */
function sheet(cols: Record<string, Cell[]>): EditableSource {
  const columns: ColumnData[] = Object.entries(cols).map(([name, vals]) => {
    if (vals.every((v) => v === null || typeof v === "number")) return { kind: "number", name, values: Float64Array.from(vals, (v) => (v === null ? NaN : (v as number))) };
    const dict: string[] = [];
    const codes = Uint32Array.from(vals, (v) => (v === null ? 0 : dict.push(String(v))));
    return { kind: "string", name, codes, dict };
  });
  return new EditableSource(new Table(columns), 5);
}

const colValues = (out: Out, name: string) => {
  const c = out.columns.find((x) => x.name === name)!;
  return c.kind === "number" ? Array.from(c.values, (v) => (Number.isNaN(v) ? null : v)) : Array.from(c.codes, (k) => (k ? c.dict[k - 1] : ""));
};

describe("journal tools", () => {
  it("guesses the journal columns", () => {
    const m = guessJeMap(["A: JE Number", "B: Effective Date", "C: Posted Date", "D: Posted By", "E: GL Account", "F: Account Name", "G: Amount", "H: Line Description"]);
    expect(m).toMatchObject({ entry: 0, date: 1, posted: 2, user: 3, account: 4, amount: 6, description: 7, debit: -1, credit: -1, time: -1 });
    const dc = guessJeMap(["Journal ID", "Date", "Entered", "Time", "User", "Account", "Debit", "Credit", "Narrative"]);
    expect(dc).toMatchObject({ entry: 0, date: 1, posted: 2, time: 3, user: 4, account: 5, amount: -1, debit: 6, credit: 7, description: 8 });
    // a lone debit column is the amount
    expect(guessJeMap(["Doc No", "Debit"])).toMatchObject({ amount: 1, debit: -1, credit: -1 });
  });

  it("reads lists the way they are typed", () => {
    expect(numberList("5000, 10000;50000 x")).toEqual([5000, 10000, 50000]);
    const { dates, bad } = parseDateList("2024-12-25, 26/12/2024; soon");
    expect(dates).toHaveLength(2);
    expect(dates[1] - dates[0]).toBe(1);
    expect(bad).toEqual(["soon"]);
    expect(guessDateOrder(["03/15/2024", "04/01/2024"])).toBe("mdy");
    expect(guessDateOrder(["15/03/2024", 45000])).toBe("dmy");
    expect(bare("AB: Vendor")).toBe("Vendor");
  });

  it("reads the journal and builds the flags sheet with original row numbers", () => {
    const src = sheet({
      Entry: ["J1", "J1", "J2", "J2", "J3", "J3"],
      Date: ["04/03/2024", "04/03/2024", "02/03/2024", "02/03/2024", "05/03/2024", "05/03/2024"],
      Account: ["6000", "2000", "6000", "2000", "6000", "2000"],
      Debit: [100, null, 5000, null, 50, null],
      Credit: [null, 100, null, 5000, null, 40],
      Description: ["Rent", "Rent", "Plug", "Plug", "Fees", "Fees"],
    });
    const data = readSheet(src);
    const map = guessJeMap(data.names);
    expect(map).toMatchObject({ entry: 0, date: 1, account: 2, debit: 3, credit: 4, description: 5 });
    const lines = readJournal(data, map);
    expect(lines.map((l) => l.amount)).toEqual([100, -100, 5000, -5000, 50, -40]);
    const r = runJeTests(lines, { tests: ["unbalanced", "weekend", "round", "keywords"] });
    expect(r.ranked.map((e) => e.id)).toEqual(["J3", "J2"]); // 5 for unbalanced; 1 + 1 + 2 = 4 for the Saturday round plug
    const [flags, summary] = journalSheets(data, lines, r, "GL");
    expect(flags.name).toBe("GL JE flags");
    expect(flags.out.columns.map((c) => c.name)).toEqual(["Rank", "Score", "Entry", "Row", "Tests", "Reasons", "Entry", "Date", "Account", "Debit", "Credit", "Description"]);
    expect(colValues(flags.out, "Row")).toEqual([5, 6, 3, 4]);
    expect(colValues(flags.out, "Rank")).toEqual([1, 1, 2, 2]);
    expect(colValues(flags.out, "Tests")[2]).toBe("Weekend and holiday postings, Round amounts, Keywords in the description");
    expect(summary.name).toBe("GL JE summary");
    expect(colValues(summary.out, "Entries flagged")).toEqual([1, 1, 1, 1]);
    expect(journalSheets(data, lines, r, "GL", false)).toHaveLength(1);
  });
});

describe("overlap tools", () => {
  it("guesses the columns and joins address parts", () => {
    const vend = readSheet(sheet({ "Vendor name": ["Acme Ltd", "Bolt"], IBAN: ["GB82WEST12345698765432", null], Address: ["1 Mill Road", "2 Elm St"], City: ["Leeds", "York"], Phone: [null, "0113 496 0000"], "VAT no": ["GB123456789", null] }));
    const m = guessPartyMap(vend.names);
    expect(m).toEqual({ bank: 1, taxId: 5, phone: 4, address: 2, name: 0 });
    const parties = readParties(vend, m, [3]);
    expect(parties[0]).toEqual({ name: "Acme Ltd", bank: "GB82WEST12345698765432", address: "1 Mill Road, Leeds", phone: undefined, taxId: "GB123456789" });
    const emp = readSheet(sheet({ "Employee name": ["Ann"], "Bank account": ["GB82 WEST 1234 5698 7654 32"], "Home address": ["1 Mill Rd"], Town: ["Leeds"] }));
    const pe = readParties(emp, guessPartyMap(emp.names), [3]);
    const r = redFlagOverlaps(parties, pe);
    expect(r.pairs.map((p) => p.matches.map((x) => x.field).sort())).toEqual([["address", "bank"]]);
  });
});

describe("footing tools", () => {
  it("reads the selection, or the whole sheet for a single cell", () => {
    const src = sheet({ Item: ["Sales", "Costs", "Total"], Q1: [100, -40, 60], Q2: [200, -60, 150], Total: [300, -100, 200] });
    const block = readBlock(src, { top: 0, left: 1, bottom: 2, right: 3 });
    expect(block.cells).toEqual([
      [100, 200, 300],
      [-40, -60, -100],
      [60, 150, 200],
    ]);
    const all = readBlock(src, { top: 1, left: 1, bottom: 1, right: 1 });
    expect(all.cells[0]).toEqual(["Sales", 100, 200, 300]);
    const r = footRange(all.cells, { labelCols: 1 });
    expect(r.issues).toBe(3); // Q2 column, the total row across, and the grand total
    const s = footSheet(r, all.top, all.left, all.cells.length - 1, 3, "TB");
    expect(s.name).toBe("TB footing");
    expect(colValues(s.out, "Cell")).toEqual(["B3", "C3", "D3", "D1", "D2", "D3", "D3", "D3"]);
    expect(colValues(s.out, "Result")).toEqual(["agrees", "DIFFERENCE", "agrees", "agrees", "agrees", "DIFFERENCE", "DIFFERENCE", "agrees"]);
    expect(colValues(s.out, "Line").slice(0, 4)).toEqual(["B", "C", "D", "Sales"]);
  });

  it("guesses the roll-forward columns and signs", () => {
    const g = guessRollMap(["A: Asset class", "B: Opening NBV", "C: Additions", "D: Disposals", "E: Depreciation", "F: Closing NBV"]);
    expect(g).toEqual({ label: 0, opening: 1, closing: 5, movements: [2, 3, 4] });
    expect(guessSign("Additions", [5, 10])).toBe(1);
    expect(guessSign("Disposals", [5, 10])).toBe(-1);
    expect(guessSign("Depreciation", [-5, -10])).toBe(1);
  });
});

describe("safe copy", () => {
  it("protects the chosen columns in a new sheet and leaves the original alone", async () => {
    const src = sheet({ Name: ["Ann Lee", "Bob Day", "Ann Lee"], Card: ["4111 1111 1111 1111", null, "5500 0000 0000 0004"], Ref: ["A1", "x", "A1"], Amount: [10, 20, 30] });
    src.setCell(1, 2, 7); // a number typed into a text column
    const data = readSheet(src);
    const fake = (s: string) => `${s.length.toString(16).padStart(4, "0")}${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
    const sheets = await buildSafeCopy(
      data,
      [
        { col: 0, method: "pseudonymise", prefix: "PERSON" },
        { col: 1, method: "mask", prefix: "CARD" },
        { col: 2, method: "keep", prefix: "ID" },
      ],
      fake,
      { mapping: true, sheet: "Staff" },
    );
    expect(sheets.map((s) => s.name)).toEqual(["Staff safe copy", "Staff pseudonym map"]);
    const copy = sheets[0].out;
    expect(colValues(copy, "Name")).toEqual(["PERSON_0001", "PERSON_0002", "PERSON_0001"]);
    expect(colValues(copy, "Card")).toEqual(["**** **** **** 1111", "", "**** **** **** 0004"]);
    expect(colValues(copy, "Amount")).toEqual([10, 20, 30]);
    // the number in a text column stays a number
    expect(copy.fixes).toEqual([[1, 2, 7]]);
    const made = sheetSource(copy);
    expect(made.getCell(1, 2)).toBe(7);
    expect(made.getCell(0, 2)).toBe("A1");
    expect(colValues(sheets[1].out, "Original value")).toEqual(["Ann Lee", "Bob Day"]);
    // the original is untouched
    expect(src.getCell(0, 0)).toBe("Ann Lee");
    expect(src.getCell(0, 1)).toBe("4111 1111 1111 1111");

    const hashed = await buildSafeCopy(data, [{ col: 0, method: "hash", prefix: "PERSON" }], fake, { hashLength: 6, mapping: true, sheet: "S" });
    expect(hashed).toHaveLength(1); // no pseudonyms, no mapping sheet
    const h = colValues(hashed[0].out, "Name");
    expect(h[0]).toBe(h[2]);
    expect(h[0]).toHaveLength(6);
  });
});
