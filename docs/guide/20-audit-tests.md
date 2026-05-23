# Audit tests

The audit tests work on the sheet you have open. Each one opens a dialog
from the command palette (Ctrl+K): pick the columns, set the options, read
the summary, then **Add the result sheet**. The data itself is never
changed, and one **Undo** removes the result sheet.

Columns are listed by letter and name. The names come from the column
headers of an imported sheet, or else from the first row of the sheet.
Every result sheet has a **Row** column with the row number in the
original sheet, so you can go back to any item.

## Duplicates

**Find duplicates…** groups rows whose key columns all match. Use up to
three key columns, each with its own rule:

- **Exactly the same.** The value as stored. `100` and the text `100` are
  different here; use *Numbers within* with 0 if that matters.
- **Same text, ignoring case, spaces and punctuation.** `ACME Ltd.`,
  `Acme Ltd` and `acme-ltd` match. Accents are ignored and `&` reads as
  *and*.
- **Similar spelling (at least % alike).** Catches typos such as
  `Jonathon Smith` and `Jonathan Smith`. 90% is a good start; lower finds
  more and lets in more false matches. The score is Jaro-Winkler, which
  weighs the start of a name most.
- **Numbers within** a difference you set, such as 0.01 or 5.
- **Dates within** a number of days.

Typical tests: same vendor and amount (exact); same vendor, amount within
1.00 and date within 7 days; vendor names spelled alike (possible
duplicate vendors).

Blank keys are never duplicates. Near matches chain: if A is near B and B
is near C, all three are one group even if A and C are further apart.

The result sheet lists each group with a **Group** number, the sheet
**Row**, and the whole row.

To stay fast on large sheets, similar spelling only compares names that
share the first three letters of some word, and in very common words only
compares names that sort close together. A pair whose words all start
differently (`Acme` and `Akme Ltd`) can be missed.

## Gaps in a sequence

**Find gaps in a sequence…** checks invoice, cheque, journal or receipt
numbers. It works with plain numbers and with codes that have a number in
them, such as `INV-0001` or `104562/A`. Codes with different text around
the number (`INV-` and `CN-`) are checked as separate series, so a stray
code shows up as a series of its own.

It reports:

- **Missing** numbers, as ranges (`INV-0005` to `INV-0009`, 5 numbers).
- **Used more than once**, with the rows.
- **Out of order**: a number lower than the one before it in
  the same series (in sheet order).

Rows with no whole number (blank, text only, a fraction) are left out and
counted.

## Benford's law

**Benford's law test…** compares how often each leading digit appears with
what Benford's law expects (a 1 about 30% of the time, a 9 under 5%).
Choose the **first digit** (1 to 9) or the **first two digits** (10 to
99); the first-two test is better at finding a specific made-up amount.

Zeros, blanks and text are left out, and negative amounts count by their
size. The first-two test also leaves out values under 10.

You get:

- **MAD** (mean absolute deviation) with Nigrini's conformity ranges:
  close, acceptable, marginally acceptable or nonconformity. This is the
  main result.
- **Chi-square** with its 5% critical value and p-value. With thousands of
  values chi-square flags even tiny differences, so lean on MAD.
- A **z-statistic** per digit. Above 1.96 means the digit stands out
  (significant at 5%); these are marked in the chart and the sheet.

Benford fits amounts that arise naturally and span several orders of
magnitude, such as invoices or payments, with at least a few hundred
values. It doesn't fit assigned numbers, prices set by policy, or amounts
with a floor or ceiling.

## Stratification

**Stratify values into bands…** counts and totals the values in each band.
Type band boundaries such as `0, 1000, 10000, 100000` (without thousands
separators; each boundary starts a new band), or leave the box empty for
round bands of equal width. The sheet shows the count, total, share of
count and of value, and the smallest and largest value per band.

## Largest items and Pareto

**Largest items (top N)…** lists the biggest values with their share of
the total and the running share. By default it ranks by size, so large
credits are included.

**Pareto analysis…** totals the amounts per vendor, customer or account
(or takes each row on its own), sorts them from largest to smallest and
shows how many make up 80% (or the cut-off you choose) of the total.

## Ageing

**Ageing buckets…** ages each item by the days from its date to the
**as-of** date. The buckets end at the days you give: `30, 60, 90` makes
0-30, 31-60, 61-90 and Over 90. Dates after the as-of date go in **Not
yet due**. With an amount column the buckets show totals; without one they
count items. Tick **Also add a sheet listing every row** for the age and
bucket of each row.

## Sampling

**Pick a sample…** offers four methods:

- **Random**: every non-blank row has the same chance.
- **Systematic**: every *n*th row from a random start, where *n* is the
  rows divided by the sample size.
- **Stratified**: the amounts are split into value bands (your boundaries,
  or three equal bands) and each band is sampled at random, in proportion
  to its size, with at least one item from each band.
- **Monetary unit (MUS)**: each currency unit has the same chance, so
  larger items are more likely to be picked. Give an **interval**, or a
  sample size and the interval is the total divided by it. Items at or
  above the interval are always picked (**sure-take**). Zero, negative and
  blank amounts can't be picked by MUS; the dialog counts them so you can
  test them another way.

Every sample uses a **seed**. The same seed on the same rows picks the same
items again, so a reviewer can repeat your sample. The seed, method and
interval are written in the **Method** column of the sample sheet; keep
them with your working papers. To repeat an earlier sample, type its seed
in the dialog.
