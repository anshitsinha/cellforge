# Bank statements

Open a statement PDF (Ctrl+O, or drag it in), or choose **Import a bank
statement (PDF or CSV)…** from the command palette (Ctrl+K). The file is
read on your computer; nothing is uploaded.

PDFs need to have real text in them, which statements downloaded from
online banking do. Scanned paper statements (pictures of text) can't be
read yet.

## What cellforge looks for

A header line with a **date** column, money columns (**Paid out / Paid in**,
**Debit / Credit**, **Withdrawals / Deposits**, or a single **Amount**) and
usually a **Balance**. Under it:

- A line starting with a date is a transaction. Lines of text below it
  (a payee's name, a reference) are joined onto its description.
- Amounts go to the column they sit under, so money out comes in negative
  and money in positive. Balances marked **DR** or **OD** are overdrawn
  (negative).
- **Balance brought forward / Opening balance** lines give the starting
  balance; **carried forward / Closing balance** lines are checked against
  the transactions; page totals are skipped.

## Dates

Dates like `28 Dec` with no year get the year from the statement (for
example its period, *1 December 2023 to 31 January 2024*) and move to the
next year when the months go from December to January. Whether `03/04` is
3 April or March 4 is worked out from the whole statement. A date that
can't be real (31/02) is left empty, with the printed text kept in a
**Date as printed** column.

## The balance check

Every balance is checked: the previous balance plus this amount must give
this balance, to the cent. Before adding the transactions you see the
opening and closing balance of each page and how many breaks there are.
In the sheet, the **Balance check** column says `ok`, or `break: expected …`
with the balance the figures add up to. A break usually means a line was
misread or a transaction is missing, so look at that page of the PDF.

When the statement shows amounts without a sign, the sign is worked out
from the balances (`ok (sign from balance)`).

The transactions go on a new sheet with columns Date, Description, Amount,
Balance, Page and Balance check. One **Undo** removes it.
