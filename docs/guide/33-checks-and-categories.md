# Data checks and categories

## Data checks

Data checks are rules your data must keep, run with one click before you
send anything on. Open **Data checks…** from the command palette (Ctrl+K).

**Add check…** picks the kind of check, the sheet, and the columns:

- **Not blank**: every row has a value in the column.
- **Unique**: no value appears twice (invoice numbers, for example).
- **Type**: every value is a number, a date, or text. A number typed as text
  (`"1,000"` that won't add up) fails a numbers check and says so.
- **In range**: numbers between a lowest and a highest value (either can be
  left empty).
- **Matches pattern**: a regular expression, like `^INV-\d{6}$` for INV-
  and six digits.
- **In master list**: every value is in a column of another sheet, such as
  account codes in the chart of accounts or vendors in the vendor master.
  Tick what doesn't matter when comparing: case, extra spaces, leading zeros
  (`00123` = `123`), punctuation (`A-123` = `A123`).
- **Totals agree**: the total of one column equals the total of another
  (debits = credits, even on another sheet) or a control total you type in.
  For a signed amount column, a control total of 0 checks that debits and
  credits cancel. **Tolerance** allows a small difference, like 0.01 for
  rounding.
- **Row count**: at least and / or at most so many rows.
- **No duplicate keys**: no two rows share the same values in the key
  columns together (entry + line, for example).
- **Formula TRUE on every row**: a formula written for the first data row,
  like `=C2+D2>0`; it moves down for the other rows the way a filled formula
  does.

**Blank cells are fine** is on for most checks; untick it to fail blanks too.
**When it fails** can be set to **Warning only**: a warning shows amber and
doesn't hold up exports. Give a check a name if the made-up description
isn't clear enough for the reviewer.

**Run checks** turns the list into a checklist: green ✓ passes, red ✗ fails,
amber ! warns. Each check says how many rows it looked at and how many
failed. **Show failing rows** lists the first 20; click one to go to the
cell.

**Edit**, **↑ / ↓** and **✕** change, reorder and delete checks; the tick box
turns a check off without deleting it. Changes can be undone like any edit,
and the checks are saved with the workbook, so next month's file runs the
same checks.

### Exporting while checks fail

When you export to CSV or Excel and a check fails, cellforge asks
**Checks are failing — export anyway?** and lists what fails. **Don't
export** stops; **Export anyway** goes ahead. Warnings never ask.

## Categories

**Categorise…** in the command palette gives each row a category (Travel,
Office, Rent…) and writes it into a column of the sheet.

Pick the column with the text to match (the description or payee), the
amount column if a rule needs it, and the column to write the category to.
If there isn't one yet, pick **(new column "Category")**.

### Rules

Each rule is a text test, an amount range, or both together:

- **contains**, **contains the word** (so `car` doesn't match `card`),
  **starts with**, **is exactly**, or **matches pattern** (a regular
  expression). Case doesn't matter.
- **Amount from / to**: either end can be left empty. With a text test as
  well, both must hold: "starts with INV and amount from 10,000" →
  Capital.

Rules run in **priority** order, lower first (empty means 100); with equal
priority, the one higher in the list goes first. The first rule that
matches gives the category. Untick a rule to leave it out for now.

The summary under the rules says how many rows would get a category, how
many would still have none, and which rows match rules with different
categories (a conflict: the higher-priority rule wins, but check the rows).

**Apply** writes the categories in one step (Undo takes it all back) and
saves the rules with the workbook. **Save rules** saves them without
applying.

### Categories you set by hand are kept

A row that already has a category keeps it, even if a rule says otherwise;
the summary counts these. Tick **Overwrite categories rows already have** to
replace them.

### Learning from what you've tagged

Tag some rows by hand first: type the category, or use **Tag the selected
rows** (below). Then **Learn from what's tagged** looks for words that turn
up mostly in one category and proposes a rule for each:

- **Rows**: how many tagged rows of that category have the word.
- **Right**: how often a tagged row with the word is in that category.
- **Elsewhere**: tagged rows with the word in other categories.

Proposals that are right at least 90% of the time come ticked. Untick any
you don't want, **Add the ticked rules**, look them over, then **Apply**.
Learned rules have a blue edge in the list. Common filler words (payment,
card, ltd, ref…) and numbers are never proposed.

### Suggestions from a local model

With a local AI model loaded ([the ask bar](34-ask-bar.md#a-local-model)),
**Suggest the rest with the local model** looks at the rows that still have
no category after your rules, up to 50 at a time. For each it is shown a few
of your tagged rows per category and must pick one of the categories you
already use, or say it isn't sure; it can't invent a new one. You get a list
of suggestions, all ticked: untick any you disagree with, then **Write the
ticked categories**. They are ordinary values, and one **Undo** takes them
back. Rows it wasn't sure about are left for you.

### Tagging by hand in bulk

Select the rows in the sheet, open **Categorise…**, type the category next
to **Tag the selected rows** and click it. The header row is left alone.
This always replaces what's there, since you asked for it.

### The uncategorised queue

**Show uncategorised rows** filters the sheet to the rows whose category is
blank, so you can work through them. Tag them (or add rules), then clear the
filter from the column's filter menu or **Clear filter** in the palette.
