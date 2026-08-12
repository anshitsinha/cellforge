# Templates

**New from a template (monthly close, bank rec, audit tests)…** in the
command palette starts a workbook that's already set up for one of the three
main jobs. Each starts with a **Start here** sheet that walks through the
steps and names the commands to use, and has data checks, conditional
formats, workpaper references and a tick-mark legend ready.

## Monthly close

- **TB current** and **TB prior**: paste Code, Name, Debit, Credit; Balance
  works itself out (debits positive, credits negative).
- **Mapping**: each account code and its report line and type (a dropdown).
- **Settings**: the flux thresholds, as the names `Threshold` (amount) and
  `ThresholdPct` (percent).
- **Flux**: this month against last, with the change and change %, and
  "Explain" in yellow where a change passes both thresholds. Accounts with
  no mapping show "(not mapped)" in red.
- Checks: the TB balances; every account is mapped; no code twice; every
  flagged change has an explanation (a warning).

## Bank reconciliation

- **Cash book** and **Bank statement**: Date, Reference, Description, Amount.
- **Outstanding**: items that explain the difference, each with a kind from a
  dropdown (deposit in transit, outstanding payment, bank error, bank-only
  item, ledger error).
- **Rec**: the reconciliation statement, worked out from the cash book and
  the outstanding items; type the statement's closing balance into B3. The
  difference turns red if it isn't zero.
- Checks: no difference; every outstanding item has a kind.

## Audit tests

- **Population**: Entry, Date, Posted, User, Account, Description, Amount,
  Reference.
- **Results**: one line per test (duplicates, gaps, Benford, journal entry
  tests, stratification, sample) with a status dropdown, exceptions,
  conclusion and workpaper reference, and counts of the population.
- Checks: every entry has an amount; every finished test has a conclusion.
