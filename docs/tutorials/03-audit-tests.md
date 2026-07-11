# Audit tests: duplicates, gaps, Benford, journals, sampling, footing

In this tutorial you run the standard data analytics tests on a year of
purchase invoices and a month of journals: duplicate payments, missing
invoice numbers, Benford's law, journal entry tests, a sample you can
repeat, and footing a schedule. Each test leaves a result sheet you can
keep with your working papers. It takes about 30 minutes.

You need:

- [purchase-invoices-2024.csv](samples/purchase-invoices-2024.csv): 418
  invoices with **Invoice**, **Invoice date**, **Vendor**, **Amount** and
  **Entered by**;
- [journals-2024-10.csv](samples/journals-2024-10.csv): October's
  journals, one row per line;
- a small schedule to foot, which you'll paste in at step 7.

The data is made up, with a few problems planted for the tests to find.

The tests never change your data. Each one opens a dialog from the
command palette (**Ctrl+K**), shows a summary as you change the settings,
and adds its result as a new sheet. One **Undo** removes a result sheet.
Every result sheet has a **Row** column (or **Sheet row**) with the row
in the original sheet, so you can go back to any item.

## 1. Open the invoices

Press **Ctrl+O**, pick `purchase-invoices-2024.csv` and press **Open**.
The sheet is called `purchase-invoices-2024`.

## 2. Duplicate payments

Choose **Find duplicates…**. Under **Key columns and how they must
match**, set:

- **Vendor**: **Exactly the same**;
- **Amount**: **Exactly the same**.

The summary finds one group: INV-10342 and INV-10348, both from Quayside
Security for 45.99, five days apart (rows 340 and 346). That's a possible
double payment to follow up. Press **Add the result sheet**.

Try a wider net: add **Invoice date** with **Dates within (days)** and
`7`, or change Amount to **Numbers within** and `1`. Looser keys find
more groups, and more false alarms.

### Vendors spelled two ways

A vendor keyed twice under slightly different names can hide duplicates
and split spend. Test the list of vendor names, not the invoices:

1. On `purchase-invoices-2024`, choose **Remove duplicates…**, tick only
   **Vendor** under **Compare these columns**, and press **Add the
   sheet**. The new sheet, `purchase-invoices-2024 unique`, has one row per
   vendor: 21 of them.
2. On that sheet, choose **Find duplicates…** with **Vendor** set to
   **Similar spelling (at least % alike)** and `90`.

One group: *Brightwater Logistics* and *Brightwatter Logistics*. Back on
the invoices, **Find…** (**Ctrl+F**) for `Brightwatter` takes you to
INV-10263, entered on 15 August.

## 3. Gaps in the invoice numbers

Choose **Find gaps in a sequence…** and pick **Invoice** under **Numbers
in**. cellforge reads `INV-10001` as the prefix `INV-` and the number
10001. The summary shows one series, INV-10001 to INV-10420, with:

- **Missing**: INV-10213 to INV-10215, 3 numbers;
- **Used twice or more**: INV-10301, on rows 298 and 299, for two
  different vendors;
- **Out of order**: none.

Press **Add the result sheet**. Ask why three invoices were never
entered, and which INV-10301 is the real one.

## 4. Benford's law

Choose **Benford's law test…**, pick **Amount** under **Amounts in** and
**First digit (1-9)** under **Test**.

All 418 amounts are tested. The main result is the **MAD** (mean absolute
deviation) and its verdict: **acceptable conformity**. A digit with a
z-statistic above 1.96 is marked; look at the invoices behind it before
you conclude anything.

Now switch the test to **First two digits (10-99)**. The verdict is
**nonconformity**, but don't read much into it: 418 values spread over 90
two-digit combinations is fewer than five per combination. The first-two
test is for thousands of values, such as a full year of payments from a
larger company.

Press **Add the result sheet** with the first-digit test chosen. To see
it as a chart, select the Amount column and choose **Insert chart…**,
then pick **Benford (first digits)** under **Edit**.

## 5. A sample you can repeat

Choose **Pick a sample…** and set:

- **Method**: **Monetary unit (MUS)**, so larger invoices are more likely
  to be picked;
- **Amounts in**: **Amount**;
- **Sample size**: `25`;
- **Seed**: `20241031`.

The interval is the total, 4,456,824.68, divided by 25: 178,272.99. The
dialog picks 25 invoices. Press **Add the result sheet**. The **Method**
column of `purchase-invoices-2024 sample` records the method, the seed
and the interval.

The seed is what makes the sample repeatable. A reviewer who runs **Pick
a sample…** on the same data with the same seed gets the same 25
invoices. Write the seed in your working papers. If you leave the seed
the dialog suggests, write that one down instead.

## 6. Journal entry tests

Opening a file starts a new workbook, so press **Ctrl+S** first to save
the invoice work as a `.cellforge` file. Then press **Ctrl+O** and open
`journals-2024-10.csv`.

Choose **Journal entry tests…**. Check the guessed columns under
**Columns**: **Entry id** is Journal, **Date (effective)** is Date,
**Posted date / time** is Posted, then **User**, **Account**,
**Description**, **Debit** and **Credit**.

Under **Settings for the tests**, type `10000` in **Approval limits**.
Leave the rest as they are.

Four entries come out on top:

| Entry | Score | Why |
| --- | --- | --- |
| J-1043 | 9 | Posted on Saturday 12 October at 21:47, by a user who posted nothing else, to accounts that are seldom used, for a round 25,000.00, described as *Adjust marketing accrual* |
| J-1057 | 6 | Dated 30 September but posted on 8 November, 39 days later; a round 3,000.00; a seldom-used account; dated at the period end |
| J-1050 | 5 | Doesn't balance: debits 4,250.00, credits 4,205.00 |
| J-1060 | 5 | 9,850.00, just below the 10,000 approval limit, to a seldom-used account |

Below them come entries scoring 2, flagged as an unusual user for the
account. With only three people posting, that test is noisy on a month
this small; read the reasons before following them up.

Press **Add the result sheet**. With **Also add a summary sheet per
test** ticked, as it is to start with, you get two sheets:
`journals-2024-10 JE flags`, every line of every flagged entry with its
score and reasons, and `journals-2024-10 JE summary`, the count for each
test. A high score is a reason to look, not a finding.

## 7. Foot and cross-foot a schedule

Click **+** to add a sheet, click A1 and paste this schedule:

```
Expense	Q1	Q2	Q3	Q4	Total
Rent	9000	9000	9000	9000	36000
Wages	26100	27300	27600	28350	109350
Utilities	1980	1710	1650	2140	7480
Marketing	3400	5150	3800	15559.75	27909.75
Total	40480	43160	42950	55049.75	180739.75
```

Select A1:F6 and choose **Foot and cross-foot this range…**. cellforge
takes 1 heading row and 1 label column. Three checks fail:

- the **Q3** column adds up to 42,050.00, but its total says 42,950.00;
- the **Total** row adds across to 181,639.75, but the corner says
  180,739.75;
- the corner itself, for the same reason.

All three point at one cell: the Q3 total, keyed 900.00 too high. The
result sheet lists every check, passed or not, so it can go in the
working papers as it is.

## 8. Keep the evidence

Choose **Save a version…** and name it, say, `Analytics, October`, then
**Save** (**Ctrl+S**). The version records the data and every result
sheet as they were when you ran the tests, and **Show history and
versions** (**Ctrl+Shift+H**) lists each step.

## More tests

On the same invoices you could also run **Stratify values into bands…**,
**Largest items (top N)…**, **Pareto analysis…** (spend by vendor) and
**Ageing buckets…**. The [audit test catalogue](#/guide/audit-test-catalogue)
lists every test with what it finds and its settings.

## What you used

- [Audit tests](#/guide/20-audit-tests)
- [Journal tests and safe sharing](#/guide/28-journal-tests-and-safe-sharing)
- [Reshape and extract](#/guide/25-transform): Remove duplicates
- [Charts](#/guide/23-charts): the Benford chart
