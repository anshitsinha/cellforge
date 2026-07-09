import { describe, expect, it } from "vitest";
import { CsvParser, detectDelimiter } from "../src/csv";

function parse(text: string | string[], delimiter = ","): string[][] {
  const rows: string[][] = [];
  const parser = new CsvParser((r) => rows.push(r), delimiter);
  for (const chunk of Array.isArray(text) ? text : [text]) parser.push(chunk);
  parser.end();
  return rows;
}

describe("CsvParser", () => {
  it("parses simple rows", () => {
    expect(parse("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles a missing trailing newline", () => {
    expect(parse("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF and lone CR line endings", () => {
    expect(parse("a,b\r\n1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps delimiters and newlines inside quotes", () => {
    expect(parse('name,note\n"Smith, J","line one\nline two"\n')).toEqual([
      ["name", "note"],
      ["Smith, J", "line one\nline two"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parse('"she said ""hi""",x\n')).toEqual([['she said "hi"', "x"]]);
  });

  it("keeps empty fields, including empty quoted ones", () => {
    expect(parse('a,,""\n,,\n')).toEqual([
      ["a", "", ""],
      ["", "", ""],
    ]);
  });

  it("skips blank lines", () => {
    expect(parse("a\n\n\nb\n")).toEqual([["a"], ["b"]]);
  });

  it("works no matter where chunk boundaries fall", () => {
    const text = 'id,quote\n1,"a ""b"", c"\r\n2,plain\n';
    const expected = parse(text);
    // try every possible split point, including mid-escape and mid-CRLF
    for (let i = 0; i <= text.length; i++) {
      expect(parse([text.slice(0, i), text.slice(i)])).toEqual(expected);
    }
  });

  it("supports other delimiters", () => {
    expect(parse("a;b\n1;2\n", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("detectDelimiter", () => {
  it("picks the most common candidate on the first line", () => {
    expect(detectDelimiter("a,b,c\n")).toBe(",");
    expect(detectDelimiter("a;b;c\n1,5;2,5;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
  });

  it("ignores delimiters inside quotes", () => {
    expect(detectDelimiter('"a,b,c";d;e\n')).toBe(";");
  });
});
