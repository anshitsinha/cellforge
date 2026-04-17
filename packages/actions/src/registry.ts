/**
 * Actions: every change to a workbook is a plain, serialisable
 * `{ type, params }` object. Applying one returns its inverse, which is
 * itself an action, so undo is "apply the inverse" and redo is "apply the
 * inverse's inverse". The same objects are recorded into recipes, kept as
 * provenance, and exposed to the AI as tools (via their schemas).
 */
import { type JsonSchema, validate } from "./schema";

export interface Action<P = unknown> {
  type: string;
  params: P;
}

/** Who asked for an action: shown in the timeline and provenance. */
export type ActionOrigin = "user" | "undo" | "redo" | "recipe" | "ai" | "system";

export interface ActionDef<Ctx, P = any> {
  type: string;
  /** one line for humans, and for the AI's tool list */
  title: string;
  schema: JsonSchema;
  /** short past-tense description of a concrete action, e.g. "edit B4" */
  describe(params: P): string;
  /**
   * Apply to the context and return the action that undoes it, or null if
   * nothing changed. May be async (e.g. sorting in a worker).
   */
  apply(ctx: Ctx, params: P): Action | null | Promise<Action | null>;
  /**
   * Whether recipes may record and replay it on new data. Inverse-only
   * actions (restoring a saved row order, say) are not.
   */
  recordable?: boolean;
  /** internal actions (inverses) are hidden from the AI and the command list */
  internal?: boolean;
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}: ${problems.join("; ")}` : message);
  }
}

export interface Applied {
  action: Action;
  inverse: Action | null;
  origin: ActionOrigin;
  at: number;
}

export class ActionRegistry<Ctx> {
  private defs = new Map<string, ActionDef<Ctx>>();
  private listeners = new Set<(applied: Applied) => void>();

  register<P>(def: ActionDef<Ctx, P>): this {
    if (this.defs.has(def.type)) throw new Error(`action ${def.type} is already registered`);
    this.defs.set(def.type, def as ActionDef<Ctx>);
    return this;
  }

  get(type: string): ActionDef<Ctx> | undefined {
    return this.defs.get(type);
  }

  /** Validation problems for an action, or [] if it can be applied. */
  check(action: Action): string[] {
    const def = this.defs.get(action?.type);
    if (!def) return [`unknown action "${action?.type}"`];
    return validate(action.params, def.schema);
  }

  describe(action: Action): string {
    const def = this.defs.get(action.type);
    return def ? def.describe(action.params) : action.type;
  }

  /** Validate, apply and notify listeners. Throws ActionError on bad input. */
  async apply(ctx: Ctx, action: Action, origin: ActionOrigin = "user"): Promise<Applied> {
    const problems = this.check(action);
    if (problems.length) throw new ActionError(`invalid ${action?.type ?? "action"}`, problems);
    const inverse = await this.defs.get(action.type)!.apply(ctx, action.params);
    const applied: Applied = { action, inverse, origin, at: Date.now() };
    for (const l of this.listeners) l(applied);
    return applied;
  }

  /** Called after every successful apply (timeline, provenance, autosave). */
  subscribe(listener: (applied: Applied) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Public action definitions, e.g. to offer as tools to a language model. */
  catalog(): { type: string; title: string; schema: JsonSchema; recordable: boolean }[] {
    return [...this.defs.values()]
      .filter((d) => !d.internal)
      .map((d) => ({ type: d.type, title: d.title, schema: d.schema, recordable: !!d.recordable }));
  }
}

/** Undo/redo over actions: each entry stores the inverse that undoes it. */
export class ActionHistory<Ctx> {
  private done: { label: string; inverse: Action; at: number }[] = [];
  private undone: { label: string; inverse: Action; at: number }[] = [];
  private busy = false;

  constructor(
    private readonly registry: ActionRegistry<Ctx>,
    private readonly ctx: () => Ctx,
    private readonly limit = 500,
  ) {}

  /** Apply a new action and make it undoable. Returns null if it changed nothing. */
  async run(action: Action, origin: ActionOrigin = "user"): Promise<Applied | null> {
    const applied = await this.exclusive(() => this.registry.apply(this.ctx(), action, origin));
    if (!applied.inverse) return null;
    this.done.push({ label: this.registry.describe(action), inverse: applied.inverse, at: Date.now() });
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    return applied;
  }

  async undo(): Promise<string | null> {
    return this.step(this.done, this.undone, "undo");
  }

  async redo(): Promise<string | null> {
    return this.step(this.undone, this.done, "redo");
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  /**
   * What can be undone (oldest first) and redone (next first), with when each
   * change was made, for a history panel.
   */
  get timeline(): { done: { label: string; at: number }[]; undone: { label: string; at: number }[] } {
    return {
      done: this.done.map(({ label, at }) => ({ label, at })),
      undone: [...this.undone].reverse().map(({ label, at }) => ({ label, at })),
    };
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  private async step(from: typeof this.done, to: typeof this.done, origin: "undo" | "redo"): Promise<string | null> {
    const entry = from.pop();
    if (!entry) return null;
    try {
      const applied = await this.exclusive(() => this.registry.apply(this.ctx(), entry.inverse, origin));
      if (applied.inverse) to.push({ label: entry.label, inverse: applied.inverse, at: entry.at });
    } catch (e) {
      from.push(entry); // leave history as it was
      throw e;
    }
    return entry.label;
  }

  /** One action at a time: an async sort must finish before the next edit applies. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await new Promise((r) => setTimeout(r, 0));
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}
