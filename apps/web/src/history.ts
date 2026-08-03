/**
 * Undo/redo as a pair of stacks of commands. Each command knows how to undo
 * and redo itself, so the history doesn't care whether it's a cell edit, a
 * paste or a sort.
 */
export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  private done: Command[] = [];
  private undone: Command[] = [];

  constructor(private readonly limit = 500) {}

  /** Record a command that has already been applied. */
  push(cmd: Command): void {
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    // a new action after undoing throws away the redo branch, like every editor
    this.undone = [];
  }

  undo(): Command | null {
    const cmd = this.done.pop();
    if (!cmd) return null;
    cmd.undo();
    this.undone.push(cmd);
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.undone.pop();
    if (!cmd) return null;
    cmd.redo();
    this.done.push(cmd);
    return cmd;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}
