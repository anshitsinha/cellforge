# Moving from Excel

cellforge looks and works like the spreadsheet you know: cells, formulas,
sheets, fill down, copy and paste, the same function names. This page is
about the differences, so you know what to expect in your first week.

## What's the same

- **Formulas.** `=SUMIFS(…)`, `=XLOOKUP(…)`, `$A$1` anchors, references to
  other sheets like `=Sales!B4` or `='Bank rec'!B4`, and about 170 of the
  Excel functions people use, with the same arguments and the same
  results. The [function reference](#/reference/functions) lists them;
  each one's examples are checked by the test suite.
- **Dynamic arrays.** `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE` and the rest
  spill into the cells below, `#SPILL!` shows when something is in the
  way, and `E2#` means the whole spilled block. See
  [formulas](#/guide/03-formulas).
- **Tables and names.** **Ctrl+T** makes a table, `Table1[Amount]` and
  `[@Amount]` work, and tables grow when you type below them. **Ctrl+F3**
  opens names and tables.
- **Most shortcuts.** Ctrl+C / X / V, Ctrl+Z / Y, Ctrl+D, Ctrl+B / I / U,
  Ctrl+F, Ctrl+H, Ctrl+Shift+L for filter buttons, Ctrl+9 / Ctrl+0 to
  hide, Ctrl+Shift+4 / 5 / 1 for currency, percent and number formats.
  The full list is on the [shortcuts page](#/guide/05-shortcuts).
- **Excel files.** Open `.xlsx` and `.xlsm`, and **Export Excel (.xlsx)**
  writes a file Excel opens, formulas included. [What comes
  across](#/guide/13-excel-files).
- **Conditional formatting, data validation, filters, sorting, freeze
  panes, merged cells, number formats.** All there. Conditional formatting
  and data validation rules also travel in `.xlsx` files, both ways.

## What's different

### Your data stays on your computer

cellforge runs in the browser, but nothing is uploaded: there's no server
and no account. Files are read on your machine, and your work is saved as
you go in the browser's private storage. **Ctrl+S** writes a `.cellforge`
file with every sheet, formula, format and version inside, for sending or
archiving. See [privacy](#/guide/06-privacy) and [getting
started](#/guide/01-getting-started).

### Actions and history instead of macros

There is no VBA, and a cellforge workbook never runs code when you open
it. Instead:

- **Every change is an action**, recorded in order with its time. Open
  **Show history and versions** (**Ctrl+Shift+H**) and click any step to
  go back to just after it.
- **Versions** keep the whole workbook as it was ("sent to auditor"), and
  **Compare** lists every cell that changed since, even after a sort.
- **The command palette** (**Ctrl+K**) lists every command and every
  action, so the jobs people write macros for (clean an export, map a
  trial balance, reconcile two sheets, combine a folder of files, run the
  audit tests) are a command away. Each one is a single step you can undo.

Recipes, which re-run your recorded steps on next month's files, are
planned; see the [progress page](#/progress).

### Big data

Excel stops at 1,048,576 rows. cellforge opens CSV and Parquet files with
tens of millions of rows, scrolls 100 million rows smoothly, fills a
formula down millions of rows at once and sorts them in seconds. Try the
**Try the sample: 100M-line ledger** command (Help > Sample data). See [big data](#/guide/04-big-data).

`.xlsx` files still hold at most 1,048,576 rows a sheet, so save big
workbooks as `.cellforge`.

### Built for checking

Some things Excel leaves to you are built in:

- **Ctrl+[** (**Inspect this cell**) shows where a number comes from:
  precedents, dependents and the formula worked out step by step.
- A lookup that misses because of a stray space or a number stored as
  text tells you so, instead of a bare `#N/A`.
- Messy exports, trial balances, bank statement PDFs, reconciliations and
  audit tests each have their own command. The
  [tutorials](#/tutorial/01-monthly-close) walk through them.

### Pivot tables and Power Query

- **Pivot table…** builds a pivot table from a sheet: drag fields to rows,
  columns, values and filters, and drill down to the rows behind any number.
  **Pivot (rows to columns)…** and **Unpivot (columns to rows)…** reshape data.
- Instead of Power Query: **Clean up this sheet (messy export)…**,
  **Combine all files in a folder…** and **Text to columns…**. **Join two
  sheets…** merges two tables on a key (after checking the keys match), and
  XLOOKUP still works a column at a time.

## Keys that differ

| Keys | In cellforge | In Excel |
| --- | --- | --- |
| Ctrl+K | Command palette: search every command | Insert hyperlink |
| Ctrl+Shift+H | History and versions panel | (nothing) |
| Ctrl+[ | Inspect the selected cell | Go to the cells this formula uses |
| Ctrl+\ | Clear formatting | Select row differences |
| Ctrl+S | Save a `.cellforge` file; use **Export Excel (.xlsx)** for Excel | Save in the file's own format |
| Ctrl+Alt+= / Ctrl+Alt+− | Insert / delete rows (Ctrl++ and Ctrl+− work too) | Ctrl++ / Ctrl+− |
| Alt, then letters | Not used: there's no ribbon. Press Ctrl+K and type the command instead | Ribbon key tips |

On a Mac, use **Cmd** where this page says **Ctrl**.

## Not there yet

- Charts, pivot tables, macros and comments in `.xlsx` files aren't
  carried over when you open them. See [Excel files](#/guide/13-excel-files).
- Notes on cells and hyperlinks are being built.

Everything planned, and what's being built now, is on the
[progress page](#/progress).
