/**
 * Turning a printed report back into a table: find the header row, drop
 * the rows that aren't data (titles, blanks, subtotals and totals, page
 * footers, headers repeated on every page), fill down group labels that
 * only appear on a group's first row, and flatten a two-row header.
 */

export interface DroppedRow {
  /** row in the original */
  row: number;
  reason: "title" | "blank" | "total" | "footer" | "repeated header";
  text: string;
}

export interface Unwrapped {
  header: string[];
  /** the data rows, as strings */
  rows: string[][];
  /** which original row each data row came from */
  sourceRows: number[];
  headerRow: number;
  dropped: DroppedRow[];
  /** columns whose blanks were filled with the label above */
  filledDown: number[];
}

const TOTAL = /^(sub[\s-]?total|total|grand total|net total|balance c\/f|balance b\/f|carried forward|brought forward)\b|\btotals?:?\s*$/i;
const FOOTER = /^(page\s+\d+(\s+of\s+\d+)?|printed\b|report (generated|run)\b|run date\b|confidential\b|end of report\b|\*\*\*)/i;

const nonEmpty = (row: string[]) => row.filter((c) => c.trim() !== "").length;
const looksNumeric = (c: string) => /^[\s(+\-$€£¥]*[\d.,'\s]+\)?\s*(%|cr|dr)?$/i.test(c.trim()) && /\d/.test(c);
const textCells = (row: string[]) => row.filter((c) => c.trim() !== "" && !looksNumeric(c)).length;

/** The header row: the first row of mostly-text cells, at least as wide as most of the data below it. */
export function findHeaderRow(rows: string[][]): number {
  const widths = rows.map(nonEmpty);
  const sorted = [...widths].filter((w) => w > 0).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  for (let r = 0; r < Math.min(rows.length, 200); r++) {
    const w = widths[r];
    if (w < Math.max(2, typical * 0.6)) continue;
    if (textCells(rows[r]) / w < 0.7) continue;
    // the next non-empty row should have numbers or at least differ from this one
    return r;
  }
  return 0;
}

export function unwrapReport(rows: string[][]): Unwrapped {
  const headerRow = findHeaderRow(rows);
  const dropped: DroppedRow[] = [];
  for (let r = 0; r < headerRow; r++) if (nonEmpty(rows[r])) dropped.push({ row: r, reason: "title", text: rows[r].filter(Boolean).join(" ") });

  let header = rows[headerRow]?.map((c) => c.trim()) ?? [];
  let dataStart = headerRow + 1;
  // a second header row (Q1 Q2 under Revenue Cost): text-only, and the row above has gaps
  const next = rows[headerRow + 1];
  if (next && nonEmpty(next) >= 2 && textCells(next) === nonEmpty(next) && header.some((h) => h === "")) {
    let carry = "";
    header = header.map((h, i) => {
      if (h) carry = h;
      const below = (next[i] ?? "").trim();
      return [h || carry, below].filter(Boolean).join(" ");
    });
    dataStart++;
  }
  const width = Math.max(header.length, ...rows.slice(dataStart).map((r) => r.length));
  header = Array.from({ length: width }, (_, i) => header[i] || `column_${i + 1}`);
  const headerKey = rows[headerRow].map((c) => c.trim().toLowerCase()).join("|");

  const out: string[][] = [];
  const sourceRows: number[] = [];
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    const text = row.map((c) => c.trim()).filter(Boolean).join(" ");
    if (!text) {
      dropped.push({ row: r, reason: "blank", text: "" });
      continue;
    }
    if (row.map((c) => c.trim().toLowerCase()).join("|") === headerKey) {
      dropped.push({ row: r, reason: "repeated header", text });
      continue;
    }
    const firstText = row.find((c) => c.trim() !== "" && !looksNumeric(c))?.trim() ?? "";
    if (TOTAL.test(firstText)) {
      dropped.push({ row: r, reason: "total", text });
      continue;
    }
    if (FOOTER.test(text) || (nonEmpty(row) === 1 && /page\s+\d+/i.test(text))) {
      dropped.push({ row: r, reason: "footer", text });
      continue;
    }
    out.push(Array.from({ length: width }, (_, i) => (row[i] ?? "").trim()));
    sourceRows.push(r);
  }

  // group labels: a text column where most rows are blank and each value starts a run
  const filledDown: number[] = [];
  for (let c = 0; c < width; c++) {
    const vals = out.map((r) => r[c]);
    const filled = vals.filter(Boolean);
    if (filled.length < 2 || filled.length > vals.length * 0.6) continue;
    if (filled.some(looksNumeric)) continue;
    if (!vals[0]) continue;
    // other columns must have data on the blank rows, or it's just sparse
    const blanksWithData = vals.filter((v, i) => !v && out[i].some((x, k) => k !== c && x)).length;
    if (blanksWithData < (vals.length - filled.length) * 0.8) continue;
    let last = "";
    for (const r of out) {
      if (r[c]) last = r[c];
      else r[c] = last;
    }
    filledDown.push(c);
  }
  return { header, rows: out, sourceRows, headerRow, dropped, filledDown };
}
