/**
 * Live fields in report text, as people read them. "{{=TEXT(ROUND(SUM(D:D),
 * 2),"#,##0.00")}}" is the template behind a chip that says "Total of This
 * month"; "{{period}}" is a chip that says "Period". The source stays one
 * click away ("Edit source"), for anyone who wants to change the formula.
 *
 * Pure: give it the sheet's column names.
 */

export type TextPart = { kind: "text"; text: string } | { kind: "field"; source: string; label: string; param: boolean };

const FIELD = /\{\{([\s\S]*?)\}\}/g;

/** "D" → 3 */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Split a formula's arguments at top-level commas. */
function args(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote && (ch === "(" || ch === "{")) depth++;
    if (!quote && (ch === ")" || ch === "}")) depth--;
    if (!quote && depth === 0 && ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** FN(inner) → [FN, inner], when the whole expression is one call. */
function call(s: string): [string, string] | null {
  const m = /^([A-Z][A-Z0-9.]*)\(([\s\S]*)\)$/i.exec(s.trim());
  if (!m) return null;
  // the closing bracket must belong to this call
  let depth = 0;
  let quote = false;
  for (let i = 0; i < m[2].length; i++) {
    const ch = m[2][i];
    if (ch === '"') quote = !quote;
    if (quote) continue;
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) return null;
  }
  return [m[1].toUpperCase(), m[2]];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const unquote = (s: string) => (/^".*"$/.test(s) ? s.slice(1, -1) : s);

/** What a live field shows, in words. */
export function fieldLabel(source: string, names: readonly string[] = []): string {
  const src = source.trim();
  if (!src.startsWith("=")) return cap(src.replace(/_/g, " "));
  let expr = src.slice(1).trim();
  // formatting and rounding wrap the figure; the words are about the figure
  for (let c = call(expr); c && (c[0] === "TEXT" || c[0] === "ROUND" || c[0] === "FIXED"); c = call(expr)) expr = args(c[1])[0] ?? "";
  const col = (ref: string | undefined): string | null => {
    const m = /^\$?([A-Z]{1,3})\$?\d*:\$?([A-Z]{1,3})\$?\d*$/i.exec(ref ?? "") ?? /^\$?([A-Z]{1,3})\$?\d+$/i.exec(ref ?? "");
    if (!m) return null;
    return names[colIndex(m[1])] || `column ${m[1].toUpperCase()}`;
  };
  const cond = (a: string[]) => {
    const parts: string[] = [];
    for (let i = 0; i + 1 < a.length; i += 2) {
      const what = col(a[i]);
      const v = a[i + 1];
      if (!what) continue;
      if (/^\{[A-Za-z_]\w*\}$/.test(v)) parts.push(`the ${v.slice(1, -1).replace(/_/g, " ")}`);
      else if (/^"[<>]/.test(v)) continue;
      else parts.push(`${what} ${unquote(v)}`);
    }
    return parts.length ? ` for ${parts.join(", ")}` : "";
  };
  if (/^-?\d+(\.\d+)?$/.test(expr)) return expr;
  const c = call(expr);
  if (!c) return "Formula";
  const a = args(c[1]);
  switch (c[0]) {
    case "SUM":
      return col(a[0]) ? `Total of ${col(a[0])}` : "Total";
    case "COUNT":
    case "COUNTA":
      return "Number of lines";
    case "AVERAGE":
      return col(a[0]) ? `Average ${col(a[0])}` : "Average";
    case "MAX":
      return col(a[0]) ? `Largest ${col(a[0])}` : "Largest";
    case "MIN":
      return col(a[0]) ? `Smallest ${col(a[0])}` : "Smallest";
    case "SUMIFS":
      return `Total of ${col(a[0]) ?? "the amount"}${cond(a.slice(1))}`;
    case "SUMIF":
      if (a.length === 2 && /^">0"$/.test(a[1]) && col(a[0])) return `Debits in ${col(a[0])}`;
      if (a.length === 2 && /^"<0"$/.test(a[1]) && col(a[0])) return `Credits in ${col(a[0])}`;
      return `Total of ${col(a[2]) ?? col(a[0]) ?? "the amount"}${cond(a.slice(0, 2))}`;
    case "COUNTIFS":
      return `Number of lines${cond(a)}`;
    case "COUNTIF":
      return col(a[0]) ? `Lines where ${col(a[0])} is ${unquote(a[1] ?? "")}` : "Number of lines";
    case "AVERAGEIFS":
      return `Average ${col(a[0]) ?? "amount"}${cond(a.slice(1))}`;
    default:
      return "Formula";
  }
}

/** Report text as plain words and live fields. */
export function textParts(text: string, names: readonly string[] = []): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(FIELD)) {
    if (m.index! > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    const source = m[1];
    out.push({ kind: "field", source, label: fieldLabel(source, names), param: !source.trim().startsWith("=") });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** True when the text has a live field in it. */
export const hasFields = (text: string) => /\{\{[\s\S]*?\}\}/.test(text);
