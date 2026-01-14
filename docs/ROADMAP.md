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

## v0.3 — scale + the compiler ✅

- [x] Selection stats over whole imported columns via the typed arrays
- [x] Radix sort in a worker — 100M rows in ~4s
- [x] Fill down (Ctrl+D), stored as one object per column
- [x] `$` anchors, row-shifted evaluation, formula printer
- [x] Fill-down compiler → JS typed-array kernels, bit-identical to the interpreter
- [x] Property-based fuzz test for the compiler's correctness contract
- [x] Lazy chunked kernel evaluation with an LRU cap
- [x] WGSL codegen + WebGPU runner (experimental, f32)
- [x] `/bench.html` evaluation harness

## v0.4 — next

- [ ] Persistent GPU-resident columns; double-f32 emulation (see RESEARCH.md)
- [ ] Fill-down *detection* for sheets with per-cell formulas (e.g. .xlsx import)
- [ ] Multi-threaded kernels (SharedArrayBuffer + workers)
- [ ] Dependency tracking instead of drop-everything invalidation
- [ ] Save/restore sessions in OPFS (Origin Private File System)
- [ ] Filter rows
- [ ] Benchmarks vs Excel / LibreOffice / Google Sheets
