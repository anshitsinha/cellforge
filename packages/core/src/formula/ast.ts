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
  | { type: "ref"; row: number; col: number; absRow?: boolean; absCol?: boolean }
  | {
      type: "range";
      range: RangeRef;
      absTop?: boolean;
      absBottom?: boolean;
      absLeft?: boolean;
      absRight?: boolean;
    }
  | { type: "unary"; op: "-" | "+" | "%"; arg: Node }
  | { type: "binary"; op: BinaryOp; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

/** Spreadsheet errors are values, not exceptions - they flow through formulas. */
export class CellError {
  constructor(readonly code: ErrorCode) {}
  toString(): string {
    return this.code;
  }
}

export type ErrorCode = "#DIV/0!" | "#VALUE!" | "#NAME?" | "#REF!" | "#NUM!" | "#CYCLE!" | "#ERROR!" | "#N/A";

export const errors = {
  div0: new CellError("#DIV/0!"),
  value: new CellError("#VALUE!"),
  name: new CellError("#NAME?"),
  ref: new CellError("#REF!"),
  num: new CellError("#NUM!"),
  cycle: new CellError("#CYCLE!"),
  syntax: new CellError("#ERROR!"),
  na: new CellError("#N/A"),
};
