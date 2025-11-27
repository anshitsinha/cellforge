import type { Theme } from "./types";

export interface EditorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type CommitMove = "down" | "up" | "right" | "left" | "none";

/**
 * The little <input> that appears on top of a cell while you're typing in it.
 *
 * The canvas can't do text editing (cursor, IME, selection, copy/paste...) and
 * reimplementing all of that would be miserable, so we cheat and float a real
 * input over the cell. Only one exists at a time.
 */
export class CellEditor {
  readonly input: HTMLInputElement;
  private active = false;

  /** Called with the final text and which way the selection should move. */
  onCommit: ((text: string, move: CommitMove) => void) | null = null;
  onCancel: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    Object.assign(this.input.style, {
      position: "absolute",
      display: "none",
      boxSizing: "border-box",
      margin: "0",
      padding: "0 5px",
      font: '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      outline: "none",
      zIndex: "1",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.input);

    this.input.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("blur", this.onBlur);
  }

  get isEditing(): boolean {
    return this.active;
  }

  open(rect: EditorRect, text: string, theme: Theme, caretAtEnd = true): void {
    this.active = true;
    this.input.value = text;
    this.input.style.display = "block";
    this.input.style.background = theme.background;
    this.input.style.color = theme.text;
    this.input.style.border = `2px solid ${theme.accent}`;
    this.place(rect);
    this.input.focus();
    if (caretAtEnd) {
      const end = text.length;
      this.input.setSelectionRange(end, end);
    }
  }

  /** Reposition while open (e.g. the user scrolled mid-edit). */
  place(rect: EditorRect): void {
    Object.assign(this.input.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      // let the editor grow a bit for long values, like excel does
      width: `${Math.max(rect.width, Math.min(400, this.input.value.length * 8 + 16))}px`,
      height: `${rect.height}px`,
    });
  }

  close(): void {
    this.active = false;
    this.input.style.display = "none";
  }

  destroy(): void {
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("blur", this.onBlur);
    this.input.remove();
  }

  private commit(move: CommitMove): void {
    if (!this.active) return;
    const text = this.input.value;
    this.close();
    this.onCommit?.(text, move);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // keep the grid's own key handling from seeing these
    e.stopPropagation();
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        this.commit(e.shiftKey ? "up" : "down");
        break;
      case "Tab":
        e.preventDefault();
        this.commit(e.shiftKey ? "left" : "right");
        break;
      case "Escape":
        e.preventDefault();
        this.close();
        this.onCancel?.();
        break;
    }
  };

  // clicking somewhere else counts as "I'm done", same as every spreadsheet
  private onBlur = (): void => this.commit("none");
}
