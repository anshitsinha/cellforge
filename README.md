# cellforge

A spreadsheet that stays fast at 100 million rows — entirely in the browser.

Excel tops out at 1,048,576 rows. Google Sheets at 10M cells. Past that, people
give up on spreadsheets and move to SQL or pandas. cellforge is an experiment in
whether that ceiling is actually necessary, or just an artifact of how
spreadsheets are built.

## What it does

- **Scroll 100M rows** smoothly — try the built-in demo dataset.
- **Open big CSVs** by button or drag-and-drop. Parsing runs in a Web Worker and
  streams the file, so the page never freezes.
- **Formulas** — `=A1*B1`, `=SUM(C:C)`, `=COUNTIF(B1:B500, "North")`,
  `=IF(D2>100, "big", "small")` and ~25 other functions, with proper error values
  (`#DIV/0!`, `#CYCLE!`, ...).
- **Fill down** (Ctrl+D) a formula through millions of rows instantly. The fill
  is stored once and compiled to a typed-array kernel (see below).
- **Sort** any column, even all 100M rows of the demo (~4s): a radix sort in a
  Web Worker reorders an index, not the data, so it's undoable.
- **Select ranges**, see sum / average / count live, **copy/paste** to and from
  Excel or Google Sheets.
- **Undo / redo** for edits, pastes, clears and sorts.
- **Export** back to CSV.
- **No server.** Your data never leaves your machine. The whole thing deploys as
  static files.

## How

- **Columnar storage** instead of a grid of cell objects. A column of 100M numbers
  is one `Float64Array`; text columns are dictionary-encoded.
- **Only draw what's on screen.** The grid is a single virtualized `<canvas>`;
  scrolling through 100M rows costs the same as scrolling through 100.
- **Edits are a sparse overlay** on top of the immutable imported data, so
  changing a few cells in a huge sheet doesn't copy anything.
- **Filled-down formulas get compiled.** `=B2*C2*(1-D2)` filled down a column is
  really one vector operation, so it's compiled into a single loop over typed
  arrays. The interpreter stays the source of truth: compiled results are
  **bit-identical** to it (checked by a fuzz test over 250K random formulas),
  and any row the kernel can't decide falls back to the interpreter.

### Compiled vs interpreted (preliminary)

16M rows, Chromium + NVIDIA Turing, median of 3 — reproduce at `/bench.html`:

| Formula | Interpreter | Compiled JS | Speedup |
| --- | ---: | ---: | ---: |
| `=A1*B1` | 27.9 M rows/s | 167.4 M rows/s | 6.0× |
| `=IF(A1>B1, SQRT(A1*B1), ROUND(A1/B1, 2))` | 3.0 M rows/s | 55.8 M rows/s | 18.4× |
| `=MAX(A1,B1,C1)-MIN(A1,B1,C1)+A1*0.5` | 2.5 M rows/s | 55.4 M rows/s | 22.2× |

There's also an experimental WebGPU backend. Its compute is very fast, but f32
precision isn't safe for spreadsheets (up to 32% error from cancellation) — see
[docs/RESEARCH.md](docs/RESEARCH.md) for the full results and what's next.

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run build      # static site in apps/web/dist
```

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Arrows, Tab, Enter, PgUp/PgDn, Home/End | Move |
| Ctrl + arrows / Ctrl + Home/End | Jump to the edge of the sheet |
| Shift + any of the above, or drag | Extend selection |
| Ctrl + A | Select all |
| Type / F2 / double-click | Edit a cell |
| Delete | Clear selection |
| Ctrl + D | Fill down |
| Ctrl + C / X / V | Copy / cut / paste |
| Ctrl + Z / Ctrl + Y | Undo / redo |

## Repo layout

```
cellforge/
├── apps/web/          # landing page, the app, /bench.html (Vite, TypeScript)
├── packages/core/     # columnar table, CSV parser, formula engine + compiler, radix sort
├── packages/grid/     # virtualized canvas grid renderer
├── packages/gpu/      # WGSL codegen + WebGPU runner (experimental)
├── bench/             # node micro-benchmarks
└── docs/              # architecture, roadmap, research notes
```

The grid knows nothing about where data comes from, and core knows nothing about
rendering — see the architecture doc for why that boundary matters.

## Contributing

Issues and PRs are welcome — have a look at [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)
