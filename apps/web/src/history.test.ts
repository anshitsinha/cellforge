import { describe, expect, it } from "vitest";
import { History } from "./history";

function counter() {
  const state = { value: 0 };
  const add = (n: number) => ({
    label: `add ${n}`,
    undo: () => (state.value -= n),
    redo: () => (state.value += n),
  });
  return { state, add };
}

describe("History", () => {
  it("undoes and redoes in order", () => {
    const h = new History();
    const { state, add } = counter();
    for (const n of [1, 2, 3]) {
      state.value += n;
      h.push(add(n));
    }
    h.undo();
    expect(state.value).toBe(3);
    h.undo();
    expect(state.value).toBe(1);
    h.redo();
    expect(state.value).toBe(3);
  });

  it("drops the redo stack after a new action", () => {
    const h = new History();
    const { state, add } = counter();
    state.value += 1;
    h.push(add(1));
    h.undo();
    state.value += 5;
    h.push(add(5));
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBe(null);
    expect(state.value).toBe(5);
  });

  it("caps its size", () => {
    const h = new History(2);
    const { add } = counter();
    h.push(add(1));
    h.push(add(2));
    h.push(add(3));
    expect(h.undo()?.label).toBe("add 3");
    expect(h.undo()?.label).toBe("add 2");
    expect(h.undo()).toBe(null);
  });
});
