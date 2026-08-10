# The ask bar: say what you want

Press **Ctrl+/** and type what you want done, in plain English: "sort by
amount descending", "freeze top row", "highlight amounts over 10000 in red".

Before anything changes, the ask bar says what it will do, in words: which
column, which rows, what happens to the header. Press **Do it** (or Enter) to
run it, or **Cancel** (or Esc). Everything it does is a normal step: Ctrl+Z
undoes it, and it shows up in the history and in recipes.

It runs on your computer and needs no AI model: it knows a set of common
phrasings, listed below. When it doesn't understand, it says so, shows what
you can type, and suggests the closest commands from the command palette.

## Naming columns

Use the header text or the column letter:

- "sort by **amount**", "sort by **column C**", "sort by **C**"
- Case, spaces and underscores don't matter: "customer name",
  "Customer_Name" and "CustomerName" are the same column.
- Plurals and small typos are fine: "amounts", "amont", "regoin".
- Part of a name works when only one column fits: "invoice" finds
  "Invoice Number". "no", "num" and "#" mean "number".

If a name fits two columns, it asks which one. If it fits none, it says so
and suggests the closest names.

You can also name cells: "B2:B20", "row 3", "rows 5 to 8", "the header row",
"columns D to F", or "the selection".

A whole column means the cells under the header, so "format C as currency"
leaves the header text alone. Bold, italic and colours apply to the whole
column, header included.

To work on another sheet, end with "on sheet Bank" or "in the Bank sheet".

## What you can type

**Sort**

- sort by amount descending
- sort by region then date
- sort by region, then by amount largest first
- sort descending by date / sort amount z to a

If the first row is a header, it stays on top.

**Filter**

- filter region is North
- filter region is North or South
- filter amount > 1000 / filter amount over 1,000 / filter amount is at least 500
- filter amount between 100 and 500
- filter notes contains urgent / filter customer starts with Ac
- filter date after 2024-01-31 (dates as year-month-day)
- show only rows where status is not Closed
- show blanks in category / hide blanks in category
- clear filter / remove the filter on region

Numbers can be written as 1000, 1,000, 1k, $1,000 or 1.5m.

**Summaries**

- sum of amount by region / average amount by category / count by status

These open the pivot table tool and tell you what to put in Rows and Values.

**Formatting**

- make column B bold / bold the header row / make B2:B20 italic
- underline row 3 / center column F
- make amount red / fill the header row yellow
- format C as currency, percent, date, long date, time, number, whole
  numbers, text or general
- clear formatting in column G

**Highlights** (conditional formatting, so they update as values change)

- find duplicates in invoice number / highlight duplicate invoice numbers
- highlight amounts over 10000 in red
- highlight amount below 0 in yellow / highlight negative amounts
- highlight top 10 amounts in green
- highlight notes containing urgent
- highlight amounts between 10 and 20

Colours: red, green, yellow, orange, blue, purple, pink, grey.

**Dropdowns**

- add a dropdown in E2:E100 with Open, Closed
- add a dropdown to status with Open, Closed and Pending

**Rows, columns and the view**

- freeze top row / freeze first column / freeze the first 2 rows
- freeze panes at C3 / unfreeze
- hide column D / hide columns D to F / hide the notes column
- unhide column D / unhide all columns / hide rows 5 to 8
- insert 3 rows above row 10 / insert a row below row 4
- add 2 columns after amount / insert a column before C
- delete rows 5 to 8 / delete rows 3, 5 and 9 / delete the notes column

**Sheets**

- rename sheet to Bank / rename sheet Sheet2 to Bank

**Other**

- fill down (copies the top row of the selection into the rows below it)
- fill down to row 100
- undo / redo

## When it asks a question

It asks instead of guessing when something is missing or unclear: "sort by
banana" (no such column), "add a dropdown in E2:E100" (which choices?),
"delete row 500" (past the end of the sheet), "rename sheet to Bank" when a
sheet is already called Bank. Change what you typed and it updates as you go.

When it used the selection or a close spelling, it says it isn't completely
sure, so check the description before pressing Do it.

## Later: a local model

A small AI model that runs on your computer will be able to take over
requests the ask bar doesn't know. It will choose from the same actions, each
one checked before it runs, and it will be undoable like everything else.
Nothing you type leaves your computer, with or without the model.
