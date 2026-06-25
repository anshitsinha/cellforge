# Plan

How we get from today's fast single-sheet grid to [the vision](VISION.md).
Each milestone ships on its own and leaves the app better than it found it.
The order puts the foundation first, then the niche-defining features
(messy import, reconciliation, checks, audit) as early as their dependencies
allow, and the AI last, on top of actions that already work without it.

Status: ✅ done · 🔨 in progress · ⬜ not started

Feature priorities are grounded in [USER-RESEARCH.md](USER-RESEARCH.md). The
plan was reviewed for bloat: anything that doesn't serve the niche was cut or
moved to "Later" (see the end of this file).

## Architecture targets

```
┌──────────────────────────────────────────────────────────────────────┐
│ apps/web      app shell, panels (recipes, checks, reconcile, audit,  │
│               explore, AI, review), command palette                  │
│ apps/docs     documentation · apps/tracker  live build tracker       │
├──────────────────────────────────────────────────────────────────────┤
│ actions       typed actions: apply / invert / serialise / describe   │
│               ← used by UI, undo, recipes, provenance, AI tools      │
├──────────────────────────────────────────────────────────────────────┤
│ workbook      sheets, styles, merges, names, tables, validation,     │
│               dependency graph + recalc scheduler                    │
├───────────────┬──────────────────┬───────────────────┬───────────────┤
│ core          │ formula          │ query (lazy)      │ files (lazy)  │
│ columnar data │ parser, function │ DuckDB-WASM over  │ xlsx, csv,    │
│ edit overlay  │ registry, Excel  │ Arrow views of    │ parquet, json │
│ sort, fills   │ semantics, spill │ sheet columns     │ pdf statements│
├───────────────┴──────────────────┴───────────────────┴───────────────┤
│ analytics     reconcile, match, audit tests, sampling, checks, PII   │
├──────────────────────────────────────────────────────────────────────┤
│ grid          canvas renderer: styles, merges, freeze, spill, marks  │
├──────────────────────────────────────────────────────────────────────┤
│ ai (lazy)     kiln runtime, model manager, constrained decoding,     │
│               tool loop over actions                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Key decisions

- **Actions are the backbone.** `Action = { type, params }` with a JSON schema
  per type; `apply(workbook) → inverse`. Undo, recipes, provenance, the evidence
  log and the AI's tools are all the same objects.
- **Columnar stays columnar.** Styles, validation, conditional formats and
  review marks are stored as range runs, never per cell.
- **Dependency graph over ranges, not cells.** A filled-down column is one node;
  recalc evaluates only what's visible or depended on.
- **One function registry** drives the evaluator, compiler, docs, autocomplete
  and AI context. Every documented example is a test.
- **Excel semantics are the spec**, verified against real `.xlsx` files with
  Excel-computed values.
- **Analytics are actions too.** "Reconcile", "find duplicate payments" or
  "Benford test" produce new sheets through actions, so they're undoable,
  recordable into recipes and callable by the AI.
- **Heavy things load lazily** (query engine, codecs, models) and are cached in
  the Origin Private File System.
- **Local AI is designed for small models:** deterministic parsing first,
  grammar-constrained output, execute-verify-retry.
- **Evidence is cryptographic:** SHA-256 fingerprints of inputs and a hash chain
  over the action log, via WebCrypto.

## Now

The item being built right now, broken into the steps it takes. The live
tracker shows this expanded, with the first unticked step as the current one.

### Recipe panel: recorded steps, edit / reorder / disable, parameters,
- [x] Recipe model: the recordable actions a session ran, as steps with parameters; sheet and range references made relative to the recipe's inputs
- [ ] Recipe panel: list of steps, edit a step's parameters, reorder, disable, delete; save / load recipes with the workbook
- [ ] Live preview at every step (the workbook as it was after step N) with per-step time and memory
- [x] Run a recipe on the current workbook as one undo step; clear errors naming the step that failed
- [ ] Tests, user guide

## Milestones

### M1: Spreadsheet core ✅
- ✅ `actions` package: registry, schemas, apply/invert, history, blob store
- ✅ Port edits, paste, clear, fill and sort onto actions
- ✅ Fix: formulas keep same-row references after sorting (Excel semantics)
- ✅ Docs site with user guide, developer guide and a live build tracker
- ✅ Workbook with multiple sheets (add, rename, delete, duplicate, reorder, colour, hide) and sheet search
- ✅ Cross-sheet references (`Sheet2!A1`, `'My Sheet'!A1:B9`)
- ✅ Dependency graph + incremental recalc
- ✅ Insert / delete / hide rows and columns with reference adjustment
- ✅ Range-run styles: font, size, bold/italic/underline/strike, colours, fill,
  borders, alignment, wrap; format painter
- ✅ Number formats incl. custom codes and accounting styles (K/M, red parentheses)
- ✅ Merge cells and Center Across Selection; row heights, auto-fit, freeze panes
- ✅ Fill handle with series detection; default paste mode setting
- ✅ Command palette (Ctrl+K) listing every public action
- ✅ Crash-proof saving: action journal in OPFS, autosave, open/save via File System Access
- ✅ History panel: timeline, named versions, compare any two points, per-cell history
- ✅ Instant insert/delete on 100M-row sheets (segment row map)

### M2: Formula engine ✅
- ✅ Function registry + generated reference and autocomplete with argument hints
- ✅ Excel type system and coercion; dates as serials (incl. the 1900 bug)
- ✅ The ~150 functions that cover real use: lookup (XLOOKUP, INDEX/MATCH),
  maths, statistics, text, dates, financial, logic, information
- ✅ Dynamic arrays and spill, `LET`, `LAMBDA`
- ✅ Named ranges; tables with structured references that grow with new rows
- ✅ Lookups that warn about type and whitespace mismatches instead of a silent `#N/A`
- ✅ Formula auditing: trace precedents/dependents, step-by-step evaluation,
  precise broken-reference locator, hard-coded-number lint
- ✅ Iterative calculation for intentional circular references
- ✅ Compiler coverage for the new functions; Excel conformance corpus in CI

### M3: Files and messy-export import ✅
- ✅ Streaming `.xlsx` reader and writer (values, formulas, styles, merges,
  names, multiple sheets), round-trip tested
- ✅ Parquet and JSON; CSV options (delimiter, encoding)
- ✅ Report un-wrapping: header-row detection, drop title/subtotal/footer rows,
  fill down group labels, flatten multi-row headers
- ✅ Folder import with column alignment across files
- ✅ Parsers: accounting negatives, locale numbers, any date format, currencies (with the item above)
- ✅ Type confidence report with jump-to (with the item above)
- ✅ Bank statements: local text-PDF/CSV import, multi-line merge, date repair,
  running-balance validation per page
- ✅ Trial balance import mapper (debit/credit or signed, code/name/current/prior)

### M4: Data tools ✅
- ✅ Filters and filter views, (Blanks) first, invert selection; multi-column sort
- ✅ Find & replace (regex, in formulas)
- ✅ Conditional formatting with a proper rules manager
- ✅ Data validation and dropdowns; date, currency and checkbox column types
- ✅ Remove duplicates, text to columns, unpivot / pivot, extract by pattern
- ✅ Goal Seek
- ✅ Notes on cells, hyperlinks

### M5: Query engine, explore, reconcile 🔨
- ⬜ Query engine (DuckDB-WASM, loaded on demand) over sheet columns
- ✅ Pivot tables (drag fields, drill-down to rows), slicers
- ✅ Column profiles
- ✅ Join doctor (match rate, duplicate keys, orphans) and guided joins
- ✅ "Why don't these match?" inspector with one-click normalisation
- ✅ Reconciliation: keys, tolerances, fuzzy text, 1:N and N:1, matched /
  unmatched / mismatched outputs, exception export
- ✅ Reference normalisation, sum matching, keying-error flags, in-side duplicates
- 🔨 Proposed adjusting entries, roll-forward of outstanding items, rec statement
- 🔨 Open-item matching for balance sheet accounts; supplier / customer statement recs
- ✅ Trial balance compare; GL → TB tie-out
- ✅ Fuzzy name matching incl. name order; mapping tables
- ✅ Key-based file compare
- ⬜ Scenarios (copy-on-write sheets) compared side by side
- ⬜ Acceptance test: synthetic bank/ledger month modelled on real data at 6K and 6M rows

### M6: Recipes and checks 🔨
- 🔨 Recipe panel: recorded steps, edit / reorder / disable, parameters,
  live preview at every step, per-step time and memory profile
- ⬜ Re-run a recipe on new files or a folder
- ⬜ Templates for the three hero workflows: monthly close, bank rec, audit tests
- ⬜ Data checks: column rules, master-list lookups, debits = credits; green/red
  checklist that gates export
- ⬜ Categorisation rules that learn from manual tagging; bulk tagging; uncategorised queue
- ⬜ Explain: where any number came from (formula chain, recipe step, source rows),
  lineage view, one-click write-up

### M7: Audit, evidence, sharing 🔨
- ✅ Duplicate tests (exact, near, fuzzy, multi-column); sequence gaps
- ✅ Benford (1st and 1st-two digits) with chi-square / MAD and chart
- ✅ Journal entry testing suite; red-flag overlaps (vendor vs employee etc.)
- ✅ Stratification, top-N, Pareto, ageing buckets, materiality
- ✅ Sampling (random, systematic, stratified, monetary-unit) with recorded seed
- ✅ Footing / cross-footing and roll-forward checks
- ⬜ Evidence pack: workbook + recipe + input fingerprints + hash-chained action log
- ⬜ Evidence linking: attached documents stored outside the workbook, cell ↔
  document-region links, validation that compares values
- ⬜ Review mode: tick marks with legend, reviewed-by, notes that block sign-off,
  workpaper references
- ✅ Share safely: PII scan, mask / hash / pseudonymise / redact into a safe copy
- ⬜ Hidden-content check, encrypted export; clear all local data; offline bundle

### M8: Charts and reports 🔨
- ✅ Charts: column, bar, line, area, pie, scatter, combo, histogram, waterfall,
  Pareto, Benford, ageing; millions of points downsampled; axis limits from cells
- ⬜ Pivot charts
- ⬜ Reports: narrative + live tables and charts, one template for many entities,
  consolidation, period roll-forward, PDF report books with contents
- 🔨 Time tools: fiscal years, MoM/YoY, rolling windows, budget vs actual, multi-currency
- 🔨 Accrual / prepayment / deferred income schedules; accounting import export templates

### M9: Local AI
- ⬜ kiln: small decoder LLMs (int4), KV cache, grammar-constrained decoding
- ⬜ Model manager: hardware detection, tiered models, OPFS cache, offline use
- ⬜ Deterministic command parser for common phrasings
- ⬜ Tool loop over the action catalog: context → constrained action → execute → verify → retry
- ⬜ Ask, Do, Explain, Clean; audit assistant; category suggestions
- ⬜ Internal eval harness for accuracy and time-to-answer

### M10: Docs and launch 🔨
- 🔨 Docs: the three hero workflows as tutorials, generated function reference,
  audit test catalogue, "moving from Excel" and "moving from IDEA/ACL" guides
- ⬜ Ask the docs with the local model
- ⬜ Landing page around the niche; installable and offline
- ⬜ Accessibility pass; locale number formats and separators

## Later (only if users ask)

Deferred on purpose, to keep the product focused. Each needs real demand first.

- The long tail of functions (engineering, cube, rarely used statistics)
- Sparklines, Flash Fill, data tables, subtotals tool, forecasts
- Semantic search; OCR of scanned PDFs and screenshots
- Watch-a-folder automation; intercompany reconciliation; 4-4-5 calendars
- Performance doctor for imported `.xlsx`; filter by colour; custom sort lists; date picker
- SQL editor panel; a wider template gallery; a public AI benchmark
- Translated interface

## Cut

Removed after review as bloat for this audience: voice input, a `NULL()`
function (breaks Excel compatibility), eyedropper, vertical tabs and tab
groups, images in cells, data-entry forms, Airtable-style column types, Excel's
Consolidate and Scenario Manager (replaced by our own tools), app lock,
client request-list tracker, translation model, AI-written variance
commentary, HTML report export, Alt-key ribbon emulation, strict currency
column blocking (now a warning in data checks), GPU research items.

## Quality bars (every milestone)

- Excel-compatible behaviour, proven by tests against Excel's own results
- Audit tests validated against published examples and hand-checked datasets
- The base app stays small: heavy features are lazy chunks with size budgets
- 100M-row demo stays smooth (scroll, sort, filter, recalc of visible cells)
- No network requests except fetching the app's own static files and models
