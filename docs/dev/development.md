# Development

How to work on cellforge: setup, layout, the rules every change follows, and
how progress is tracked.

## Setup

Requires Node 20+.

```bash
npm install
npm run dev        # the app        → http://localhost:5173  (/app.html for the sheet)
npm run docs       # these docs     → http://localhost:5174  (#/progress for the checklist)
npm test           # all unit tests (vitest)
npm run typecheck  # strict TypeScript, no emit
npm run build      # static site in apps/web/dist
```

## Repository layout

```
apps/web/           landing page, the app (app.html), /bench.html
  src/actions.ts      the sheet's actions (edits, fill, sort)
  src/app.ts          app shell: wires grid, data, actions, toolbar
  src/editable.ts     edit layer over the columnar data, fills, row order
apps/docs/          this documentation site (user guide, dev guide, progress)
packages/actions/   action registry, schemas, history, blob store
packages/core/      columnar table, CSV parser, formula parser/evaluator/compiler
packages/grid/      virtualized canvas grid
packages/gpu/       experimental WebGPU backend
docs/               markdown sources for the docs site
  guide/              user guide
  dev/                developer guide
  PLAN.md             milestones and the item being built now
```

## The one rule: every change is an action

Anything that changes a workbook goes through an action
(`packages/actions`, registered in `apps/web/src/actions.ts`):

```ts
registry.register<{ col: number; descending?: boolean }>({
  type: "rows.sort",
  title: "Sort all rows by one column",   // shown in the command list and to the AI
  schema: s.object({ col: s.int(undefined, 0), descending: s.bool() }, ["col"]),
  describe: (p) => `sort by column ${columnLetter(p.col)}`,
  recordable: true,                       // may be recorded into recipes
  async apply(ctx, p) {
    // change ctx.sheet, then return the action that undoes this one
    return { type: "rows.order", params: { order: ctx.blobs.put(before) } };
  },
});
```

Why this matters:

- **Undo** is "apply the inverse"; **redo** is "apply the inverse's inverse".
- **Recipes** are recorded lists of actions replayed on new data.
- **Provenance and the audit trail** are the log of applied actions.
- **The AI's tools** are the action catalogue (`registry.catalog()`), validated
  by the same schemas as a user's edit.

Checklist for a new action:

1. Params are plain JSON. Big data goes through `ctx.blobs` and is referenced by id.
2. `apply` validates bounds and returns the inverse, or `null` if nothing changed.
3. Inverse-only actions are `internal: true`.
4. Tests: apply → undo → redo round trip, bad input rejected before anything
   changes, and a JSON log of it replays onto a fresh sheet.

## Tests

- Unit tests live next to the code (`*.test.ts`) or in `packages/*/test/`.
- The formula compiler has a property-based fuzz test: compiled results must be
  bit-identical to the interpreter.
- UI changes are also checked by hand in a browser before committing.

## Progress tracking

[`docs/PLAN.md`](#/dev/PLAN) is the single source of truth:

- milestone items are marked ✅ done, 🔨 in progress, ⬜ not started;
- exactly one item is 🔨, and the `## Now` section breaks it into steps
  (`- [ ]` / `- [x]`).

The [progress page](#/progress) is generated from that file, so updating the
plan *is* updating the checklist. When an item is finished: tick its steps,
mark it ✅, mark the next one 🔨, and replace the `## Now` section.

## Commits

Small and focused, [Conventional Commits](https://www.conventionalcommits.org/)
style: `feat(sheet): …`, `fix(grid): …`, `docs: …`, `refactor(app): …`.
Say *what* changed in the first line and *why* in the body.

## Docs

- User guide pages describe only what works today, accurately. Anything
  planned links to the progress page instead.
- Developer docs explain *why*, not just *what*.
- New pages: drop a markdown file into `docs/guide/` or `docs/dev/`; the docs
  site picks it up automatically (file name order = sidebar order).
