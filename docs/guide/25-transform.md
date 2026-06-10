# Reshape and extract

These tools work on the sheet you have open. Each one opens a dialog from
the command palette (Ctrl+K). The dialog shows a preview of the first 10
rows as you change the options, so you can see the result before you
commit to it.

Some tools make a **new sheet** and never change the one you started from:
remove duplicates, unpivot and pivot. Others **write new columns** into the
sheet: text to columns and extract. Goal Seek changes one cell. Every tool
is one **Undo**.

Columns are listed by letter and name. The names come from the column
headers of an imported sheet, or else from the first row of the sheet.

## Remove duplicates

**Remove duplicates…** keeps one row of each set of rows that match.

- Tick the columns to compare. Rows count as duplicates only when all the
  ticked columns match. Tick them all to remove rows that are the same in
  every column.
- **Ignore upper and lower case**: `ACME` and `Acme` match.
- **Ignore extra spaces**: `Acme ` and `Acme` match, and so do `Acme  Ltd`
  and `Acme Ltd`.
- **Which row stays**: the first row of each set (from the top) or the
  last.

A number and the same number typed as text (`100` and `'100`) match, and
blank cells match other blank cells, as in Excel.

The result goes on a new sheet named after yours with *unique* on the end.
The status bar says how many rows were removed. Tick **Also add a sheet
listing the removed rows** to get a second sheet with each removed row,
its row number, and the row number of the row that was kept in its place.

To find near duplicates (similar names, amounts within a tolerance) without
removing anything, use **Find duplicates…** in the
[audit tests](20-audit-tests.md).

## Text to columns

**Text to columns…** splits one column into several. The new columns go
to the right of it; the column itself stays as it is.

Pick the column (the one you're in is picked for you), then how to split:

- **Split at characters**: tick Tab, Comma, Semicolon, Space or Bar, or
  type your own in *other* (it can be more than one character, such as
  ` - `). You can tick several.
- **Treat delimiters in a row as one**: `a,,b` gives two columns, not
  three. Useful for values lined up with spaces.
- **Quotes**: text inside quotes is never split, so `"Smith, John",42`
  gives `Smith, John` and `42`. Two quotes inside quotes stand for one.
- **Cut at fixed character positions**: type the positions to cut after,
  such as `4, 10`. Each piece has its spaces trimmed.

Each new column becomes numbers, dates or text by what most of its values
look like, the same way imports work: `1,200.50`, `(30.00)` and `30 CR`
become numbers, `15/03/2024` becomes a date. A column of codes with leading
zeros (`0042`) stays text so the zeros are kept.

When the first row of the sheet names the columns, the new columns get
names too (`Detail 1`, `Detail 2`…).

With more than one row selected, only those rows are split. Otherwise the
whole column is.

If any cell where the new columns would go already has something in it,
the dialog says how many and the button changes to **Overwrite N cells and
split**. To keep them, cancel, insert empty columns to the right of the
column, and try again. If the sheet needs more columns on the right, they
are added first (that is a separate undo step).

## Unpivot (columns to rows)

**Unpivot…** turns a wide table into a long one. A trial balance with one
column per month becomes one row per account and month:

| Account | Jan | Feb |
| --- | --- | --- |
| Sales | 100 | 120 |

becomes

| Account | Attribute | Value |
| --- | --- | --- |
| Sales | Jan | 100 |
| Sales | Feb | 120 |

For each column, choose **Keep on every row** (labels such as the account),
**Turn into rows** (the month columns) or **Leave out**. The dialog
guesses: columns before the first column of numbers are kept, the rest are
turned into rows. Rename *Attribute* and *Value* to something clearer,
such as *Month* and *Amount*. Blank values are left out unless you untick
**Leave out blank values**.

The result goes on a new sheet. Long tables are easier to filter, sort,
pivot and reconcile.

## Pivot (rows to columns)

**Pivot…** does the opposite: one row per distinct row label, one column
per distinct value of the column you pick.

- **Row labels from**: up to three columns, such as account and cost
  centre.
- **New columns from**: the column whose values become column names, such
  as month.
- **Values from**: the column to put in the cells.
- **Combine values by**: sum, count, average, smallest, largest, or the
  first value. Text that isn't a number is left out of sums and averages,
  and the dialog says how many values that was.

Rows and columns come in the order they first appear. A cell with nothing
in it is blank (or 0 for count). The result goes on a new sheet.

## Extract by pattern

**Extract by pattern…** pulls one piece out of text, such as bank
narratives or memo lines, into a new column to the right of it.

- **Email address**, **Phone number**, **Web address (URL)**.
- **First number**: `1,200` in `Qty 1,200 units`.
- **Amount (money)**: a number with a currency sign or code, decimals, or
  thousands separators, such as `$1,234.50`, `(300.00)`, `GBP 75` or
  `1,000.00 CR`. Brackets and CR make it negative. A bare whole number such
  as a year is not taken as an amount.
- **Date**: `15/03/2024`, `2024-03-15`, `15 Mar 2024`, `March 15, 2024`.
  Whether `03/04/2024` is the 3rd of April or March 4th is decided from all
  the dates in the column.
- **Invoice-like code**: letters followed by digits, such as `INV-2024-001`,
  `PO#12345` or `AB12`.
- **Reference after a keyword**: type the keyword, such as `Ref` or
  `Invoice`. The text right after it is taken, skipping `:`, `#`, `.`,
  `-`, spaces and `No.`. The keyword matches whole words only, so `Ref`
  doesn't match inside `Refund`.
- **Custom pattern**: a regular expression. If it has a capture group in
  brackets, only that part is taken: `Order (\d+)` gives `123` from
  `Order 123-ABC`. Upper and lower case are treated the same.

Numbers, amounts and dates come out as real numbers and dates. Tick **Take
every match** to get all of them, separated by `;` (as text). Tick **Also
add a column saying whether anything was found** to get a TRUE / FALSE
column beside it, handy for filtering the rows where nothing was found.

Like text to columns, it works on the selected rows when more than one is
selected, and warns before overwriting cells that aren't empty.

## Goal Seek

**Goal Seek…** finds the value of one input that makes a formula give the
result you want. For example: what interest rate makes the monthly payment
900?

- **Set cell**: the cell with the formula, such as the payment.
- **To value**: the result you want.
- **By changing cell**: the input cell, such as the rate. It must hold a
  number (or be empty) and the formula must depend on it.

The answer appears in the dialog as you type, with how many steps it took.
The sheet doesn't change while it searches: every try is worked out on a
copy. **Keep this value** writes the answer into the changing cell, as one
undo step.

If there's no exact answer (the formula never reaches the target, or jumps
over it), the dialog says so and shows the closest value it found, which
you can keep or not. Try a different starting value in the changing cell
if the search goes the wrong way.
