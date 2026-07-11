# Bank reconciliation: PDF statement to rec statement

In this tutorial you reconcile October's bank account: read the bank's
PDF statement, match it against the cash book exported from the ledger,
explain what's left over and build a reconciliation statement that agrees
to the cent. It takes about 15 minutes.

You need two files:

- the bank statement: [bank-statement-2024-10.pdf](samples/bank-statement-2024-10.pdf),
  a one-page statement with real text in it, like one downloaded from
  online banking (there's also a [CSV version](samples/bank-statement-2024-10.csv)
  of the same statement);
- the cash book: [cash-book-2024-10.csv](samples/cash-book-2024-10.csv),
  the ledger's bank account for October, with receipts positive and
  payments negative.

The cash book opened the month at 24,615.32, the same as the bank, so
September reconciled with nothing outstanding.

Every command below is in the command palette (**Ctrl+K**).

## 1. Open the cash book

Press **Ctrl+O** (or choose **Open…**), pick `cash-book-2024-10.csv` and
press **Open**. The sheet has four columns: **Date**, **Reference**,
**Description** and **Amount**, with 15 lines.

Double-click the tab and rename it `Book`.

## 2. Import the bank statement

Choose **Import a bank statement (PDF or CSV)…** and pick
`bank-statement-2024-10.pdf`. The file is read on your computer.

Before anything is added, cellforge shows what it read: *13 transactions
on 1 page. Opening balance 24,615.32, closing 13,715.27.* and *Every
balance follows from the one before.* The opening balance comes from the
*Balance brought forward* line. Each balance on the statement has been
checked: the one before plus the amount, to the cent. The table under it
gives each page's opening and closing balance and its breaks (0).

The dates are printed as `02 Oct` with no year. cellforge takes the year
from the line *Statement 1 October 2024 to 31 October 2024*.

Press **Add the transactions**. A new sheet named
`bank-statement-2024-10` holds 13 transactions with **Date**,
**Description**, **Amount** (money out negative), **Balance**, **Page**
and **Balance check**, which says `ok` on every line. Rename it `Bank`.

## 3. Match

Go back to `Book` and choose **Reconcile two sheets…**. Side A is the
sheet you're on (`Book`) and side B is the next one (`Bank`).

Check the columns cellforge guessed:

| | Side A: Book | Side B: Bank |
| --- | --- | --- |
| Reference | Reference | (none) |
| Amount | Amount | Amount |
| Date | Date | Date |
| Description | Description | Description |

The bank's descriptions (`BGC BAKER AND SONS LTD`) have nothing in common
with your references (`RCP-3101`), so side B has no reference. Leave
**B amounts have the opposite sign** unticked: both sheets show money out
as negative. Keep the default tolerances: amounts must agree exactly and
dates must be within 3 days.

Press **Match**. The summary shows:

- **9** pairs matched by **Amount and date only**;
- **1** match by **Several A = one B**: the receipts from Greenfield Cafe
  (1,800.00) and Hill Street Deli (1,200.00) on 7 October were paid in
  together as one counter credit of 3,000.00 on 8 October;
- **4** unmatched on side A and **3** on side B;
- **1** possible keying error.

Press **Add result sheets**. You get **Rec matched**, **Rec unmatched A**,
**Rec unmatched B** and **Rec mismatched** (empty here). Each row keeps
its row number from the original sheet in the **Sheet row** column.

## 4. Explain the leftovers

**Rec unmatched A** (in the cash book, not on the statement):

| Description | Amount | Why |
| --- | --- | --- |
| Payment - Coastal Packaging | -1,243.00 | Keying error (see below) |
| Cheque 100245 - Bright Signs | -1,250.00 | Outstanding cheque: written on 29 October, not yet cleared |
| Cheque 100246 - Lakeside Printing | -830.40 | Outstanding cheque |
| Receipt - Riverside Hotel | 4,500.00 | Deposit in transit: paid in on 31 October, credited in November |

**Rec unmatched B** (on the statement, not in the cash book):

| Description | Amount | Why |
| --- | --- | --- |
| FPO COASTAL PACKAGING | -1,234.00 | Keying error (see below) |
| ACCOUNT FEE OCTOBER | -35.00 | Bank charge, not yet in the cash book |
| INTEREST PAID | 12.48 | Interest, not yet in the cash book |

The **Note** column on both Coastal Packaging lines says *possible keying
error: amount two digits swapped*, with the row on the other side. To see the detail, go back to the
reconcile dialog: under **Why don't these match?** type the Coastal
Packaging rows (row 6 of the cash book, row 5 of the statement; the
**Sheet row** column gives both) and press **Explain**. It shows two
digits swapped: 1,243.00 against 1,234.00, a difference of 9.00. The bank
paid 1,234.00, the amount on the supplier's invoice, so the cash book is
wrong.

Now write each explanation next to its line. Column G of both unmatched
sheets is free. Type these words exactly, because the rec statement adds
up by them:

- in **Rec unmatched A**, G1 to G4: `Keying error`, `Outstanding cheque`,
  `Outstanding cheque`, `Deposit in transit`;
- in **Rec unmatched B**, G1 to G3: `Keying error`, `Bank charge`,
  `Interest`.

## 5. The reconciliation statement

Add a sheet with **+** and rename it `Rec statement`. Click A1 and paste
the labels:

```
Balance per bank statement
Less cheques not yet cleared
Add deposits not yet credited
Adjusted bank balance

Balance per cash book
Less bank charges
Add interest received
Correct the Coastal Packaging payment
Adjusted cash book balance

Difference
```

Then type the formulas in column B:

| Cell | Formula | Result |
| --- | --- | --- |
| B1 | `=Bank!D13` | 13,715.27 |
| B2 | `=SUMIF('Rec unmatched A'!$G$1:$G$10, "Outstanding cheque", 'Rec unmatched A'!$D$1:$D$10)` | -2,080.40 |
| B3 | `=SUMIF('Rec unmatched A'!$G$1:$G$10, "Deposit in transit", 'Rec unmatched A'!$D$1:$D$10)` | 4,500.00 |
| B4 | `=SUM(B1:B3)` | 16,134.87 |
| B6 | `=24615.32+SUM(Book!D1:D15)` | 16,148.39 |
| B7 | `=SUMIF('Rec unmatched B'!$G$1:$G$10, "Bank charge", 'Rec unmatched B'!$D$1:$D$10)` | -35.00 |
| B8 | `=SUMIF('Rec unmatched B'!$G$1:$G$10, "Interest", 'Rec unmatched B'!$D$1:$D$10)` | 12.48 |
| B9 | `=SUMIF('Rec unmatched B'!$G$1:$G$10, "Keying error", 'Rec unmatched B'!$D$1:$D$10)-SUMIF('Rec unmatched A'!$G$1:$G$10, "Keying error", 'Rec unmatched A'!$D$1:$D$10)` | 9.00 |
| B10 | `=SUM(B6:B9)` | 16,134.87 |
| B12 | `=B4-B10` | 0.00 |

`Bank!D13` is the last balance on the statement sheet, which is the
closing balance. Sheet names with spaces go in single quotes.

The adjusted bank balance and the adjusted cash book balance are both
16,134.87, and the difference is zero. Select B1:B12 and choose
**Number format: Number** to show two decimals.

## 6. Finish

- Post the three cash book adjustments in the ledger: the bank charge,
  the interest and the 9.00 correction to the Coastal Packaging payment.
- Next month, check that the two cheques and the 4,500.00 deposit clear.
- Choose **Save a version…** and call it `October bank rec`, then **Save**
  (**Ctrl+S**) to keep the workbook with your working papers. Every step
  above is in **Show history and versions** (**Ctrl+Shift+H**).

## What you used

- [Bank statements](#/guide/17-bank-statements)
- [Reconciling two sheets](#/guide/21-reconciliation)
- [Working with sheets](#/guide/07-sheets): adding and renaming
- [SUMIF](#/reference/functions-statistics?h=sumif) and cross-sheet references in [formulas](#/guide/03-formulas)
