/**
 * Reference entries for the functions evaluate.ts handles itself because
 * they control when their arguments run: LET, LAMBDA and the LAMBDA helpers.
 */
import type { FunctionInfo } from "../functions";

export const SPECIAL_INFO: FunctionInfo[] = [
  {
    name: "LET",
    category: "Logic",
    summary: "Names intermediate results inside a formula, so a long formula reads clearly and repeated parts are worked out once.",
    args: [
      { name: "name1", description: "a name, e.g. rate" },
      { name: "value1", description: "its value" },
      { name: "name2, value2", description: "more names (each can use the ones before)", optional: true, repeats: true },
      { name: "calculation", description: "the result, using the names" },
    ],
    examples: [
      ["=LET(net, A3-A1, net/A1)", 2],
      ["=LET(x, 5, y, x*2, x+y)", 15],
    ],
  },
  {
    name: "LAMBDA",
    category: "Logic",
    summary: "Makes your own function from a formula. Call it straight away, keep it in a LET name, or pass it to MAP, REDUCE, BYROW and friends.",
    args: [
      { name: "parameter1", description: "a name for the first input", optional: true, repeats: true },
      { name: "calculation", description: "the formula, using the parameters" },
    ],
    examples: [
      ["=LAMBDA(n, n*n)(7)", 49],
      ["=LET(gross, LAMBDA(net, net*1.2), gross(A1))", 12],
    ],
  },
  {
    name: "MAP",
    category: "Logic",
    summary: "Runs a LAMBDA on every value of an array (or several arrays in step) and spills the results.",
    args: [
      { name: "array1", description: "the values" },
      { name: "array2", description: "more arrays, same size, passed as extra parameters", optional: true, repeats: true },
      { name: "lambda", description: "a LAMBDA taking one value per array" },
    ],
    examples: [["=SUM(MAP(A1:A3, LAMBDA(v, v*2)))", 120]],
  },
  {
    name: "REDUCE",
    category: "Logic",
    summary: "Folds an array into one value: the LAMBDA gets the running total and each value in turn.",
    args: [
      { name: "initial_value", description: "where the total starts" },
      { name: "array", description: "the values" },
      { name: "lambda", description: "LAMBDA(total, value, new total)" },
    ],
    examples: [["=REDUCE(0, A1:A3, LAMBDA(t, v, t+v))", 60]],
  },
  {
    name: "SCAN",
    category: "Logic",
    summary: "Like REDUCE but spills every step (a running total).",
    args: [
      { name: "initial_value", description: "where the total starts" },
      { name: "array", description: "the values" },
      { name: "lambda", description: "LAMBDA(total, value, new total)" },
    ],
    examples: [["=INDEX(SCAN(0, A1:A3, LAMBDA(t, v, t+v)), 3)", 60]],
  },
  {
    name: "BYROW",
    category: "Logic",
    summary: "Runs a LAMBDA on each row of an array; spills one result per row.",
    args: [{ name: "array", description: "the data" }, { name: "lambda", description: "a LAMBDA taking one row" }],
    examples: [["=SUM(BYROW(A1:A3, LAMBDA(r, MAX(r))))", 60]],
  },
  {
    name: "BYCOL",
    category: "Logic",
    summary: "Runs a LAMBDA on each column of an array; spills one result per column.",
    args: [{ name: "array", description: "the data" }, { name: "lambda", description: "a LAMBDA taking one column" }],
    examples: [["=INDEX(BYCOL(A1:A3, LAMBDA(c, SUM(c))), 1)", 60]],
  },
  {
    name: "MAKEARRAY",
    category: "Logic",
    summary: "Builds an array of a given size from a LAMBDA of the row and column number.",
    args: [
      { name: "rows", description: "how many rows" },
      { name: "columns", description: "how many columns" },
      { name: "lambda", description: "LAMBDA(row, column, value)" },
    ],
    examples: [["=INDEX(MAKEARRAY(3, 3, LAMBDA(r, c, r*c)), 2, 3)", 6]],
  },
];
