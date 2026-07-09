/**
 * A workbook: an ordered list of sheets. Each sheet owns its data (an
 * EditableSource over imported or blank data). Which sheet is on screen is
 * view state, not part of the workbook's data, so switching isn't undoable,
 * just as in Excel.
 */
import type { ChartSpec } from "./charts/model";
import type { Recipe } from "./recipe";
import { BlankSource, EditableSource } from "./editable";
import type { Version } from "./versions";
import { formatFormula, parseFormula, type Node } from "@cellforge/core";

/** A defined name: Revenue = 'Sales'!$C$2:$C$500, or a constant like VatRate = 0.2. */
export interface NameDef {
  name: string;
  /** what it refers to, as a formula without the "=" */
  formula: string;
  comment?: string;
}

/** Excel's rules for names: letter or _ first, then letters, digits, _ and .; not a cell address. */
export function nameProblem(name: string): string | null {
  if (!/^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/.test(name)) return "A name starts with a letter or _ and has only letters, digits, _ and dots.";
  if (/^[A-Za-z]{1,3}\d+$/.test(name) || /^[Rr]\d*[Cc]\d*$/.test(name)) return "A name can't look like a cell address.";
  if (/^(TRUE|FALSE)$/i.test(name)) return "TRUE and FALSE can't be names.";
  return null;
}

export interface Sheet {
  id: string;
  name: string;
  source: EditableSource;
  /** tab colour, CSS colour string */
  color?: string;
  hidden?: boolean;
  /** where the sheet's data came from ("Imported from march.csv", "Clean copy of Export"), for explaining numbers */
  origin?: string;
}

/** Excel's rules: 1–31 characters, none of \ / ? * [ ] :, not starting or ending with '. */
export function sheetNameProblem(name: string): string | null {
  if (!name.trim()) return "A sheet name can't be empty.";
  if (name.length > 31) return "A sheet name can be at most 31 characters.";
  if (/[\\/?*[\]:]/.test(name)) return "A sheet name can't contain \\ / ? * [ ] or :";
  if (name.startsWith("'") || name.endsWith("'")) return "A sheet name can't start or end with an apostrophe.";
  return null;
}

export class Workbook {
  readonly sheets: Sheet[] = [];
  private nextId = 1;
  /** named versions, oldest first; saved with the workbook */
  versions: Version[] = [];
  /** charts (floating windows over the sheets); saved with the workbook */
  charts: ChartSpec[] = [];
  /** saved recipes; saved with the workbook */
  recipes: Recipe[] = [];

  /** iterative calculation for circular references (off by default, as in Excel) */
  private iter: { max: number; change: number } | null = null;

  get iterative(): { max: number; change: number } | null {
    return this.iter;
  }

  set iterative(v: { max: number; change: number } | null) {
    this.iter = v;
    for (const s of this.sheets) s.source.iterative = v;
    this.clearAll();
  }

  /** defined names, by upper-case name */
  private names = new Map<string, NameDef & { ast: Node | null }>();

  get definedNames(): NameDef[] {
    return [...this.names.values()].map(({ name, formula, comment }) => ({ name, formula, ...(comment ? { comment } : {}) }));
  }

  getName(name: string): NameDef | undefined {
    const n = this.names.get(name.toUpperCase());
    return n && { name: n.name, formula: n.formula, ...(n.comment ? { comment: n.comment } : {}) };
  }

  /** Add or replace a name. Throws for a bad name or formula. */
  setName(def: NameDef): void {
    const problem = nameProblem(def.name);
    if (problem) throw new Error(problem);
    const text = def.formula.trim().replace(/^=/, "");
    let ast: Node | null;
    try {
      ast = parseFormula("=" + text);
    } catch (e) {
      throw new Error(`${def.name} doesn't refer to anything valid: ${(e as Error).message}`);
    }
    this.names.set(def.name.toUpperCase(), { name: def.name, formula: text, ast, ...(def.comment ? { comment: def.comment } : {}) });
    this.clearAll();
  }

  deleteName(name: string): void {
    this.names.delete(name.toUpperCase());
    this.clearAll();
  }

  /** Rewrite every name's definition (structural changes, sheet renames). */
  mapNames(f: (ast: Node) => Node): void {
    for (const [k, n] of this.names) {
      if (!n.ast) continue;
      const ast = f(n.ast);
      this.names.set(k, { ...n, ast, formula: formatFormula(ast).replace(/^=/, "") });
    }
  }

  /** Replace all names at once (undo). */
  restoreNames(defs: NameDef[]): void {
    this.names.clear();
    for (const d of defs) this.names.set(d.name.toUpperCase(), { ...d, ast: safeParse(d.formula) });
    this.clearAll();
  }

  /** A table by name, anywhere in the workbook. */
  findTable(name: string): { source: EditableSource; sheetName: string; table: import("./editable").TableDef } | null {
    const lower = name.toLowerCase();
    for (const s of this.sheets) {
      const t = s.source.tables.find((x) => x.name.toLowerCase() === lower);
      if (t) return { source: s.source, sheetName: s.name, table: t };
    }
    return null;
  }

  /** A table's name on its own (=SUM(Sales)) means its data rows. */
  private tableDataRange(name: string): Node | null {
    const f = this.findTable(name);
    if (!f) return null;
    const t = f.table;
    return { type: "range", range: { top: t.top + 1, left: t.left, bottom: t.bottom, right: t.right }, sheet: f.sheetName, absTop: true, absBottom: true, absLeft: true, absRight: true };
  }

  /** Swap in a whole new set of sheets (restoring a version), in place. */
  replaceSheets(sheets: Sheet[]): void {
    if (!sheets.length) throw new Error("A workbook needs at least one sheet.");
    this.sheets.splice(0, this.sheets.length, ...sheets.map((s) => ({ ...s })));
    for (const s of this.sheets) this.connect(s.source);
    const ids = this.sheets.map((s) => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
    this.nextId = Math.max(this.nextId, Math.max(0, ...ids) + 1);
    this.clearAll();
  }

  constructor(first?: { name: string; source: EditableSource }) {
    this.add(first?.name ?? "Sheet1", first?.source ?? new EditableSource(new BlankSource()));
  }

  /** A workbook with exactly these sheets (ids kept), e.g. when opening a saved file. */
  static restore(sheets: Sheet[]): Workbook {
    if (!sheets.length) throw new Error("A workbook needs at least one sheet.");
    const wb = new Workbook();
    wb.sheets.splice(0);
    for (const s of sheets) {
      wb.sheets.push({ ...s });
      wb.connect(s.source);
    }
    const ids = sheets.map((s) => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
    wb.nextId = Math.max(0, ...ids) + 1;
    wb.clearAll();
    return wb;
  }

  newId(): string {
    return `s${this.nextId++}`;
  }

  get(id: string): Sheet {
    const s = this.sheets.find((x) => x.id === id);
    if (!s) throw new Error(`No sheet with id ${id}`);
    return s;
  }

  has(id: string): boolean {
    return this.sheets.some((x) => x.id === id);
  }

  indexOf(id: string): number {
    return this.sheets.findIndex((x) => x.id === id);
  }

  /** Sheet names are unique, ignoring case (like Excel). */
  byName(name: string): Sheet | undefined {
    const lower = name.toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === lower);
  }

  /** "Sheet2", "Sheet3"… or "Data (2)" for copies: the first free name. */
  freeName(base = "Sheet"): string {
    if (base === "Sheet") {
      for (let n = this.sheets.length + 1; ; n++) if (!this.byName(`Sheet${n}`)) return `Sheet${n}`;
    }
    if (!this.byName(base)) return base;
    const stem = base.replace(/ \(\d+\)$/, "");
    for (let n = 2; ; n++) {
      const candidate = `${stem.slice(0, 31 - ` (${n})`.length)} (${n})`;
      if (!this.byName(candidate)) return candidate;
    }
  }

  /** Insert a sheet (at the end by default). Used by actions; validates the name. */
  add(name: string, source: EditableSource, index = this.sheets.length, id = this.newId(), extra: Partial<Sheet> = {}): Sheet {
    const problem = sheetNameProblem(name);
    if (problem) throw new Error(problem);
    if (this.byName(name)) throw new Error(`There's already a sheet called "${name}".`);
    const sheet: Sheet = { id, name, source, ...extra };
    this.sheets.splice(Math.max(0, Math.min(index, this.sheets.length)), 0, sheet);
    this.connect(source);
    this.clearAll(); // formulas elsewhere may refer to this name
    const n = Number(id.slice(1));
    if (Number.isInteger(n) && n >= this.nextId) this.nextId = n + 1;
    return sheet;
  }

  remove(id: string): { sheet: Sheet; index: number } {
    const index = this.indexOf(id);
    if (index < 0) throw new Error(`No sheet with id ${id}`);
    if (this.sheets.filter((s) => !s.hidden).length === 1 && !this.sheets[index].hidden) {
      throw new Error("A workbook needs at least one visible sheet.");
    }
    const [sheet] = this.sheets.splice(index, 1);
    this.clearAll(); // references to it now show #REF!
    return { sheet, index };
  }

  rename(id: string, name: string): string {
    const sheet = this.get(id);
    const problem = sheetNameProblem(name);
    if (problem) throw new Error(problem);
    const clash = this.byName(name);
    if (clash && clash.id !== id) throw new Error(`There's already a sheet called "${name}".`);
    const old = sheet.name;
    sheet.name = name;
    // formulas that pointed at the old name follow the sheet (as in Excel)
    if (old !== name) {
      for (const s of this.sheets) s.source.renameSheetRefs(old, name);
      this.mapNames((ast) => renameSheetIn(ast, old, name));
    }
    this.clearAll();
    return old;
  }

  move(id: string, to: number): number {
    const from = this.indexOf(id);
    if (from < 0) throw new Error(`No sheet with id ${id}`);
    const [sheet] = this.sheets.splice(from, 1);
    this.sheets.splice(Math.max(0, Math.min(to, this.sheets.length)), 0, sheet);
    return from;
  }

  setHidden(id: string, hidden: boolean): boolean {
    const sheet = this.get(id);
    if (hidden && !sheet.hidden && this.sheets.filter((s) => !s.hidden).length === 1) {
      throw new Error("A workbook needs at least one visible sheet.");
    }
    const was = !!sheet.hidden;
    sheet.hidden = hidden || undefined;
    return was;
  }

  /**
   * Cross-sheet wiring: a sheet resolves other sheets by name, and any change
   * to it drops the cached results of the others, since their formulas may
   * read it; propagate() limits that to the sheets that name it.
   */
  private connect(source: EditableSource): void {
    source.resolveSheet = (name) => this.byName(name)?.source ?? null;
    source.resolveName = (name) => this.names.get(name.toUpperCase())?.ast ?? this.tableDataRange(name);
    source.resolveTable = (name) => this.findTable(name);
    source.iterative = this.iter;
    source.onChange = () => this.propagate(source);
  }

  /**
   * A sheet changed: drop cached results on the sheets whose formulas name
   * it, then on the sheets that name those, and so on.
   */
  private propagate(changed: EditableSource): void {
    const done = new Set([changed]);
    const queue = [changed];
    while (queue.length) {
      const src = queue.pop()!;
      const name = this.sheets.find((x) => x.source === src)?.name;
      if (!name) continue;
      for (const s of this.sheets) {
        if (done.has(s.source) || !s.source.refersTo(name)) continue;
        done.add(s.source);
        s.source.clearCaches();
        queue.push(s.source);
      }
    }
  }

  private clearAll(): void {
    for (const s of this.sheets) s.source.clearCaches();
  }

  get visible(): Sheet[] {
    return this.sheets.filter((s) => !s.hidden);
  }
}

function safeParse(text: string): Node | null {
  try {
    return parseFormula("=" + text);
  } catch {
    return null;
  }
}
/** A copy of an AST with references to sheet `from` pointing at `to`. */
function renameSheetIn(node: Node, from: string, to: string): Node {
  const lower = from.toLowerCase();
  switch (node.type) {
    case "ref":
    case "range":
      return node.sheet !== undefined && node.sheet.toLowerCase() === lower ? { ...node, sheet: to } : node;
    case "unary":
      return { ...node, arg: renameSheetIn(node.arg, from, to) };
    case "binary":
      return { ...node, left: renameSheetIn(node.left, from, to), right: renameSheetIn(node.right, from, to) };
    case "call":
      return { ...node, args: node.args.map((a) => renameSheetIn(a, from, to)) };
    default:
      return node;
  }
}
