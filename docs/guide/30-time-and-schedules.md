# Time, currency and schedules

These tools handle the time side of finance work: fiscal calendars, period
comparisons, budget against actual, currency conversion, and the monthly
schedules behind prepayments, accruals and deferred income. Each one opens
a dialog from the command palette (Ctrl+K) and previews the result as you
change the options.

Tools that make a table add a **new sheet** and leave your data alone.
Tools that add columns put them next to the column they work from. Every
tool is one **Undo** (adding columns at the edge of the sheet first is a
second one).

Dates can be real dates or text such as `31/01/2025` or `2025-01-31`. Text
dates are read day first, unless some of them only make sense month first.

## Fiscal periods

**Fiscal periods…** adds the fiscal year, quarter and period of each date
in a column.

- **Date column**: the column with the dates. The first date column is
  picked for you.
- **Year starts in**: the first month of the fiscal year. January gives
  the calendar year.
- **Name the year by**: the calendar year the fiscal year ends in (a July
  year that ends in June 2025 is FY2025) or the one it starts in (FY2024).
- **Periods**: calendar months, or a 52/53-week calendar of 4-4-5, 4-5-4
  or 5-4-4 weeks. With weeks, pick the weekday the weeks end on and whether
  the year ends on the last such weekday of its last month or the one
  nearest the month's end. A year with 53 weeks puts the extra week in
  period 12.
- **Add**: any of fiscal year, quarter (1 to 4), period (1 to 12) and a
  label such as `FY2025 P03`.

**Insert new columns** (on by default) inserts the columns right after
the date column, so nothing is overwritten. Turn it off to write into the
columns that are already there; the dialog warns how many cells would be
overwritten. With more than one row selected, only those rows are filled.

## Period comparison

**Period comparison (MoM / YoY / rolling)…** totals an amount column by
period and compares the periods. Pick:

- **Dates in** and **Amounts in**.
- **Separate series for each** (optional): a column such as account or
  entity. Each value gets its own run of periods.
- **Period**: day, week (Monday to Sunday, numbered the ISO way), month,
  quarter, year, or fiscal period, quarter or year. The fiscal ones use the
  same settings as Fiscal periods.
- **Rolling window**: how many periods the rolling sum and average cover,
  this one included. 0 leaves them out.

The new sheet has one row per period with:

| Column | What it is |
| --- | --- |
| Rows | how many rows fell in the period |
| Amount | the total |
| Previous month (or week, quarter...) | the period just before |
| MoM change, MoM % | the change on the previous period (QoQ, YoY and so on for other periods) |
| Same period last year, YoY change, YoY % | the change on the same period a year earlier |
| YTD | the total so far this year (the fiscal year for fiscal periods) |
| QTD | the total so far this quarter |
| Rolling N sum and average | over the last N periods; blank until there are N |

Periods with no rows are still listed, with an amount of 0, so "previous
period" always means the one just before. A percentage is blank when the
amount it compares with is 0. Rows whose date isn't a date are left out
and counted in the dialog.

## Budget vs actual

**Budget vs actual…** compares two sheets: one of actuals, one of budget.
A sheet with *budget*, *plan* or *forecast* in its name is picked as the
budget.

For each side, pick the sheet and its columns:

- **Account** and **Amount** (needed).
- **Cost centre** and **Period** (optional, but pick them on both sides or
  on neither).
- **Account type** (optional): text such as *Revenue* or *Expense*.

Lines with the same account, cost centre and period are added up on each
side and matched, ignoring upper and lower case and extra spaces. Periods
match by month however they are written: a date, `2025-01`, `202501`,
`Jan 2025` and `01/2025` are all January 2025. So daily actuals match a
monthly budget.

The new sheet has the actual, the budget, the **variance** (actual minus
budget), the variance as a percentage of the budget, and whether it is
**favourable**:

- **Amounts are: income and costs both positive**: more income than
  budget is favourable, more cost is unfavourable. Income or expense is
  read from the account type column, or else from the account name
  (*sales*, *revenue*, *income* against *cost*, *expense*, *salaries*,
  *rent* and so on). When neither says, the column is left blank.
- **Amounts are: ledger signs** (costs positive, income negative): a lower
  number is always favourable, so the account type isn't needed.

Lines on one side only are kept, with a note: *Not in the budget* or *No
actual*. The last row is the total.

## Convert currency

**Convert currency…** uses a sheet of exchange rates. The rates sheet
needs a date, a from currency, a to currency and a rate, where 1 unit of
*from* buys *rate* units of *to*. If it has no to column (just date,
currency and rate), say which currency the rates are against and which way
round they are written.

For each date, the rate used is the latest one **on or before** that date,
never a later one. A pair with no rate of its own is found the other way
round (EUR to USD from a USD to EUR rate), or through a base currency
(GBP to JPY as GBP to USD times USD to JPY). The base is the currency used
most in the rates sheet, or the one you type in **Triangulate through**.

**Convert each row** adds three columns after the amount: the rate, the
converted amount (rounded to the decimals you choose) and the date of the
rate used. Pick the currency column, or type one currency for every row;
pick the date column, or give one date for every row. Amounts with no rate
are left blank and counted in the dialog.

**Revalue balances** takes a list of balances (name, currency, amount in
that currency, and the amount booked in your base currency) and a closing
date. The new sheet shows each balance at the closing rate and the **FX
gain or loss**: the revalued amount minus the booked amount. Write
liabilities as negative amounts, so a stronger foreign currency shows as a
loss on them. The last row is the total gain or loss.

## Accrual and prepayment schedules

**Accrual / prepayment schedule…** builds a month-by-month schedule from a
few details:

- **Kind**: a *prepayment* (paid in advance, released to expense), a
  *deferred income* (billed in advance, released to revenue), or an
  *accrual* (a cost incurred but not yet invoiced, charged each month).
- **Amount**, and the **first** and **last day** the amount covers.
- **Spread**:
  - *Straight-line*: the same amount each month, over the number of months
    the period spans counted from the start date. 1 Jan to 31 Dec and 15
    Jan to 14 Jan are both 12 months; 1 Jan to 15 Mar is 3. A period that
    starts on a month's last day starts in the next month.
  - *Daily*: each calendar month gets its share of the days in the period.
- **Post on**: the last day of the month, the first, or a day of your
  choice (the 25th, say; in a shorter month, its last day).
- **Debit each month** and **Credit each month**: the accounts for the
  monthly entry. They are filled in for the kind you pick (expense and
  prepayments, deferred income and revenue, expense and accruals); type
  your own account names or codes.

Each month is rounded to the decimals you set and the **last month takes
the remainder**, so the months add up to the amount exactly.

Two new sheets are added:

- **schedule**: one row per month with the posting date, the days covered,
  the opening balance, the amount released (or charged), the closing
  balance and the total so far, and a total row. A prepayment or deferred
  income starts at the full amount and ends at 0; an accrual starts at 0
  and builds up.
- **journal**: two lines per month (one debit, one credit) with an entry
  number, date, account and a description such as `Insurance 2025-03
  (3 of 12)`. A negative amount, such as a credit note, posts the other way
  round.

## Journal export template

**Journal export template…** turns a schedule's journal, or any table of
debits and credits, into a plain layout for an accounting system's import:
date, account, description, debit, credit.

1. **Map the columns** of the sheet: date, account, description, and
   either debit and credit columns or one amount column (debits positive,
   credits negative). A reference or entry number is optional. The columns
   are guessed from their names.
2. **Choose the layout**: separate debit and credit columns or one signed
   amount, how dates are written (`2025-01-31`, `31/01/2025` or
   `01/31/2025`), and whether to include the reference.
3. **Rename the headers** to what your system's import expects.
4. **Download CSV**. Tick **Also add it as a new sheet** to keep a copy in
   the workbook.

Amounts are written with two decimals and no thousands separators, and a
zero debit or credit is left blank. Rows with no account and no amount are
left out. Before you download, the dialog shows the total debits and
credits and warns when they differ, and lists entries (by reference, or by
date without one) whose lines don't balance on their own. Most systems
reject a journal that doesn't balance.

The file is made in your browser and saved to your computer; nothing is
uploaded.
