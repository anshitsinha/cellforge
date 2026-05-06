# Formulas

Start a cell with `=` to calculate: `=A1*B1`, `=SUM(C:C)`, `=IF(D2>100, "big", "small")`.

## References

| You write | It means |
| --- | --- |
| `A1` | one cell; adjusts when filled down or copied |
| `A1:B9` | a rectangle of cells |
| `C:C` | the whole column C, however many rows |
| `$A$1` | always this cell (`$` locks the column and/or row) |
| `Data!B4` | cell B4 on the sheet called Data |
| `'Bank Jan'!A1:A9` | a range on a sheet whose name has spaces or symbols (in quotes) |
| `Data!C:C` | a whole column on another sheet |

Sheet names in formulas ignore upper and lower case. If you rename a sheet,
formulas that refer to it are updated for you. If you delete it, they show
`#REF!`, and undoing the delete brings their values back.

## Operators

`+ - * / ^` for maths, `&` to join text, and `= <> < > <= >=` to compare.

## Functions

The [function reference](#/guide/functions) lists every function with its
arguments and worked examples: about 150 of the Excel functions people
actually use, from lookups (XLOOKUP, INDEX/MATCH) and conditional totals
(SUMIFS, COUNTIFS) to text, dates, statistics and finance (NPV, XIRR).
Each one gives the same answers as Excel, checked by the test suite.

While you type a formula, cellforge helps:

- after `=` and a few letters it suggests matching functions; use the arrow
  keys and **Tab** (or click) to insert one with its opening bracket;
- inside a function's brackets it shows its arguments, with the one you're
  on in bold and a line on what it expects.

This works in the cell and in the formula bar.

## Formulas that fill several cells (dynamic arrays)

A formula can return a whole block of values. It shows in its own cell and
**spills** into the cells below and to the right, exactly as in current Excel:

| Formula | Spills |
| --- | --- |
| `=A2:A100*1.2` | every amount with 20% added |
| `=UPPER(B2:B100)` | every name in capitals (functions that take one value work cell by cell) |
| `=FILTER(A2:C500, C2:C500>1000)` | only the rows over 1,000 |
| `=SORT(A2:C500, 3, -1)` | the rows sorted by the third column, largest first |
| `=UNIQUE(B2:B500)` | each supplier once |
| `=SEQUENCE(12)` | 1 to 12 |
| `={1,2,3;4,5,6}` | a 2-row, 3-column array written by hand |

Click a spilled cell and the formula bar is empty: the formula lives in the
first cell only. If something is already in the way, the formula shows
**#SPILL!** until you clear those cells. To use the whole spilled block in
another formula, add **#** to its first cell: `=SUM(E2#)`.

Also available: SORTBY, TRANSPOSE, TAKE, DROP, VSTACK, HSTACK, TOCOL, TOROW,
CHOOSECOLS and CHOOSEROWS, and INDEX with a row or column of 0 for a whole
column or row.

## Naming things inside a formula: LET and LAMBDA

**LET** gives names to parts of a long formula, so it reads clearly and
each part is worked out once:

```
=LET(net, B2-C2, rate, net/B2, IF(rate>0.1, "check", "ok"))
```

**LAMBDA** makes your own function. Keep it in a LET name, call it right
away, or hand it to **MAP** (every value), **REDUCE** (fold to one value),
**SCAN** (running results), **BYROW**, **BYCOL** or **MAKEARRAY**:

```
=MAP(B2:B100, C2:C100, LAMBDA(net, vat, net + vat))
=REDUCE(0, D2:D100, LAMBDA(total, x, total + ROUND(x, 2)))
```

## Names and tables

**Names** make formulas readable: `=SUMIF(Region, "North", Amount)` instead of
`=SUMIF(Sales!$A$2:$A$500, "North", Sales!$C$2:$C$500)`.

- Select cells, right-click and choose **Define a name…** (or search for it
  with **Ctrl+K**). A name can also hold a constant, like `VatRate` = `0.2`.
- Names follow their cells when you insert or delete rows and columns or
  rename the sheet. **Names and tables…** (**Ctrl+F3**) lists them all.

**Tables** turn a block with a header row into something formulas can talk
about by column name. Select the block (headers included) and press
**Ctrl+T**, or right-click and choose **Make a table**.

| You write | It means |
| --- | --- |
| `Table1[Amount]` | the whole Amount column (data rows only) |
| `[@Amount]` | the Amount in this row (in a formula inside the table) |
| `Table1[@Amount]` | the same, naming the table |
| `Table1` | all the data rows |
| `Table1[#Headers]` | the header row; `#All` is headers and data together |
| `Table1[[Q1]:[Q4]]` | the columns Q1 to Q4 |

Tables **grow on their own**: type in the row just below and it becomes part
of the table, so `=SUM(Table1[Amount])` never misses new rows. A header
typed just to the right adds a column. Inserting rows inside a table grows
it too. Tables get banded rows and a coloured header; your own formatting
shows on top.

## Numbers, text, TRUE/FALSE and dates

A cell holds a number, text, TRUE or FALSE, or nothing. These follow Excel's
rules exactly, so formulas copied from Excel give the same answers:

- **Dates and times are numbers**: days since 1900 (1 January 1900 is 1;
  Excel's famous non-existent 29 February 1900 is there too, so serials match
  Excel files), with the time as a fraction (noon is .5). That's why
  `=B2-A2` gives the days between two dates. Use **DATE**, **YEAR**,
  **EOMONTH** and friends to build and take them apart.
- **Text that looks like a number counts as one in maths**: `="10%"*2` is
  0.2 and `="$1,200"+1` is 1201. Text that doesn't gives #VALUE!.
- **Comparisons**: numbers compare by value and text ignores upper and lower
  case. Different types never match, so `=1="1"` is FALSE (a classic cause of
  lookups not finding a value), and when sorted, numbers come before text,
  which comes before TRUE and FALSE.
- **Empty cells** count as 0 next to numbers, "" next to text and FALSE next
  to TRUE/FALSE. **SUM**, **AVERAGE** and **COUNT** skip text and TRUE/FALSE
  inside ranges.
- **Typing TRUE or FALSE** (any case) makes a real TRUE/FALSE, not text.
- **COUNTIF and SUMIF** take wildcards: `*` for any run of characters, `?`
  for one, and `~` before either to mean the character itself.

## Errors

Errors are values that flow through formulas, so you can catch them with
`IFERROR`.

| Error | Meaning |
| --- | --- |
| `#DIV/0!` | divided by zero |
| `#VALUE!` | wrong kind of value, e.g. text where a number was needed |
| `#NUM!` | an impossible number, e.g. the square root of a negative |
| `#N/A` | a value isn't available |
| `#REF!` | a reference outside the sheet, or to a sheet that doesn't exist |
| `#NAME?` | an unknown function name |
| `#CYCLE!` | the formula depends on itself |
| `#ERROR!` | the formula couldn't be read; check the brackets and quotes |
