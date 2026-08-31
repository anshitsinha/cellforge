/**
 * A formula in plain English: "=IFERROR(SUMIFS(C:C, A:A, "North"), 0)"
 * reads "the total of C:C where A:A is "North", or 0 if that gives an error".
 * Deterministic, so it works with no model; a local model can smooth it,
 * but this is the version the model is checked against.
 */
import type { Node } from "./ast";
import { formatFormula } from "./print";
import { FUNCTION_INFO } from "./functions";

export interface WordsOptions {
  /** a name for a cell or range, e.g. its column heading: "C2:C200" → "Amount (C2:C200)" */
  label?: (node: Extract<Node, { type: "ref" | "range" }>, text: string) => string | null;
  /** row shift of a filled formula (as stored with it), so references print as on screen */
  shift?: number;
}

const OPS: Record<string, string> = {
  "+": "plus",
  "-": "minus",
  "*": "times",
  "/": "divided by",
  "^": "to the power of",
  "&": "joined to",
  "=": "equals",
  "<>": "is not",
  "<": "is less than",
  ">": "is more than",
  "<=": "is at most",
  ">=": "is at least",
};

/** A criteria argument ("North", ">1000", "<>") as words. */
function criterion(n: Node, w: (n: Node) => string): string {
  if (n.type !== "string") return `matches ${w(n)}`;
  const m = /^(<>|>=|<=|=|<|>)?(.*)$/s.exec(n.value)!;
  const [, op, rest] = m;
  const v = /^-?\d+(\.\d+)?$/.test(rest) ? rest : `"${rest}"`;
  if (!op || op === "=") return rest === "" ? "is blank" : `is ${v}`;
  if (op === "<>") return rest === "" ? "is not blank" : `is not ${v}`;
  return `${OPS[op]} ${v}`;
}

const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

export function formulaInWords(node: Node, opts: WordsOptions = {}): string {
  const w = (n: Node): string => {
    switch (n.type) {
      case "number":
        return String(n.value);
      case "string":
        return `"${n.value}"`;
      case "boolean":
        return n.value ? "TRUE" : "FALSE";
      case "ref":
      case "range": {
        const text = formatFormula(n, opts.shift ?? 0).slice(1);
        return opts.label?.(n, text) ?? text;
      }
      case "unary":
        return n.op === "-" ? `minus ${w(n.arg)}` : n.op === "%" ? `${w(n.arg)} percent` : w(n.arg);
      case "binary": {
        const side = (x: Node) => (x.type === "binary" ? `(${w(x)})` : w(x));
        return `${side(n.left)} ${OPS[n.op]} ${side(n.right)}`;
      }
      case "array":
        return `the list {${n.rows.map((r) => r.map(w).join(", ")).join("; ")}}`;
      case "name":
        return n.name;
      case "missing":
        return "(left out)";
      case "error":
        return `the error ${n.code}`;
      case "call":
        return call(n.name.toUpperCase(), n.args);
    }
  };

  const pairs = (args: Node[], from: number): string[] => {
    const out: string[] = [];
    for (let i = from; i + 1 < args.length; i += 2) out.push(`${w(args[i])} ${criterion(args[i + 1], w)}`);
    return out;
  };

  const call = (name: string, a: Node[]): string => {
    const all = () => list(a.map(w));
    switch (name) {
      case "SUM":
        return `the total of ${all()}`;
      case "AVERAGE":
        return `the average of ${all()}`;
      case "MIN":
        return `the smallest of ${all()}`;
      case "MAX":
        return `the largest of ${all()}`;
      case "COUNT":
        return `how many numbers are in ${all()}`;
      case "COUNTA":
        return `how many cells are filled in ${all()}`;
      case "COUNTBLANK":
        return `how many cells are blank in ${all()}`;
      case "PRODUCT":
        return `${all()} multiplied together`;
      case "ABS":
        return `${w(a[0])} without its sign`;
      case "ROUND":
      case "ROUNDUP":
      case "ROUNDDOWN": {
        const how = name === "ROUND" ? "rounded" : name === "ROUNDUP" ? "rounded up" : "rounded down";
        const d = a[1]?.type === "number" ? a[1].value : a[1]?.type === "unary" && a[1].op === "-" && a[1].arg.type === "number" ? -a[1].arg.value : null;
        const to = d === null ? `to ${a[1] ? w(a[1]) : 0} decimal places` : d === 0 ? "to a whole number" : d > 0 ? `to ${d} decimal place${d === 1 ? "" : "s"}` : `to the nearest ${10 ** -d}`;
        return `${w(a[0])} ${how} ${to}`;
      }
      case "IF":
        return `if ${w(a[0])} then ${a[1] ? w(a[1]) : "TRUE"}, otherwise ${a[2] ? w(a[2]) : "FALSE"}`;
      case "IFS": {
        const parts: string[] = [];
        for (let i = 0; i + 1 < a.length; i += 2) parts.push(`${w(a[i + 1])} if ${w(a[i])}`);
        return parts.join("; else ");
      }
      case "IFERROR":
        return `${w(a[0])}, or ${w(a[1])} if that gives an error`;
      case "IFNA":
        return `${w(a[0])}, or ${w(a[1])} if nothing is found`;
      case "AND":
        return `${list(a.map(w))} are all true`.replace(/ are all true$/, a.length === 1 ? " is true" : " are all true");
      case "OR":
        return a.length === 1 ? `${w(a[0])} is true` : `any of ${list(a.map(w))} is true`;
      case "NOT":
        return `not (${w(a[0])})`;
      case "SUMIF":
        return `the total of ${w(a[2] ?? a[0])} where ${w(a[0])} ${criterion(a[1], w)}`;
      case "COUNTIF":
        return `how many cells in ${w(a[0])} ${criterion(a[1], w).replace(/^is /, "are ")}`;
      case "AVERAGEIF":
        return `the average of ${w(a[2] ?? a[0])} where ${w(a[0])} ${criterion(a[1], w)}`;
      case "SUMIFS":
        return `the total of ${w(a[0])} where ${pairs(a, 1).join(" and ")}`;
      case "AVERAGEIFS":
        return `the average of ${w(a[0])} where ${pairs(a, 1).join(" and ")}`;
      case "MAXIFS":
        return `the largest of ${w(a[0])} where ${pairs(a, 1).join(" and ")}`;
      case "MINIFS":
        return `the smallest of ${w(a[0])} where ${pairs(a, 1).join(" and ")}`;
      case "COUNTIFS":
        return `how many rows have ${pairs(a, 0).join(" and ")}`;
      case "VLOOKUP":
      case "HLOOKUP": {
        const exact = a[3] && !(a[3].type === "boolean" && a[3].value) && !(a[3].type === "number" && a[3].value !== 0);
        const dir = name === "VLOOKUP" ? "column" : "row";
        return `look up ${w(a[0])} in the first ${dir} of ${w(a[1])} and take ${dir} ${w(a[2])}${exact ? " (exact match)" : " (closest match below)"}`;
      }
      case "XLOOKUP":
        return `look up ${w(a[0])} in ${w(a[1])} and take the matching value from ${w(a[2])}${a[3] && a[3].type !== "missing" ? `, or ${w(a[3])} if it isn't found` : ""}`;
      case "INDEX":
        if (a[1]?.type === "call" && a[1].name.toUpperCase() === "MATCH") {
          const m = a[1].args;
          return `look up ${w(m[0])} in ${w(m[1])} and take the matching value from ${w(a[0])}`;
        }
        return `the value at row ${a[1] ? w(a[1]) : 1}${a[2] ? `, column ${w(a[2])}` : ""} of ${w(a[0])}`;
      case "MATCH":
        return `the position of ${w(a[0])} in ${w(a[1])}`;
      case "TODAY":
        return "today's date";
      case "NOW":
        return "the date and time now";
      case "EOMONTH":
        return `the last day of the month ${a[1] && !(a[1].type === "number" && a[1].value === 0) ? `${w(a[1])} months after` : "of"} ${w(a[0])}`;
      case "EDATE":
        return `the date ${w(a[1])} months after ${w(a[0])}`;
      case "YEAR":
      case "MONTH":
      case "DAY":
        return `the ${name.toLowerCase()} of ${w(a[0])}`;
      case "LEFT":
        return `the first ${a[1] ? w(a[1]) : 1} characters of ${w(a[0])}`;
      case "RIGHT":
        return `the last ${a[1] ? w(a[1]) : 1} characters of ${w(a[0])}`;
      case "MID":
        return `${w(a[2])} characters of ${w(a[0])} from character ${w(a[1])}`;
      case "LEN":
        return `the length of ${w(a[0])}`;
      case "TRIM":
        return `${w(a[0])} with extra spaces removed`;
      case "UPPER":
      case "LOWER":
        return `${w(a[0])} in ${name.toLowerCase()} case`;
      case "CONCAT":
      case "CONCATENATE":
        return `${list(a.map(w))} joined together`;
      case "TEXT":
        return `${w(a[0])} shown as ${w(a[1])}`;
      case "VALUE":
        return `${w(a[0])} as a number`;
      case "SUBTOTAL":
      case "AGGREGATE":
        return `a subtotal of ${list(a.slice(1).map(w))} (ignoring other subtotals)`;
      case "FILTER":
        return `the rows of ${w(a[0])} where ${w(a[1])}${a[2] ? `, or ${w(a[2])} if none` : ""}`;
      case "SORT":
        return `${w(a[0])} sorted`;
      case "UNIQUE":
        return `the distinct values of ${w(a[0])}`;
      default: {
        const info = FUNCTION_INFO[name];
        const what = info ? info.summary.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()) : null;
        return `${name}(${a.map(w).join(", ")})${what ? ` (${what})` : ""}`;
      }
    }
  };

  const text = w(node);
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}
