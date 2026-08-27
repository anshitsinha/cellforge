import { describe, expect, it } from "vitest";
import { s, validate } from "../../actions/src/schema";
import { JsonGrammar, TokenMasker, type GrammarState, type JsonSchema } from "../src/grammar";
import { makeRng } from "../src/sample";

const enc = new TextEncoder();
const dec = new TextDecoder();

const ACTION = s.object(
  {
    type: s.string(undefined, { enum: ["rows.sort", "cells.set", "col.format"] }),
    params: s.anyOf(
      s.object({ col: s.int(undefined, 0, 16383), descending: s.bool() }, ["col"]),
      s.object({ row: s.int(undefined, 0), col: s.int(undefined, 0), value: s.anyOf(s.string(undefined, { maxLength: 20 }), s.number(), s.bool(), s.null()) }),
    ),
    note: s.string(undefined, { minLength: 2, maxLength: 12 }),
  },
  ["type", "params"],
);

const SCHEMAS: [string, JsonSchema][] = [
  ["action", ACTION],
  ["array of bounded numbers", s.array({ type: "number", minimum: -2.5, maximum: 7 }, undefined, 1, 4)],
  ["integers in a range", { type: "integer", minimum: 100, maximum: 250 }],
  ["negative range", { type: "number", minimum: -10, maximum: -5 }],
  ["fraction range", { type: "number", minimum: 0.25, maximum: 0.3 }],
  ["free object", { type: "object", properties: { id: s.int() }, required: ["id"], additionalProperties: true }],
  ["nested arrays", s.array(s.array(s.anyOf(s.bool(), s.null()), undefined, 0, 2), undefined, 2, 3)],
  ["string bounds", s.string(undefined, { minLength: 3, maxLength: 5 })],
];

function accepts(g: JsonGrammar, text: string): GrammarState | null {
  return g.advance(g.initial(), enc.encode(text));
}

describe("JSON grammar automaton", () => {
  const g = new JsonGrammar(ACTION);
  it("accepts valid documents, with or without light whitespace", () => {
    for (const doc of [
      '{"type":"rows.sort","params":{"col":3}}',
      '{"params": {"col": 0, "descending": true}, "type": "col.format"}',
      '{"type":"cells.set","params":{"row":1,"col":2,"value":"héllo \\"x\\" \\u00e9"},"note":"ok"}',
      '{"type":"cells.set","params":{"row":1,"col":2,"value":-12.25}}',
      '{"type":"cells.set","params":{"row":1,"col":2,"value":null}}',
    ]) {
      const st = accepts(g, doc);
      expect(st, doc).not.toBeNull();
      expect(g.isDone(st!)).toBe(true);
      expect(validate(JSON.parse(doc), ACTION)).toEqual([]);
    }
  });

  it("rejects invalid documents at the first bad byte", () => {
    for (const doc of [
      '{"type":"rows.filter"', // not in the enum
      '{"type":"rows.sort","params":{"col":-1}}', // below minimum
      '{"type":"rows.sort","params":{"col":16384}}', // above maximum
      '{"type":"rows.sort","params":{"col":1.5}}', // not an integer
      '{"type":"rows.sort","params":{"col":01}}', // leading zero
      '{"type":"rows.sort","bogus":1}', // unknown key
      '{"type":"rows.sort","type":"rows.sort"}', // duplicate key
      '{"params":{"col":3}}', // missing required "type"
      '{"type":"rows.sort","params":{"col":3},"note":"x"}', // too short
      '{"type":"rows.sort","params":{"col":3},"note":"abcdefghijklm"}', // too long
      '{"type":"rows.sort","params":{"col":3},}', // trailing comma
      '{"type":"rows.sort","params":{"col":3}}x', // trailing garbage
      '{"type":"rows.sort","params":{"col":1e3}}', // exponents are not generated
      '{   "type":"rows.sort"}', // too much whitespace
    ]) {
      const st = accepts(g, doc);
      expect(st === null || !g.isDone(st), doc).toBe(true);
    }
  });

  it("checks UTF-8 inside strings", () => {
    const str = new JsonGrammar(s.string());
    expect(str.advance(str.initial(), [0x22, 0xc3, 0xa9, 0x22])).not.toBeNull(); // é
    expect(str.advance(str.initial(), [0x22, 0xc3, 0x22])).toBeNull(); // truncated sequence
    expect(str.advance(str.initial(), [0x22, 0xed, 0xa0])).toBeNull(); // surrogate
    expect(str.advance(str.initial(), [0x22, 0xff])).toBeNull();
    expect(str.advance(str.initial(), enc.encode('"\\ud800'))).toBeNull(); // escaped surrogate
    expect(str.advance(str.initial(), [0x22, 0x0a])).toBeNull(); // raw control character
  });

  it("counts string length in UTF-16 units like the validator", () => {
    const g2 = new JsonGrammar(s.string(undefined, { maxLength: 2 }));
    expect(g2.advance(g2.initial(), enc.encode('"🙂"'))).not.toBeNull();
    expect(g2.advance(g2.initial(), enc.encode('"🙂a'))).toBeNull();
  });

  it("can stop after a top-level number but must not after a prefix", () => {
    const n = new JsonGrammar({ type: "integer", minimum: 100, maximum: 250 });
    expect(n.canStop(n.advance(n.initial(), enc.encode("12"))!)).toBe(false);
    expect(n.canStop(n.advance(n.initial(), enc.encode("120"))!)).toBe(true);
    expect(n.advance(n.initial(), enc.encode("3"))).toBeNull(); // 3, 30..39, 300.. none in range
  });

  for (const [name, schema] of SCHEMAS) {
    it(`every reachable state can be completed to a valid value: ${name}`, () => {
      const g = new JsonGrammar(schema);
      const rng = makeRng(name.length * 7919);
      for (let walk = 0; walk < 150; walk++) {
        let st = g.initial();
        const bytes: number[] = [];
        const steps = Math.floor(rng() * 40);
        for (let i = 0; i < steps && !g.isDone(st); i++) {
          // pick a random accepted byte, preferring printable ASCII
          const choices: [number, GrammarState][] = [];
          for (let b = 0; b < 256; b++) {
            const n = g.advance(st, [b]);
            if (n) choices.push([b, n]);
          }
          // a live state accepts some byte, or is a finished top-level number
          if (choices.length === 0) {
            expect(g.canStop(st)).toBe(true);
            break;
          }
          const ascii = choices.filter(([b]) => b >= 0x20 && b < 0x7f);
          const pool = ascii.length && rng() < 0.9 ? ascii : choices;
          const [b, next] = pool[Math.floor(rng() * pool.length)]!;
          bytes.push(b);
          st = next;
        }
        const tail = g.completion(st)!;
        expect(tail).not.toBeNull();
        const done = g.advance(st, tail);
        expect(done).not.toBeNull();
        expect(g.canStop(done!)).toBe(true);
        const text = dec.decode(new Uint8Array([...bytes, ...tail]));
        expect(validate(JSON.parse(text), schema as never), text).toEqual([]);
      }
    });
  }

  it("completions are real documents", () => {
    for (const [, schema] of SCHEMAS) {
      const g = new JsonGrammar(schema);
      const text = dec.decode(g.completion(g.initial())!);
      expect(validate(JSON.parse(text), schema as never), text).toEqual([]);
    }
  });
});

describe("token masks", () => {
  // a toy vocabulary of multi-byte pieces
  const pieces = ['{"', '"', ":", ",", "}", "{", "type", "rows", ".sort", "cells.set", "col", "params", "1", "23", "0", " ", "true", "-", "x", '":"', '":', '"}', '}}', "é"];
  const vocab = { vocabSize: pieces.length, tokenBytes: (i: number) => enc.encode(pieces[i]!) };
  const g = new JsonGrammar(ACTION);
  const masker = new TokenMasker(vocab);
  const allowed = (st: GrammarState) => {
    const { mask } = masker.mask(g, st);
    return pieces.filter((_, i) => mask[i]);
  };

  it("allows only tokens that keep the document valid", () => {
    expect(allowed(g.initial()).sort()).toEqual([" ", "{", '{"'].sort());
    const afterOpen = g.advance(g.initial(), enc.encode('{"'))!;
    // only prefixes of "type" / "params" / "note" keys
    expect(allowed(afterOpen).sort()).toEqual(["params", "type"].sort());
    const inCol = g.advance(g.initial(), enc.encode('{"type":"rows.sort","params":{"col":'))!;
    expect(allowed(inCol).sort()).toEqual([" ", "0", "1", "23"].sort());
  });

  it("the budget filter only admits tokens that can still finish in time", () => {
    const st = g.advance(g.initial(), enc.encode('{"type":"rows.sort","params":{"col":1'))!;
    const tail = g.completion(st)!;
    expect(dec.decode(tail)).toBe("}}");
    const { mask } = masker.mask(g, st, 2);
    const ok = pieces.filter((_, i) => mask[i]);
    expect(ok).toContain("}}");
    expect(ok).toContain("23"); // "col":123 still closes with "}}"
    expect(ok).not.toContain(","); // another key would not fit in 2 bytes
    expect(masker.mask(g, st).mask[pieces.indexOf(",")]).toBe(1);
  });
});
