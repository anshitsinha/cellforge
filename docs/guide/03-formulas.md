# Formulas

Start a cell with `=` to calculate: `=A1*B1`, `=SUM(C:C)`, `=IF(D2>100, "big", "small")`.

## References

| You write | It means |
| --- | --- |
| `A1` | one cell; adjusts when filled down or copied |
| `A1:B9` | a rectangle of cells |
| `C:C` | the whole column C, however many rows |
| `$A$1` | always this cell (`# Formulas

Start a cell with `=` to calculate: `=A1*B1`, `=SUM(C:C)`, `=IF(D2>100, "big", "small")`.

## References

| You write | It means |
| --- | --- |
| `A1` | one cell; adjusts when filled down or copied |
| `A1:B9` | a rectangle of cells |
| `C:C` | the whole column C, however many rows |
 locks the column and/or row) |
| `Data!B4` | cell B4 on the sheet called Data |
| `'Bank Jan'!A1:A9` | a range on a sheet whose name has spaces or symbols (in quotes) |
| `Data!C:C` | a whole column on another sheet |

Sheet names in formulas ignore upper and lower case. If you rename a sheet,
formulas that refer to it are updated for you. If you delete it, they show
`#REF!`, and undoing the delete brings their values back.

## Operators

`+ - * / ^` for maths, `&` to join text, and `= <> < > <= >=` to compare.

## Functions available today

| Category | Functions |
| --- | --- |
| Totals | `SUM` `AVERAGE` `MIN` `MAX` `COUNT` `COUNTA` |
| Conditional | `COUNTIF` `SUMIF` `IF` `IFERROR` |
| Logic | `AND` `OR` `NOT` |
| Maths | `ABS` `SQRT` `INT` `ROUND` `MOD` `POWER` |
| Text | `LEN` `UPPER` `LOWER` `TRIM` `CONCAT` |

The full library of around 500 Excel and Google Sheets functions is planned
for milestone M2; see [progress](#/progress).

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
