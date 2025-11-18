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
┌───────────────────────────────────────────────┐
│ apps/web        UI shell, formula bar, files   │
├───────────────────────────────────────────────┤
│ packages/grid   virtualized canvas renderer    │
├───────────────────────────────────────────────┤
│ data model      columnar store + formula graph │  (planned: crates/engine)
├───────────────────────────────────────────────┤
│ packages/gpu    WGSL codegen + WebGPU runtime  │  (planned)
└───────────────────────────────────────────────┘
```

### Grid (`packages/grid`)

- Renders to a single `<canvas>`; never creates DOM nodes per cell.
- Asks a `DataSource` for only the visible window of rows/columns each frame.
- Knows nothing about formulas or storage — it just draws strings it's handed.
  That boundary is deliberate so the engine can be swapped (JS → WASM → GPU)
  without touching rendering.
- Scroll height is virtual. Browsers cap element heights (~33M px in Chrome), so
  at 100M rows × 24px we can't use a real scrollable div of that height. The grid
  keeps its own scroll offset instead.

### Columnar store _(planned)_

- One typed array per column (`Float64Array`, dictionary-encoded strings, etc.).
- Cells that are "special" (a one-off formula, an override) live in a sparse
  side table so the dense path stays dense.

### Formula compiler _(planned)_

- Parse → AST → detect "fill-down" formulas (same relative expression per row).
- Fill-down formulas compile to one vectorised kernel instead of N evaluations.
- Targets: WGSL compute shader (WebGPU) or a WASM loop as fallback.

## Decisions log

Bigger design decisions get a short write-up in [`docs/decisions/`](decisions/).
