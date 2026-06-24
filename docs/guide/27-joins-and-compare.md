# Joins, compares and mapping tables

These tools work across two sheets. Put each file in its own sheet first,
then pick the tool from the command palette (Ctrl+K). Each one adds its
result as new sheets (or, for a mapping table, new cells) and leaves your
data alone. Undo removes the result.

## Join two sheets

**Join two sheets…** brings columns from one sheet into another where a
key matches. It does what VLOOKUP or XLOOKUP does, for every column at
once, and it tells you what won't match before you join.

1. Pick sheet A and sheet B. A is the sheet you're on.
2. Pick the key column on each side. cellforge guesses the pair whose
   values overlap most. For a key made of several columns (say company
   and invoice number), fill in key columns 2 and 3.
3. Read the join doctor (below), and fix the keys if it says so.
4. Choose the kind of join, what to do when a key matches several rows,
   and the columns to bring over.
5. Press **Add joined sheet**.

### The join doctor

The doctor runs when the dialog opens (on very big sheets, press **Check
keys** yourself) and again whenever you press **Check keys**. You need
to run it before you can join. For each side it shows:

- **Find a partner**: rows whose key is on the other side, and what share
  of the rows that is.
- **No partner**: keys (and rows) with nothing on the other side.
- **Repeated keys**: keys on more than one row. A repeated key on B means
  each matching A row appears once per repeat.
- **Blank keys**: these never match.
- **Numbers / text like numbers / text**: the number 123 and the text
  "00123" are different keys until you say otherwise.
- **Spaces at the ends or doubled**.

Above the table it says whether the join is one-to-one, one-to-many,
many-to-one or many-to-many, and how many rows an inner and a left join
would make.

When a fix would match more rows, the doctor lists it with the match rate
you'd get, for example "Numbers stored as text = numbers: 98.2% / 99.0%
would match (+1,204 / +1,204 rows)". Press **Use** to switch it on.

When the two sides have more than about 400,000 different keys between
them, the gains are worked out from a sample of the keys and marked
"estimated". The match rates in the table are always exact.

### Compare keys

These options say how loosely keys must match. All are off at first, so
keys must be exactly equal.

- **Trim spaces**: spaces at the ends and doubled spaces don't count.
- **Ignore case**: "abc" = "ABC".
- **Numbers stored as text = numbers**: "00123", "123" and 123 match, and
  so do "1,234.50" and 1234.5.
- **Ignore spaces and punctuation**: "AB-12" = "AB 12" = "AB12".
- **Ignore leading zeros**: "000123A" = "123A".
- **Reference rules**: everything above plus a prefix such as INV, REF or
  PO, so "INV-00123" = "123". This is the same rule the reconciliation
  uses.

### Why don't these match?

Below the doctor, pick a key from A and a key from B that have no partner
and press **Explain**. It says what each value is (a number, text that
looks like a number, text with a trailing space) and the smallest set of
options that would make them equal. **Turn it on and check again** does
that. When no option helps but the two are alike, it offers fuzzy
matching instead.

### Kinds of join

- **Inner**: only rows with a match on both sides.
- **Left**: every A row, with B's columns where there's a match.
- **Right**: every B row, with A's columns where there's a match.
- **Full**: every row from both sides.
- **Anti**: the A rows with no match in B. To get B rows with no match in
  A, swap the sheets.

### Several matches

When an A row's key is on several B rows:

- **Keep every match**: the A row repeats once per match.
- **Keep the first match only**: the first B row (top to bottom). The
  Match column says when others were left out.
- **Keep every match and flag the repeats**: as the first option, and the
  Match column marks each one.

### Fuzzy matching

Fill in **Fuzzy match %** (85 is a good start) to pair rows that didn't
match exactly with the most similar key left over on the other side. Tick
**Keys are person or company names** when they are: then word order,
titles and legal endings don't count (see Names below). Fuzzy pairs show
"fuzzy 91%" in the Match column. Check them.

### The joined sheet

The new sheet has the columns you picked from A, then from B (a name used
on both sides gets the sheet name added), then:

- **Match**: match, fuzzy and the score, or only in A / only in B.
- **A row** and **B row**: the row number in each original sheet.

Joins are hash based, so they stay fast on big sheets: a million rows
against a million takes a second or two.

## Compare two versions by key

**Compare two versions by key…** answers "what changed between last
month's file and this month's?". Pick the old and the new sheet and the
key column (or up to three). Columns are paired by their header names;
untick any you don't want compared.

- **Number tolerance**: numbers this close count as the same.
- **Ignore case** and **Ignore extra spaces** for text.

Numbers compare as numbers, so 100 and "100.00" are the same. Press
**Compare** for the counts, then **Add result sheets**:

- **Compare added**: rows in the new version only, with their row numbers.
- **Compare removed**: rows in the old version only.
- **Compare changed**: one row per changed value, with the key, the column,
  the old and new values, the difference for numbers, and both row
  numbers.

When a key is on more than one row, the repeats pair up in order (the
second old row with the second new one), and the dialog warns you. Add a
key column to tell them apart.

## Compare trial balances

**Compare trial balances…** compares one trial balance with its own prior
period, or two trial balances with each other (this year and last, or two
entities). Columns are read the same way as **Map as trial balance**. If a
guess is wrong, map the sheet with that tool first and compare the sheet it
makes.

The **TB compare** sheet has one row per account: both balances, the
movement (A − B), the movement as a percentage of B, accounts only on one
side, and the name in B when it changed. Accounts are matched on the code,
ignoring case and spaces. Accounts on more than one line are added together
and listed in the dialog.

## Tie the GL out to the TB

**Tie the GL out to the TB…** totals the general ledger by account and
compares each total with the trial balance.

1. Pick the GL sheet and say which columns hold the account and the
   amount, or the debit and credit (credit is taken away from debit).
2. Pick the TB sheet.
3. **Compare with** the TB closing balance, or with the movement (current
   minus prior) when the GL only holds this period's postings.

The **GL to TB** sheet lists each account with the GL total, the number of
GL lines, the TB figure, the difference and a status: agrees, differs,
only in GL or only in TB. An account with no GL lines and a zero TB figure
agrees. The dialog shows the biggest differences first.

## Names

Fuzzy name matching knows that these are the same:

- "Smith, John" and "John Smith" (a single comma turns the name round)
- "J. Smith" and "John Smith" (an initial matches the name it starts)
- "Mr John Smith Jr" and "John Smith" (titles and suffixes are dropped)
- "Acme Ltd", "ACME Limited" and "The Acme Co." (legal endings are dropped)
- "Müller & Söhne" and "Muller and Sohne"

A missing middle name costs a little. A missing first name costs a lot:
"Smith" alone isn't a good match for "John Smith".

## Apply a mapping table

A mapping table is two columns on a sheet: the value as written (from)
and the value you want (to). Use it to standardise supplier names, map
old account codes to new ones, or tag items with a category.

**Apply a mapping table…** maps a column of the sheet you're on:

1. Pick the column to map, the sheet with the table, and its From and To
   columns (guessed from headers like "from", "old", "to", "new").
2. **Match**: ignoring case and spaces (the default), exactly, or as names
   (order, titles and Ltd/Inc don't count).
3. **Fuzzy match %**: optionally map a value with no entry to the most
   similar From name.
4. **Keep values with no mapping**: otherwise they're left blank.
5. **Replace the original values**: otherwise the result goes in a new
   column after the last one.

The whole change is one step, so one Undo puts it back. The status bar
says how many values were mapped and lists the ones with no mapping. When
the table maps the same value to two different things, the first one is
used and the status bar says so.

No table yet? Put your master list (the names you want) in the To column
of another sheet and press **Suggest pairs**. cellforge pairs each
distinct value in your column with the most similar master name and adds
a **Mapping table** sheet with From, To and Score. Check it, delete the
wrong rows, then apply it.
