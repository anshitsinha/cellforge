# Moving from IDEA or ACL

If you run data analytics in IDEA or ACL (Galvanize / Diligent
Analytics), most of what you do every day has a direct equivalent in
cellforge. This page maps the common operations to the command you'd use
instead. Every command is in the command palette: press **Ctrl+K** and
type a few letters of its name.

## How the work feels

- **Your source data isn't changed.** As in IDEA and ACL, the tests read
  a sheet and write their result to a new sheet. Your imported data stays
  as it came in, and one **Undo** removes a result.
- **The log is built in.** Every import, test and edit is a step in
  **Show history and versions** (**Ctrl+Shift+H**), with its time. Save a
  named version before and after a piece of work, and **Compare** shows
  every cell that changed in between.
- **Size isn't the limit.** cellforge reads CSV and Parquet files with
  tens of millions of rows on your own computer, and nothing is uploaded.
- **It's also a spreadsheet.** Where IDEA has an equation editor and ACL
  has computed fields, you type a formula in a new column and fill it
  down, with the same functions as Excel.
- **No scripting language.** There's no IDEAScript or ACLScript. Recipes
  that re-run recorded steps on new files are planned; see the
  [progress page](#/progress).

## The operations

| You want to | IDEA | ACL | In cellforge |
| --- | --- | --- | --- |
| Import a file | Import Assistant | Data Definition Wizard, `IMPORT` | **Open…** (Ctrl+O): CSV, text, Excel, JSON, Parquet. See [text files](#/guide/14-other-files) and [Excel files](#/guide/13-excel-files) |
| Import a printed report | Report Reader | `IMPORT PRINT` | **Clean up this sheet (messy export)…**: finds the header, drops titles, subtotals and footers, fills down group labels, turns text into numbers and dates |
| Import a bank statement | Report Reader | `IMPORT PDF` | **Import a bank statement (PDF or CSV)…**: reads text PDFs and checks every running balance |
| Import a trial balance | Import, then field mapping | Import, then `DEFINE FIELD` | **Map this sheet as a trial balance…**: code, name, debit / credit or signed, prior period, with debits = credits checked |
| Append many files | Append Databases | `APPEND` | **Combine several files…** or **Combine all files in a folder…**; columns are lined up by name |
| Extract records (direct extraction) | Direct Extraction | `EXTRACT … IF` | Filter buttons (**Ctrl+Shift+L**) or **Filter this column…**; for a new sheet of matching rows, `=FILTER(A1:E5000, D1:D5000>10000)` |
| Pull text apart | Equation editor, `@Mid` / `@Left` | `SUBSTR`, `REGEXFIND` | **Extract by pattern…** (emails, amounts, dates, invoice codes, your own pattern), **Text to columns…**, or text [functions](#/reference/functions-text) |
| Computed field | Virtual field | `COMPUTED` field | A formula in a new column, filled down with **Fill down** (Ctrl+D) |
| Index or sort | Index, Sort | `INDEX`, `SORT` | **Sort by several columns…**, or Sort A→Z / Z→A on one column |
| Field statistics, totals | Field Statistics | `STATISTICS`, `TOTAL` | Select a column: the status bar shows its sum, average and count |
| Summarise by a key | Summarization | `SUMMARIZE`, `CLASSIFY` | **Pivot table…** *(coming soon)*. Today: **Pareto analysis…** totals per vendor, customer or account; or `UNIQUE` with `SUMIFS` |
| Cross-tabulate | Pivot Table | `CROSSTAB` | **Pivot (rows to columns)…**: row labels, a column to spread across, sum / count / average |
| Stratify | Stratification | `STRATIFY` | **Stratify values into bands…** |
| Age | Aging | `AGE` | **Ageing buckets…** |
| Top items | Top Records Extraction | `SORT` then `EXTRACT` | **Largest items (top N)…** |
| Duplicates | Duplicate Key Detection | `DUPLICATES`, `FUZZYDUP` | **Find duplicates…**: exact, ignoring case and punctuation, similar spelling, numbers or dates within a tolerance |
| Gaps | Gap Detection | `GAPS` | **Find gaps in a sequence…**: also flags numbers used twice and out of order |
| Join two files | Join Databases | `JOIN`, `RELATE` | **Join two sheets…** *(coming soon)*. Today: `XLOOKUP` brings in one column at a time |
| Matched and unmatched records | Compare Databases, Join (unmatched) | `JOIN UNMATCHED` | **Reconcile two sheets…**: matched, unmatched each side, mismatched amounts, keying errors |
| Compare two versions of a file | Compare Databases | `JOIN` and a computed difference | **Compare two versions by key…** *(coming soon)* |
| Sample | Random, Systematic, Stratified Random, Monetary Unit Sampling | `SAMPLE` (record, MUS) with `SEED` | **Pick a sample…**: random, systematic, stratified, monetary unit, with a seed |
| Benford | Benford's Law | `BENFORD` | **Benford's law test…**: first or first two digits, MAD, chi-square, z per digit |
| Journal entry testing | JET / SmartAnalyzer tests | Journal entry scripts | **Journal entry tests…**: eleven tests scored together |
| Vendor against employee master | Join and fuzzy match | `FUZZYJOIN` | **Red-flag overlaps (vendor vs employee)…** |
| Foot a schedule | Field Statistics | `TOTAL` | **Foot and cross-foot this range…** |
| Export results | Export Database | `EXPORT` | **Export Excel (.xlsx)** or **Export CSV**; **Save** (Ctrl+S) keeps everything, history included, in one `.cellforge` file |
| History, audit trail | History, project log | Command log | **Show history and versions** (Ctrl+Shift+H); **Save a version…** |

## Things to know

- **Seeds.** **Pick a sample…** suggests a seed; the seed, method and
  interval are written in the **Method** column of the sample sheet.
  Typing the same seed on the same data picks the same items, the same
  as `SEED` in ACL.
- **Fuzzy duplicates.** Similar spelling uses Jaro-Winkler. 90% is a good
  start for names. To find a vendor keyed twice, test the list of
  distinct vendors (make it with **Remove duplicates…**), not every
  invoice: see the [audit tests tutorial](#/tutorial/03-audit-tests).
- **Row numbers.** Every result sheet has the row number in the source
  sheet, so you can go from a finding back to the record.
- **Dates and amounts as text.** Exports full of `(1,234.50)`, `1.234,56`
  or `31/01/2024` are read as numbers and dates by **Clean up this sheet
  (messy export)…** and by **Combine several files…**.

## Where to go next

- [Audit test catalogue](#/guide/audit-test-catalogue): every test, what
  it finds and its settings
- [Tutorial: audit tests](#/tutorial/03-audit-tests), step by step on
  sample data
- [Tutorial: bank reconciliation](#/tutorial/02-bank-reconciliation)
