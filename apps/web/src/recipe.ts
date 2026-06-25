/**
 * Recipes: the steps of a piece of work, kept so they can be looked at,
 * edited and run again. Every recordable action the user runs is recorded
 * with the sheet it worked on (by name, so a recipe can run on another
 * workbook that has sheets with the same names), how long it took and how
 * much memory it used. Undo and redo keep the recording in step.
 */
import type { Action } from "@cellforge/actions";

export interface RecipeStep {
  action: Action;
  /** the sheet the step works on, by name ("" = whichever sheet is active when the recipe runs) */
  sheet: string;
  label: string;
  enabled: boolean;
  /** when recorded: how long it took (ms) and the change in memory used (bytes, where the browser says) */
  ms?: number;
  memory?: number;
  note?: string;
}

export interface Recipe {
  name: string;
  steps: RecipeStep[];
  /** when it was saved */
  at: number;
}

/** The session's recording, in step with undo and redo. */
export class RecipeRecorder {
  private done: RecipeStep[] = [];
  private undone: RecipeStep[] = [];

  record(step: Omit<RecipeStep, "enabled">): void {
    this.done.push({ ...step, enabled: true });
    if (this.done.length > 2000) this.done.shift();
    this.undone = [];
  }

  /** An undo happened: the last step is no longer part of the work (if it was recorded). */
  undo(label: string): void {
    const last = this.done[this.done.length - 1];
    if (last && last.label === label) this.undone.push(this.done.pop()!);
  }

  redo(label: string): void {
    const next = this.undone[this.undone.length - 1];
    if (next && next.label === label) this.done.push(this.undone.pop()!);
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  get steps(): readonly RecipeStep[] {
    return this.done;
  }
}

/** Parameters that hold a sheet id: recorded by the sheet's name ("@Name") so a recipe can run on other workbooks. */
const SHEET_KEYS = ["sheet", "fromSheet"];

/**
 * A step's action ready to run: sheet names back to ids. Returns the action
 * and the id of the sheet to treat as active.
 */
export function bindStep(step: RecipeStep, sheetIdByName: (name: string) => string | undefined, activeId: string): { action: Action; sheetId: string } {
  const find = (name: string) => {
    const id = sheetIdByName(name);
    if (!id) throw new Error(`There's no sheet called "${name}".`);
    return id;
  };
  const sheetId = step.sheet ? find(step.sheet) : activeId;
  const params = { ...(step.action.params as Record<string, unknown>) };
  for (const k of SHEET_KEYS) {
    const v = params[k];
    if (typeof v === "string" && v.startsWith("@")) params[k] = find(v.slice(1));
  }
  return { action: { type: step.action.type, params }, sheetId };
}

/** A step's action as recorded: sheet ids become "@Name". */
export function unbindAction(action: Action, sheetNameById: (id: string) => string | undefined): Action {
  const params = { ...(action.params as Record<string, unknown>) };
  for (const k of SHEET_KEYS) {
    const v = params[k];
    if (typeof v === "string") {
      const name = sheetNameById(v);
      if (name) params[k] = `@${name}`;
    }
  }
  return { type: action.type, params };
}

/** Make a recipe from recorded steps. */
export function makeRecipe(name: string, steps: readonly RecipeStep[]): Recipe {
  return { name, steps: steps.map((s) => structuredClone(s)), at: Date.now() };
}

/** Bytes in plain words. */
export function memoryText(bytes: number | undefined): string {
  if (bytes === undefined || Math.abs(bytes) < 1024) return ""; // the browser only reports memory roughly
  const abs = Math.abs(bytes);
  const t = abs < 1024 ? `${abs} B` : abs < 1024 ** 2 ? `${(abs / 1024).toFixed(0)} KB` : abs < 1024 ** 3 ? `${(abs / 1024 ** 2).toFixed(1)} MB` : `${(abs / 1024 ** 3).toFixed(2)} GB`;
  return (bytes < 0 ? "−" : "+") + t;
}

/** Memory in use, where the browser tells us (Chrome); undefined elsewhere. */
export function usedMemory(): number | undefined {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m?.usedJSHeapSize;
}
