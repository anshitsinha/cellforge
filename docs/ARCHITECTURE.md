# Architecture

This is a living doc. It describes where things are headed, not just what exists
today — sections marked _(planned)_ aren't built yet.

## The core bet

Traditional spreadsheets model a sheet as a sparse map of cells, each cell an
object holding a value, a formula, formatting, dependents, etc. That's flexible,
but it means memory and recalc time scale with the number of *cells*.

Most large sheets aren't really "a million independent cells" though. They're a
table: a handful of columns, lots of rows, and formulas that are the same
expression filled down a column. cellforge treats that as the common case and
optimises for it.

## Layers

```
┌────────────────────────────────────────────────────────┐
│ apps/web        landing page, app shell, import/export, │
│                 clipboard, undo, sort, edit overlay     │
├────────────────────────────────────────────────────────┤
│ packages/grid   virtualized canvas renderer + input     │
├────────────────────────────────────────────────────────┤
│ packages/core   columnar Table, CSV parser, formulas    │
├────────────────────────────────────────────────────────┤
│ packages/gpu    WGSL codegen + WebGPU runtime           │  (experimental)
└────────────────────────────────────────────────────────┘
```

`grid` and `core` don't depend on each other. The app wires them together.

## Grid (`packages/grid`)

- Renders to a single `<canvas>`; never creates DOM nodes per cell. The only DOM
  it adds is a floating `<input>` while a cell is being edited (text editing,
  IME and clipboard are not worth reimplementing on canvas).
- Asks a `DataSource` for only the visible window of rows/columns each frame.
- Knows nothing about formulas or storage — it just draws values it's handed and
  reports edits back through callbacks (`onCellEdit`, `onClearRange`,
  `onSelectionChange`).
- Scroll height is virtual. Browsers cap element heights (~33M px in Chrome), so
  at 100M rows × 24px we can't use a real scrollable div of that height. The grid
  keeps its own scroll offsets and draws its own scrollbars.
- Column widths are a `Float64Array` plus prefix sums, so x → column is a binary
  search. Rows all share one height, so y → row is a division.

## Data (`packages/core` + `apps/web/src/editable.ts`)

The data a user sees is three layers stacked:

```
 view row ──► row order (Uint32Array, from sorting) ──► base row
                                                          │
                     sparse edit overlay  ◄───────────────┤  (values + formulas)
                                                          │
                     immutable columnar Table ◄───────────┘  (imported CSV)
```

### Columnar Table

- One typed array per column. Numbers are a `Float64Array` with `NaN` for
  blanks; text is dictionary-encoded (`Uint32Array` of codes + a string list),
  which is a big win for repetitive columns like region or status.
- Built in a Web Worker while the file streams in, then the buffers are
  *transferred* (not copied) to the main thread.
- Type inference is "numeric until proven otherwise": a column flips to text on
  its first non-numeric value.

### Edit overlay

- Edits live in a `Map<baseRow, Map<col, value | formula>>`, so editing a few
  cells in a 100M-row sheet costs a few map entries.
- Keyed by *base* row so edits move with their row when the sheet is re-sorted.

### Sorting

- Sorting produces a new view → base `Uint32Array` instead of moving data.
  Undo restores the previous array. Keys are extracted once up front so the
  comparator doesn't call `getCell` n·log(n) times.

### Formulas

- Hand-written tokenizer + recursive-descent parser → AST → tree-walking
  evaluator. Errors (`#DIV/0!`, `#VALUE!`, ...) are values that flow through
  formulas, not exceptions.
- References are in view coordinates — what the user sees.
- Results are cached per cell and the cache is dropped on any edit. Crude, but
  always correct, and only visible cells get evaluated.
- Ranges are visited through `EvalContext.eachInRange`. When a range covers
  untouched numeric columns of an imported table, the sheet iterates the
  `Float64Array` directly instead of calling `getCell` per row.

### Fills and the formula compiler

- **Fill down** stores one `Fill` per column: a template AST, the row it's
  relative to (`origin`), and a base-row interval. Lookup order for a cell is
  explicit edit → newest covering fill → base data.
- `evaluate(ast, ctx, rowShift)` evaluates a template as if it were filled
  `rowShift` rows down; `$`-anchored refs don't move.
- `compileFill` turns the template into a JS loop over `Float64Array`s. It's a
  fast path under a strict contract: finite output is bit-identical to the
  interpreter, NaN means "ask the interpreter". See
  [RESEARCH.md](RESEARCH.md) for how that's guaranteed and tested.
- Kernels run lazily per 64K-row chunk as rows are read, with an LRU cap
  (~128MB), so a 100M-row fill costs nothing until it's looked at.
- Inputs from untouched imported columns are zero-copy `subarray`s.
- Kernels are only used while the sheet is unsorted (they index rows
  directly); sorted sheets fall back to the interpreter per cell.
- `packages/gpu` has a WGSL backend for the same subset. It's f32 only, so it
  backs the benchmark, not the app.

### Sorting at scale

- Keys are extracted on the main thread: numbers as-is, text replaced by its
  rank among distinct values (from the dictionary for imported columns).
- A stable LSD radix sort (`core/radix.ts`) runs in a worker: floats are
  bit-twiddled into order-preserving uints and bucketed 16 bits at a time,
  plus one pass on a number/text/blank "kind" byte. No comparator calls.

## Undo

Every user action becomes a `Command` with `undo()` / `redo()` on a pair of
stacks. Cell edits record the previous *stored* value — `undefined` ("never
edited, show the original") is kept distinct from `null` ("edited to empty").

## Known limits (for now)

- Clearing / copying is capped at 1M cells (it goes through the sparse overlay).
- Sorting 100M rows needs ~1.7GB free memory (keys + index arrays).
- Selection stats over edited or generated columns use the per-cell path,
  sliced so the UI stays responsive.
- Any edit drops every cached formula result and fill chunk; there's no
  dependency graph yet.
- Very long dependency chains (a running total filled down 100K+ rows) recurse
  once per row in the interpreter and show `#CYCLE!` if they hit the stack limit.
