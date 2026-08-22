# Roadmap

Rough order, subject to change.

## v0.1 — the grid ✅

- [x] Repo setup, docs
- [x] Vite app shell
- [x] Virtualized canvas grid (rows/cols, headers, scrolling)
- [x] Cell selection + keyboard navigation
- [x] Formula bar + in-place cell editing
- [x] Column resize
- [x] Draggable scrollbars

## v0.2 — a usable spreadsheet ✅

- [x] Landing page
- [x] CSV import (streaming, in a Web Worker, drag and drop)
- [x] Columnar store (`Float64Array` / dictionary-encoded strings)
- [x] New blank sheet, CSV export
- [x] Range selection, copy/cut/paste (TSV, Excel-compatible)
- [x] Sum / average / count for the selection
- [x] Formula parser + interpreter (~25 functions)
- [x] Undo / redo
- [x] Sort by column (index-based)

## v0.3 — scale everything

- [ ] Selection stats and SUM over whole columns via the columnar fast path
- [ ] Sort in a worker so 100M rows works
- [ ] Column-level clear/fill instead of per-cell edits
- [ ] Save/restore sessions in OPFS (Origin Private File System)
- [ ] Filter rows

## v0.4 — the fast path

- [ ] Fill-down detection (same relative formula repeated down a column)
- [ ] Rust → WASM engine
- [ ] WGSL codegen for vectorised formulas
- [ ] Benchmarks vs Excel / Google Sheets / DuckDB
