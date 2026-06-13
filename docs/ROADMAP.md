# Roadmap

Rough order, subject to change.

## v0.1 — the grid

- [x] Repo setup, docs
- [ ] Vite app shell
- [ ] Virtualized canvas grid (rows/cols, headers, scrolling)
- [ ] Cell selection + keyboard navigation
- [ ] Formula bar + in-place cell editing
- [ ] Column resize

## v0.2 — real data

- [ ] CSV import (streaming, off main thread)
- [ ] Columnar store in a Web Worker
- [ ] 10M-row demo dataset generator

## v0.3 — formulas

- [ ] Formula parser
- [ ] Interpreter (baseline, for correctness)
- [ ] Fill-down detection

## v0.4 — the fast path

- [ ] Rust → WASM engine
- [ ] WGSL codegen for vectorised formulas
- [ ] Benchmarks vs Excel / Google Sheets / DuckDB
