import { describe, expect, it } from "vitest";
import { readParquet, rleHybrid, Table, unsnappy } from "../src";

// --- a tiny Thrift compact-protocol writer, to build test files -----------
type F = [id: number, type: "i32" | "i64" | "bin" | "list-i32" | "list-bin" | "list-struct" | "struct", value: unknown];
const enc = new TextEncoder();
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
const zig = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const TYPE = { i32: 5, i64: 6, bin: 8, "list-i32": 9, "list-bin": 9, "list-struct": 9, struct: 12 } as const;
function struct(fields: F[]): number[] {
  const out: number[] = [];
  let last = 0;
  for (const [id, type, value] of fields) {
    const t = TYPE[type];
    out.push(id - last > 0 && id - last <= 15 ? ((id - last) << 4) | t : t, ...(id - last > 15 ? varint(zig(id)) : []));
    last = id;
    if (type === "i32" || type === "i64") out.push(...varint(zig(value as number)));
    else if (type === "bin") {
      const b = typeof value === "string" ? enc.encode(value) : (value as Uint8Array);
      out.push(...varint(b.length), ...b);
    } else if (type === "struct") out.push(...struct(value as F[]));
    else {
      const items = value as unknown[];
      const et = type === "list-i32" ? 5 : type === "list-bin" ? 8 : 12;
      out.push(items.length < 15 ? (items.length << 4) | et : 0xf0 | et, ...(items.length >= 15 ? varint(items.length) : []));
      for (const it of items) {
        if (et === 5) out.push(...varint(zig(it as number)));
        else if (et === 8) {
          const b = enc.encode(it as string);
          out.push(...varint(b.length), ...b);
        } else out.push(...struct(it as F[]));
      }
    }
  }
  out.push(0);
  return out;
}
const i32le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const i64le = (n: number) => [...i32le(n), 0, 0, 0, 0];
const plainStrings = (xs: string[]) => xs.flatMap((s) => [...i32le(enc.encode(s).length), ...enc.encode(s)]);
const snappyLiteral = (d: number[]) => [...varint(d.length), (d.length - 1) << 2, ...d];

function dataPage(values: number[], count: number, opts: { encoding?: number; codec?: number } = {}): { header: number[]; body: number[] } {
  const body = opts.codec === 1 ? snappyLiteral(values) : values;
  const header = struct([
    [1, "i32", 0],
    [2, "i32", values.length],
    [3, "i32", body.length],
    [5, "struct", [[1, "i32", count], [2, "i32", opts.encoding ?? 0], [3, "i32", 3], [4, "i32", 3]] as F[]],
  ]);
  return { header, body };
}

function buildFile(): Uint8Array {
  const bytes: number[] = [...enc.encode("PAR1")];
  const chunks: F[][] = [];
  const add = (name: string, type: number, pages: { header: number[]; body: number[] }[], count: number, codec = 0, dictPages = 0) => {
    const start = bytes.length;
    for (const p of pages) bytes.push(...p.header, ...p.body);
    const size = bytes.length - start;
    const md: F[] = [
      [1, "i32", type],
      [2, "list-i32", [0]],
      [3, "list-bin", [name]],
      [4, "i32", codec],
      [5, "i64", count],
      [6, "i64", size],
      [7, "i64", size],
      [9, "i64", dictPages ? start + pages[0].header.length + pages[0].body.length : start],
      ...(dictPages ? ([[11, "i64", start]] as F[]) : []),
    ];
    chunks.push([[2, "i64", start], [3, "struct", md]]);
  };
  // id: INT64, required, plain
  add("id", 2, [dataPage([...i64le(1), ...i64le(2), ...i64le(3)], 3)], 3);
  // name: text, optional (a null in the middle), Snappy
  const defs = [...i32le(2), 3, 0b101];
  add("name", 6, [dataPage([...defs, ...plainStrings(["a", "c"])], 3, { codec: 1 })], 3, 1);
  // region: dictionary-encoded text
  const dict = plainStrings(["North", "South"]);
  const dictHeader = struct([[1, "i32", 2], [2, "i32", dict.length], [3, "i32", dict.length], [7, "struct", [[1, "i32", 2], [2, "i32", 0]] as F[]]]);
  add("region", 6, [{ header: dictHeader, body: dict }, dataPage([1, 3, 0b010], 3, { encoding: 8 })], 3, 0, 1);
  // day: INT32 DATE (days since 1970)
  add("day", 1, [dataPage([...i32le(19737), ...i32le(19738), ...i32le(19739)], 3)], 3);
  const schema: F[][] = [
    [[4, "bin", "schema"], [5, "i32", 4]],
    [[1, "i32", 2], [3, "i32", 0], [4, "bin", "id"]],
    [[1, "i32", 6], [3, "i32", 1], [4, "bin", "name"], [6, "i32", 0]],
    [[1, "i32", 6], [3, "i32", 0], [4, "bin", "region"], [6, "i32", 0]],
    [[1, "i32", 1], [3, "i32", 0], [4, "bin", "day"], [6, "i32", 6]],
  ];
  const meta = struct([
    [1, "i32", 1],
    [2, "list-struct", schema],
    [3, "i64", 3],
    [4, "list-struct", [[[1, "list-struct", chunks], [2, "i64", 0], [3, "i64", 3]] as F[]]],
  ]);
  bytes.push(...meta, ...i32le(meta.length), ...enc.encode("PAR1"));
  return Uint8Array.from(bytes);
}

describe("Parquet", () => {
  it("reads plain, optional, Snappy, dictionary and date columns", async () => {
    const { columns, dateColumns } = await readParquet(buildFile());
    const t = new Table(columns);
    expect(columns.map((c) => c.name)).toEqual(["id", "name", "region", "day"]);
    expect([0, 1, 2].map((r) => t.getCell(r, 0))).toEqual([1, 2, 3]);
    expect([0, 1, 2].map((r) => t.getCell(r, 1))).toEqual(["a", null, "c"]);
    expect([0, 1, 2].map((r) => t.getCell(r, 2))).toEqual(["North", "South", "North"]);
    expect(t.getCell(0, 3)).toBe(45306); // 2024-01-15 as an Excel serial
    expect(dateColumns).toEqual([{ col: 3, withTime: false }]);
  });

  it("Snappy back-references and the RLE/bit-packed levels", () => {
    // "abc" then a copy of 6 bytes from 3 back: abcabcabc
    const s = unsnappy(Uint8Array.from([9, (3 - 1) << 2, 97, 98, 99, ((6 - 4) << 2) | 1, 3]));
    expect(new TextDecoder().decode(s)).toBe("abcabcabc");
    // an RLE run of 5 sevens (width 3), then a bit-packed group 1,0,1,...
    expect(rleHybrid(Uint8Array.from([5 << 1, 7, 3, 0b101]), 0, 4, 3, 5)).toEqual([7, 7, 7, 7, 7]);
    expect(rleHybrid(Uint8Array.from([3, 0b101]), 0, 2, 1, 3)).toEqual([1, 0, 1]);
  });

  it("refuses something that isn't Parquet", async () => {
    await expect(readParquet(enc.encode("a,b,c\n1,2,3"))).rejects.toThrow(/Parquet/);
  });
});
