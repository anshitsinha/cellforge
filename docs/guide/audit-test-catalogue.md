# Audit test catalogue

Every audit and analytics test in cellforge, what it finds and what you
can set. Each one opens from the command palette (**Ctrl+K**) and works
on the sheet you have open. None of them changes your data: they add a
result sheet, and one **Undo** removes it. Every result sheet that lists
records has the row number in the original sheet.

For worked examples on sample data, follow the
[audit tests tutorial](#/tutorial/03-audit-tests).

## Data integrity

| Test | What it finds | Settings | Result sheet |
| --- | --- | --- | --- |
| **Find duplicates…** | Rows whose key columns all match: duplicate payments, invoices entered twice, vendors keyed twice under similar names | Up to three key columns, each with its rule: exactly the same; same text ignoring case, spaces and punctuation; similar spelling (at least % alike); numbers within; dates within (days) | `<sheet> duplicates`: each group with a group number and the whole rows |
| **Find gaps in a sequence…** | Missing numbers, numbers used more than once, and numbers lower than the one before (out of order), in invoice, cheque, journal or receipt numbers, plain or with text around them (`INV-0001`) | The column the numbers are in | `<sheet> gaps`: each issue with the series, the numbers and the rows |
| **Foot and cross-foot this range…** | Column totals and row totals that don't add up, and a grand total that disagrees with either | Heading rows at the top; label columns on the left; whether the last row and last column hold totals; differences up to this are fine (0.01) | `<sheet> footing`: every check, passed or not, with the stated and computed totals |
| **Roll-forward check…** | Lines where opening plus movements doesn't equal closing, in fixed asset, provision or similar schedules | Line name; opening balance; up to six movement columns, each adding or taking away; closing balance; differences up to this are fine | `<sheet> roll-forward`: every line with expected and actual closing and the difference, and a total |
| **Map this sheet as a trial balance…** | Debits that don't equal credits (this period and prior), account codes used twice, and values in money columns that aren't numbers | Which column is the code, name, debit, credit, signed balance, and prior period columns | `<sheet> TB`: code, name, current, prior and movement |
| **Import a bank statement (PDF or CSV)…** | Running balances that don't follow from the one before (a misread or missing line), and a closing balance that disagrees with the transactions | None: the columns and date order are worked out from the statement | `<file name>`: date, description, amount, balance, page and a balance check on every line |

## Analytics

| Test | What it finds | Settings | Result sheet |
| --- | --- | --- | --- |
| **Benford's law test…** | Leading digits that occur more or less often than Benford's law expects, a sign of made-up or manipulated amounts | The amount column; first digit (1-9) or first two digits (10-99) | `<sheet> Benford`: expected and actual share and count per digit, the difference, z-statistics, MAD with Nigrini's conformity verdict, and chi-square with its p-value |
| **Stratify values into bands…** | How the count and value of a population are spread across value bands, to plan testing | The amount column; band boundaries (`0, 1000, 10000`), or a number of equal bands | `<sheet> strata`: count, total, share of count and value, smallest and largest per band |
| **Largest items (top N)…** | The biggest values and how much of the total they make up | The amount column; how many; rank by size ignoring the sign (on to start with, so large credits count) | `<sheet> top N`: rank, row, value and running share |
| **Pareto analysis…** | The few vendors, customers or accounts that make up most of the total | The amount column; group by (or each row on its own); the cut-off (80%) | `<sheet> Pareto`: totals per group, largest first, with share and cumulative share |
| **Ageing buckets…** | How old open items are: receivables, payables, unreconciled items | The date column; the amount column (or count items); as-of date; bucket ends in days (`30, 60, 90`); also a sheet listing every row with its age | `<sheet> ageing`, and `<sheet> ageing rows` if asked |
| **Pick a sample…** | A repeatable sample for testing | Method: random, systematic (every nth row from a random start), stratified (random within value bands) or monetary unit (MUS); sample size; seed; for MUS the amount column and the interval (items at or above it are always picked); for stratified the band boundaries | `<sheet> sample`: the picked rows, why each was picked, and the method, seed and interval |

## Journal entries and fraud indicators

**Journal entry tests…** maps the columns of a general ledger export
(entry id, effective date, posted date and time, user, account,
description, signed amount or debit and credit), runs the tests below and
scores each entry by the weights of the tests it fails.

| Test | Flags an entry when | Setting | Weight |
| --- | --- | --- | --- |
| Entries that don't balance | debits and credits differ by more than 0.005 | | 5 |
| Duplicate entries | another entry has the same accounts and amounts, on the same date or within the days you set | Duplicates: dates at most (days) apart | 3 |
| Backdated entries | it was posted long after its effective date | Backdated: posted more than (days), 30 | 2 |
| Just below an approval limit | its total debits are just under a limit | Approval limits; just below: within %, 5 | 2 |
| Unusual user for the account | a user posted very few lines to a busy account, or very few entries at all | Unusual user: at most (lines), 2, on accounts with at least (lines), 10; users with at most (entries), 2 | 2 |
| Seldom-used accounts | it uses an account that appears in very few entries | Seldom-used: account in at most (entries), 3 | 2 |
| Keywords in the description | a word in the description starts with a keyword | Keywords (adjust, reverse, correction, plug, misc, suspense, write off…) | 2 |
| Weekend and holiday postings | it is dated or posted on a Saturday, Sunday or a holiday | Holidays | 1 |
| Posted outside working hours | it was posted before or after working hours | Working hours from, 8; to, 18 | 1 |
| Round amounts | a line is a round amount | Round: multiple of, 1,000; or trailing zeros at least | 1 |
| Near the period end | it is dated in the last days of the month, quarter or year | Near the period end: last (days), 3; period | 1 |

The result is `<sheet> JE flags`, every line of every flagged entry with
its rank, score, tests and reasons in words, and `<sheet> JE summary`
with a count per test. More in [journal tests](#/guide/28-journal-tests-and-safe-sharing).

| Test | What it finds | Settings | Result sheet |
| --- | --- | --- | --- |
| **Red-flag overlaps (vendor vs employee)…** | Pairs across two lists, usually vendors and employees, that share a bank account, tax id, phone number or address, or have similar names | The two sheets; the name, bank account, address, phone and tax id columns on each; what to compare; names alike: at least % (92) | `Overlaps <A> v <B>`: each pair with a score, what matched and both rows |

## Reconciliation

| Test | What it finds | Settings | Result sheets |
| --- | --- | --- | --- |
| **Reconcile two sheets…** | Matched items, items on one side only, items with the same reference but a different amount or date, duplicates within a side, and likely keying errors (swapped digits, a slipped decimal point, a flipped sign) | Reference, amount, minus (credit) column, date and description on each side; amount tolerance, or percent; date window ± days; B amounts have the opposite sign; which passes to run; description match %; sum up to items | **Rec matched**, **Rec unmatched A**, **Rec unmatched B**, **Rec mismatched** |

The passes run strictest first: same reference and amount; same
reference within tolerance; normalised reference; similar description;
amount and date only; and sums (one item against several). See
[reconciling two sheets](#/guide/21-reconciliation).

## Before you share

| Test | What it finds | Settings | Result sheet |
| --- | --- | --- | --- |
| **PII scan and safe copy…** | Personal data: email addresses, phone numbers, IBANs, card numbers, US social security and UK national insurance numbers, and columns named like dates of birth, names, addresses and id numbers | For each column: keep, mask, hash, pseudonymise or redact; salt for hashing; hash length; also add the pseudonym mapping as a separate sheet | `<sheet> safe copy`, and `<sheet> pseudonym map` if asked |
| **Circle invalid data** | Cells that break their data validation rule | The rules set with **Data validation (dropdown list, allowed values)…** | None: the cells are circled in red |
