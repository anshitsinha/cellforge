# cellforge

A spreadsheet that stays fast at 100 million rows — entirely in the browser.

Excel tops out at ~1M rows. Google Sheets at 10M cells. Past that, people give up
on spreadsheets and move to SQL or pandas. cellforge is an experiment in whether
that ceiling is actually necessary, or just an artifact of how spreadsheets are
built.

The idea:

- **Columnar storage** instead of a grid of cell objects. A column of 100M numbers
  is one `Float64Array`, not 100M heap objects.
- **Formulas get compiled, not interpreted.** A formula like `=B2*C2` applied down a
  column is really a vector operation, so it gets compiled to a WebGPU compute
  shader (with a WASM/CPU fallback).
- **Only draw what's on screen.** The grid is a virtualized `<canvas>`; scrolling
  through 100M rows costs the same as scrolling through 100.
- **No server.** Your data never leaves your machine. The whole thing deploys as
  static files.

> **Status:** early. Right now this is the grid UI. The engine lands next — see the
> [roadmap](docs/ROADMAP.md).

## Getting started

Requires Node 20+.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Repo layout

```
cellforge/
├── apps/web/          # the app (Vite + TypeScript)
├── packages/grid/     # virtualized canvas grid renderer
├── docs/              # architecture notes, roadmap, decisions
└── bench/             # benchmarks (coming soon)
```

The engine (`crates/engine`, Rust → WASM) and the GPU runtime (`packages/gpu`)
will be added as the project grows. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the pieces fit together.

## Contributing

Issues and PRs are welcome — have a look at [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)
