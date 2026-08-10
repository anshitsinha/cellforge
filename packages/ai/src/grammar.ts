/**
 * Grammars for constrained decoding: a model asked for an action can only
 * produce text that parses as one of the catalog's actions with
 * well-shaped params. Two forms of the same thing:
 *
 * - `actionSchema`: one JSON schema, the union of `{type, params}` objects
 *   (what a JSON-schema-constrained decoder takes, and what `validate` checks)
 * - `toGbnf`: a GBNF grammar (llama.cpp's format) for token-level masking
 *
 * Objects are emitted with their keys in schema order, required keys
 * first; optional keys may be left out but not reordered. That is enough
 * for a decoder to always produce valid output.
 */
import type { JsonSchema } from "@cellforge/actions";
import type { CatalogEntry } from "./validate";

/** The union of every action in the catalog, as `{ "type": ..., "params": {...} }`. */
export function actionSchema(catalog: readonly CatalogEntry[], only?: readonly string[]): JsonSchema {
  const entries = only ? catalog.filter((c) => only.includes(c.type)) : catalog;
  const options: JsonSchema[] = entries.map((c) => ({
    type: "object",
    description: c.title,
    properties: { type: { type: "string", enum: [c.type] }, params: c.schema },
    required: ["type", "params"],
  }));
  return { anyOf: options, description: "one action from the catalog" };
}

// --------------------------------------------------------------- GBNF --

/** A JSON text as a GBNF string literal: "\"rows.sortBy\"" */
const lit = (json: string) => `"${json.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const PRIMITIVES: Record<string, string> = {
  ws: '[ \\t\\n]{0,4}',
  string: '"\\"" ( [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" ( ["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] ) )* "\\"" ws',
  integer: '"-"? ( "0" | [1-9] [0-9]{0,15} ) ws',
  uinteger: '( "0" | [1-9] [0-9]{0,15} ) ws',
  number: '"-"? ( "0" | [1-9] [0-9]{0,15} ) ( "." [0-9]{1,15} )? ( [eE] [-+]? [0-9]{1,3} )? ws',
  boolean: '( "true" | "false" ) ws',
  null: '"null" ws',
  value: "( object | array | string | number | boolean | null )",
  object: '"{" ws ( string ":" ws value ( "," ws string ":" ws value )* )? "}" ws',
  array: '"[" ws ( value ( "," ws value )* )? "]" ws',
};

/**
 * A GBNF grammar whose `root` accepts exactly the JSON texts that match the
 * schema (within the subset the actions use). Whitespace between tokens is
 * allowed but limited, so a model can't stall on spaces.
 */
export function toGbnf(schema: JsonSchema, rootName = "root"): string {
  const rules = new Map<string, string>();
  const used = new Set<string>();
  const memo = new Map<string, string>();
  let counter = 0;

  const prim = (name: string): string => {
    if (used.has(name)) return name;
    used.add(name);
    // pull in the primitives this one refers to
    for (const dep of PRIMITIVES[name].match(/\b[a-z]+\b/g) ?? []) if (dep in PRIMITIVES && dep !== name) prim(dep);
    return name;
  };

  const define = (hint: string, body: string): string => {
    const key = body;
    const hit = memo.get(key);
    if (hit) return hit;
    const name = `${hint.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "r"}-${++counter}`;
    rules.set(name, body);
    memo.set(key, name);
    return name;
  };

  /** A rule body for the schema (used inline or wrapped in a named rule). */
  const body = (s: JsonSchema, hint: string): string => {
    if ("anyOf" in s) return s.anyOf.map((x, i) => ref(x, `${hint}-${i}`)).join(" | ");
    switch (s.type) {
      case "string":
        if (s.enum) return s.enum.map((v) => lit(JSON.stringify(v))).join(" | ") + ` ${prim("ws")}`;
        return prim("string");
      case "integer":
        return s.minimum !== undefined && s.minimum >= 0 ? prim("uinteger") : prim("integer");
      case "number":
        return prim("number");
      case "boolean":
        return prim("boolean");
      case "null":
        return prim("null");
      case "array": {
        const item = ref(s.items, `${hint}-item`);
        const ws = prim("ws");
        const more = `( "," ${ws} ${item} )*`;
        return (s.minItems ?? 0) > 0 ? `"[" ${ws} ${item} ${more} "]" ${ws}` : `"[" ${ws} ( ${item} ${more} )? "]" ${ws}`;
      }
      case "object": {
        const ws = prim("ws");
        const props = Object.entries(s.properties);
        if (!props.length) return s.additionalProperties ? prim("object") : `"{" ${ws} "}" ${ws}`;
        const required = new Set(s.required ?? []);
        const kv = (k: string, v: JsonSchema) => `${lit(JSON.stringify(k))} ${ws} ":" ${ws} ${ref(v, `${hint}-${k}`)}`;
        const req = props.filter(([k]) => required.has(k));
        const opt = props.filter(([k]) => !required.has(k));
        // required keys in order, then each optional key, in order, if present
        if (req.length) {
          const head = req.map(([k, v]) => kv(k, v)).join(` "," ${ws} `);
          const tail = opt.map(([k, v]) => `( "," ${ws} ${kv(k, v)} )?`).join(" ");
          return `"{" ${ws} ${head}${tail ? " " + tail : ""} "}" ${ws}`;
        }
        // no required keys: any in-order subset of the optional ones
        // first(i) = kv_i tail(i+1) | first(i+1);  tail(i) = ( "," kv_i )? tail(i+1)
        const tailName: string[] = [];
        for (let i = opt.length - 1; i >= 0; i--) {
          const next = tailName[i + 1];
          tailName[i] = define(`${hint}-tail`, `( "," ${ws} ${kv(opt[i][0], opt[i][1])} )?${next ? " " + next : ""}`);
        }
        const firstName: string[] = [];
        for (let i = opt.length - 1; i >= 0; i--) {
          const t = tailName[i + 1];
          const own = `${kv(opt[i][0], opt[i][1])}${t ? " " + t : ""}`;
          firstName[i] = define(`${hint}-first`, firstName[i + 1] ? `${own} | ${firstName[i + 1]}` : own);
        }
        return `"{" ${ws} ${firstName[0]}? "}" ${ws}`;
      }
    }
  };

  /** A rule name for the schema. */
  const ref = (s: JsonSchema, hint: string): string => {
    const b = body(s, hint);
    if (/^[a-z0-9-]+$/i.test(b)) return b; // already a single rule
    return define(hint, b);
  };

  const rootBody = body(schema, "action");
  const out = [`${rootName} ::= ${rootBody}`];
  for (const [name, b] of rules) out.push(`${name} ::= ${b}`);
  for (const name of Object.keys(PRIMITIVES)) if (used.has(name)) out.push(`${name} ::= ${PRIMITIVES[name]}`);
  return out.join("\n") + "\n";
}

/** The GBNF grammar for "one action from the catalog". */
export function actionGbnf(catalog: readonly CatalogEntry[], only?: readonly string[]): string {
  return toGbnf(actionSchema(catalog, only));
}
