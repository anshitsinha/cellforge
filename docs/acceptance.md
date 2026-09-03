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

1. parse both CSVs in 64 KB chunks with `CsvParser`, kept as columns
   (`ColumnCollector`: one array per column, no array per row);
2. `parseStatement` over the bank file, one line at a time
   (`columnsToLines`): every running balance must follow and the closing
   balance must agree;
3. `unwrapColumns` on both (the column form of `unwrapReport`, same
   answers): titles, totals, footers, repeated headers and balance lines
   dropped, the columns compacted in place;
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
- The 6K run takes under 5 s (it takes about 0.4 s).

When something isn't met, the test fails with the whole report (stage
times, the category table, the rule table) and a list of what fell short.

## Running it

```sh
npx vitest run packages/core/test/acceptance.test.ts      # 6K, part of the normal test run
node --max-old-space-size=12000 --import ./bench/acceptance/register.mjs bench/acceptance/run.ts 6000000
node --import ./bench/acceptance/register.mjs bench/acceptance/run.ts 60000 7   # any size, any seed
node --max-old-space-size=10000 --import ./bench/acceptance/register.mjs bench/acceptance/diag.ts 6000000 --why=descOnly,dit
```

`register.mjs` lets plain Node run the TypeScript sources (it resolves
extensionless imports and strips types with the transformer Vite ships).
Add `--no-statement-check` to skip the `parseStatement` stage.
`diag.ts` skips the CSV round trip (records straight from the generator;
the scores agree with the full run to within a few dozen items) and lists
the wrong matches by rule and planted category, with examples;
`--why=<categories>` says what happened to each line of the groups that
were missed.

## Current numbers

Windows 11, Intel i5-10300H, Node 26.

### 6K rows (ledger 3,005, bank 3,008)

| Stage | ms |
| --- | ---: |
| generate month | 9 |
| write CSV exports | 25 |
| parse CSV | 12 |
| bank statement check | 69 |
| unwrap reports | 31 |
| profile columns | 47 |
| build records | 10 |
| reconcile | 162 |
| rec statement | 24 |
| **total** | **≈ 390** |

Peak RSS 112 MB.

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
| generate month | 2.7 | 646 | 913 |
| write CSV exports (≈ 520 MB of text) | 13.5 | 1,359 | 1,802 |
| parse CSV (into columns) | 6.5 | 2,373 | 2,713 |
| bank statement check (`parseStatement`, line by line) | 31.8 | 2,991 | 3,323 |
| unwrap reports (`unwrapColumns`) | 16.7 | 1,836 | 2,911 |
| profile columns (11 columns) | 19.7 | 2,475 | 3,073 |
| build records | 4.8 | 3,540 | 3,924 |
| reconcile (3M × 3M) | 66.4 | 3,731 | 4,554 |
| rec statement | 5.7 | 3,962 | 4,804 |
| **total** | **≈ 169** | | peak RSS **4,838** |

Before this round (rows of strings, `unwrapReport`, `rowsToLines`, and
reconcile without its memory work) the same run peaked at 7,536 MB RSS
(7,956 in an earlier measurement) and took ≈ 217 s.

| Planted category | planted | found | recall | 6K bar |
| --- | ---: | ---: | ---: | ---: |
| Exact | 2,129,192 | 2,129,192 | 100% | 99% |
| Reference format differs | 308,578 | 308,578 | 100% | 95% |
| Description only | 216,005 | 215,872 | 99.9% | 95% |
| Split 1:N (k = 2 / 3 / 4, 12,343 each) | 37,029 | 37,029 | 100% | 100% |
| Batched deposit with slip ref | 37,029 | 37,029 | 100% | 100% |
| Batched deposit, no ref | 18,515 | 0 | 0% | 90% |
| Duplicate ledger posting | 12,343 | 12,343 | 100% | 100% |
| Digits swapped / one digit / sign flipped | 12,343 / 12,343 / 9,257 | all | 100% | 100% |
| Digits swapped, no ref | 9,257 | 9,243 | 99.8% | 95% |
| Reference typo | 12,343 | 12,342 | 99.99% | 95% |
| Deposits in transit | 30,858 | 30,850 | 99.97% | 99% |
| Unpresented cheques | 37,029 | 37,029 | 100% | 99% |
| Fees / interest / direct debits | 61,716 / 617 / 55,544 | all | 100% | 99–100% |

| Rule | matches | precision |
| --- | ---: | ---: |
| exact | 2,141,535 | 100% |
| reference | 308,578 | 100% |
| fuzzy | 55,475 | 99.96% (20 wrong) |
| amount+date | 160,435 | 99.99% (18 wrong) |
| one-to-many / many-to-one | 37,029 / 37,029 | 100% |

Match rate 93.6%; 38 wrong matches, 35 of them pair a line with another
line for the same party, amount and kind (two payments of 100.00 to the
same company in the same few days: nothing in the data tells them apart);
55,559 keying flags (31 not planted); 13,470 duplicate groups (1,127 not
planted: 1,098 are two bank fees with the same description and odd amount
on one day, e.g. `UNPAID ITEM FEE 5.27`, too rare on other days to count
as routine; 21 are two receipts on one paying-in slip with the same
amount; 8 others); clean-up perfect (no junk records, no lost lines, every value read); 0
balance breaks; rec statement difference 0.

Before the volume-aware passes the 6M run had: description only 99.5%,
duplicates 97.3%, digits swapped without a reference 62.0%, reference
typo 92.8%, deposits in transit 97.8%, unpresented cheques 95.4%, fees
98.3%, interest 78.4%; fuzzy precision 98.8%, amount + date 97.0% (5,647
wrong matches); 1,131 false keying flags, 2,476 false duplicate groups.

Everything a reference ties together held at 6M exactly as at 6K. What
dropped was what rests on amount and date alone: with ~100,000 lines a
day a leftover deposit in transit, bank fee or keyed-wrong line often has
a same-amount stranger within ±3 days. The passes now weigh that (fix 12
below), and every category but one meets its 6K bar at 6M. The
thresholds are enforced on the 6K run; the 6M run reports and exits
non-zero listing what it misses (now only the batched deposits without a
reference).

## What the test found, and what was fixed

All in `packages/core/src`, each with focused tests (in
`packages/core/test/recfixes.test.ts` unless it says otherwise).

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
    38.6 s to 27.9 s (19.7 s in the run above, which reads the columns
    directly: fix 14).

12. **Amount + date at volume** (`recon/match.ts`, `textModel`; fuzzy,
    amount + date and keying flags; `recon/text.ts`, `nameAgreement`,
    `kindOf`): at 6M rows the passes that rest on amount and date paired
    leftovers with strangers (97.0% precision, 98.8% fuzzy), pulling the
    timing and bank-only categories below their bars. A blunt "only when
    the amount is unique both ways" broke the reference-less bank file
    contract in `recon.test.ts`, so the passes now weigh each pair:
    - the run learns what agreeing descriptions look like from its own key
      matches (true pairs) against random leftovers (strangers): for each
      class of name agreement (words in common, a truncated word counts; a
      word left over on either side) and for transaction kinds that differ
      (cheque, card, fee, interest, direct debit, transfer, deposit), how
      much likelier it is between true pairs;
    - against that, the number of items of that amount in the window on
      the busier side (counted by binary search, not capped), any of which
      could show the same agreement by chance. A pair needs its evidence
      to outweigh that crowd. Without descriptions, a pair needs the two
      sides to hold about as many items of that amount in the window (at
      most 2 : 1), so a reference-less bank file still matches but a lone
      ledger item among a crowd of bank lines of its amount is left;
    - candidates come from an index by amount and party word (however many
      items of that amount the window holds) plus the nearest by date;
      pairs with descriptions go best first over the whole run, then those
      without, each ledger item in turn, nearest date first;
    - keying flags without a reference: every amount a typo could have
      made is a candidate, flagged only when names and kinds agree more
      than chance among that many candidates, best first; reference typos
      are looked up through an index of the reference with one or two
      characters blanked (the old search looked at the first 32 lines of
      that amount, which at volume were rarely in the window);
    - an item whose reference is anywhere on the other side (the copy of a
      matched posting) is left out of fuzzy and amount + date, as it
      already was from the rest of amount + date.

    Without enough key matches to learn from (fewer than 200 pairs with
    descriptions, e.g. a bank file with no references) the passes work as
    before. Tests: `packages/core/test/volume.test.ts`.
13. **Routine lines listed as duplicates** (`recon/match.ts`,
    `findDuplicates`): two `CHAPS FEE 15.00` lines on one day were a
    "duplicate" (2,476 such groups at 6M). A line known only by its
    description is now left out when that description and amount turn up
    on a quarter of the other days or more. Postings with a reference are
    unaffected.
14. **Memory at 6M** (`clean/unwrap.ts`, `clean/bank.ts`,
    `clean/values.ts`, `recon/match.ts`): rows were held as arrays of
    strings, unwrapped into a second copy, turned into 3M statement line
    objects at once, and reconcile made a string or a pool per record in
    several passes. Now the CSV is parsed into columns
    (`ColumnCollector`), unwrapped in place (`unwrapColumns`) and checked
    as a statement one line at a time (`columnsToLines`); `profileColumn`
    keeps no tuple per value; reconcile buckets exact matches without a
    key + amount string per item, searches small key groups without a
    pool, makes the reference sets and the word index once, and groups
    duplicates by sorting. Peak RSS at 6M: 7,536 → 4,838 MB; the run went
    from ≈ 217 s to ≈ 169 s. Tests:
    `packages/core/test/unwrapcolumns.test.ts`.

## Known limits

- **Batched deposits without a reference** are only matched when the date
  window holds few enough candidates that a sum is unlikely to be chance.
  At 6K rows that is 18 of 19; at 6M rows (about 100,000 lines a day)
  it's none, by design: they are reported as deposits in transit and bank
  receipts instead of being matched to the wrong items. This is the one
  6K bar the 6M run misses.
- **Same party, same amount, same few days**: 35 of the 38 wrong matches
  at 6M pair a line with another line for the same party, amount and kind
  (two 100.00 payments to one company in a week). Nothing in the data
  tells them apart.
- **Duplicate groups that weren't planted**: 1,127 at 6M (2,476 before),
  almost all two identical bank fees on one day at an odd amount
  (`UNPAID ITEM FEE 5.27`); the routine test only drops a description and
  amount that turn up on a quarter of the other days. The check doesn't
  count these against the bars (only planted duplicates are scored).
- **The volume-aware passes learn from the run's key matches.** With fewer
  than 200 key matches that have descriptions on both sides there is
  nothing to learn from, and fuzzy, amount + date and the keying flags
  work as before (nearest date, any shared name). A file whose two sides
  never name the party the same way learns that agreeing names are no
  evidence, and then leans on the 2 : 1 balance of amounts in the window.
- **Memory**: 6M rows still peak at about 4.8 GB RSS. What's left is
  mostly the 520 MB of CSV text (fields are slices of it), the 6M record
  objects the reconcile API takes, the normalised keys and texts inside
  reconcile, and V8 collecting late under a 12 GB heap limit.
- Both files start from the same opening balance, so there are no
  outstanding items brought forward from last month.
