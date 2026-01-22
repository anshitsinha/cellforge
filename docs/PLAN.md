# Plan

How we get from today's fast single-sheet grid to [the vision](VISION.md).
Each milestone ships on its own and leaves the app better than it found it.
The order puts the foundation first, then the niche-defining features
(messy import, reconciliation, checks, audit) as early as their dependencies
allow, and the AI last, on top of actions that already work without it.

Status: ✅ done · 🔨 in progress · ⬜ not started

Feature priorities are grounded in [USER-RESEARCH.md](USER-RESEARCH.md).

## Architecture targets

```
┌──────────────────────────────────────────────────────────────────────┐
│ apps/web      app shell, panels (recipes, checks, reconcile, audit,  │
│               explore, AI, review), command palette                  │
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
│ analytics     reconcile, match, audit tests, sampling, checks, PII   │
├──────────────────────────────────────────────────────────────────────┤
│ grid          canvas renderer: styles, merges, freeze, spill, marks  │
├──────────────────────────────────────────────────────────────────────┤
│ ai (lazy)     kiln runtime, model manager, constrained decoding,     │
│               tool loop over actions, embeddings, Whisper, OCR       │
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
- **Heavy things load lazily** (query engine, codecs, models, OCR) and are
  cached in the Origin Private File System.
- **Local AI is designed for small models:** deterministic parsing first,
  grammar-constrained output, execute-verify-retry.
- **Evidence is cryptographic:** SHA-256 fingerprints of inputs and a hash chain
  over the action log, via WebCrypto.

## Milestones

### M1: Spreadsheet core 🔨
- ✅ `actions` package: registry, schemas, apply/invert, history, blob store
- 🔨 Port edits, paste, clear, fill and sort onto actions
- ⬜ Fix: formulas keep same-row references after sorting (Excel semantics)
- ⬜ Workbook with multiple sheets (add, rename, reorder, colour, hide, duplicate, delete)
- ⬜ Cross-sheet references (`Sheet2!A1`, `'My Sheet'!A1:B9`)
- ⬜ Dependency graph + incremental recalc
- ⬜ Insert / delete / hide rows and columns with reference adjustment
- ⬜ Range-run styles: font, size, bold/italic/underline/strike, colours, fill,
  borders, alignment, indent, rotation, wrap
- ⬜ Number formats incl. custom codes and accounting styles (K/M, red parentheses)
- ⬜ Merged cells, row heights, auto-fit, freeze panes, split view, zoom
- ⬜ Fill handle with series detection; format painter
- ⬜ Command palette (Ctrl+K) listing every public action; Alt-key key tips
- ⬜ Instant structural edits at any size (insert a row in a huge model < 50 ms)
- ⬜ Cell history ("blame") and input-vs-formula highlighting
- ⬜ Save / restore in OPFS, autosave, open/save via File System Access

### M2: Formula engine, complete
- ⬜ Function registry + generated reference and autocomplete with argument hints
- ⬜ Excel type system and coercion; dates as serials (incl. the 1900 bug)
- ⬜ Dynamic arrays and spill, `LET`, `LAMBDA`, `MAP`/`REDUCE`/`SCAN`/`BYROW`
- ⬜ Named ranges, tables with structured references
- ⬜ All categories: math, statistical, logical, lookup, text, date/time,
  financial, information, engineering, database; Sheets extras (`QUERY`,
  `SPLIT`, `REGEX*`, `ARRAYFORMULA`, `FLATTEN`)
- ⬜ Formula auditing: trace precedents/dependents, evaluate step by step,
  watch window, error checking, lint for hard-coded numbers
- ⬜ Iterative calculation; self-expanding tables; currency-typed columns
- ⬜ Compiler coverage for the new functions; Excel conformance corpus in CI

### M3: Files and messy-export import
- ⬜ Streaming `.xlsx` reader and writer (values, formulas, styles, merges,
  names, multiple sheets), round-trip tested
- ⬜ Parquet, JSON, ODS, fixed-width text; encoding detection
- ⬜ Report un-wrapping: header-row detection, drop title/subtotal/footer rows,
  fill down group labels, flatten multi-row headers
- ⬜ Folder import with column alignment across files
- ⬜ Parsers: accounting negatives, locale numbers, any date format, currencies
- ⬜ Type confidence report with jump-to
- ⬜ Big-file utilities: preview while loading, split, sample, CSV → Parquet
- ⬜ Bank statements: local PDF/CSV import, multi-line merge, date repair,
  running-balance validation per page
- ⬜ Performance doctor for imported `.xlsx`; open, documented native file format

### M4: Data tools
- ⬜ Filters and filter views, multi-column sort, custom lists
- ⬜ Find & replace (regex, in formulas), Go To Special, search across a folder
- ⬜ Conditional formatting (rules, scales, bars, icons, formulas)
- ⬜ Data validation and dropdowns; smart column types (date, currency, email,
  URL, checkbox, rating, select)
- ⬜ Remove duplicates, text to columns, flash fill, unpivot / pivot, extract by pattern
- ⬜ What-if: goal seek, data tables, scenario manager; subtotals, consolidate
- ⬜ Comments, notes, hyperlinks, images in cells, checkboxes

### M5: Query engine, explore, reconcile
- ⬜ DuckDB-WASM on demand; sheets exposed as Arrow views; SQL panel
- ⬜ Pivot tables (drag fields, drill-down to rows), slicers
- ⬜ Column profiles
- ⬜ Join doctor (match rate, duplicate keys, orphans) and guided joins
- ⬜ Reconciliation: keys, tolerances, fuzzy text, 1:N and N:1, matched /
  unmatched / mismatched outputs, exception export
- ⬜ Reference normalisation, sum matching, keying-error flags, in-side duplicates,
  proposed adjusting entries, roll-forward of outstanding items, rec statement
- ⬜ Open-item matching for balance sheet accounts (auto-clear reversals)
- ⬜ Acceptance test: synthetic bank/ledger month modelled on real data (split
  cheques, repeated numbers, split deposits, clearing lag) at 6K and 6M rows
- ⬜ Key-based file compare; intercompany reconciliation
- ⬜ Entity resolution and reusable mapping tables
- ⬜ Scenarios (copy-on-write sheets) and side-by-side compare

### M6: Recipes, checks, history
- ⬜ Recipe panel: recorded steps, edit / reorder / disable, parameters
- ⬜ Re-run on new files; watch a folder; templates gallery
- ⬜ Data checks: column rules, master-list lookups, debits = credits; green/red
  checklist; period close checklist that gates export
- ⬜ Categorisation rules that learn from manual tagging; bulk tagging; uncategorised queue
- ⬜ Incremental refresh (reprocess only changed inputs)
- ⬜ Version timeline, per-cell provenance, "explain this cell", lineage view

### M7: Audit, privacy, evidence
- ⬜ Duplicate and near-duplicate tests; sequence gaps
- ⬜ Benford (1st and 1st-two digits) with chi-square / MAD and chart
- ⬜ Journal entry testing suite; red-flag overlaps (vendor vs employee etc.)
- ⬜ Stratification, top-N, Pareto, ageing buckets, materiality calculator
- ⬜ Sampling (random, systematic, stratified, monetary-unit) with recorded seed
- ⬜ Footing / cross-footing and roll-forward checks
- ⬜ PII scanner; mask / hash / redact; anonymised export; safe-share check
- ⬜ Password-encrypted workbooks, app lock, clear-all-data, offline bundle
- ⬜ Evidence packs, hash-chained history, review marks, workpaper references,
  period snapshots, review diff, auto-documentation
- ⬜ Evidence linking: attached documents stored outside the workbook, cell ↔
  document-region links, local extraction, validation that compares values
- ⬜ Native tick marks with legend; review notes that block sign-off
- ⬜ Reversible pseudonymisation; named versions instead of file copies

### M8: Charts and reports
- ⬜ Charts: column, bar, line, area, pie/donut, scatter, combo, histogram,
  box, waterfall/bridge, Pareto, Benford, ageing; millions of points downsampled
- ⬜ Pivot charts, sparklines
- ⬜ Report mode and report packs: narrative + live tables and charts;
  print setup; PDF and self-contained HTML export
- ⬜ One template, many entities, plus consolidation; automatic period roll-forward;
  report books with contents and page numbers
- ⬜ Accrual / prepayment / deferred income schedules; accounting import export templates
- ⬜ Time tools: fiscal calendars, MoM/YoY, rolling windows, resampling,
  budget vs actual, multi-currency, simple forecasts

### M9: Local AI
- ⬜ kiln: decoder LLM support (small int4 models), KV cache, sampling,
  grammar-constrained decoding
- ⬜ Model manager: hardware detection, tiered models, OPFS cache, offline use
- ⬜ Deterministic command parser for common phrasings
- ⬜ Tool loop over the action catalog: context builder → constrained action →
  execute → verify → retry
- ⬜ Ask, Do, Explain, Clean, Insights; audit assistant; variance commentary
- ⬜ Voice input (Whisper); embeddings for fuzzy matching and semantic search;
  tables from PDFs and images; category suggestions; local translation of narratives
- ⬜ Eval harness: accuracy and time-to-answer on a fixed task set, published

### M10: Docs and launch
- ⬜ `apps/docs`: getting started, the three hero workflows as tutorials,
  function reference (generated), audit test catalogue, AI cookbook,
  shortcuts, "moving from Excel" and "moving from IDEA/ACL" guides
- ⬜ Landing page around the niche and hero workflows; installable, offline
- ⬜ Accessibility; locale formats and separators; translated UI

## Quality bars (every milestone)

- Excel-compatible behaviour, proven by tests against Excel's own results
- Audit tests validated against published examples and hand-checked datasets
- The base app stays small: heavy features are lazy chunks with size budgets
- 100M-row demo stays smooth (scroll, sort, filter, recalc of visible cells)
- No network requests except fetching the app's own static files and models
