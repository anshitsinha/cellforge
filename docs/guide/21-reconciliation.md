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
   `inv 123` and `#123` all count as the same, and so do `DEP-4471`
   and `DEP004471`. When the amounts are exactly the same the date
   window doesn't apply, so a cheque presented a week after it was
   written still matches.
4. **Similar description**, with the amount within tolerance and the date
   inside the window. "Description match %" sets how alike the
   descriptions must be. Word order and punctuation don't count, so
   `Smith, John` matches `JOHN SMITH`.
5. **Amount and date only**, for sides with no shared reference. Two items
   whose references are both filled in but different are never paired here,
   and an item whose reference is on the other side waits for that item.
   When several items have the same amount (a run of 100.00 payments), pairs
   whose descriptions name the same party (`Payment to Apex Plastics` and
   `BACS APEX PLASTICS`) go first, best first; the rest pair by nearest
   date.
6. **Sums.** One item on one side can equal the sum of 2 or more items on
   the other side ("Sum up to items" sets the most, 4 by default). Either
   side can hold the single item. Items that share the reference come
   first; if all of them add up, they match however many there are.
   Without a shared reference the items must fall inside the date window
   and have the same sign, and a sum only counts when exactly one
   combination adds up and the window holds few enough items that it's
   unlikely to be chance. The search has a limit so it stays fast. When it
   stops early, the summary says so.

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
  characters swapped is flagged too. When no reference ties the two, the
  descriptions must name the same party, so a cheque for 36.00 and a bank
  fee of 30.00 aren't called a keying error.

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

## Bank rec statement and adjusting entries

Choose **Bank rec statement…** from the command palette. Put the ledger
(cash book) on the left and the bank statement on the right, check the
columns, and fill in the two closing balances: the one on the bank
statement and the one in the ledger. Amounts are read in the ledger's
sign, so money in is positive. Enter an overdraft as a negative balance.
If the bank shows money out as positive, tick **Bank amounts have the
opposite sign**.

**Run** matches the two sides the same way as **Reconcile two sheets**,
then sets out the standard statement:

| Bank side | Ledger side |
| --- | --- |
| Balance per bank statement | Balance per ledger |
| Add: deposits in transit (receipts in the ledger only) | Add: receipts on the bank only (interest, direct credits) |
| Less: outstanding payments (payments in the ledger only) | Less: payments on the bank only (fees, direct debits) |
| Add / less: bank errors | Add / less: errors in the ledger |
| **Adjusted bank balance** | **Adjusted ledger balance** |

The **difference** between the two adjusted balances should be nil. When
it isn't, check the balances and make sure both sheets cover the same
period. Last period's outstanding items are rolled forward separately
(see below).

Errors are the differences on items that are the same on both sides: a
mismatched pair (same reference, different amount), a match inside the
tolerance that's a few cents out, and an unmatched pair that looks like a
keying error (1,243 against 1,234). By default these are the ledger's
errors. Pick **Errors are the bank's** to show them on the bank side
instead. A ledger posting entered twice (the same reference, amount and
date as one that matched the bank) is always an error in the ledger, not
a deposit in transit or an outstanding payment, and gets a reversing
entry.

**Add result sheets** adds two sheets:

- **Bank rec statement**: each line with its total, and the items behind
  it underneath, with their row numbers on each side.
- **Adjusting entries**: a proposed journal for each item on the ledger
  side. Each item on the bank only is posted against the bank account
  (named in **Bank account name**) and an account chosen from the
  description: bank charges for fees and commission, interest income or
  expense, FX gains and losses, tax, accounts receivable for a returned
  cheque, and accounts payable with the payee's name for a direct debit.
  Anything else goes to Suspense. A keying error gets a correcting entry
  for the difference, such as "two digits swapped: decrease by 9.00".
  These are proposals: check them before you post them.

## Roll forward outstanding items

Choose **Roll forward outstanding items…**. On the left, put last
period's outstanding items, such as the deposits in transit and
unpresented cheques from the last statement. On the right, put this
period's data, which is usually the new bank statement. Set the date to
age to (it starts at the latest date in the two sheets) and the ageing
buckets.

The items are matched by reference first, whatever the dates, and then by
amount (and by sums). Each item from last period comes out as:

- **Cleared**, with the date it cleared, the days it took and the rows that
  cleared it;
- **Cleared, amount differs**: a cheque with the same number cleared for a
  different amount;
- **Still open**, with its age and ageing bucket. Items older than **Stale
  after days** (180 by default) are flagged. A cheque that old may need
  writing back.

The summary shows the total brought forward, cleared and still open, and
how many of this period's items cleared last period's. Leave those items
out when you reconcile this period.

## Open-item matching in one account

For a suspense or clearing account, or an AR or AP control account,
choose **Open-item matching (one account)…** and map the account's sheet.
Use one amount column (debits positive, credits negative) or a Debit and
a Minus (credits) column. To match only within each customer, supplier or
employee, map a **Party** column.

Within each party, items are cleared in this order:

1. **One reference nets to zero**: every item carrying the same
   (normalised) reference adds up to nil. For example, an invoice and its
   two part payments.
2. A debit against a credit with the same reference and amount.
3. A debit against a credit for the same amount when the references
   differ or are missing, nearest date first. To keep pairs close
   together, set a date window.
4. One item against the sum of several on the other side.

Items of 0.00 clear themselves. Everything else is open. An invoice with
a part payment under the same reference stays open with a note such as
"part settled … 20.00 left".

You get two sheets. **Open items** has the party, age and ageing bucket
for each item. **Cleared items** shows each cleared group with its rule
and the date it cleared. The summary splits the account balance into
cleared and open, so the open items add up to the balance.

## Supplier / customer statement rec

Choose **Supplier / customer statement rec…**. Put your ledger for one
supplier (or customer) on the left and their statement on the right. If
both sheets have a column for the document type (Invoice, Credit note,
Payment), map it as **Document type**. Without one, the type is worked out
from the reference (CN-12 is a credit note), the description and the sign.

The two sides usually show amounts with opposite signs. In your purchase
ledger an invoice is a credit, but on the supplier's statement it's a
debit. cellforge guesses the two sign settings from the balances, so check
**Their amounts have the opposite sign to ours** and **Invoices are
positive in our ledger** before you run it. The statement shows every
amount with invoices positive, so a balance owed is positive on both
sides.

Items are matched by document number first. `INV-1001` on your side
matches `1001` on theirs, whatever the dates. Whatever is left is then
matched by amount and date (± 7 days by default) and by sums. The rec
then runs from their balance to yours:

- Invoices on their statement not in our ledger
- Credit notes on their statement not booked by us
- Payments on their statement not in our ledger
- Payments in transit (in our ledger, not yet on their statement)
- Invoices and credit notes in our ledger not on their statement
- Amount differences (same document, different amount; keying errors are
  named)

The result is the calculated balance per our ledger, compared with the
stated one. Leave either balance blank to use the items added up. Fill in
**Their statement date** and anything of yours dated after it is noted as
a cut-off item. The sheets are **Statement rec** (the lines with the items
behind them) and **Statement rec matched**.
