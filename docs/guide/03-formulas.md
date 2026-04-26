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
arguments and worked examples. More arrive with every release; around 150
of the most used Excel functions are planned for milestone M2.

While you type a formula, cellforge helps:

- after `=` and a few letters it suggests matching functions; use the arrow
  keys and **Tab** (or click) to insert one with its opening bracket;
- inside a function's brackets it shows its arguments, with the one you're
  on in bold and a line on what it expects.

This works in the cell and in the formula bar.

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
