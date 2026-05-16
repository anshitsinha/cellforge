/**
 * Combining many files into one table: line up their columns by name
 * (ignoring case, spacing and punctuation, and a few common abbreviations),
 * keep every column any file has, and note which file each row came from.
 */
import type { ColumnData } from "../columns";
import { formatGeneral } from "../numfmt";

export interface FilePart {
  name: string;
  columns: ColumnData[];
  /** number format per column (dates from Excel or Parquet), if any */
  numFmts?: (string | undefined)[];
}

export interface AlignedColumn {
  /** the name in the combined table: the first file's spelling */
  name: string;
  key: string;
  /** for each file, its column index for this one, or null if it hasn't got it */
  from: (number | null)[];
}

const SYNONYMS: Record<string, string> = {
  amt: "amount",
  amnt: "amount",
  qty: "quantity",
  desc: "description",
  descr: "description",
  ref: "reference",
  refno: "reference",
  acct: "account",
  acc: "account",
  accountno: "accountnumber",
  acctno: "accountnumber",
  invno: "invoicenumber",
  invoiceno: "invoicenumber",
  dt: "date",
  txndate: "transactiondate",
  trandate: "transactiondate",
  custname: "customername",
  vendorname: "vendor",
  suppliername: "supplier",
};

/** The matching key for a column name: "Invoice No." and "invoice_no" both give "invoicenumber". */
export function columnKey(name: string): string {
  const k = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return SYNONYMS[k] ?? k;
}

/**
 * Line up the files' columns. `renames` maps a column's key to another key,
 * which merges the two (the user saying "Cust" is "Customer").
 */
export function alignColumns(headers: string[][], renames: Record<string, string> = {}): AlignedColumn[] {
  const out: AlignedColumn[] = [];
  const byKey = new Map<string, AlignedColumn>();
  headers.forEach((names, f) => {
    names.forEach((name, c) => {
      let key = columnKey(name) || `column${c + 1}`;
      for (let hops = 0; renames[key] && renames[key] !== key && hops < 10; hops++) key = renames[key];
      let col = byKey.get(key);
      if (!col) {
        col = { name: name.trim() || `column_${c + 1}`, key, from: headers.map(() => null) };
        byKey.set(key, col);
        out.push(col);
      }
      // two columns of one file with the same key: the second keeps its own column
      if (col.from[f] !== null) {
        const own: AlignedColumn = { name: name.trim(), key: `${key}#${c}`, from: headers.map(() => null) };
        own.from[f] = c;
        out.push(own);
        byKey.set(own.key, own);
      } else col.from[f] = c;
    });
  });
  return out;
}

const cellText = (col: ColumnData, row: number): string => {
  if (col.kind === "number") {
    const v = col.values[row];
    return Number.isNaN(v) ? "" : formatGeneral(v);
  }
  const code = col.codes[row];
  return code ? col.dict[code - 1] : "";
};

/**
 * One table from all the files, columns as `alignColumns` lined them up.
 * A column stays numeric only if it's numeric in every file that has it;
 * otherwise its numbers become text so nothing is lost.
 */
export function combineParts(
  parts: FilePart[],
  aligned: AlignedColumn[],
  sourceColumn = "source file",
): { columns: ColumnData[]; numFmts: (string | undefined)[] } {
  const counts = parts.map((p) => (p.columns.length ? (p.columns[0].kind === "number" ? p.columns[0].values.length : p.columns[0].codes.length) : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const columns: ColumnData[] = [];
  const numFmts: (string | undefined)[] = [];

  // the file name first, so every row says where it came from
  const fileCodes = new Uint32Array(total);
  let at = 0;
  parts.forEach((_, f) => {
    fileCodes.fill(f + 1, at, at + counts[f]);
    at += counts[f];
  });
  columns.push({ kind: "string", name: sourceColumn, codes: fileCodes, dict: parts.map((p) => p.name) });
  numFmts.push(undefined);

  for (const a of aligned) {
    const sources = a.from.map((c, f) => (c === null ? null : parts[f].columns[c]));
    const numeric = sources.every((s) => s === null || s.kind === "number");
    const fmts = new Set(a.from.flatMap((c, f) => (c === null ? [] : [parts[f].numFmts?.[c]])));
    numFmts.push(numeric && fmts.size === 1 ? [...fmts][0] : undefined);
    if (numeric) {
      const values = new Float64Array(total).fill(NaN);
      let offset = 0;
      sources.forEach((s, f) => {
        if (s && s.kind === "number") values.set(s.values, offset);
        offset += counts[f];
      });
      columns.push({ kind: "number", name: a.name, values });
    } else {
      const codes = new Uint32Array(total);
      const dict: string[] = [];
      const lookup = new Map<string, number>();
      let offset = 0;
      sources.forEach((s, f) => {
        if (s) {
          for (let r = 0; r < counts[f]; r++) {
            const t = cellText(s, r);
            if (!t) continue;
            let code = lookup.get(t);
            if (code === undefined) {
              code = dict.push(t);
              lookup.set(t, code);
            }
            codes[offset + r] = code;
          }
        }
        offset += counts[f];
      });
      columns.push({ kind: "string", name: a.name, codes, dict });
    }
  }
  return { columns, numFmts };
}
