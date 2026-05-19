# Importing a trial balance

Open or paste the trial balance as your accounting system exports it, then
choose **Map this sheet as a trial balance…** from the command palette
(Ctrl+K).

## Saying what each column is

cellforge finds the header row (skipping company name and report titles)
and guesses each column:

- **Account code** and **Account name**, or **Code and name together** for
  a column like `1000 - Cash at bank`, which is split in two.
- **Debit** and **Credit**, or a single **Balance (signed)** where credits
  are negative, in brackets `(3,000.00)` or marked `CR`.
- **Prior debit / Prior credit / Prior balance** for the comparative
  period. Headers with years (`2023`, `2024`) put the earlier year as
  prior; a second Debit / Credit pair is taken as prior; so are headers
  with *prior*, *previous*, *last year* or *PY*.

Change any guess with its dropdown; the checks update straight away.

## Checks

- **Debits equal credits**, for this period and the prior one; if not, the
  difference is shown.
- **Account codes used more than once.**
- **Values that aren't numbers** in money columns (a letter O typed for a
  zero, say), with a link to each in the sheet.
- Total and heading rows are left out.

## The result

**Make the trial balance sheet** adds a sheet with **Code**, **Name**,
**Current** and, when there's a prior period, **Prior** and **Movement**.
Debits are positive and credits negative, shown in brackets. One **Undo**
removes it.
