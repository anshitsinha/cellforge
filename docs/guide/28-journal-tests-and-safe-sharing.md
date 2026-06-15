# Journal tests and safe sharing

These tools open from the command palette (Ctrl+K). Like the other audit
tests, they read your data, show a summary as you change the settings,
and add the result as a new sheet. Your data is never changed, and one
**Undo** removes each result sheet.

Every result sheet that lists rows has a **Row** column with the row
number in the original sheet, so you can go back to any item.

## Journal entry tests

**Journal entry tests…** runs the usual journal entry tests over a
general ledger export with one row per journal line.

### Map the columns

The dialog guesses which column is which from the column names. Check
the guesses under **Columns**:

- **Entry id.** The journal or document number. Lines with the same id
  are one entry. Without it, every line counts as its own entry and the
  balance and duplicate tests can't run.
- **Date (effective).** The date the entry is for.
- **Posted date / time.** When it was entered in the system. If it has a
  time, the after-hours test uses it.
- **Posted time.** Only if the time is in a column of its own.
- **User**, **Account** and **Description.**
- **Amount (signed)**, or **Debit** and **Credit.** With debit and credit
  columns the amount is debit less credit. Credits can be positive or
  negative numbers.

Day-first or month-first dates are worked out from the text dates in the
sheet.

### The tests

Untick a test to skip it. A test that needs a column you haven't mapped
says *not run* in the summary.

| Test | Flags an entry when | Weight |
|---|---|---|
| Entries that don't balance | debits and credits differ by more than 0.005 | 5 |
| Duplicate entries | another entry has the same accounts and amounts, on the same date (or within the days you set; -1 ignores the date) | 3 |
| Backdated entries | it was posted more than 30 days after its date | 2 |
| Just below an approval limit | its total debits are within 5% under a limit you give | 2 |
| Unusual user for the account | a user posted at most 2 lines to an account that has at least 10, or a user posted at most 2 entries in all | 2 |
| Seldom-used accounts | it uses an account that appears in at most 3 entries | 2 |
| Keywords in the description | a description has a word starting with a keyword (adjust, reverse, correction, plug, misc, suspense, write off…) | 2 |
| Weekend and holiday postings | it is dated or posted on a Saturday, a Sunday, or a holiday you list | 1 |
| Posted outside working hours | it was posted before 08:00 or from 18:00 | 1 |
| Round amounts | a line is a multiple of 1,000 (or has as many trailing zeros as you ask for) | 1 |
| Near the period end | it is dated in the last 3 days of the month (or quarter, or year) | 1 |

All the numbers in the table are settings under **Settings for the
tests**. Some notes:

- **Holidays** are dates separated by commas, such as
  `2024-12-25, 2024-12-26`.
- **Working hours** are hours from midnight: 8.5 means 08:30. A start
  later than the end (22 to 6) means a night shift. A posted time of
  exactly midnight counts as no time, since many systems store dates that
  way.
- **Approval limits** are numbers separated by commas, without thousands
  separators: `5000, 10000, 50000`.
- **Keywords** match the start of a word, ignoring case and punctuation:
  `adjust` finds *Adjustment* and *ADJ-ADJUSTED*, but `reverse` doesn't
  find *unreversed*.

The summary also says what share of entries falls near the period end,
against the share you'd expect if dates were spread evenly. Twice the
expected share or more is shown as a warning.

### Scores and the result

Each flagged entry scores the sum of the weights of the tests it fails.
The **JE flags** sheet lists every line of every flagged entry, highest
score first, with the **Rank**, **Score**, **Entry**, **Row**, the
**Tests** it failed, the **Reasons** in words (for example *Posted 44
days after its date*), and the whole original row. The **JE summary**
sheet lists each test with the number of entries and lines it flagged.

A high score is a reason to look, not a finding. Read the reasons and
follow up the entries that matter.

## Red-flag overlaps

**Red-flag overlaps…** compares two lists, usually the vendor master and
the employee master, and lists pairs that share details. Open both lists
as sheets first.

Pick the two sheets and check the guessed columns: name, bank account or
IBAN, address (plus a second address column such as the city, which is
joined to the first), phone and tax id. Then choose what to compare.

Values are tidied before they are compared:

- **Bank account and tax id:** letters and digits only, case ignored
  (leading zeros dropped from tax ids).
- **Phone:** the last 9 digits, so `+44 20 7946 0018` matches
  `020 7946 0018`.
- **Address:** case and punctuation ignored, and common words shortened:
  *Street* reads as *St*, *Road* as *Rd*, *Suite* and *Unit* as *Apt*.
- **Name:** legal forms and titles (Ltd, Inc, Mr) are dropped, and names
  are compared both as written and with the words sorted, so *Smith John*
  matches *John Smith*. Names count as alike at 92% Jaro-Winkler or more;
  lower the figure to find more.

The result sheet lists each pair with a score (bank account and tax id
5, phone and address 3, name 2 times the similarity), what matched, the
row and name on each side, and the matched values.

## Foot and cross-foot

Select a schedule including its total row and total column, then run
**Foot and cross-foot this range…**. With a single cell selected the
whole sheet is used.

The dialog guesses the heading rows (text, or years such as 2024) and the
label columns on the left. It then adds up each column and compares it
with the last row, and adds across each row and compares it with the last
column. The bottom-right cell is checked against both the total row and
the total column. Untick a total that isn't there.

Text and blank cells count as nothing. Differences of up to 0.01 are
ignored by default.

The result sheet lists every check, not only the ones that fail, with the
cell of the stated total, what it adds up to, the stated figure and the
difference, so it can go in the working papers as it is.

## Roll-forward check

**Roll-forward check…** works on a schedule with one row per line, such
as a fixed asset or provision movement schedule. Pick the opening
balance, up to six movement columns and the closing balance. For each
row, opening plus movements should equal closing.

Movements named like reductions (disposals, depreciation, write-offs,
payments, releases) are set to *take away*, unless their values are
already negative. Change any of them if the guess is wrong.

The result sheet lists every line with the expected and actual closing
balance and the difference, and a total row at the bottom.

## PII scan and safe copy

**PII scan and safe copy…** looks for personal data in the sheet you
have open, so you can share a copy without it.

It looks at the values for:

- email addresses;
- phone numbers;
- IBANs (the check digits must be right);
- card numbers (the Luhn check digit must be right);
- US social security numbers (written 123-45-6789) and UK national
  insurance numbers.

And at the column names for dates of birth, people's names, addresses
and id numbers (passport, tax id, employee id, bank account). Company
names (vendor, supplier, account name) are not counted as personal.

Each column shows what was found, how often, and a couple of examples.
Choose what happens to each column in the copy:

- **Keep as is.**
- **Mask** keeps the last 4 letters or digits and replaces the rest with
  `*`, keeping spaces and punctuation: `**** **** **** 1111`.
- **Hash** replaces each value with its salted SHA-256 hash (the first 16
  hex characters by default). The same value always gives the same hash
  with the same salt, so you can still count, group and join on it. The
  salt is made fresh for each copy and is not put in the copy. To hash
  two files so they still join, use the same salt for both and keep it
  somewhere safe.
- **Pseudonymise** replaces each value with a token such as
  `PERSON_0001`. The same value (ignoring case) gets the same token
  everywhere in the copy, also across columns of the same kind.
- **Redact** leaves the cell blank.

**Make the safe copy** adds a new sheet. It holds values only, not
formulas. The original sheet is not changed.

If you tick the mapping option, a second sheet lists each token with its
original value. Anyone with that sheet can undo the pseudonyms: delete
it, or move it to a file you keep, before you share the workbook.

The scan finds the common patterns, not everything. Free text,
uncommon formats and names in columns with unusual titles can slip
through. Check the copy before you send it.
