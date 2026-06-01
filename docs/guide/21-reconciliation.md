# Reconciling two sheets

Put the two sides in two sheets. That could be the ledger and the bank
statement, two sub-ledgers, or your records and a supplier statement. Then
choose **Reconcile two sheets…** from the command palette (Ctrl+K).

## Picking the sides and columns

Side A is the sheet you're on and side B is the next one. Change either
with the dropdowns at the top. For each side, say which column is:

- **Reference**: an invoice number, cheque number, document ID and so on.
  Only map it when both sides use the same references. If the bank's
  references have nothing to do with your ledger's, leave it as (none).
- **Amount**.
- **Minus column (credits)**: for a Debit / Credit layout. The amount is
  debit minus credit.
- **Date**. Text dates are read day-first unless the column shows they're
  month-first (13/02 vs 02/13).
- **Description**: used by the fuzzy pass.

cellforge guesses each one from the headers and the values. Check the
guesses before you match.

## Tolerances

- **Amount tolerance** and **Or percent**: how far apart two amounts can
  be and still match. When you fill in both, the larger one applies.
- **Date window ± days**: how far apart two dates can be. Leave it blank
  to ignore dates.
- **B amounts have the opposite sign**: tick this when money out is
  negative on one side and positive on the other, as with a bank statement
  against a cash book.

## The passes

Matching runs in passes, strictest first. Each pass only looks at what the
earlier passes didn't match. Untick any pass you don't want.

1. **Same reference and amount.** If a reference appears more than once,
   the nearest date wins.
2. **Same reference, within tolerance**, with dates inside the window.
3. **Normalised reference.** Case, spaces, punctuation, leading zeros and
   prefixes like INV, REF, PO and CHQ are ignored, so `INV-000123`,
   `inv 123` and `#123` all count as the same.
4. **Similar description**, with the amount within tolerance and the date
   inside the window. "Description match %" sets how alike the
   descriptions must be. Word order and punctuation don't count, so
   `Smith, John` matches `JOHN SMITH`.
5. **Amount and date only**, for sides with no shared reference. Two items
   whose references are both filled in but different are never paired here.
6. **Sums.** One item on one side can equal the sum of 2 or more items on
   the other side ("Sum up to items" sets the most). Either side can hold
   the single item. The items must share the reference, or, without one,
   fall inside the date window. The search has a limit so it stays fast.
   When it stops early, the summary says so.

## What you get

Press **Match** to see the summary: the match rate, the count for each
pass, mismatched and unmatched counts, the unmatched totals for each side,
and the duplicates. 100,000 rows a side takes a second or two.

- **Mismatched**: the same reference on both sides, but the amount is
  beyond the tolerance or the date is outside the window.
- **Unmatched A / Unmatched B**: everything left over.
- **Duplicates within a side**: rows with the same reference (or
  description), amount and date.
- **Possible keying errors**: pairs where one amount looks like a typing
  mistake of the other. That means two digits swapped (1,234 / 1,243; the
  difference always divides by 9), one wrong digit, a decimal point in the
  wrong place (×10, ×100) or a flipped sign. A reference with two
  characters swapped is flagged too.

**Add result sheets** adds four sheets. Each row keeps its row number from
the original sheet.

- **Rec matched**: one row for each record, grouped, with the rule that
  matched it, the amount difference and the days between the dates.
- **Rec unmatched A** and **Rec unmatched B**, with a Note column for
  keying errors, duplicates and sums that weren't fully searched.
- **Rec mismatched**: both sides next to each other, with the difference.

Each sheet is one step in the history, so Undo removes them one at a time.

## Why don't these match?

After matching, type a row from side A and a row from side B and press
**Explain**. cellforge lists every difference it finds:

- references that differ in case, spaces, punctuation, a prefix or
  leading zeros (and what they normalise to)
- references with two characters swapped or one character wrong
- an amount difference, opposite signs, swapped digits or a misplaced
  decimal point
- the number of days between the dates, against the window
- how alike the descriptions are

When a setting would fix it, such as turning on normalised references,
flipping B's sign, widening the date window or allowing a small amount
difference, **Apply and match again** changes that setting and runs the
match again.
