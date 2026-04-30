/** Logic: IFS, SWITCH, XOR, IFNA. */
import { errors } from "../ast";
import { compare, eachValue, isError, scalarArg, toBool, type Scalar } from "../evaluate";
import { define } from "./define";

define(
  {
    name: "IFS",
    category: "Logic",
    summary: "Checks conditions in order and returns the value for the first that's true (#N/A if none is). Use TRUE as the last condition for a default.",
    args: [
      { name: "condition1", description: "the first test" },
      { name: "value1", description: "what to show if it's true" },
      { name: "condition2, value2", description: "more pairs", optional: true, repeats: true },
    ],
    examples: [
      ['=IFS(A2>25, "high", A2>15, "mid", TRUE, "low")', "mid"],
      ['=IFS(A1>100, "big")', "#N/A"],
    ],
  },
  (args) => {
    if (args.length < 2 || args.length % 2) return errors.value;
    for (let i = 0; i < args.length; i += 2) {
      const c = toBool(scalarArg(args[i]));
      if (isError(c)) return c;
      if (c) return scalarArg(args[i + 1]);
    }
    return errors.na;
  },
);

define(
  {
    name: "SWITCH",
    category: "Logic",
    summary: "Compares a value against a list and returns the result for the first match, or a default.",
    args: [
      { name: "expression", description: "the value to check" },
      { name: "value1", description: "a value to compare with" },
      { name: "result1", description: "what to return when it matches" },
      { name: "value2, result2…", description: "more pairs; an odd last argument is the default", optional: true, repeats: true },
    ],
    examples: [
      ['=SWITCH(B4, "North", 1, "East", 2, 0)', 2],
      ['=SWITCH(B4, "West", 1, "none")', "none"],
    ],
  },
  (args) => {
    if (args.length < 3) return errors.value;
    const v = scalarArg(args[0]);
    if (isError(v)) return v;
    let i = 1;
    for (; i + 1 < args.length; i += 2) {
      const w: Scalar = scalarArg(args[i]);
      if (isError(w)) return w;
      if (typeof w === typeof v && compare(v, w) === 0) return scalarArg(args[i + 1]);
    }
    return i < args.length ? scalarArg(args[i]) : errors.na;
  },
);

define(
  {
    name: "XOR",
    category: "Logic",
    summary: "TRUE when an odd number of the conditions are true.",
    args: [
      { name: "logical1", description: "a condition" },
      { name: "logical2", description: "more", optional: true, repeats: true },
    ],
    examples: [["=XOR(A1>5, A2>5)", false], ["=XOR(A1>15, A2>15)", true]],
  },
  (args, ctx) => {
    let odd = false;
    let err: Scalar = null;
    eachValue(args, ctx, (v, fromRange) => {
      if (err !== null) return;
      if (isError(v)) return void (err = v);
      if (fromRange && typeof v !== "boolean" && typeof v !== "number") return;
      const b = toBool(v);
      if (isError(b)) err = b;
      else if (b) odd = !odd;
    });
    return err ?? odd;
  },
);

define(
  {
    name: "IFNA",
    category: "Logic",
    summary: "A value, or something else if it's #N/A (a lookup that found nothing). Other errors still show.",
    args: [{ name: "value", description: "usually a lookup" }, { name: "value_if_na", description: "what to show instead of #N/A" }],
    examples: [['=IFNA(MATCH("West", B1:B5, 0), "not found")', "not found"], ["=IFNA(1/0, 0)", "#DIV/0!"]],
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const v = scalarArg(args[0]);
    return isError(v) && v.code === "#N/A" ? scalarArg(args[1]) : v;
  },
);
