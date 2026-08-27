# SQL queries

SQL lets you ask questions of your sheets in a few lines: totals by account
and month, ledger lines with no match on the bank statement, duplicate
invoices, a running balance. It runs on your computer, inside the app, like
everything else. Nothing is sent anywhere.

Choose **SQL query…** from the command palette (Ctrl+K).

## Sheets are tables

Every sheet in the workbook is a table with the sheet's name. Its columns
are named by the column headers of an imported file, or else by the first
row of the sheet. A column with no name is called `Column A`, `Column B`
and so on.

The panel lists the sheets and their columns on the left. Click a name to
put it into the query at the cursor.

Names are not case-sensitive: `amount`, `Amount` and `AMOUNT` are the same
column. A name with a space or a symbol in it goes in double quotes or
square brackets:

```sql
SELECT "Posting Date", [Account Name], Amount
FROM "GL March"
```

Text values go in single quotes: `WHERE Account = '4000'`. To put a single
quote inside text, write it twice: `'O''Brien'`.

## Running a query

Press **Run** or Ctrl+Enter. The first 200 rows of the result show under
the editor, with how many rows there are and how long it took.

If something is wrong, the message says what and where (line and column),
and the cursor jumps there. For example:

- `There's no column "Ammount". Did you mean Amount?`
- `"Description" isn't in GROUP BY: add it to GROUP BY, or summarise it`
- `SUM() can't be used in WHERE; use HAVING after GROUP BY to filter on totals`

**Put the result on a new sheet** adds the result as a sheet you can sort,
filter, chart or export. Dates and number formats carry over. The sheet
remembers the query it came from (see *Explain*). Undo removes it.

### Saving queries

Type a name next to **Save** and press it to keep the query with the
workbook. Saved queries are listed on the left; click one to open it. Saving
again under the same name replaces it. Saving and deleting can be undone.

## Examples

These use a ledger sheet called `GL` with the columns `Date`, `Account`,
`Description`, `Ref` and `Amount`, and a bank sheet called `Bank`.

### Totals by account and month

```sql
SELECT Account,
       DATE_TRUNC('month', Date) AS Month,
       SUM(Amount) AS Total,
       COUNT(*) AS Lines
FROM GL
GROUP BY Account, Month
ORDER BY Account, Month
```

`DATE_TRUNC('month', Date)` turns every date into the first day of its
month, so all of March adds up together. Use `'quarter'` or `'year'` the
same way.

### Ledger items with no match on the bank statement

```sql
SELECT g.Date, g.Ref, g.Amount
FROM GL g
LEFT JOIN Bank b ON g.Ref = b.Ref AND g.Amount = b.Amount
WHERE b.Ref IS NULL
ORDER BY g.Date
```

A LEFT JOIN keeps every ledger line. Lines with no bank line to match get
blanks on the bank side, and `WHERE b.Ref IS NULL` keeps only those. Swap
the two sheets to find bank lines missing from the ledger.

### Duplicates

```sql
SELECT Ref, Amount, COUNT(*) AS Times
FROM GL
GROUP BY Ref, Amount
HAVING COUNT(*) > 1
ORDER BY Times DESC
```

`HAVING` filters the groups after they are added up; `WHERE` filters rows
before.

### Running balance

```sql
SELECT Date, Ref, Amount,
       SUM(Amount) OVER (PARTITION BY Account ORDER BY Date, Ref
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS Balance
FROM GL
ORDER BY Account, Date, Ref
```

`PARTITION BY Account` starts the balance again for each account.
`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` adds up row by row.
Without it, rows on the same date get the same balance (the standard SQL
rule), which is rarely what you want for a balance.

### More

The ten biggest payments:

```sql
SELECT Date, Description, Amount FROM GL
WHERE Amount < 0
ORDER BY Amount
LIMIT 10
```

This month against last month, by account:

```sql
WITH m AS (
  SELECT Account, DATE_TRUNC('month', Date) AS Month, SUM(Amount) AS Total
  FROM GL GROUP BY Account, Month
)
SELECT Account, Month, Total,
       LAG(Total) OVER (PARTITION BY Account ORDER BY Month) AS Previous,
       Total - LAG(Total) OVER (PARTITION BY Account ORDER BY Month) AS Change
FROM m
ORDER BY Account, Month
```

Payments over 10,000 at weekends:

```sql
SELECT * FROM GL
WHERE ABS(Amount) > 10000 AND EXTRACT(DOW FROM Date) IN (0, 6)
```

Ledger and bank side by side, with differences:

```sql
SELECT COALESCE(g.Ref, b.Ref) AS Ref, g.Amount AS Ledger, b.Amount AS Bank,
       COALESCE(g.Amount, 0) - COALESCE(b.Amount, 0) AS Difference
FROM GL g FULL JOIN Bank b ON g.Ref = b.Ref
WHERE g.Ref IS NULL OR b.Ref IS NULL OR g.Amount <> b.Amount
```

## What you can write

- `SELECT [DISTINCT] ... FROM ... [WHERE] [GROUP BY] [HAVING] [ORDER BY] [LIMIT] [OFFSET]`
- Column names in the output: `expression AS Name`. Without a name, the
  column is called by what you wrote (`SUM(Amount)`).
- `ORDER BY` a column, an output name, a position (`ORDER BY 2`) or an
  expression, with `ASC` or `DESC` and `NULLS FIRST` or `NULLS LAST`.
  Blanks come last going up and first going down unless you say otherwise.
- `GROUP BY` columns, expressions, output names or positions.
- Joins: `JOIN` (inner), `LEFT JOIN`, `RIGHT JOIN`, `FULL JOIN`,
  `CROSS JOIN`, `JOIN ... USING (column)`, and `FROM a, b WHERE ...`.
- `UNION ALL`, `UNION`, `EXCEPT`, `INTERSECT`.
- Subqueries: in `FROM (SELECT ...) AS t`, in `IN (SELECT ...)`, as a value
  `(SELECT AVG(Amount) FROM GL)`, and `EXISTS (SELECT ...)`. They can't
  refer to the outer query's columns.
- `WITH name AS (SELECT ...)` to name a step and use it later; several
  steps separated by commas.
- `CASE WHEN ... THEN ... ELSE ... END` and `CASE x WHEN 1 THEN ... END`.
- `IN (...)`, `BETWEEN ... AND ...`, `LIKE` and `ILIKE` (`%` any text, `_`
  one character; `ILIKE` ignores case; `ESCAPE '!'`), `IS NULL`,
  `IS NOT NULL`, `IS DISTINCT FROM`.
- Arithmetic `+ - * / %`, text joining with `||`. Division by zero gives a
  blank, not an error. `7 / 2` is 3.5.
- Comments: `-- to the end of the line` and `/* ... */`.

### Functions

| Kind | Functions |
| --- | --- |
| Totals | `COUNT(*)`, `COUNT(x)`, `COUNT(DISTINCT x)`, `SUM`, `AVG`, `MIN`, `MAX`, `MEDIAN`, `STDDEV` (sample), `STDDEV_POP`, `VARIANCE`, `VAR_POP`, `STRING_AGG(x, ', ')`, `ANY_VALUE`; `SUM(DISTINCT x)`, `AVG(DISTINCT x)` |
| Windows (with `OVER`) | `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE(n)`, `LAG(x [, n [, default]])`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, and `SUM`, `AVG`, `COUNT`, `MIN`, `MAX` over a window |
| Blanks | `COALESCE(a, b, ...)`, `NULLIF(a, b)`, `IFNULL(a, b)` |
| Text | `LOWER`, `UPPER`, `TRIM`, `LTRIM`, `RTRIM`, `LENGTH` (`LEN`), `SUBSTR(s, start [, length])` (`SUBSTRING`, `MID`), `LEFT(s, n)`, `RIGHT(s, n)`, `REPLACE(s, from, to)`, `CONCAT(...)`, `POSITION(x IN s)`, `STRPOS(s, x)`, `LPAD`, `RPAD`, `REVERSE` |
| Numbers | `ABS`, `ROUND(x [, digits])`, `TRUNC`, `FLOOR`, `CEIL`, `MOD`, `POWER`, `SQRT`, `SIGN`, `LN`, `EXP`, `LOG10`, `GREATEST`, `LEAST` |
| Dates | `YEAR`, `MONTH`, `DAY`, `QUARTER`, `EXTRACT(part FROM d)`, `DATE_TRUNC('month', d)` (also `'year'`, `'quarter'`, `'week'`, `'day'`), `EOMONTH(d [, months])`, `DATE(y, m, d)`, `DATEDIFF('day' / 'month' / 'year', from, to)`, `CURRENT_DATE` |
| Types | `CAST(x AS NUMBER / INTEGER / TEXT / DATE)` |

A window function works out a value for each row from other rows: a
running total, a rank, the previous row's value. `OVER (...)` says which
rows: `PARTITION BY` splits the rows into groups, `ORDER BY` sets the order
within each group, and `ROWS BETWEEN 3 PRECEDING AND CURRENT ROW` (for
example) sets how many rows around the current one count.

## Blanks (NULL)

An empty cell is `NULL` in SQL. NULL means "unknown", so:

- `Amount = NULL` is never true. Write `Amount IS NULL`.
- A comparison with a blank is neither true nor false, and `WHERE` only
  keeps rows where the condition is true. `WHERE Dept <> 'Ops'` leaves out
  rows with no department; add `OR Dept IS NULL` to keep them.
- `NOT IN (...)` with a blank in the list keeps nothing.
- Totals skip blanks. `COUNT(*)` counts rows; `COUNT(Amount)` counts the
  filled-in amounts. A `SUM` of nothing is blank, not 0; wrap it in
  `COALESCE(SUM(Amount), 0)` for 0.
- `GROUP BY` puts all the blanks in one group.
- Joins never match blank keys.

## Dates, numbers and text

- Dates are the sheet's dates (Excel serial numbers underneath). Write a
  date as `DATE '2024-03-31'`, or as text `'2024-03-31'` when comparing it
  with a date column: `WHERE Date >= '2024-01-01'`.
- `Date + 30` is 30 days later; `Date2 - Date1` is the number of days
  between them.
- Text that holds a number compares as a number with a number column, so an
  account code typed as text in one sheet matches the same code stored as a
  number in another. Text that isn't a number never equals a number.
- Text sorts without regard to case ("apple" next to "Apple"), but `=`
  compares exactly; use `LOWER(a) = LOWER(b)` or `ILIKE` to ignore case.
- Conditions in the select list come out as TRUE or FALSE.
- Totals add cents exactly, even over millions of rows.

## Speed

Queries run on the columns directly, without copying the sheets. On a
typical laptop, `SELECT Region, SUM(Amount) FROM Sales GROUP BY Region`
over 10 million rows takes about a tenth of a second, and joining two
1-million-row sheets about a quarter of a second. A join that would make
more than 50 million rows stops with a message: check that the keys you
join on are what you expect.

## Not supported

`INSERT`, `UPDATE` and `DELETE` (SQL here only reads; put the result on a
new sheet instead), subqueries that refer to the outer query, recursive
`WITH`, `FILTER (WHERE ...)` (use `SUM(CASE WHEN ... THEN Amount END)`),
`RANGE` frames with a number of rows (use `ROWS`), and `ORDER BY` inside
`STRING_AGG`.
