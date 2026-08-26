# Acceptance test: a bank / ledger month at 6K and 6M rows

PLAN.md (M5) asks for an acceptance test on a synthetic bank and ledger
month modelled on real data. This page says what it covers, how to run it,
and the current numbers.

## What it does

`bench/acceptance/generate.ts` makes one month (March 2025) of a cash book
for a bank account (the ledger, side A) and the bank statement for it
(side B). It is seeded, so a seed and a size always give the same files
byte for byte. The size is the total number of transaction lines in the two
files (ledger ≈ bank ≈ half each).

Both are written out as CSV the way real systems export them:

- **Ledger** (GL detail report): title rows, a "Printed …" line, an opening
  and closing balance row, a daily "Total for dd/mm/yyyy" subtotal, a page
  footer ("Page 3 of 52") and repeated header every 60 lines, "End of
  report". Amounts as `(1,234.56)`, `-1234.56` or `1,234.56-`; dates as
  `05/03/2025` (mostly), `2025-03-05` or `5-Mar-25`; a running balance.
- **Bank**: title rows, `Date, Description, Reference, Paid out, Paid in,
  Balance`, dated `BALANCE BROUGHT FORWARD` / `BALANCE CARRIED FORWARD`
  lines at every page break, page footers, a dated `CLOSING BALANCE`.
  Dates as `05 Mar 2025` or `05/03/2025`. Descriptions in bank style
  (`BGC`, `FPO`, `BACS`, `CARD PAYMENT TO … ON 05MAR`, `DD …`), upper
  case, sometimes without the Ltd / plc, sometimes cut at 18 characters.

About 15,000 counterparties. Amounts are log-normal around a few hundred
pounds; a fifth are whole pounds and one in twenty whole hundreds, so
plenty of items share an amount. The bank date is 0–3 days after the
ledger date (cheques 1–6 days).

### What is planted, and what should happen to it

| Category | Share | Expected |
| --- | --- | --- |
| Exact: same reference string, same amount | 69% | matched |
| Reference format differs: `INV-0012345` vs `12345`, `inv 0012345`, `#12345`, `INV12345`; cheques `CHQ 012345` vs `12345` | 10% | matched |
| Description only: no reference on the bank line | 7% | matched |
| Split payment 1:N: an invoice paid in 2, 3 or 4 parts, each part quoting the reference | 1.2% | one match holding all parts |
| Batched deposit N:1: 2–4 receipts banked on one paying-in slip (`DEP-4471` in the ledger, `DEP000004471` on the bank) | 1.2% | one match |
| Batched deposit N:1 without a reference (`COUNTER CREDIT`) | 0.6% | one match |
| Duplicate ledger posting | 0.4% | original matched, the copy listed as a duplicate and shown as a ledger error |
| Amount keyed wrong, same reference: two digits swapped / one digit wrong / sign flipped | 1.1% | a mismatched pair flagged with that keying error |
| Amount keyed wrong (digits swapped), no reference on the bank | 0.3% | both unmatched, the pair flagged |
| Reference typo (two digits swapped), same amount | 0.4% | flagged (or matched) |
| Deposit in transit (receipts in the last 3 days, not on the bank) | 1% | "Add: deposits in transit" |
| Unpresented cheque | 1.2% | "Less: outstanding payments" |
| Bank fee, interest, direct debit (bank only) | 4% | "receipts / payments on the bank only" |

The answer key is kept per line: every ledger and bank line knows the
planted group it belongs to, and every line of each CSV file knows which
transaction it is (or that it is a title, total or footer).

### The pipeline, as a user would run it

`bench/acceptance/pipeline.ts`, shared by the test and the bench:

1. parse both CSVs in 64 KB chunks with `CsvParser`;
2. `parseStatement` over the bank rows: every running balance must follow
   and the closing balance must agree;
3. `unwrapReport` on both: titles, totals, footers, repeated headers and
   balance lines dropped;
4. `profileColumn` on every column, values read with `parseAs`;
5. records as the reconcile dialog builds them (key, amount = in − out,
   date, description);
6. `reconcile` with the **default settings**;
7. `recStatement` with the two closing balances read off the reports;
8. score against the answer key.

### What is checked

- **Recall per planted category** (table below; the bar is in the "need"
  column): ≥ 99% of exact matches, ≥ 95% of reference-format and
  description-only matches, every 1:N split up to k = 4 and every batched
  deposit with a slip reference, ≥ 90% of batched deposits without one,
  every keying error with a reference, every duplicate, ≥ 99% of timing
  and bank-only items on the right line of the rec statement.
- **Precision per rule**: ≥ 99% of the matches each rule makes are
  planted pairs/groups.
- No false keying flags, no false duplicate groups.
- Clean-up: no non-transaction row left as a record, no transaction lost,
  every date and amount read, each column profiled as the right type.
- Every record is in a match, a mismatched pair or a rec statement line;
  the rec statement difference is 0.
- The bank statement's running balance has no breaks.
- The 6K run takes under 5 s (it takes about 0.3 s).

When something isn't met, the test fails with the whole report (stage
times, the category table, the rule table) and a list of what fell short.

## Running it

```sh
npx vitest run packages/core/test/acceptance.test.ts      # 6K, part of the normal test run
node --max-old-space-size=12000 --import ./bench/acceptance/register.mjs bench/acceptance/run.ts 6000000
node --import ./bench/acceptance/register.mjs bench/acceptance/run.ts 60000 7   # any size, any seed
```

`register.mjs` lets plain Node run the TypeScript sources (it resolves
extensionless imports and strips types with the transformer Vite ships).
Add `--no-statement-check` to skip the `parseStatement` stage.

## Current numbers

Windows 11, Intel i5-10300H, Node 26.

### 6K rows (ledger 3,005, bank 3,008)

| Stage | ms |
| --- | ---: |
| generate month | 8 |
| write CSV exports | 23 |
| parse CSV | 9 |
| bank statement check | 49 |
| unwrap reports | 25 |
| profile columns | 59 |
| build records | 8 |
| reconcile | 69 |
| rec statement | 20 |
| **total** | **≈ 275** |

Peak RSS 111 MB.

| Planted category | planted | found | recall | need |
| --- | ---: | ---: | ---: | ---: |
| Exact | 2,129 | 2,129 | 100% | 99% |
| Reference format differs | 309 | 309 | 100% | 95% |
| Description only | 216 | 216 | 100% | 95% |
| Split 1:N (k = 2 / 3 / 4: 13 / 12 / 12) | 37 | 37 | 100% | 100% |
| Batched deposit with slip ref | 37 | 37 | 100% | 100% |
| Batched deposit, no ref | 19 | 18 | 94.7% | 90% |
| Duplicate ledger posting | 12 | 12 | 100% | 100% |
| Digits swapped / one digit / sign flipped | 12 / 12 / 10 | all | 100% | 100% |
| Digits swapped, no ref | 10 | 10 | 100% | 95% |
| Reference typo | 12 | 12 | 100% | 95% |
| Deposits in transit / unpresented cheques | 31 / 37 | all | 100% | 99% |
| Fees / interest / direct debits | 62 / 2 / 56 | all | 100% | 99–100% |

Every rule's precision is 100% (exact 2,141, reference 309, fuzzy 58,
amount+date 158, one-to-many 37, many-to-one 55). 56 keying flags, none
false; 12 duplicate groups, none false. Rec statement difference 0.

### 6M rows

Ledger 3,005,551, bank 3,006,169 lines. `--max-old-space-size=12000`.

| Stage | s | heap after, MB | RSS after, MB |
| --- | ---: | ---: | ---: |
| generate month | 2.9 | 646 | 917 |
| write CSV exports (≈ 520 MB of text) | 12.8 | 1,359 | 1,799 |
| parse CSV | 4.6 | 2,919 | 3,269 |
| bank statement check (`parseStatement`) | 36.9 | 5,327 | 5,705 |
| unwrap reports | 20.5 | 4,273 | 4,777 |
| profile columns (11 columns) | 27.9 | 7,168 | 7,668 |
| build records | 6.1 | 3,052 | 6,105 |
| reconcile (3M × 3M) | 76.2 | 4,747 | 5,777 |
| rec statement | 5.2 | 4,976 | 5,986 |
| **total** | **≈ 194** | | peak RSS **7,956** |

| Planted category | planted | found | recall | 6K bar |
| --- | ---: | ---: | ---: | ---: |
| Exact | 2,129,192 | 2,129,192 | 100% | 99% |
| Reference format differs | 308,578 | 308,578 | 100% | 95% |
| Description only | 216,005 | 214,879 | 99.5% | 95% |
| Split 1:N (k = 2 / 3 / 4, 12,343 each) | 37,029 | 37,029 | 100% | 100% |
| Batched deposit with slip ref | 37,029 | 37,029 | 100% | 100% |
| Batched deposit, no ref | 18,515 | 0 | 0% | 90% |
| Duplicate ledger posting | 12,343 | 12,015 | 97.3% | 100% |
| Digits swapped / one digit / sign flipped | 12,343 / 12,343 / 9,257 | all | 100% | 100% |
| Digits swapped, no ref | 9,257 | 5,735 | 62.0% | 95% |
| Reference typo | 12,343 | 11,457 | 92.8% | 95% |
| Deposits in transit | 30,858 | 30,191 | 97.8% | 99% |
| Unpresented cheques | 37,029 | 35,339 | 95.4% | 99% |
| Fees / interest / direct debits | 61,716 / 617 / 55,544 | 60,666 / 484 / 55,544 | 98.3% / 78.4% / 100% | 99–100% |

| Rule | matches | precision |
| --- | ---: | ---: |
| exact | 2,141,535 | 100% |
| reference | 308,578 | 100% |
| fuzzy | 55,089 | 98.8% |
| amount+date | 165,437 | 97.0% |
| one-to-many / many-to-one | 37,029 / 37,029 | 100% |

Match rate 93.8%; 5,647 wrong matches (47 of them pair the same party,
amount and kind); 52,266 keying flags (1,131 not planted); clean-up
perfect (no junk records, no lost lines, every value read); 0 balance
breaks; rec statement difference 0.

Everything that a reference ties together holds at 6M exactly as at 6K.
What drops is what rests on amount and date alone: with ~100,000 lines a
day, a leftover deposit in transit, bank fee or keyed-wrong line often
has a same-amount stranger within ±3 days, and the amount + date pass
pairs them (most of the wrong matches; they pull the timing and
bank-only categories below their bars). The thresholds are enforced on
the 6K run; the 6M run reports and exits non-zero listing what it misses.

## What the test found, and what was fixed

All in `packages/core/src`, each with focused tests in
`packages/core/test/recfixes.test.ts`.

1. **Leading zeros after letters** (`recon/text.ts`, `normRef`):
   `DEP-4471` and `DEP004471` were different references, so every
   batched deposit with a zero-padded slip number went unmatched.
   `explain()` already called them the same. Zeros after a leading run of
   letters are now dropped.
2. **Cheques that clear after the date window** (`recon/match.ts`,
   reference pass): `CHQ 102132` against `102132` six days later, same
   amount, ended up "mismatched" with a difference of 0.00. The exact pass
   ignores the window; the reference pass now does too when the amounts are
   exactly the same (nearest date first). With a tolerance the window
   still applies.
3. **Splits of four** (`recon/match.ts`, sum pass): the default
   `sumMaxItems` was 3, so a 4-part split never matched. Items that share
   a reference and add up as a whole now match however many there are, and
   the default is 4.
4. **Sums found by coincidence** (`recon/match.ts`, sum pass,
   `subsetSum`): without a reference, the sum pass took the 24 nearest
   items by date and accepted the first combination that added up. It
   matched a 60.00 cheque to three bank fees, interest to three deposits in
   transit, a payment plus a receipt to a fee. Now: sums by reference run
   first (both ways); the date search only uses items of the same sign, only
   when it can search everything in the window, takes the fewest items
   first, needs exactly one combination to add up (`subsetSum(…, unique)`
   reports a second as ambiguous) and skips a search where so many
   combinations exist that one would add up by chance (`chanceSums`). It
   runs in rounds, so a sum that was ambiguous can match once others have
   taken their items. An item whose reference the other side has is left
   for that item.
5. **Equal amounts paired with the wrong party** (`recon/match.ts`,
   amount + date pass): several 100.00 payments in a few days were paired
   in ledger order by nearest date. Pairs whose descriptions name the same
   party (a word in common that isn't a banking word, `nameWords` /
   `sharesName` in `recon/text.ts`) now go first, best pairs first across
   the whole run; among the rest, ties go to the more similar description.
   An item whose reference is anywhere on the other side isn't matched on
   amount alone (the second copy of a duplicate was clearing an unrelated
   bank line).
6. **Fuzzy pass ignored references** (`recon/match.ts`): two items with
   different references and similar descriptions were matched; now
   references that differ rule a pair out, as in the amount + date pass.
7. **False keying flags** (`recon/match.ts`, keying errors): with no
   reference to tie them, any unmatched pair one digit apart was flagged
   (a 36.00 cheque and a 30.00 fee), and the rec statement then moved both
   out of the timing lines into "errors". The descriptions must now name
   the same party when both sides have one.
8. **Duplicates on the rec statement** (`recon/statement.ts`,
   `recStatement`): the second copy of a ledger posting showed as a deposit
   in transit or an outstanding payment. It is now an error in the ledger
   (`duplicatesAsErrors`, default on) and `proposeAdjustments` writes a
   reversing entry for it.
9. **Dated balance lines** (`clean/unwrap.ts`, `unwrapReport`):
   `01 Mar 2025, BALANCE BROUGHT FORWARD, …` was kept as a transaction (134
   junk records in the 6K bank file) because the total check looks at the
   first text cell, which was the date. Brought / carried forward and
   opening / closing balance lines are now dropped past a date; the whole
   cell must be the phrase, so an account called "Opening Balance Equity"
   stays.
10. **Stack overflow on big files** (`clean/bank.ts`, `parseStatement`;
    `clean/unwrap.ts`, `unwrapReport`): `Math.min(...years)` and
    `Math.max(...rows.map(…))` throw `RangeError` past ~100K rows. Now
    loops.
11. **Slow column profiles** (`clean/values.ts`): `profileColumn` parsed
    every value twice and `parseNumberLoose` ran its whole regex chain on
    plain numbers and on text with no digits; `valid()` built a `Date` per
    date. Fast paths and one pass: profiling the 6M-row month went from
    38.6 s to 27.9 s.

## Known limits

- **Batched deposits without a reference** are only matched when the date
  window holds few enough candidates that a sum is unlikely to be chance.
  At 6K rows that is 18 of 19; at 6M rows (about 100,000 lines a day)
  it's none, by design: they are reported as deposits in transit and bank
  receipts instead of being matched to the wrong items.
- **Amount + date at volume**: at 6M rows leftovers of different kinds
  share an amount within the window by chance and get paired (97.0%
  precision for that rule, 98.8% for fuzzy). A stricter rule (only pair
  when the amount is unique both ways) broke the existing contract that a
  reference-less bank file still auto-matches by amount and date
  (recon.test.ts, 100k x 100k), so it wasn't adopted; making the pass
  aware of volume is open.
- **Memory**: the pipeline holds every row as an array of strings
  (`unwrapReport` takes `string[][]`); at 6M rows peak RSS is several GB.
  The app keeps columns, not rows; a column-based unwrap would cut this.
- Both files start from the same opening balance, so there are no
  outstanding items brought forward from last month.
