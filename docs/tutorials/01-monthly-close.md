# Monthly close: trial balance to flux review

In this tutorial you take October's trial balance from a messy export to a
flux review: clean it, map it, compare it with September, highlight the
movements worth explaining, total them by account type and chart them.
It takes about 20 minutes.

You need:

- the October export: [tb-2024-10.csv](samples/tb-2024-10.csv), as an
  accounting system prints it, with a company name on top, debits and
  credits as text, a total row and a page footer;
- September's balances, which you'll paste in at step 4.

Every command below is in the command palette. Press **Ctrl+K** and type
a few letters of its name.

## 1. Open the export

1. Press **Ctrl+O** (or choose **Open…**) and pick `tb-2024-10.csv`.
2. The preview shows the first lines of the file. The real column names
   (Account, Account name, Debit, Credit) are on line 5, under a title, a
   report date and a blank line. Set **Skip rows at the top** to `4`.
3. Leave **First row has the column names** ticked and press **Open**.

The sheet is called `tb-2024-10`. Scroll down: under the accounts there's
a **Total** row, a blank row and a `Page 1 of 1` footer. Those must go
before you do anything with the numbers.

## 2. Clean it

Choose **Clean up this sheet (messy export)…**.

The preview says what it will do:

- **Rows left out, and why**: the total row, the blank row and the footer.
- **Each column's type**: Account, Debit and Credit are numbers, Account
  name is text. The amounts in the file are text like `91,030.50`; the
  clean sheet holds real numbers.

Press **Make the clean sheet**. You get two new sheets: `tb-2024-10 clean`
with the 18 accounts, and `tb-2024-10 dropped` listing the three rows left
out. The original sheet is untouched.

## 3. Map it as a trial balance

On `tb-2024-10 clean`, choose **Map this sheet as a trial balance…**.

cellforge guesses the columns: Account is the **Account code**, Account
name the **Account name**, then **Debit** and **Credit**. The checks say
debits equal credits, no code is used twice and every
amount is a number.

Press **Make the trial balance sheet**. The new sheet,
`tb-2024-10 clean TB`, has three columns: **Code**, **Name** and
**Current**, with debits positive and credits negative.

Double-click its tab and rename it `Oct`. Short sheet names make short
formulas.

> On a sheet made by cellforge, the column headers show names (Code,
> Name, Current) instead of letters, and the first account is in row 1.
> Formulas still use letters: Code is column A, Name is B, Current is C.

## 4. Bring in last month

1. Click **+** at the bottom left to add a sheet, and rename it `Sep`.
2. Click cell A1, copy the block below and paste it with **Ctrl+V**.

```
Code	Balance
1000	83250.00
1100	112400.00
1200	65300.00
1500	150000.00
1510	-45000.00
2000	-58900.00
2100	-14200.00
2200	-6500.00
3000	-50000.00
3100	-120000.00
4000	-540000.00
4100	-3600.00
5000	297000.00
6000	81000.00
6100	27000.00
6200	5400.00
6300	12350.00
6400	4500.00
```

The block is tab-separated, the same as copying from Excel, so it lands
in two columns: codes in A2:A19, balances in B2:B19.

## 5. Compare to last month

Go back to `Oct`. Columns D onwards are free. Type these in row 1:

| Cell | Formula | What it gives |
| --- | --- | --- |
| D1 | `=XLOOKUP(VALUE(A1), Sep!$A$2:$A$19, Sep!$B$2:$B$19, 0)` | September's balance for the account |
| E1 | `=C1-D1` | the movement |
| F1 | `=IF(D1=0, 0, E1/ABS(D1))` | the movement as a share of last month |
| G1 | `=CHOOSE(VALUE(LEFT(A1, 1)), "Assets", "Liabilities", "Equity", "Income", "Expenses", "Expenses")` | the account type, from the code's first digit |

Why `VALUE`: the trial balance sheet keeps codes as text (`"1000"`),
while the codes you pasted are numbers. `VALUE` turns the text into a
number so the two match. The last argument of XLOOKUP, `0`, is what you
get for an account that didn't exist last month.

Now select D1:G18 and press **Ctrl+D** (**Fill down**). Select F1:F18 and
choose **Number format: Percent**.

Check a few rows: Trade debtors (row 2) moved 16,550.00, or 14.72%;
Accruals (row 8) moved -12,000.00, or -184.62%; Marketing (row 17) moved
15,559.75.

## 6. Highlight what needs explaining

A common rule: explain any movement over 10,000 **and** over 10% of last
month's balance.

1. Select A1:G18.
2. Choose **Conditional formatting: new rule for the selection…**.
3. Pick **Formula is true** and type `=AND(ABS($E1)>10000, ABS($F1)>0.1)`.
   The `$` keeps the columns fixed while the row moves, so each row is
   tested on its own movement.
4. Pick a look, such as light red fill with dark red text, and save the
   rule.

Five rows light up: 1100 Trade debtors, 2200 Accruals, 4000 Sales, 5000
Cost of sales and 6300 Marketing. These are the ones to explain in your
flux commentary. Change the thresholds in the formula with **Conditional
formatting: manage rules…** and the highlighting follows.

## 7. Total by account type

**Pivot table…** builds this summary for you: put the account type in
Rows and the amount in Values. Or, to keep it live in the sheet, two SUMIF
formulas do the same job.

Add a sheet, rename it `By type`, click A1 and paste:

```
Type	Last month	This month	Movement
Assets
Liabilities
Equity
Income
Expenses
Total
```

Then type:

| Cell | Formula |
| --- | --- |
| B2 | `=SUMIF(Oct!$G$1:$G$18, A2, Oct!$D$1:$D$18)` |
| C2 | `=SUMIF(Oct!$G$1:$G$18, A2, Oct!$C$1:$C$18)` |
| D2 | `=C2-B2` |
| B7 | `=SUM(B2:B6)` |
| C7 | `=SUM(C2:C6)` |
| D7 | `=SUM(D2:D6)` |

Select B2:D6 and press **Ctrl+D** to fill rows 3 to 6. You should see:

| Type | Last month | This month | Movement |
| --- | --- | --- | --- |
| Assets | 365,950.00 | 384,680.50 | 18,730.50 |
| Liabilities | -79,600.00 | -98,760.25 | -19,160.25 |
| Equity | -170,000.00 | -170,000.00 | 0.00 |
| Income | -543,600.00 | -605,950.00 | -62,350.00 |
| Expenses | 427,250.00 | 490,029.75 | 62,779.75 |
| Total | 0.00 | 0.00 | 0.00 |

The Total row is your check: both trial balances balance, so each column
adds up to zero.

## 8. Chart it

Select A1:C6 and choose **Insert chart…**. The chart opens over the
sheet. Press **Edit** and pick **Column** to put last month and this
month side by side for each type, add a title, and set the number format
to `#,##0`. **PNG** downloads the chart for your close pack.

## 9. Keep a record

Choose **Save a version…** and call it `October close, first pass`. If
the TB is re-run later, open **Show history and versions**
(**Ctrl+Shift+H**) and press **Compare** on that version to see every
number that changed.

**Compare trial balances…** does the same comparison account by account
without the lookup formulas, and lists accounts that are only in one month.

## What you used

- [Text files](#/guide/14-other-files): skipping title rows when opening
- [Cleaning up a messy export](#/guide/15-clean-up)
- [Importing a trial balance](#/guide/18-trial-balance)
- [XLOOKUP](#/reference/functions-lookup?h=xlookup), [SUMIF](#/reference/functions-statistics?h=sumif), [CHOOSE](#/reference/functions-lookup?h=choose)
- [Conditional formatting](#/guide/24-conditional-formatting)
- [Charts](#/guide/23-charts)
- [History and versions](#/guide/10-history)
