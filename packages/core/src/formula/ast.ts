/** A rectangular block of cells. `bottom` may be Infinity for whole-column refs (A:A). */
export interface RangeRef {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * `abs*` flags record `$` anchors. They only matter when a formula is copied
 * or filled to another row: relative parts move with it, anchored parts don't.
 */
export type Node =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  /** spill: A1# — the whole array that the formula in A1 spilled */
  | { type: "ref"; row: number; col: number; absRow?: boolean; absCol?: boolean; sheet?: string; spill?: boolean }
  | {
      type: "range";
      range: RangeRef;
      /** another sheet's name, as written (matched case-insensitively) */
      sheet?: string;
      absTop?: boolean;
      absBottom?: boolean;
      absLeft?: boolean;
      absRight?: boolean;
    }
  | { type: "unary"; op: "-" | "+" | "%"; arg: Node }
  | { type: "binary"; op: BinaryOp; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] }
  /** an array constant: {1,2;3,4} (rows of constants) */
  | { type: "array"; rows: Node[][] }
  /** a name: a LET variable or LAMBDA parameter */
  | { type: "name"; name: string }
  /** an argument left empty, as in XLOOKUP(a, b, c, , 0) */
  | { type: "missing" }
  /** an error written into the formula, e.g. #REF! where a deleted cell was */
  | { type: "error"; code: ErrorCode };

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

/** Spreadsheet errors are values, not exceptions - they flow through formulas. */
/** Why an error happened and how to fix it, when cellforge can tell (lookup near misses). */
export interface ErrorHint {
  message: string;
  fix?: { kind: "trim" | "toNumber"; range: RangeRef; sheet?: string; label: string };
}

export class CellError {
  constructor(
    readonly code: ErrorCode,
    readonly hint?: ErrorHint,
  ) {}
  toString(): string {
    return this.code;
  }
}

export type ErrorCode = "#DIV/0!" | "#VALUE!" | "#NAME?" | "#REF!" | "#NUM!" | "#CYCLE!" | "#ERROR!" | "#N/A" | "#SPILL!" | "#CALC!";

export const errors = {
  div0: new CellError("#DIV/0!"),
  value: new CellError("#VALUE!"),
  name: new CellError("#NAME?"),
  ref: new CellError("#REF!"),
  num: new CellError("#NUM!"),
  cycle: new CellError("#CYCLE!"),
  syntax: new CellError("#ERROR!"),
  na: new CellError("#N/A"),
  /** an array result has no room to spill */
  spill: new CellError("#SPILL!"),
  /** an array came out empty (FILTER with nothing left) */
  calc: new CellError("#CALC!"),
};
