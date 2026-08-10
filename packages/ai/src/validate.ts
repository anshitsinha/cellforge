/**
 * Check a proposed action before it runs: against its schema in the catalog
 * (the same check the registry makes) and against the workbook as the
 * context describes it (the sheet exists, the columns and rows are inside
 * it). Problems come back in plain English, ready to show a person or to
 * hand back to a model for another try.
 */
import { type Action, type JsonSchema, validate } from "@cellforge/actions";
import { type AskContext, type CellRange, type SheetInfo, colCount, columnLetter, editDistance } from "./context";

export interface CatalogEntry {
  type: string;
  title: string;
  schema: JsonSchema;
  recordable?: boolean;
}

/** "params.keys[0].col: must be >= 0" → "keys[0].col must be 0 or more" */
function plain(problem: string): string {
  const m = /^params\.?([^:]*):\s*(.*)$/.exec(problem);
  if (!m) return problem;
  const where = m[1] || "the parameters";
  let what = m[2];
  what = what
    .replace(/^required$/, "is missing")
    .replace(/^unknown field$/, "is not a known field")
    .replace(/^must be >= (.*)$/, "must be $1 or more")
    .replace(/^must be <= (.*)$/, "must be $1 or less")
    .replace(/^expected (.*)$/, "should be $1")
    .replace(/^does not match any allowed shape$/, "doesn't match any allowed shape");
  return `${where} ${what}`;
}

function closestTypes(catalog: readonly CatalogEntry[], type: string): string[] {
  return catalog
    .map((c) => ({ t: c.type, d: editDistance(c.type.toLowerCase(), String(type).toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.t);
}

function sheetFor(ctx: AskContext, params: Record<string, unknown>, problems: string[]): SheetInfo | undefined {
  const id = params.sheet;
  if (id === undefined) return ctx.sheets.find((s) => s.id === ctx.activeSheet) ?? ctx.sheets[0];
  const sheet = ctx.sheets.find((s) => s.id === id) ?? ctx.sheets.find((s) => typeof id === "string" && s.name.toLowerCase() === id.toLowerCase());
  if (!sheet) problems.push(`There is no sheet "${String(id)}". Sheet ids: ${ctx.sheets.map((s) => `${s.id} (${s.name})`).join(", ")}.`);
  else if (sheet.id !== id) problems.push(`"sheet" takes the sheet's id, not its name: use "${sheet.id}" for ${sheet.name}.`);
  return sheet;
}

const isRange = (x: unknown): x is CellRange =>
  typeof x === "object" && x !== null && ["top", "left", "bottom", "right"].every((k) => typeof (x as Record<string, unknown>)[k] === "number");

function checkColumn(sheet: SheetInfo, col: number, what: string, problems: string[]) {
  const n = colCount(sheet);
  if (col >= n) problems.push(`${what} is column ${columnLetter(col)} (${col}), but ${sheet.name} has only ${n} column${n === 1 ? "" : "s"} (A to ${columnLetter(Math.max(0, n - 1))}).`);
}

function checkRow(sheet: SheetInfo, row: number, what: string, problems: string[], allowEnd = false) {
  const limit = allowEnd ? sheet.rowCount : sheet.rowCount - 1;
  if (row > limit) problems.push(`${what} is row ${row + 1} (index ${row}), but ${sheet.name} has only ${sheet.rowCount.toLocaleString("en-US")} rows.`);
}

function checkRange(sheet: SheetInfo, r: CellRange, what: string, problems: string[]) {
  if (r.top > r.bottom || r.left > r.right) problems.push(`${what}: the top-left corner must come before the bottom-right one.`);
  const n = colCount(sheet);
  if (r.right >= n) problems.push(`${what} reaches column ${columnLetter(r.right)}, but ${sheet.name} ends at column ${columnLetter(Math.max(0, n - 1))}.`);
  if (r.bottom >= sheet.rowCount) problems.push(`${what} reaches row ${r.bottom + 1}, but ${sheet.name} has only ${sheet.rowCount.toLocaleString("en-US")} rows.`);
}

/** Problems with an action, in plain English; [] means it can run. */
export function validateAction(action: unknown, catalog: readonly CatalogEntry[], ctx: AskContext): string[] {
  if (typeof action !== "object" || action === null || Array.isArray(action)) return ["The answer must be one JSON object like {\"type\": ..., \"params\": {...}}."];
  const a = action as Partial<Action>;
  if (typeof a.type !== "string") return ['The action needs a "type", one of the catalog\'s action names.'];
  const entry = catalog.find((c) => c.type === a.type);
  if (!entry) return [`There is no action called "${a.type}". Close ones: ${closestTypes(catalog, a.type).join(", ")}.`];
  const schemaProblems = validate(a.params, entry.schema);
  if (schemaProblems.length) return schemaProblems.map((p) => `${a.type}: ${plain(p)}.`);
  return checkAgainstContext(a as Action, ctx);
}

/** Context checks for the actions whose params point at cells, rows, columns or sheets. */
export function checkAgainstContext(action: Action, ctx: AskContext): string[] {
  const problems: string[] = [];
  const p = (action.params ?? {}) as Record<string, unknown>;
  if (action.type.startsWith("sheet.") && action.type !== "sheet.add") {
    if (typeof p.sheet === "string") {
      const sheet = ctx.sheets.find((s) => s.id === p.sheet);
      if (!sheet) {
        const byName = ctx.sheets.find((s) => s.name.toLowerCase() === (p.sheet as string).toLowerCase());
        problems.push(byName ? `"sheet" takes the sheet's id, not its name: use "${byName.id}" for ${byName.name}.` : `There is no sheet "${p.sheet}".`);
      }
      if (action.type === "sheet.rename" && typeof p.name === "string") {
        const clash = ctx.sheets.find((s) => s.id !== p.sheet && s.name.toLowerCase() === (p.name as string).toLowerCase());
        if (clash) problems.push(`There's already a sheet called "${clash.name}".`);
        if (/[[\]:*?/\\]/.test(p.name)) problems.push("Sheet names can't contain [ ] : * ? / or \\.");
      }
    }
    return problems;
  }
  const sheet = sheetFor(ctx, p, problems);
  if (!sheet) return problems;
  switch (action.type) {
    case "rows.sortBy":
      for (const [i, k] of ((p.keys as { col: number }[]) ?? []).entries()) checkColumn(sheet, k.col, `Sort key ${i + 1}`, problems);
      break;
    case "rows.sort":
    case "filter.set":
      checkColumn(sheet, p.col as number, "The column", problems);
      break;
    case "cols.hide":
    case "cols.delete":
      checkColumn(sheet, (p.at as number) + ((p.count as number | undefined) ?? 1) - 1, "The last column", problems);
      break;
    case "cols.insert":
      if ((p.at as number) > colCount(sheet)) problems.push(`Column ${columnLetter(p.at as number)} is past the end of ${sheet.name}.`);
      break;
    case "rows.hide":
    case "rows.delete":
      checkRow(sheet, (p.at as number) + ((p.count as number | undefined) ?? 1) - 1, "The last row", problems);
      break;
    case "rows.insert":
      checkRow(sheet, p.at as number, "The insert point", problems, true);
      break;
    case "view.freeze":
      if ((p.rows as number) >= sheet.rowCount) problems.push(`Freezing ${p.rows} rows would freeze the whole sheet.`);
      if ((p.cols as number) >= colCount(sheet) && (p.cols as number) > 0) problems.push(`Freezing ${p.cols} columns would freeze every column.`);
      break;
    default:
      break;
  }
  // any range, anywhere in the params (format.set, fill.down, rule.ranges, ...)
  const walk = (v: unknown, path: string) => {
    if (isRange(v)) return checkRange(sheet, v, path, problems);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(p, "");
  return problems;
}

/** A retry prompt's feedback: what was wrong with the last answer. */
export function describeProblems(problems: readonly string[]): string {
  return problems.length ? `That didn't work:\n${problems.map((p) => `- ${p}`).join("\n")}` : "";
}
