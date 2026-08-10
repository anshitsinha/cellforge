import { type JsonSchema, s, validate } from "@cellforge/actions";
import { describe, expect, it } from "vitest";
import { actionGbnf, actionSchema, toGbnf } from "../src";
import { CATALOG } from "./fixtures";
import { gbnfAccepts, undefinedRules } from "./gbnf";

describe("actionSchema", () => {
  const schema = actionSchema(CATALOG);

  it("is the union of {type, params} over the catalog", () => {
    expect("anyOf" in schema && schema.anyOf.length).toBe(CATALOG.length);
    expect(validate({ type: "view.freeze", params: { rows: 1, cols: 0 } }, schema)).toEqual([]);
    expect(validate({ type: "rows.sortBy", params: { keys: [{ col: 2, descending: true }], hasHeader: true } }, schema)).toEqual([]);
  });

  it("rejects unknown types, bad params and extra keys", () => {
    expect(validate({ type: "view.melt", params: {} }, schema)).not.toEqual([]);
    expect(validate({ type: "view.freeze", params: { rows: -1, cols: 0 } }, schema)).not.toEqual([]);
    expect(validate({ type: "view.freeze", params: { rows: 1, cols: 0 }, extra: 1 }, schema)).not.toEqual([]);
  });

  it("can be narrowed to some actions", () => {
    const only = actionSchema(CATALOG, ["view.freeze"]);
    expect("anyOf" in only && only.anyOf.length).toBe(1);
  });
});

describe("toGbnf", () => {
  it("defines every rule it uses", () => {
    expect(undefinedRules(actionGbnf(CATALOG))).toEqual([]);
  });

  it("accepts valid actions and rejects invalid ones", () => {
    const g = actionGbnf(CATALOG);
    const yes = [
      { type: "view.freeze", params: { rows: 1, cols: 0 } },
      { type: "view.freeze", params: { rows: 1, cols: 0, sheet: "s2" } },
      { type: "rows.sortBy", params: { keys: [{ col: 2, descending: true }, { col: 0 }], hasHeader: true } },
      { type: "filter.set", params: { col: 0, condition: { kind: "text", op: "equals", value: 'say "hi" \\ there' } } },
      { type: "filter.set", params: { col: 2, condition: { kind: "number", op: ">", a: -1.5e3 } } },
      { type: "filter.set", params: { col: 2, condition: null } },
      { type: "filter.clear", params: {} },
      { type: "filter.clear", params: { sheet: "s1" } },
      { type: "format.set", params: { range: { top: 0, left: 1, bottom: 9, right: 1 }, style: { bold: true, numFmt: "$#,##0.00" } } },
      { type: "format.set", params: { range: { top: 0, left: 1, bottom: 9, right: 1 }, style: {} } },
      { type: "validation.add", params: { rule: { kind: "list", ranges: [{ top: 1, left: 4, bottom: 99, right: 4 }], list: ["Open", "Closed"] } } },
    ];
    for (const a of yes) expect(gbnfAccepts(g, JSON.stringify(a)), JSON.stringify(a)).toBe(true);
    // pretty-printed JSON is fine too (limited whitespace)
    expect(gbnfAccepts(g, JSON.stringify(yes[0], null, 1))).toBe(true);
    const no = [
      '{"type":"view.melt","params":{}}',
      '{"type":"view.freeze","params":{"rows":1}}', // missing cols
      '{"type":"view.freeze","params":{"rows":-1,"cols":0}}', // minimum 0
      '{"type":"view.freeze","params":{"rows":1.5,"cols":0}}', // integer
      '{"type":"view.freeze","params":{"rows":1,"cols":0,"oops":1}}', // unknown key
      '{"type":"rows.sortBy","params":{"keys":[]}}', // minItems 1
      '{"type":"filter.set","params":{"col":0,"condition":{"kind":"text","op":"like","value":"x"}}}', // enum
      '{"params":{"rows":1,"cols":0},"type":"view.freeze"}', // keys out of order
      "sure! here you go",
    ];
    for (const t of no) expect(gbnfAccepts(g, t), t).toBe(false);
  });

  it("handles objects with only optional keys in any subset (in order)", () => {
    const schema: JsonSchema = s.object({ a: s.int(), b: s.bool(), c: s.string() }, []);
    const g = toGbnf(schema);
    for (const t of ["{}", '{"a":1}', '{"b":true}', '{"c":"x"}', '{"a":1,"c":"x"}', '{"b":false,"c":"x"}', '{"a":1,"b":true,"c":"x"}']) expect(gbnfAccepts(g, t), t).toBe(true);
    for (const t of ['{"c":"x","a":1}', '{,"a":1}', '{"a":1,}', '{"a":1 "b":true}']) expect(gbnfAccepts(g, t), t).toBe(false);
  });

  it("supports free-form objects and anyOf", () => {
    const g = toGbnf(s.object({ spec: s.anyOf({ type: "object", properties: {}, additionalProperties: true }, s.null()) }));
    expect(gbnfAccepts(g, '{"spec":null}')).toBe(true);
    expect(gbnfAccepts(g, '{"spec":{"kind":"bar","series":[1,2,{"x":"y"}],"on":false}}')).toBe(true);
    expect(gbnfAccepts(g, '{"spec":3}')).toBe(false);
  });

  it("produces valid rule names and a root", () => {
    const g = actionGbnf(CATALOG);
    expect(g.startsWith("root ::= ")).toBe(true);
    for (const line of g.trim().split("\n")) expect(line).toMatch(/^[a-zA-Z0-9-]+ ::= /);
  });
});
