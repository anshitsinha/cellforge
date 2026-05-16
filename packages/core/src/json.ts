/**
 * JSON into columns: an array of records ([{...}, {...}]), an array of
 * arrays (first row = names), an object holding one of those, or JSON
 * Lines (one record per line). Nested objects become a.b columns.
 */
import { ColumnBuilder, type ColumnData } from "./columns";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function flatten(value: Json, prefix: string, out: Map<string, string>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  let s: string;
  if (value === null) s = "";
  else if (typeof value === "boolean") s = value ? "TRUE" : "FALSE";
  else if (Array.isArray(value)) s = JSON.stringify(value);
  else s = String(value);
  out.set(prefix || "value", s);
}

/** The list of records inside parsed JSON. */
function recordsOf(data: Json): Json[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    // { "data": [...] } / { "results": [...] }: the first array of objects
    for (const v of Object.values(data)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
    return [data];
  }
  return [data];
}

export function jsonToColumns(text: string): ColumnData[] {
  const trimmed = text.trim();
  let records: Json[];
  try {
    records = recordsOf(JSON.parse(trimmed) as Json);
  } catch (e) {
    // JSON Lines: one value per line
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    try {
      records = lines.map((l) => JSON.parse(l) as Json);
    } catch {
      throw new Error(`That isn't valid JSON: ${(e as Error).message}`);
    }
  }
  if (!records.length) throw new Error("The JSON has no records.");
  // an array of arrays: the first row names the columns
  if (records.every((r) => Array.isArray(r))) {
    const [head, ...rows] = records as Json[][];
    const builders = head.map((h, i) => new ColumnBuilder(String(h ?? `column_${i + 1}`)));
    for (const row of rows) {
      while (row.length > builders.length) {
        const b = new ColumnBuilder(`column_${builders.length + 1}`);
        b.padTo(builders[0]?.length ?? 0);
        builders.push(b);
      }
      builders.forEach((b, i) => {
        const m = new Map<string, string>();
        flatten(row[i] ?? null, "v", m);
        b.push(m.get("v") ?? "");
      });
    }
    return builders.map((b) => b.finish());
  }
  const order: string[] = [];
  const builders = new Map<string, ColumnBuilder>();
  let n = 0;
  for (const rec of records) {
    const flat = new Map<string, string>();
    flatten(rec, "", flat);
    for (const k of flat.keys()) {
      if (!builders.has(k)) {
        const b = new ColumnBuilder(k);
        b.padTo(n);
        builders.set(k, b);
        order.push(k);
      }
    }
    for (const k of order) builders.get(k)!.push(flat.get(k) ?? "");
    n++;
  }
  return order.map((k) => builders.get(k)!.finish());
}
