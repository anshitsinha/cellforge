/**
 * Where a number came from: a tree from a cell down through the formulas it
 * reads to the values typed in or imported, with where each sheet's data
 * came from (an imported file, a clean-up, a combine) and, for rows that
 * carry it, which file and row they came from. Also a plain-English
 * write-up to paste into a working paper.
 */
import { formatFormula, references } from "@cellforge/core";
import { columnLetter, type CellRange } from "@cellforge/grid";
import type { Workbook } from "./workbook";

export interface LineageNode {
  sheetId: string;
  sheetName: string;
  row: number;
  col: number;
  /** "Sheet!B5" or "B5" (on the cell's own sheet), or a range "B2:B9" */
  label: string;
  /** the value as shown */
  value: string;
  /** spill: part of the result of a formula elsewhere (its anchor is the child) */
  kind: "formula" | "typed" | "imported" | "empty" | "range" | "spill";
  formula?: string;
  /** a range: how many cells and their total */
  range?: { cells: number; numbers: number; total: number };
  /** when it was typed, and what (from the edit trail) */
  typed?: { at: number; text: string };
  /** where this sheet's data came from */
  origin?: string;
  /** provenance columns on this row (source file, original row, page…) */
  provenance?: string;
  /** shown once already higher up the tree */
  repeat?: boolean;
  children: LineageNode[];
}

export interface LineageOptions {
  /** the last time this cell was typed in, if known */
  lastEdit?: (sheetId: string, row: number, col: number) => { at: number; text: string } | undefined;
  depth?: number;
  /** ranges up to this many cells are opened up cell by cell */
  expandUpTo?: number;
  /** stop after this many nodes */
  maxNodes?: number;
}

const PROVENANCE = /^(source file|source|file|original row|row|page|from|sheet|statement page)$/i;

const a1 = (r: CellRange) => (r.top === r.bottom && r.left === r.right ? `${columnLetter(r.left)}${r.top + 1}` : `${columnLetter(r.left)}${r.top + 1}:${columnLetter(r.right)}${r.bottom + 1}`);

/** Provenance columns on a row: "source file march.csv, original row 14". */
function provenanceOf(wb: Workbook, sheetId: string, row: number): string | undefined {
  const src = wb.get(sheetId).source;
  const parts: string[] = [];
  const cols = src.usedRange().cols;
  for (let c = 0; c < cols && parts.length < 3; c++) {
    const name = src.getColumnName(c);
    if (!name || !PROVENANCE.test(name.trim())) continue;
    const v = src.getCell(row, c);
    if (v !== null && v !== "") parts.push(`${name.toLowerCase()} ${v}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

export function explainCell(wb: Workbook, sheetId: string, row: number, col: number, opts: LineageOptions = {}): LineageNode {
  const depth = opts.depth ?? 8;
  const expandUpTo = opts.expandUpTo ?? 6;
  const maxNodes = opts.maxNodes ?? 300;
  const seen = new Set<string>();
  let count = 0;
  const home = sheetId;

  const visit = (sid: string, r: number, c: number, level: number): LineageNode => {
    count++;
    const sheet = wb.get(sid);
    const src = sheet.source;
    const label = `${sid === home ? "" : `${sheet.name}!`}${columnLetter(c)}${r + 1}`;
    const v = src.getCell(r, c);
    const node: LineageNode = {
      sheetId: sid,
      sheetName: sheet.name,
      row: r,
      col: c,
      label,
      value: v === null ? "" : typeof v === "number" ? src.formatValue(v, src.getStyle(r, c)).text : String(v),
      kind: "empty",
      children: [],
    };
    const f = src.formulaAt(r, c);
    // a cell filled by a spilling formula: the formula is the explanation
    const spill = !f && v !== null ? src.spillAreaAt(r, c) : null;
    if (f) node.kind = "formula";
    else if (spill && (spill.row !== r || spill.col !== c)) node.kind = "spill";
    const key = `${sid}:${r}:${c}`;
    if (seen.has(key)) {
      node.repeat = true;
      if (node.kind === "empty" && v !== null && v !== "") node.kind = src.getStored(r, c) !== undefined ? "typed" : "imported";
      return node;
    }
    seen.add(key);
    if (node.kind === "spill") {
      node.children.push(visit(sid, spill!.row, spill!.col, level + 1));
      return node;
    }
    if (f) {
      node.kind = "formula";
      node.formula = formatFormula(f.ast, f.shift);
      if (level >= depth || count >= maxNodes) return node;
      for (const ref of references(f.ast, f.shift, src.evalContext)) {
        if (count >= maxNodes) break;
        const target = ref.sheet ? wb.byName(ref.sheet) : sheet;
        if (!target) continue;
        const rg = ref.range;
        const bottom = Math.min(rg.bottom, target.source.rowCount - 1);
        const right = Math.min(rg.right, target.source.colCount - 1);
        const cells = (bottom - rg.top + 1) * (right - rg.left + 1);
        if (cells <= 0) continue;
        if (cells <= expandUpTo) {
          for (let rr = rg.top; rr <= bottom; rr++) for (let cc = rg.left; cc <= right; cc++) node.children.push(visit(target.id, rr, cc, level + 1));
        } else {
          let numbers = 0;
          let total = 0;
          const usedRows = Math.min(bottom, target.source.usedRange().rows - 1);
          for (let rr = rg.top; rr <= usedRows; rr++) {
            for (let cc = rg.left; cc <= right; cc++) {
              const x = target.source.getCell(rr, cc);
              if (typeof x === "number") {
                numbers++;
                total += x;
              }
            }
          }
          const rangeLabel = `${target.id === home ? "" : `${target.name}!`}${a1({ top: rg.top, left: rg.left, bottom, right })}`;
          node.children.push({
            sheetId: target.id,
            sheetName: target.name,
            row: rg.top,
            col: rg.left,
            label: rangeLabel,
            value: "",
            kind: "range",
            range: { cells, numbers, total },
            ...(target.origin ? { origin: target.origin } : {}),
            children: [],
          });
          count++;
        }
      }
      return node;
    }
    if (v === null || v === "") return node;
    const typed = opts.lastEdit?.(sid, r, c);
    if (typed || src.getStored(r, c) !== undefined) {
      node.kind = "typed";
      if (typed) node.typed = typed;
    } else node.kind = "imported";
    if (sheet.origin) node.origin = sheet.origin;
    const prov = provenanceOf(wb, sid, r);
    if (prov) node.provenance = prov;
    return node;
  };
  return visit(sheetId, row, col, 0);
}

const when = (at: number) => new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The tree as plain sentences, one per line, for a working paper. */
export function writeUp(root: LineageNode): string {
  const lines: string[] = [];
  const describe = (n: LineageNode): string => {
    const name = n.label;
    switch (n.kind) {
      case "formula":
        return `${name} is ${n.value || "empty"}, worked out as ${n.formula}.`;
      case "typed":
        return `${name} is ${n.value}, typed in${n.typed ? ` on ${when(n.typed.at)}` : ""}${n.origin ? ` on a sheet that came from: ${n.origin}` : ""}.`;
      case "imported":
        return `${name} is ${n.value}, from the data as imported${n.origin ? ` (${n.origin})` : ""}${n.provenance ? `; this row: ${n.provenance}` : ""}.`;
      case "range": {
        const r = n.range!;
        return `${name} has ${r.cells.toLocaleString()} cells, ${r.numbers.toLocaleString()} of them numbers adding up to ${r.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}${n.origin ? `; that sheet came from: ${n.origin}` : ""}.`;
      }
      case "spill":
        return `${name} is ${n.value}, part of the result of the formula in ${n.children[0]?.label ?? "another cell"}.`;
      case "empty":
        return `${name} is empty.`;
    }
  };
  const walk = (n: LineageNode, indent: number) => {
    if (n.repeat) {
      lines.push(`${"  ".repeat(indent)}${n.label} (explained above).`);
      return;
    }
    lines.push(`${"  ".repeat(indent)}${describe(n)}`);
    for (const c of n.children) walk(c, indent + 1);
  };
  walk(root, 0);
  return lines.join("\n");
}
