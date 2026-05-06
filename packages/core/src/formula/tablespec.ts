/**
 * The part inside a structured reference's brackets: Sales[Amount],
 * Sales[@Amount], Sales[[#All],[Amount]], Sales[[Q1]:[Q4]], Sales[#Headers].
 */
export interface TableSpec {
  /** which rows: the data, everything, the header row, the totals row, or the formula's own row */
  area: "data" | "all" | "headers" | "totals" | "this";
  /** first and last column by header name (none = every column) */
  from?: string;
  to?: string;
}

const AREAS: Record<string, TableSpec["area"]> = { "#data": "data", "#all": "all", "#headers": "headers", "#totals": "totals", "#this row": "this" };

/** Split on commas that aren't inside brackets. */
function topLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      cur += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "[") depth++;
    if (c === "]") depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const unbracket = (s: string) => {
  const t = s.trim();
  const inner = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  return inner.replace(/'(.)/g, "$1").trim();
};

export function parseTableSpec(spec: string): TableSpec | null {
  let s = spec.trim();
  const out: TableSpec = { area: "data" };
  if (s === "") return out;
  if (s.startsWith("@")) {
    out.area = "this";
    s = s.slice(1).trim();
    if (s === "") return out;
  }
  for (const part of topLevel(s, ",")) {
    const p = part.trim();
    const area = AREAS[unbracket(p).toLowerCase()];
    if (area) {
      out.area = area;
      continue;
    }
    if (p.startsWith("@")) {
      out.area = "this";
      const rest = p.slice(1).trim();
      if (rest) out.from = out.to = unbracket(rest);
      continue;
    }
    const span = topLevel(p, ":");
    if (span.length === 2) {
      out.from = unbracket(span[0]);
      out.to = unbracket(span[1]);
    } else if (span.length === 1) {
      out.from = out.to = unbracket(p);
    } else return null;
    if (!out.from) return null;
  }
  return out;
}
