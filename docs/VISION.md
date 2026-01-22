# Vision

**cellforge is the private data workbench for analysts: a complete spreadsheet
that runs entirely on your own computer, handles data of any size, and proves
every number.**

> Open anything. Prove everything. Upload nothing.

## Who it's for

People who handle **large, sensitive, recurring data** and have to **defend their
numbers**:

- **finance and accounting:** month-end close, reconciliations, variance analysis
- **internal and external audit:** journal entry testing, sampling, duplicate payments
- **operations and procurement:** messy ERP exports, vendor data, inventory counts
- **compliance, risk and fraud:** red-flag tests on data that may not leave the building
- **healthcare, government and research admins:** big, regulated datasets

They share four problems that no single tool solves:

1. **Messy exports.** ERP, bank and CRM dumps that are huge, with title rows,
   subtotals, page footers and five date formats.
2. **Repetition.** The same cleanup, checks and report every week or month.
3. **Matching.** Does system A agree with system B? (bank vs ledger, invoices
   vs payments, counts vs book)
4. **Defensibility and privacy.** Numbers must be provable to a reviewer or
   regulator, and the data legally can't go to a cloud tool or a chatbot.

Today they juggle Excel (row limit, fragile), Power Query (hidden), expensive
audit software (IDEA, ACL/Diligent), and "the colleague who knows Python".
cellforge replaces that stack with one tool they already know how to use.

## Three hero workflows

These define the product. Demos, docs and the landing page are built around them.

1. **Monthly close:** drop the folder of exports → the recipe cleans and appends
   them → checks go green → the report pack is exported. Next month: drop, re-run.
2. **Reconciliation:** bank vs ledger in two minutes. Matched, unmatched and
   mismatched items, exceptions listed, evidence saved.
3. **Audit in a box:** duplicates, sequence gaps, Benford, journal entry tests,
   sampling and an evidence pack, on 50M rows, offline.

## Principles

1. **Local only.** One PC, one browser tab. No servers, no accounts, no uploads,
   no telemetry. The AI runs on the user's GPU. Works offline, including on
   air-gapped machines.
2. **Familiar first.** Anyone who knows Excel is productive in the first minute:
   same formulas, same shortcuts, `.xlsx` in and out.
3. **No limits.** Size is never the reason something doesn't work.
4. **Everything is an action.** Every change, whether typed, clicked, replayed
   or suggested by the AI, is a typed, undoable, recordable action. That gives
   undo, recipes, provenance, audit trails and the AI's tool interface.
5. **The AI plans, the engine computes.** The model turns intent into formulas,
   queries and actions; the engine executes them exactly on all the data.
6. **Show the work.** Any number can be explained and re-derived: formula chain,
   recipe step, input file fingerprint, and the rows behind it.
7. **No bloat.** Heavy parts load only when first used. The base app opens instantly.

## What makes it different

| | Excel / Sheets | Audit software | Chatbot + Python | cellforge |
| --- | --- | --- | --- | --- |
| Data size | 1M rows / 10M cells | large | any, with code | 100M+ rows, no code |
| Data leaves the PC | Sheets: yes | no | yes | never |
| Familiar to Excel users | yes | no | no | yes |
| Reconciliation | manual VLOOKUPs | partial | write code | built in |
| Audit tests | manual | yes | write code | built in |
| Repeatable | Power Query, hidden | scripts | notebooks | recipes, visible |
| Provable to a reviewer | no | partial | the chat log | evidence packs |
| Natural language | cloud | no | yes, cloud | yes, local |
| Price | subscription | thousands per seat | subscription | free |

## Feature map

### Complete spreadsheet
Everything Excel and Google Sheets users rely on: multiple sheets, ~500
functions including dynamic arrays and `LAMBDA`, formatting and conditional
formatting, validation, filters and filter views, tables, pivots, charts,
what-if tools, freeze/split, comments, named ranges, print, and `.xlsx`
round-trip. Accountant-friendly number formats (thousands/millions, negatives in
red parentheses) are built in.

### Messy-export import
- Report un-wrapping: find the real header row, drop title/subtotal/footer
  rows, fill down blank group labels, flatten multi-row headers
- Folder import: append many files, aligning renamed or reordered columns
- Accounting negatives `(1,234)`, locale numbers `1.234,56`, any date format,
  currency symbols, fixed-width text, mixed encodings
- Reshape: unpivot / pivot, split / merge columns, extract with patterns
- Type confidence: "17 rows in Date aren't dates", with jump-to
- Big-file utilities: preview-while-loading, split, sample, convert CSV → Parquet

### Reconciliation and matching
- Two-table reconciliation with keys, tolerances (amount, date window), fuzzy
  text, one-to-many and many-to-one; matched / unmatched / mismatched outputs
- Join doctor: match rate, duplicate keys and orphans before any lookup
- Key-based file compare: added, removed and changed rows between versions
- Intercompany reconciliation across entities and currencies
- Entity resolution: one vendor/customer under many spellings across sources
- Mapping tables (old → new chart of accounts, categories) reused across recipes
- Search across a folder: "find invoice 48213 in every 2025 export"

### Audit and fraud analytics
- Duplicates: payments (same vendor and amount within N days), invoices, near-duplicates
- Sequence gaps and duplicates in invoice, cheque and PO numbers
- Benford's law (first digit, first two digits) with significance and a chart
- Journal entry testing: unbalanced entries, manual or unusual users, keywords
  ("reverse", "adjust"), back-dated, weekend/holiday, round amounts, entries just
  below approval limits, period-end cut-off
- Red-flag overlaps: vendor vs employee (same bank account, address, phone),
  ghost employees, payments after termination, split purchases under thresholds
- Stratification by value bands, top-N, Pareto (80/20)
- Ageing buckets for receivables and payables
- Sampling: random, systematic, stratified, monetary-unit; seed recorded
- Materiality calculator; footing and cross-footing checks (row totals vs column totals)
- Roll-forward checks: opening + movements = closing

### Data checks
- Rules on columns: ranges, uniqueness, required, allowed values, "exists in
  master list", date within period, debits = credits
- Checks run on every refresh; green/red checklist with jump-to-failures
- Period close checklist that gates report export

### Privacy and security
- PII scanner: emails, phones, cards (Luhn-validated), national IDs, IBANs, names
- Mask, hash (joins still work) or redact; export an anonymised copy
- Safe-share check before export: hidden sheets/rows, PII, external links, comments
- Password-encrypted workbooks (AES-GCM via WebCrypto) and an app lock
- "Clear all local data" in one click; offline bundle for air-gapped machines

### Defensibility and review
- Evidence pack: workbook + recipe + input file fingerprints + action log, re-runnable
  by a reviewer to the same numbers
- Tamper-evident history: each step's hash chains to the previous one
- Review marks: tick marks, reviewed-by on cells and ranges, review notes
- Workpaper references: cross-reference codes (A-1, B-2) linking cells and sheets
- Period snapshots: lock a period's numbers and compare against them later
- "What changed since last review": a workbook diff
- Lineage view: sources → recipe steps → sheets → report, as a diagram
- Auto-documentation: sheets, sources, steps, checks and assumptions as a write-up

### Recurring reporting
- Parameterised recipes (period, entity, threshold), re-run on new files
- Watch a folder: new files are processed when the folder is reopened
- Report packs: the same formatted workbook or PDF each period
- Fiscal calendars (custom year start, 4-4-5), MoM / YoY, rolling windows, resampling
- Budget vs actual with variance bridges (waterfall)
- Multi-currency conversion from a dated rate table
- Simple cash-flow and trend forecasts with seasonality
- Template gallery: bank rec, AR/AP ageing, expense audit, payroll checks,
  budget vs actual, inventory count rec, intercompany rec, duplicate payments,
  journal entry testing

### Explore and analysis
- Instant group-by and pivot on 100M rows; drill into the rows behind any number
- Column profiles: type, blanks, distinct, min/max, histogram, top values
- Scenarios: copy-on-write what-if sheets compared side by side
- SQL panel for power users; results as linked, re-runnable sheets

### Workspace
- Projects ("engagements"): a folder of source files, workbooks, recipes and evidence
- Command palette (Ctrl+K) for every action, which is also the AI's entry point
- Report mode: narrative + live tables and charts, PDF and self-contained HTML export
- Niche charts: waterfall/bridge, ageing, Benford, Pareto, stratification

### Local AI
Runs on [kiln](https://github.com/anshitsinha/kiln), our WebGPU inference engine.
Output is constrained to valid actions; the engine executes and checks.
- **Ask:** answers come with the formula or query behind them
- **Do:** "reconcile these two sheets", "flag invoices paid twice", carried out as
  reviewable, replayable steps
- **Audit assistant:** explains findings and suggests the next test
- **Variance commentary:** drafts the management narrative from the numbers
- **Explain** any cell; **clean** dates, names and categories; fuzzy dedupe
- **Insights:** anomalies, trends, "what drove this change?"
- Voice input (Whisper); tables from PDFs and screenshots; semantic search
- Because nothing leaves the PC, this is the AI these users are allowed to use

## Non-goals

- Servers, accounts, cloud sync, telemetry
- Real-time multi-user collaboration
- VBA / macros (recipes and `LAMBDA` cover the real needs, safely)
- A desktop install (the browser is the platform)
