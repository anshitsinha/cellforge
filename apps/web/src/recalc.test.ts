/**
 * Incremental recalculation: an edit must refresh everything that depends on
 * it (or the sheet shows stale numbers) and should leave everything else
 * alone (or it's slow). The randomised test checks the first property
 * against a from-scratch recalculation after every single step.
 */
import { describe, expect, it } from "vitest";
import { BlankSource, EditableSource, parseInput } from "./editable";
import { SyntheticSource } from "./demo";
import { Workbook } from "./workbook";

const set = (s: EditableSource, row: number, col: number, text: string) => s.setCell(row, col, parseInput(text));

describe("incremental recalculation", () => {
  it("follows chains of formulas", () => {
    const s = new EditableSource(new BlankSource(10, 5));
    set(s, 0, 0, "1");
    set(s, 0, 1, "=A1*2");
    set(s, 0, 2, "=B1+1");
    set(s, 0, 3, "=SUM(A1:C1)");
    expect(s.getCell(0, 3)).toBe(1 + 2 + 3);
    set(s, 0, 0, "10");
    expect(s.getCell(0, 2)).toBe(21);
    expect(s.getCell(0, 3)).toBe(10 + 20 + 21);
  });

  it("whole-column readers see edits anywhere in the column", () => {
    const s = new EditableSource(new BlankSource(100, 5));
    set(s, 0, 1, "=SUM(A:A)");
    expect(s.getCell(0, 1)).toBe(0);
    set(s, 99, 0, "5");
    expect(s.getCell(0, 1)).toBe(5);
  });

  it("fills: an edit inside the input block refreshes the fill", () => {
    const s = new EditableSource(new BlankSource(10, 3));
    for (let r = 0; r < 10; r++) set(s, r, 0, String(r));
    set(s, 0, 1, "=A1*10");
    s.addFill(1, 1, 9, s.getTemplate(0, 1).template, 0);
    expect(s.getCell(7, 1)).toBe(70);
    set(s, 7, 0, "100");
    expect(s.getCell(7, 1)).toBe(1000);
  });

  it("an unrelated edit leaves a compiled 200K-row fill alone", () => {
    const s = new EditableSource(new SyntheticSource(200_000), 4);
    let kernelRows = 0;
    s.onKernelRun = (run) => (kernelRows += run.rows);
    // H = units * unit_price, filled down the whole sheet and compiled
    set(s, 0, 7, "=E1*F1");
    const fill = s.addFill(7, 1, 199_999, s.getTemplate(0, 7).template, 0);
    expect(s.isCompiled(fill)).toBe(true);
    const v = s.getCell(150_000, 7);
    const computed = kernelRows;
    expect(computed).toBeGreaterThan(0);

    set(s, 5, 9, "note"); // column J: nothing reads it
    expect(s.getCell(150_000, 7)).toBe(v);
    expect(kernelRows).toBe(computed); // no recompute

    set(s, 150_000, 4, "0"); // units on that row: the fill reads it
    expect(s.getCell(150_000, 7)).toBe(0);
    expect(kernelRows).toBeGreaterThan(computed);
  });

  it("sorting keeps results right, and unsorting restores the index", () => {
    const s = new EditableSource(new BlankSource(3, 2));
    set(s, 0, 0, "3");
    set(s, 1, 0, "1");
    set(s, 2, 0, "2");
    set(s, 0, 1, "=A1*2");
    s.setRowOrder(Uint32Array.from([1, 2, 0]));
    expect(s.trackedDependents).toBe(0); // sorted: no index
    set(s, 2, 0, "5"); // the row that holds the formula's input
    expect(s.getCell(2, 1)).toBe(10);
    s.setRowOrder(null);
    expect(s.trackedDependents).toBe(1);
    set(s, 0, 0, "7");
    expect(s.getCell(0, 1)).toBe(14);
  });

  it("cross-sheet: only sheets that name the changed one are refreshed, through chains", () => {
    const wb = new Workbook({ name: "One", source: new EditableSource(new BlankSource(5, 3)) });
    const two = wb.add("Two", new EditableSource(new BlankSource(5, 3)));
    const three = wb.add("Three", new EditableSource(new BlankSource(5, 3)));
    const one = wb.sheets[0];
    set(one.source, 0, 0, "1");
    set(two.source, 0, 0, "=One!A1+1");
    set(three.source, 0, 0, "=Two!A1*10");
    expect(three.source.getCell(0, 0)).toBe(20);
    set(one.source, 0, 0, "4");
    expect(three.source.getCell(0, 0)).toBe(50);
    expect(two.source.refersTo("one")).toBe(true);
    expect(one.source.refersTo("two")).toBe(false);
  });
});

describe("randomised: incremental always equals a full recalculation", () => {
  // deterministic PRNG so failures reproduce
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }

  const ROWS = 8;
  const COLS = 5;
  const letter = (c: number) => String.fromCharCode(65 + c);

  // Formulas only read columns to their left, so there are no cycles: with a
  // cycle, which cell reports #CYCLE! depends on evaluation order, so
  // "incremental equals full" isn't defined there (cycles have their own test).
  function randomFormula(rand: () => number, col: number): string {
    const anyCol = () => letter(Math.floor(rand() * col));
    const ref = () => `${rand() < 0.2 ? "$" : ""}${anyCol()}${rand() < 0.2 ? "$" : ""}${1 + Math.floor(rand() * ROWS)}`;
    const pick = rand();
    if (pick < 0.35) return `=${ref()}+${ref()}`;
    if (pick < 0.6) return `=${ref()}*2-${Math.floor(rand() * 5)}`;
    if (pick < 0.8) {
      const c = anyCol();
      const a = 1 + Math.floor(rand() * ROWS);
      const b = 1 + Math.floor(rand() * ROWS);
      return `=SUM(${c}${Math.min(a, b)}:${c}${Math.max(a, b)})`;
    }
    if (pick < 0.9) return `=SUM(${anyCol()}:${anyCol()})`;
    return `=IF(${ref()}>3,${ref()},${ref()})`;
  }

  const snapshot = (s: EditableSource) => {
    const out: unknown[] = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) out.push(s.getCell(r, c));
    return out;
  };

  for (const seed of Array.from({ length: 24 }, (_, i) => i + 1)) {
    it(`seed ${seed}: 300 random steps`, () => {
      const rand = rng(seed);
      const s = new EditableSource(new BlankSource(ROWS, COLS));
      const fills: ReturnType<EditableSource["addFill"]>[] = [];
      const log: string[] = [];
      for (let step = 0; step < 300; step++) {
        const row = Math.floor(rand() * ROWS);
        const col = Math.floor(rand() * COLS);
        const op = rand();
        if (op < 0.4) {
          const t = String(Math.floor(rand() * 10));
          log.push(`set ${letter(col)}${row + 1} = ${t}`);
          set(s, row, col, t);
        } else if (op < 0.7 && col > 0) {
          const t = randomFormula(rand, col);
          log.push(`set ${letter(col)}${row + 1} = ${t}`);
          set(s, row, col, t);
        } else if (op < 0.78) {
          log.push(`revert ${letter(col)}${row + 1}`);
          s.revertCell(row, col);
        }
        else if (op < 0.86 && !s.rowOrder && row < ROWS - 1) {
          const bottom = row + 1 + Math.floor(rand() * (ROWS - row - 1));
          const { template, origin } = s.getTemplate(row, col);
          s.takeEdits(col, row + 1, bottom);
          log.push(`fill ${letter(col)}${row + 2}:${letter(col)}${bottom + 1} from row ${row + 1}`);
          fills.push(s.addFill(col, row + 1, bottom, template, origin));
        } else if (op < 0.9 && fills.length && !s.rowOrder) {
          log.push("remove a fill");
          s.removeFill(fills.splice(Math.floor(rand() * fills.length), 1)[0]);
        } else if (op < 0.95) {
          const order = Uint32Array.from({ length: ROWS }, (_, i) => i).sort(() => rand() - 0.5);
          log.push(`sort ${[...order].join(",")}`);
          s.setRowOrder(order);
        } else {
          log.push("unsort");
          s.setRowOrder(null);
        }
        // read a few cells so caches fill up between edits, like a real screen
        for (let k = 0; k < 6; k++) s.getCell(Math.floor(rand() * ROWS), Math.floor(rand() * COLS));

        const incremental = snapshot(s);
        const fresh = s.clone(); // same data, empty caches: computed from scratch
        const full = snapshot(fresh);
        const diffs = incremental
          .map((v, i) => (Object.is(v, full[i]) ? null : `${letter(i % COLS)}${Math.floor(i / COLS) + 1}: ${v} vs ${full[i]} [${s.getEditText(Math.floor(i / COLS), i % COLS)}]`))
          .filter(Boolean);
        expect(diffs, `seed ${seed}, step ${step}: ${log.slice(-8).join(" | ")}`).toEqual([]);
      }
    });
  }
});
