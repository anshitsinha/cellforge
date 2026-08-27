import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore, validate } from "@cellforge/actions";
import { actionSchema, runRequest } from "@cellforge/ai";
import { Kiln } from "@cellforge/kiln";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { askContext } from "./askbar";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";
import { buildTinyModel } from "../../../packages/kiln/test/tiny";

describe("a local model in the ask loop", () => {
  it("always proposes an action that parses and fits the catalog, and the loop runs it or gives up cleanly", async () => {
    const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(10, 3)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const registry = sheetActions();
    const h = new ActionHistory(registry, () => ctx);
    await h.run(setCells([{ row: 0, col: 0, input: "Region" }, { row: 0, col: 1, input: "Amount" }]));

    // a few actions keep the tiny random model's job small; the real app passes the whole catalog
    const catalog = registry.catalog().filter((c) => ["view.freeze", "cols.hide", "rows.hide"].includes(c.type));
    const kiln = await Kiln.load(buildTinyModel({ contextLength: 4096 }).bytes);

    // the grammar guarantees the shape even from a model that knows nothing
    const schema = actionSchema(catalog);
    for (let i = 0; i < 3; i++) {
      const text = await kiln.propose(`Request ${i}: hide something`, schema);
      const action = JSON.parse(text) as unknown;
      expect(validate(action, schema)).toEqual([]);
    }

    const t = await runRequest("make the sheet look tidier somehow", {
      catalog: () => catalog,
      context: () => askContext(workbook, ctx.activeSheet, { top: 0, left: 0, bottom: 0, right: 0 }),
      run: (a) => h.run(a),
      undo: () => h.undo(),
      model: kiln,
      maxTries: 2,
    });
    expect(["done", "gave-up"]).toContain(t.status);
  }, 120_000);
});
