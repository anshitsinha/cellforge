/**
 * A workbook: an ordered list of sheets. Each sheet owns its data (an
 * EditableSource over imported or blank data). Which sheet is on screen is
 * view state, not part of the workbook's data, so switching isn't undoable,
 * just as in Excel.
 */
import { BlankSource, EditableSource } from "./editable";

export interface Sheet {
  id: string;
  name: string;
  source: EditableSource;
  /** tab colour, CSS colour string */
  color?: string;
  hidden?: boolean;
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
    if (old !== name) for (const s of this.sheets) s.source.renameSheetRefs(old, name);
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
