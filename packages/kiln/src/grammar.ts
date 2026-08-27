/**
 * Grammar-constrained decoding for a JSON Schema subset (the one in
 * packages/actions/src/schema.ts): object / array / string / number /
 * integer / boolean / null / enum / anyOf, with minLength/maxLength,
 * minimum/maximum, minItems/maxItems, required and additionalProperties.
 *
 * The schema becomes a byte-level pushdown automaton. A parser state is an
 * immutable set of stacks (one per live anyOf alternative), so stepping is
 * allocation-only and states can be shared freely while walking a trie of
 * the vocabulary to build a token mask. Every state the automaton accepts can
 * still be completed to a valid document, and `completion()` gives that
 * shortest-ish completion, which the decoder forces when the token budget
 * runs out, so constrained output always parses and validates.
 *
 * Deliberate restrictions on what the model may emit (all still valid JSON):
 *   - numbers have no exponent, at most 15 integer and 6 fraction digits
 *   - at most 2 whitespace bytes between tokens; no whitespace after the value
 *   - enum strings are spelled exactly as JSON.stringify spells them
 *   - object keys contain no escapes; \u escapes in strings are not surrogates
 */

export type JsonSchema =
  | { type: "string"; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "null"; description?: string }
  | { type: "array"; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
  | {
      type: "object";
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: readonly string[];
      additionalProperties?: boolean;
    }
  | { anyOf: readonly JsonSchema[]; description?: string };

// ---- normalised schema nodes ------------------------------------------

type Node =
  | { k: "str"; min: number; max: number; lits: Uint8Array[] | null }
  | { k: "num"; int: boolean; min: number; max: number }
  | { k: "bool" }
  | { k: "null" }
  | { k: "arr"; items: Node[]; min: number; max: number }
  | { k: "obj"; props: Map<string, Node[]>; order: string[]; lits: Map<string, Uint8Array>; required: string[]; free: boolean }
  | { k: "any" };

const enc = new TextEncoder();
const ANY: Node = { k: "any" };
const LIT_TRUE = enc.encode("true"), LIT_FALSE = enc.encode("false"), LIT_NULL = enc.encode("null");
const MAX_INT_DIGITS = 15;
const MAX_FRAC_DIGITS = 6;
const WS_MAX = 2;

function normalise(s: JsonSchema): Node[] {
  if ("anyOf" in s) return s.anyOf.flatMap(normalise);
  switch (s.type) {
    case "string":
      return [{ k: "str", min: s.minLength ?? 0, max: s.maxLength ?? Infinity, lits: s.enum ? s.enum.map((v) => enc.encode(JSON.stringify(v))) : null }];
    case "number":
    case "integer":
      return [{ k: "num", int: s.type === "integer", min: s.minimum ?? -Infinity, max: s.maximum ?? Infinity }];
    case "boolean":
      return [{ k: "bool" }];
    case "null":
      return [{ k: "null" }];
    case "array":
      return [{ k: "arr", items: normalise(s.items), min: s.minItems ?? 0, max: s.maxItems ?? Infinity }];
    case "object": {
      const props = new Map<string, Node[]>();
      const lits = new Map<string, Uint8Array>();
      for (const [k, v] of Object.entries(s.properties)) {
        props.set(k, normalise(v));
        lits.set(k, enc.encode(JSON.stringify(k)));
      }
      return [{ k: "obj", props, order: [...props.keys()], lits, required: [...(s.required ?? [])], free: s.additionalProperties === true }];
    }
  }
}

// ---- frames and stacks -------------------------------------------------

type Frame =
  | { t: "V"; node: Node; ws: number }
  | { t: "S"; node: { min: number; max: number }; len: number; esc: number; uD: boolean; cont: number; lo: number; hi: number; units: number; key: string | null; exclude: ReadonlySet<string> | null }
  | { t: "L"; cands: Uint8Array[]; names: (string | null)[]; pos: number }
  | { t: "N"; node: { int: boolean; min: number; max: number }; text: string }
  | { t: "A"; node: Extract<Node, { k: "arr" }>; count: number; ph: "open" | "need" | "after" | "value"; ws: number }
  | { t: "O"; node: Extract<Node, { k: "obj" }>; seen: readonly string[]; ph: "open" | "needKey" | "colon" | "after" | "keying" | "value"; key: string; ws: number }
  | { t: "E"; done: boolean };

interface Stack {
  f: Frame;
  up: Stack | null;
}

/** An immutable parser state: the set of live alternatives. */
export type GrammarState = readonly Stack[];

interface Info {
  key?: string;
}

// only space and newline between tokens: tidy output, still valid JSON
const isWs = (b: number) => b === 0x20 || b === 0x0a;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isHex = (b: number) => isDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

function pushValue(alts: Node[], up: Stack): Stack[] {
  return alts.map((node) => ({ f: { t: "V", node, ws: 0 }, up }));
}

/** A parent receives a completed child. */
function resume(st: Stack, info: Info): Stack {
  const f = st.f;
  switch (f.t) {
    case "O":
      if (f.ph === "keying") return { f: { ...f, ph: "colon", key: info.key ?? "", ws: 0 }, up: st.up };
      return { f: { ...f, ph: "after", seen: [...f.seen, f.key], ws: 0 }, up: st.up };
    case "A":
      return { f: { ...f, ph: "after", count: f.count + 1, ws: 0 }, up: st.up };
    case "E":
      return { f: { t: "E", done: true }, up: null };
    default:
      throw new Error(`grammar: frame ${f.t} cannot hold a child`);
  }
}

function strFrame(min: number, max: number, key: string | null = null, exclude: ReadonlySet<string> | null = null): Frame {
  return { t: "S", node: { min, max }, len: 0, esc: 0, uD: false, cont: 0, lo: 0x80, hi: 0xbf, units: 0, key, exclude };
}

// number prefix rules: -?(0|[1-9]\d*)(\.\d+)?  without exponent
const NUM_PREFIX = /^-?(?:(?:0|[1-9]\d{0,14})(?:\.\d{0,6})?)?$/;
const NUM_FULL = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/;
const MAXABS = 1e15 - 1;

/** Is there a number in [min, max] whose text starts with `text`? */
function numFeasible(text: string, n: { int: boolean; min: number; max: number }): boolean {
  if (!NUM_PREFIX.test(text)) return false;
  if (n.int && text.includes(".")) return false;
  const neg = text.startsWith("-");
  const body = neg ? text.slice(1) : text;
  const fits = (lo: number, hi: number) => {
    // absolute range -> signed range
    const a = neg ? -hi : lo;
    // a "-" prefix must lead to a strictly negative value (no "-0")
    const b = neg ? -Math.max(lo, n.int ? 1 : 1e-6) : hi;
    const L = Math.max(a, n.min), H = Math.min(b, n.max);
    if (L > H) return false;
    return !n.int || Math.ceil(L) <= Math.floor(H);
  };
  const eps = n.int ? 1 : 1e-6;
  if (body === "") return text === "" ? fits(0, MAXABS) || fitsNeg() : fits(0, MAXABS);
  const dot = body.indexOf(".");
  if (dot >= 0) {
    const I = body.slice(0, dot);
    const F = body.slice(dot + 1);
    const lo = Number(I + "." + (F || "0"));
    const span = Math.pow(10, -F.length);
    return fits(lo, F.length >= MAX_FRAC_DIGITS ? lo : lo + span - 1e-6);
  }
  if (body === "0") return fits(0, n.int ? 0 : 1 - 1e-6);
  const d = Number(body);
  for (let j = 0; body.length + j <= MAX_INT_DIGITS; j++) {
    const p = Math.pow(10, j);
    if (fits(d * p, (d + 1) * p - eps)) return true;
  }
  return false;

  function fitsNeg() {
    const L = Math.max(-MAXABS, n.min), H = Math.min(-eps, n.max);
    if (L > H) return false;
    return !n.int || Math.ceil(L) <= Math.floor(H);
  }
}

function numComplete(text: string, n: { int: boolean; min: number; max: number }): boolean {
  if (!NUM_FULL.test(text) || /^-0(\.0*)?$/.test(text)) return false;
  if (n.int && text.includes(".")) return false;
  const v = Number(text);
  return v >= n.min && v <= n.max;
}

/** Shortest-ish digits to append to `text` to reach a valid number, or null. */
function numSuffix(text: string, n: { int: boolean; min: number; max: number }): string | null {
  let t = text;
  for (let guard = 0; guard < 40; guard++) {
    if (numComplete(t, n)) return t.slice(text.length);
    let moved = false;
    for (const c of "0123456789.-") {
      if (numFeasible(t + c, n)) {
        t += c;
        moved = true;
        break;
      }
    }
    if (!moved) return null;
  }
  return null;
}

function requiredMissing(f: Extract<Frame, { t: "O" }>): string[] {
  return f.node.required.filter((k) => !f.seen.includes(k));
}

function remainingKeys(f: Extract<Frame, { t: "O" }>): string[] {
  return f.node.order.filter((k) => !f.seen.includes(k));
}

/** Advance one stack by one byte, appending successors to `out`. */
function step(st: Stack, b: number, out: Stack[]): void {
  const f = st.f;
  const up = st.up!;
  switch (f.t) {
    case "E":
      return;
    case "V": {
      if (isWs(b)) {
        if (f.ws < WS_MAX) out.push({ f: { ...f, ws: f.ws + 1 }, up });
        return;
      }
      startValue(f.node, up, b, out);
      return;
    }
    case "L": {
      const cands: Uint8Array[] = [];
      const names: (string | null)[] = [];
      for (let i = 0; i < f.cands.length; i++) {
        const c = f.cands[i]!;
        if (c[f.pos] === b) {
          if (c.length === f.pos + 1) {
            out.push(resume(up, { key: f.names[i] ?? undefined }));
          } else {
            cands.push(c);
            names.push(f.names[i]!);
          }
        }
      }
      if (cands.length) out.push({ f: { t: "L", cands, names, pos: f.pos + 1 }, up });
      return;
    }
    case "N": {
      const t2 = f.text + String.fromCharCode(b);
      if ((isDigit(b) || b === 0x2e || b === 0x2d) && numFeasible(t2, f.node)) {
        out.push({ f: { ...f, text: t2 }, up });
        return;
      }
      // anything else ends the number; the parent must accept the byte
      if (numComplete(f.text, f.node)) step(resume(up, {}), b, out);
      return;
    }
    case "S": {
      const { max, min } = f.node;
      if (f.esc === 1) {
        if (b === 0x75 /* u */) out.push({ f: { ...f, esc: 2, uD: false }, up });
        else if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(b)) out.push({ f: { ...f, esc: 0, len: f.len + 1 }, up });
        return;
      }
      if (f.esc >= 2) {
        // \uXXXX, esc = 2..5 is the index of the next hex digit + 2
        if (!isHex(b)) return;
        const idx = f.esc - 2;
        if (idx === 0) {
          out.push({ f: { ...f, esc: 3, uD: b === 0x64 || b === 0x44 }, up });
          return;
        }
        if (idx === 1 && f.uD && !(b >= 0x30 && b <= 0x37)) return; // no surrogates
        if (idx === 3) out.push({ f: { ...f, esc: 0, len: f.len + 1 }, up });
        else out.push({ f: { ...f, esc: f.esc + 1 }, up });
        return;
      }
      if (f.cont > 0) {
        if (b < f.lo || b > f.hi) return;
        const key = f.key !== null ? f.key + String.fromCharCode(b) : null;
        if (f.cont === 1) out.push({ f: { ...f, cont: 0, lo: 0x80, hi: 0xbf, len: f.len + f.units, units: 0, key }, up });
        else out.push({ f: { ...f, cont: f.cont - 1, lo: 0x80, hi: 0xbf, key }, up });
        return;
      }
      if (b === 0x22) {
        if (f.len < min) return;
        if (f.key !== null && f.exclude?.has(f.key)) return;
        out.push(resume(up, { key: f.key !== null ? latin1ToUtf16(f.key) : undefined }));
        return;
      }
      if (b === 0x5c) {
        if (f.key === null && f.len < max) out.push({ f: { ...f, esc: 1 }, up });
        return;
      }
      if (b < 0x20) return;
      const key = f.key !== null ? f.key + String.fromCharCode(b) : null;
      if (b < 0x80) {
        if (f.len + 1 <= max) out.push({ f: { ...f, len: f.len + 1, key }, up });
        return;
      }
      let cont = 0, lo = 0x80, hi = 0xbf, units = 1;
      if (b >= 0xc2 && b <= 0xdf) cont = 1;
      else if (b === 0xe0) { cont = 2; lo = 0xa0; }
      else if (b === 0xed) { cont = 2; hi = 0x9f; }
      else if (b >= 0xe1 && b <= 0xef) cont = 2;
      else if (b === 0xf0) { cont = 3; lo = 0x90; units = 2; }
      else if (b >= 0xf1 && b <= 0xf3) { cont = 3; units = 2; }
      else if (b === 0xf4) { cont = 3; hi = 0x8f; units = 2; }
      else return;
      if (f.len + units > max) return;
      out.push({ f: { ...f, cont, lo, hi, units, key }, up });
      return;
    }
    case "A": {
      if (isWs(b)) {
        if (f.ph !== "value" && f.ws < WS_MAX) out.push({ f: { ...f, ws: f.ws + 1 }, up });
        return;
      }
      const n = f.node;
      if (f.ph === "open" || f.ph === "need") {
        if (f.ph === "open" && b === 0x5d && n.min === 0) {
          out.push(resume(up, {}));
          return;
        }
        if (f.count < n.max) {
          const self: Stack = { f: { ...f, ph: "value", ws: 0 }, up };
          for (const v of pushValue(n.items, self)) step(v, b, out);
        }
        return;
      }
      if (f.ph === "after") {
        if (b === 0x2c && f.count < n.max) out.push({ f: { ...f, ph: "need", ws: 0 }, up });
        else if (b === 0x5d && f.count >= n.min) out.push(resume(up, {}));
      }
      return;
    }
    case "O": {
      if (isWs(b)) {
        if (f.ph !== "value" && f.ph !== "keying" && f.ws < WS_MAX) out.push({ f: { ...f, ws: f.ws + 1 }, up });
        return;
      }
      switch (f.ph) {
        case "open":
        case "needKey":
          if (b === 0x7d && f.ph === "open" && requiredMissing(f).length === 0) out.push(resume(up, {}));
          else if (b === 0x22) startKey(f, up, out);
          return;
        case "after":
          if (b === 0x2c && (f.node.free || remainingKeys(f).length > 0)) out.push({ f: { ...f, ph: "needKey", ws: 0 }, up });
          else if (b === 0x7d && requiredMissing(f).length === 0) out.push(resume(up, {}));
          return;
        case "colon":
          if (b === 0x3a) {
            const self: Stack = { f: { ...f, ph: "value", ws: 0 }, up };
            const alts = f.node.props.get(f.key) ?? [ANY];
            out.push(...pushValue(alts, self));
          }
          return;
        default:
          return;
      }
    }
  }
}

function latin1ToUtf16(s: string): string {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf16ToLatin1(s: string): string {
  let out = "";
  for (const b of enc.encode(s)) out += String.fromCharCode(b);
  return out;
}

function startKey(f: Extract<Frame, { t: "O" }>, up: Stack, out: Stack[]) {
  const self: Stack = { f: { ...f, ph: "keying", ws: 0 }, up };
  const rem = remainingKeys(f);
  if (rem.length) {
    const lit: Stack = { f: { t: "L", cands: rem.map((k) => f.node.lits.get(k)!), names: rem, pos: 0 }, up: self };
    step(lit, 0x22, out);
  }
  if (f.node.free) {
    const exclude = new Set(f.node.order.map(utf16ToLatin1));
    out.push({ f: strFrame(0, 64, "", exclude), up: self });
  }
}

function startValue(node: Node, up: Stack, b: number, out: Stack[]) {
  switch (node.k) {
    case "str":
      if (b !== 0x22) return;
      if (node.lits) step({ f: { t: "L", cands: node.lits, names: node.lits.map(() => null), pos: 0 }, up }, b, out);
      else out.push({ f: strFrame(node.min, node.max), up });
      return;
    case "num":
      if (b === 0x2d || isDigit(b)) step({ f: { t: "N", node, text: "" }, up }, b, out);
      return;
    case "bool":
      step({ f: { t: "L", cands: [LIT_TRUE, LIT_FALSE], names: [null, null], pos: 0 }, up }, b, out);
      return;
    case "null":
      step({ f: { t: "L", cands: [LIT_NULL], names: [null], pos: 0 }, up }, b, out);
      return;
    case "arr":
      if (b === 0x5b && node.min <= node.max) out.push({ f: { t: "A", node, count: 0, ph: "open", ws: 0 }, up });
      return;
    case "obj":
      if (b === 0x7b) out.push({ f: { t: "O", node, seen: [], ph: "open", key: "", ws: 0 }, up });
      return;
    case "any":
      if (b === 0x22) out.push({ f: strFrame(0, Infinity), up });
      else if (b === 0x2d || isDigit(b)) step({ f: { t: "N", node: { int: false, min: -Infinity, max: Infinity }, text: "" }, up }, b, out);
      else if (b === 0x74 || b === 0x66 || b === 0x6e) step({ f: { t: "L", cands: [LIT_TRUE, LIT_FALSE, LIT_NULL], names: [null, null, null], pos: 0 }, up }, b, out);
      else if (b === 0x5b) out.push({ f: { t: "A", node: ANY_ARRAY, count: 0, ph: "open", ws: 0 }, up });
      else if (b === 0x7b) out.push({ f: { t: "O", node: ANY_OBJECT, seen: [], ph: "open", key: "", ws: 0 }, up });
      return;
  }
}

const ANY_ARRAY: Extract<Node, { k: "arr" }> = { k: "arr", items: [ANY], min: 0, max: Infinity };
const ANY_OBJECT: Extract<Node, { k: "obj" }> = { k: "obj", props: new Map(), order: [], lits: new Map(), required: [], free: true };

// ---- completions -------------------------------------------------------

const A_BYTE = 0x61;

function minValue(node: Node, depth = 0): number[] | null {
  if (depth > 32) return null;
  switch (node.k) {
    case "str":
      if (node.lits) return node.lits.length ? [...node.lits[0]!] : null;
      if (node.min > node.max) return null;
      return [0x22, ...new Array<number>(node.min).fill(A_BYTE), 0x22];
    case "num": {
      const s = numSuffix("", node);
      return s === null ? null : [...enc.encode(s)];
    }
    case "bool":
      return [...LIT_TRUE];
    case "null":
    case "any":
      return [...LIT_NULL];
    case "arr": {
      if (node.min > node.max) return null;
      const out = [0x5b];
      if (node.min > 0) {
        const item = minAlt(node.items, depth + 1);
        if (!item) return null;
        for (let i = 0; i < node.min; i++) {
          if (i) out.push(0x2c);
          out.push(...item);
        }
      }
      out.push(0x5d);
      return out;
    }
    case "obj": {
      const out = [0x7b];
      let first = true;
      for (const k of node.required) {
        const v = minAlt(node.props.get(k) ?? [ANY], depth + 1);
        if (!v) return null;
        if (!first) out.push(0x2c);
        first = false;
        out.push(...enc.encode(JSON.stringify(k)), 0x3a, ...v);
      }
      out.push(0x7d);
      return out;
    }
  }
}

function minAlt(alts: Node[], depth = 0): number[] | null {
  let best: number[] | null = null;
  for (const n of alts) {
    const v = minValue(n, depth);
    if (v && (!best || v.length < best.length)) best = v;
  }
  return best;
}

function finishFrame(f: Frame): { bytes: number[]; info: Info } | null {
  switch (f.t) {
    case "E":
      return { bytes: [], info: {} };
    case "V": {
      const v = minValue(f.node);
      return v ? { bytes: v, info: {} } : null;
    }
    case "L":
      return { bytes: [...f.cands[0]!.subarray(f.pos)], info: { key: f.names[0] ?? undefined } };
    case "N": {
      const s = numSuffix(f.text, f.node);
      return s === null ? null : { bytes: [...enc.encode(s)], info: {} };
    }
    case "S": {
      const bytes: number[] = [];
      let len = f.len;
      let key = f.key;
      if (f.esc === 1) { bytes.push(0x6e); len++; }
      else if (f.esc >= 2) { for (let i = f.esc; i <= 5; i++) bytes.push(0x30); len++; }
      else if (f.cont > 0) {
        bytes.push(f.lo);
        for (let i = 1; i < f.cont; i++) bytes.push(0x80);
        if (key !== null) for (let i = 0; i < f.cont; i++) key += String.fromCharCode(i === 0 ? f.lo : 0x80);
        len += f.units;
      }
      while (len < f.node.min || (key !== null && f.exclude?.has(key))) {
        if (len >= f.node.max) return null;
        bytes.push(A_BYTE);
        if (key !== null) key += "a";
        len++;
      }
      bytes.push(0x22);
      return { bytes, info: { key: key !== null ? latin1ToUtf16(key) : undefined } };
    }
    case "A": {
      const n = f.node;
      const item = () => minAlt(n.items);
      const out: number[] = [];
      let count = f.count;
      if (f.ph === "open" && n.min === 0) return { bytes: [0x5d], info: {} };
      if (f.ph === "open" || f.ph === "need") {
        const v = item();
        if (!v) return null;
        out.push(...v);
        count++;
      }
      while (count < n.min) {
        const v = item();
        if (!v) return null;
        out.push(0x2c, ...v);
        count++;
      }
      out.push(0x5d);
      return { bytes: out, info: {} };
    }
    case "O": {
      const out: number[] = [];
      const missing = requiredMissing(f);
      const addPair = (k: string, comma: boolean) => {
        const v = minAlt(f.node.props.get(k) ?? [ANY]);
        if (!v) return false;
        if (comma) out.push(0x2c);
        out.push(...enc.encode(JSON.stringify(k)), 0x3a, ...v);
        return true;
      };
      let rest = missing;
      if (f.ph === "colon") {
        const v = minAlt(f.node.props.get(f.key) ?? [ANY]);
        if (!v) return null;
        out.push(0x3a, ...v);
        rest = missing.filter((k) => k !== f.key);
        for (const k of rest) if (!addPair(k, true)) return null;
      } else if (f.ph === "needKey") {
        let k = missing[0] ?? remainingKeys(f)[0];
        if (k === undefined) {
          // a free key that isn't a declared property
          k = "a";
          while (f.node.props.has(k)) k += "a";
        }
        if (!addPair(k, false)) return null;
        for (const m of missing) if (m !== k && !addPair(m, true)) return null;
      } else {
        let comma = f.ph === "after";
        for (const k of missing) {
          if (!addPair(k, comma)) return null;
          comma = true;
        }
      }
      out.push(0x7d);
      return { bytes: out, info: {} };
    }
  }
}

function stackCompletion(st: Stack): number[] | null {
  const out: number[] = [];
  let cur: Stack | null = st;
  while (cur && cur.f.t !== "E") {
    const r = finishFrame(cur.f);
    if (!r) return null;
    out.push(...r.bytes);
    cur = resume(cur.up!, r.info);
  }
  return out;
}

// ---- public API --------------------------------------------------------

export class JsonGrammar {
  private root: Node[];
  constructor(readonly schema: JsonSchema) {
    this.root = normalise(schema);
  }

  initial(): GrammarState {
    return pushValue(this.root, { f: { t: "E", done: false }, up: null });
  }

  /** Feed bytes; null when the bytes can't be part of a valid document. */
  advance(state: GrammarState, bytes: ArrayLike<number>): GrammarState | null {
    let cur: Stack[] = state as Stack[];
    for (let i = 0; i < bytes.length; i++) {
      const next: Stack[] = [];
      for (const st of cur) step(st, bytes[i]!, next);
      if (next.length === 0) return null;
      cur = next;
    }
    return cur;
  }

  /** The document is complete and nothing more may follow. */
  isDone(state: GrammarState): boolean {
    return state.some((s) => s.f.t === "E" && s.f.done);
  }

  /** Generation may stop here (complete document, possibly extendable, e.g. a top-level number). */
  canStop(state: GrammarState): boolean {
    return state.some((s) => (s.f.t === "E" && s.f.done) || (s.f.t === "N" && s.up?.f.t === "E" && numComplete(s.f.text, s.f.node)));
  }

  /** Bytes that complete the document from this state (shortest over alternatives), or null if none. */
  completion(state: GrammarState): Uint8Array | null {
    let best: number[] | null = null;
    for (const st of state) {
      const c = stackCompletion(st);
      if (c && (!best || c.length < best.length)) best = c;
    }
    return best ? new Uint8Array(best) : null;
  }
}

// ---- token masks -------------------------------------------------------

interface TrieNode {
  next: Map<number, TrieNode>;
  ids: number[];
}

/** Anything that maps a token id to its bytes (Tokenizer does). */
export interface TokenBytes {
  readonly vocabSize: number;
  tokenBytes(id: number): Uint8Array | null;
}

/** Computes which tokens keep a grammar state alive, by walking a trie of the vocabulary. */
export class TokenMasker {
  private root: TrieNode = { next: new Map(), ids: [] };
  constructor(readonly vocab: TokenBytes) {
    for (let id = 0; id < vocab.vocabSize; id++) {
      const b = vocab.tokenBytes(id);
      if (!b || b.length === 0) continue;
      let n = this.root;
      for (const x of b) {
        let c = n.next.get(x);
        if (!c) n.next.set(x, (c = { next: new Map(), ids: [] }));
        n = c;
      }
      n.ids.push(id);
    }
  }

  /**
   * mask[id] = 1 when the token's bytes are accepted from `state`. With
   * `maxCompletion`, a token is only allowed if the document can still be
   * finished in that many bytes afterwards (used near the token budget).
   */
  mask(grammar: JsonGrammar, state: GrammarState, maxCompletion = Infinity): { mask: Uint8Array; next: Map<number, GrammarState> } {
    const mask = new Uint8Array(this.vocab.vocabSize);
    const next = new Map<number, GrammarState>();
    const walk = (node: TrieNode, st: Stack[]) => {
      if (node.ids.length) {
        const ok = maxCompletion === Infinity || (grammar.completion(st)?.length ?? Infinity) <= maxCompletion;
        if (ok) for (const id of node.ids) { mask[id] = 1; next.set(id, st); }
      }
      for (const [b, child] of node.next) {
        const out: Stack[] = [];
        for (const s of st) step(s, b, out);
        if (out.length) walk(child, out);
      }
    };
    walk(this.root, state as Stack[]);
    return { mask, next };
  }
}
