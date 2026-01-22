import { describe, expect, it } from "vitest";
import { type Action, ActionError, ActionHistory, ActionRegistry, s, validate } from "../src";

describe("schema validation", () => {
  const schema = s.object({
    row: s.int("row", 0),
    text: s.anyOf(s.string(), s.null()),
    tags: s.array(s.string(undefined, { enum: ["a", "b"] })),
  });

  it("accepts valid params", () => {
    expect(validate({ row: 3, text: null, tags: ["a"] }, schema)).toEqual([]);
  });

  it("reports precise paths", () => {
    expect(validate({ row: -1, text: 5, tags: ["c"], extra: 1 }, schema)).toEqual([
      "params.row: must be >= 0",
      "params.text: does not match any allowed shape",
      "params.tags[0]: must be one of a, b",
      "params.extra: unknown field",
    ]);
    expect(validate({ row: 1.5, text: "x" }, schema)).toEqual(["params.tags: required", "params.row: expected an integer"]);
  });
});

/** A toy context: a counter and a log, enough to exercise the machinery. */
interface Ctx {
  value: number;
}

function registry() {
  return new ActionRegistry<Ctx>()
    .register<{ by: number }>({
      type: "add",
      title: "Add to the counter",
      schema: s.object({ by: s.number() }),
      describe: (p) => `add ${p.by}`,
      recordable: true,
      apply(ctx, p) {
        if (p.by === 0) return null;
        ctx.value += p.by;
        return { type: "add", params: { by: -p.by } };
      },
    })
    .register<{ to: number }>({
      type: "set",
      title: "Set the counter",
      schema: s.object({ to: s.number() }),
      describe: (p) => `set to ${p.to}`,
      async apply(ctx, p) {
        await new Promise((r) => setTimeout(r, 1)); // like a sort in a worker
        const before = ctx.value;
        ctx.value = p.to;
        return { type: "set", params: { to: before } };
      },
    });
}

describe("actions", () => {
  it("apply returns the inverse and validates first", async () => {
    const reg = registry();
    const ctx = { value: 1 };
    const applied = await reg.apply(ctx, { type: "add", params: { by: 4 } });
    expect(ctx.value).toBe(5);
    expect(applied.inverse).toEqual({ type: "add", params: { by: -4 } });
    await expect(reg.apply(ctx, { type: "add", params: { by: "4" } })).rejects.toBeInstanceOf(ActionError);
    await expect(reg.apply(ctx, { type: "nope", params: {} })).rejects.toThrow(/unknown action/);
    expect(ctx.value).toBe(5);
  });

  it("history undoes and redoes through inverses, async included", async () => {
    const reg = registry();
    const ctx = { value: 0 };
    const h = new ActionHistory(reg, () => ctx);
    await h.run({ type: "add", params: { by: 2 } });
    await h.run({ type: "set", params: { to: 10 } });
    await h.run({ type: "add", params: { by: 0 } }); // no-op: not recorded
    expect(ctx.value).toBe(10);
    expect(await h.undo()).toBe("set to 10");
    expect(ctx.value).toBe(2);
    expect(await h.undo()).toBe("add 2");
    expect(ctx.value).toBe(0);
    expect(await h.undo()).toBeNull();
    await h.redo();
    await h.redo();
    expect(ctx.value).toBe(10);
    // a new action drops the redo branch
    await h.undo();
    await h.run({ type: "add", params: { by: 1 } });
    expect(h.canRedo).toBe(false);
    expect(ctx.value).toBe(3);
  });

  it("serialises: a log of actions replays to the same state", async () => {
    const reg = registry();
    const log: Action[] = [];
    reg.subscribe((a) => a.origin === "user" && log.push(JSON.parse(JSON.stringify(a.action))));
    const a = { value: 0 };
    for (const action of [
      { type: "add", params: { by: 3 } },
      { type: "set", params: { to: 7 } },
      { type: "add", params: { by: -2 } },
    ]) {
      await reg.apply(a, action);
    }
    const b = { value: 0 };
    for (const action of log) await reg.apply(b, action, "recipe");
    expect(b.value).toBe(a.value);
  });

  it("serialises concurrent runs", async () => {
    const reg = registry();
    const ctx = { value: 0 };
    const h = new ActionHistory(reg, () => ctx);
    await Promise.all([h.run({ type: "set", params: { to: 5 } }), h.run({ type: "add", params: { by: 1 } })]);
    expect(ctx.value).toBe(6);
  });

  it("catalog lists public actions with their schemas", () => {
    const reg = registry();
    reg.register({ type: "secret", title: "x", schema: s.object({}), describe: () => "", apply: () => null, internal: true });
    expect(reg.catalog().map((c) => c.type)).toEqual(["add", "set"]);
    expect(reg.catalog()[0].recordable).toBe(true);
  });
});
