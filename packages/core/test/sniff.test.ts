import { describe, expect, it } from "vitest";
import { detectEncoding, jsonToColumns, previewCsv, Table } from "../src";

const enc = new TextEncoder();

describe("text file detection", () => {
  it("finds the encoding from the bytes", () => {
    expect(detectEncoding(enc.encode("a,b\n1,2"))).toBe("utf-8");
    expect(detectEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("utf-8");
    expect(detectEncoding(Uint8Array.from([0xff, 0xfe, 0x61, 0]))).toBe("utf-16le");
    // "Café" in Windows-1252: é is a lone 0xE9, invalid in UTF-8
    expect(detectEncoding(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x0a]))).toBe("windows-1252");
  });

  it("previews with the detected delimiter, skipping title rows", () => {
    const p = previewCsv(enc.encode("Quarterly report\nRegion;Amount\nNorth;1,5\n"), { skipRows: 1 });
    expect(p.delimiter).toBe(";");
    expect(p.rows).toEqual([["Region", "Amount"], ["North", "1,5"]]);
    const latin = previewCsv(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]));
    expect(latin.rows[0]).toEqual(["Café", "1"]);
  });
});

describe("JSON", () => {
  it("records, nested objects and JSON Lines", () => {
    const t = new Table(jsonToColumns(JSON.stringify([{ id: 1, name: "a", addr: { city: "X" } }, { id: 2, name: "b", ok: true }])));
    expect(t.columns.map((c) => c.name)).toEqual(["id", "name", "addr.city", "ok"]);
    expect([t.getCell(1, 0), t.getCell(0, 2), t.getCell(1, 3), t.getCell(0, 3)]).toEqual([2, "X", "TRUE", null]);
    const lines = new Table(jsonToColumns('{"a":1}\n{"a":2,"b":"x"}\n'));
    expect(lines.rowCount).toBe(2);
    expect(lines.getCell(1, 1)).toBe("x");
    const wrapped = new Table(jsonToColumns(JSON.stringify({ results: [{ q: 5 }] })));
    expect(wrapped.getCell(0, 0)).toBe(5);
    const arrays = new Table(jsonToColumns(JSON.stringify([["x", "y"], [1, 2], [3, 4]])));
    expect(arrays.columns.map((c) => c.name)).toEqual(["x", "y"]);
    expect(arrays.getCell(1, 1)).toBe(4);
    expect(() => jsonToColumns("{nope")).toThrow(/valid JSON/);
  });
});
