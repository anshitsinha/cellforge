# Plan

How we get from today's fast single-sheet grid to [the vision](VISION.md).
Each milestone ships on its own and leaves the app better than it found it.
Order is chosen so that every later layer (recipes, AI) sits on a foundation
that already exists.

Status: ✅ done · 🔨 in progress · ⬜ not started

## Architecture targets

```
┌──────────────────────────────────────────────────────────────────────┐
│ apps/web      app shell, panels (recipes, AI, audit, explore)        │
│ apps/docs     documentation site, function reference (generated)     │
├──────────────────────────────────────────────────────────────────────┤
│ actions       typed actions: apply / invert / serialise / describe   │
│               ← used by UI, undo, recipes, provenance, AI tools      │
├──────────────────────────────────────────────────────────────────────┤
│ workbook      sheets, styles, merges, names, tables, validation,     │
│               dependency graph + recalc scheduler                    │
├───────────────┬──────────────────┬───────────────────┬───────────────┤
│ core          │ formula          │ query (lazy)      │ files (lazy)  │
│ columnar data │ parser, function │ DuckDB-WASM over  │ xlsx, csv,    │
│ edit overlay  │ registry, Excel  │ Arrow views of    │ parquet, ods, │
│ sort, fills   │ semantics, spill │ sheet columns     │ json, pdf     │
├───────────────┴──────────────────┴───────────────────┴───────────────┤
│ grid          canvas renderer: styles, merges, freeze, spill, charts │
├──────────────────────────────────────────────────────────────────────┤
│ ai (lazy)     kiln runtime, model manager, constrained decoding,     │
│               tool loop over actions, embeddings, Whisper, OCR       │
└──────────────────────────────────────────────────────────────────────┘
```

### Key decisions

- **Actions are the backbone.** `Action = { type, params }` with a JSON schema
  per type. `apply(workbook) → inverse`. Undo is a stack of inverses, a recipe is
  a list of actions, provenance records which action wrote a cell, and the AI's
  tools *are* the action schemas. There is no second API.
- **Columnar stays columnar.** Styles, validation and conditional formats are
  stored as **range runs** (rectangles with priority), never per cell, so a
  100M-row sheet with a styled header costs a few objects.
- **Dependency graph over ranges, not cells.** Precedents are stored as
  rectangles in an interval index; a filled-down column is one node. Recalc
  marks dirty ranges and evaluates only what's visible or depended on.
- **One function registry.** Each function declares name, category, argument
  signature, return kind, volatility, description and examples. The evaluator,
  the compiler, the docs site, the autocomplete and the AI context are all
  generated from it, and every example is a test.
- **Excel semantics are the spec.** Coercions, error propagation, date serials
  (including the 1900 leap-year bug), criteria strings, floating point display.
  Verified against a corpus of real `.xlsx` files with Excel-computed values.
- **Heavy things load lazily.** DuckDB-WASM, file codecs, models and OCR are
  fetched on first use and cached in the Origin Private File System.
- **Local AI is designed for small models.** Deterministic command parsing first;
  the model only fills gaps. Output is grammar-constrained to valid actions, the
  engine executes and checks, and errors loop back. Model size scales with the GPU.

## Milestones

### M1: Spreadsheet core 🔨
- ⬜ `actions` package: action registry, apply/invert, serialisation; port undo onto it
- ⬜ Workbook with multiple sheets (add, rename, reorder, delete, duplicate)
- ⬜ Cross-sheet references (`Sheet2!A1`, `'My Sheet'!A1:B9`)
- ⬜ Dependency graph + incremental recalc (replaces drop-everything invalidation)
- ⬜ Insert / delete rows and columns with reference adjustment
- ⬜ Range-run styles: font, bold/italic/underline, colours, fill, borders, alignment, wrap
- ⬜ Number formats (Excel format codes: general, number, currency, %, date, time, custom)
- ⬜ Merged cells, row heights, hide rows/columns, freeze panes
- ⬜ Fill handle (drag) with series detection (1,2,3 / Mon, Tue / Jan, Feb)
- ⬜ Save / restore workbooks in OPFS; autosave; open/save via File System Access

### M2: Formula engine, complete
- ⬜ Function registry + generated reference
- ⬜ Excel type system and coercion rules; dates as serials
- ⬜ Dynamic arrays and spill (`#SPILL!`), `LET`, `LAMBDA`, `MAP`/`REDUCE`/`SCAN`
- ⬜ Named ranges, structured references to tables
- ⬜ Functions by category: math, statistical, logical, lookup (XLOOKUP, INDEX/MATCH),
  text, date/time, financial, information, engineering, Google Sheets extras (`QUERY`,
  `SPLIT`, `REGEXMATCH`, `ARRAYFORMULA`)
- ⬜ Compiler coverage for the new functions where filled down
- ⬜ Excel conformance corpus in CI

### M3: Files
- ⬜ Streaming `.xlsx` reader (values, formulas, styles, merges, names, multiple sheets);
  streams so large files never load fully into memory
- ⬜ `.xlsx` writer, round-trip tested
- ⬜ Parquet, JSON, ODS; CSV options (delimiter, encoding)

### M4: Data tools
- ⬜ Filters (values, conditions, by colour), multi-column sort, sort by custom list
- ⬜ Find & replace (regex, within formulas), go to special
- ⬜ Conditional formatting (rules, colour scales, data bars, icon sets)
- ⬜ Data validation (lists/dropdowns, numbers, dates, custom)
- ⬜ Tables (structured ranges with headers, banding, totals row)
- ⬜ Remove duplicates, text to columns, flash fill
- ⬜ Comments and notes

### M5: Query engine + Explore
- ⬜ DuckDB-WASM loaded on demand; sheets exposed as Arrow views (zero-copy where possible)
- ⬜ SQL panel; results as linked, re-runnable sheets
- ⬜ Pivot tables (drag fields; sum/count/avg/min/max/distinct; drill-down to rows)
- ⬜ Column profile (type, blanks, distinct, min/max, histogram)
- ⬜ Join two sheets on keys; compare two files (added / removed / changed rows)
- ⬜ Scenarios (cheap copy-on-write sheet copies) and side-by-side compare

### M6: Recipes + history
- ⬜ Recorded step list (subset of actions that make sense on new data)
- ⬜ Edit, reorder, disable steps; parameters
- ⬜ Re-run a recipe on a new file; save recipes with the workbook
- ⬜ Version timeline (scrub through history), per-cell provenance, "explain this cell"

### M7: Charts + reports
- ⬜ Charts: column, bar, line, area, pie/donut, scatter, combo, histogram,
  box plot, waterfall; downsampled rendering for millions of points
- ⬜ Pivot charts, sparklines
- ⬜ Report mode: narrative blocks + live tables and charts; print and PDF export

### M8: Local AI
- ⬜ kiln: decoder-only LLM support (small instruction/coder models, int4), KV cache,
  sampling, grammar-constrained decoding
- ⬜ Model manager: hardware detection, tiered model choice, OPFS cache, download progress
- ⬜ Deterministic command parser for common phrasings (no model needed)
- ⬜ Tool loop: context builder (schema, profiles, samples, function docs) → constrained
  action generation → execute → verify → retry
- ⬜ Ask, Explain, Clean, Insights panels; voice input (Whisper on kiln)
- ⬜ Audit engine: deterministic rules + AI explanations + one-click fixes
- ⬜ Embeddings model: fuzzy dedupe, semantic search, categorisation
- ⬜ Tables from PDFs and images (local OCR / table model)
- ⬜ Eval harness: accuracy and time-to-answer on a fixed task set, published honestly

### M9: Docs + launch
- ⬜ `apps/docs`: getting started, guides, function reference (generated), AI cookbook,
  keyboard shortcuts, Excel migration guide
- ⬜ Landing page rewrite around the vision; installable, offline-capable
- ⬜ Accessibility pass; locale formats and argument separators

## Quality bars (every milestone)

- Excel-compatible behaviour, proven by tests against Excel's own results
- The base app stays small: heavy features are lazy chunks with size budgets
- 100M-row demo stays smooth (scroll, sort, filter, recalc of visible cells)
- No network requests except fetching the app's own static files and models
