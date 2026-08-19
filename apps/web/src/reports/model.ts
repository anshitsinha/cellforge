/**
 * What a report is, as plain JSON-safe data saved with the workbook: a
 * title, parameters (an entity, a period) and a list of blocks. Text can
 * hold {{name}} (a parameter) and {{=formula}} (worked out against the
 * workbook); inside a formula, {name} is the parameter as a value.
 */
import type { ChartSpec, SavedPivot } from "../charts/model";

/** Keep only rows whose sheet column `column` equals parameter `param`. */
export interface ParamFilter {
  param: string;
  /** a column of the sheet, 0-based (A = 0); for a pivot, the same column as a field */
  column: number;
}

export type ReportBlock =
  | { id: string; kind: "heading"; text: string; level: 1 | 2 | 3 }
  | { id: string; kind: "paragraph"; text: string }
  | { id: string; kind: "table"; source: "range"; sheetId: string; range: string; headerRow: boolean; title?: string; filter?: ParamFilter }
  | { id: string; kind: "table"; source: "pivot"; sheetId: string; pivot: SavedPivot; title?: string; filter?: ParamFilter; totals?: boolean }
  | { id: string; kind: "chart"; chartId?: string; spec?: ChartSpec; title?: string; filter?: ParamFilter }
  | { id: string; kind: "pageBreak" };

export type BlockKind = ReportBlock["kind"];

export interface ReportParam {
  name: string;
  /** the value used when the report isn't run for each entity / period */
  value: string;
}

/** Where "Run for each" gets its values. */
export interface RunFor {
  param: string;
  /** distinct values of a sheet column (below its header), or a typed list */
  sheetId?: string;
  column?: number;
  list?: string[];
  /** also a consolidated report over all of them (filters off, {param} = "*") */
  consolidated?: boolean;
  /** what the consolidated report calls the parameter (default "All") */
  allLabel?: string;
}

export interface Report {
  id: string;
  title: string;
  /** a line under the title; can hold {{…}} */
  subtitle?: string;
  /** the sheet that unqualified references in formulas read */
  sheetId: string;
  params: ReportParam[];
  blocks: ReportBlock[];
  page?: { size: "A4" | "Letter"; landscape: boolean };
  runFor?: RunFor;
}

/** A parameter value as given to one run of a report. */
export interface ParamValue {
  value: string;
  /** a consolidated run: filters on this parameter are off and {param} is "*" */
  all?: boolean;
  /** text shown for {{param}} (the value, or "All") */
  label?: string;
}

let seq = 0;
/** A short id that's unlikely to repeat. */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(seq++ % 1296).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function newReport(sheetId: string, title = "Report"): Report {
  return { id: newId("rep"), title, sheetId, params: [], blocks: [], page: { size: "A4", landscape: false } };
}

/** An empty block of a kind, ready to edit. */
export function newBlock(kind: BlockKind, sheetId: string): ReportBlock {
  const id = newId("b");
  switch (kind) {
    case "heading":
      return { id, kind, text: "Heading", level: 1 };
    case "paragraph":
      return { id, kind, text: "" };
    case "table":
      return { id, kind, source: "range", sheetId, range: "A1:D10", headerRow: true };
    case "chart":
      return { id, kind };
    case "pageBreak":
      return { id, kind };
  }
}

export const BLOCK_LABEL: Record<BlockKind, string> = {
  heading: "Heading",
  paragraph: "Text",
  table: "Table",
  chart: "Chart",
  pageBreak: "Page break",
};

/** Why a report can't be saved, or null. */
export function reportProblem(r: unknown): string | null {
  const x = r as Partial<Report> | null;
  if (!x || typeof x !== "object") return "A report must be an object.";
  if (typeof x.id !== "string" || !x.id) return "A report needs an id.";
  if (typeof x.title !== "string") return "A report needs a title.";
  if (typeof x.sheetId !== "string") return "A report needs a sheet.";
  if (!Array.isArray(x.params) || !Array.isArray(x.blocks)) return "A report needs params and blocks lists.";
  const names = new Set<string>();
  for (const p of x.params) {
    if (!p || typeof p.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) return `"${p?.name}" isn't a parameter name (letters, digits and _).`;
    if (names.has(p.name.toLowerCase())) return `Parameter "${p.name}" is there twice.`;
    names.add(p.name.toLowerCase());
  }
  for (const b of x.blocks) if (!b || typeof b.id !== "string" || !(b.kind in BLOCK_LABEL)) return "A block is missing its id or kind.";
  return null;
}
