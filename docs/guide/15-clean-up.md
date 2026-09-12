# Cleaning up a messy export

Exports from accounting and ERP systems are often printed reports dressed
up as spreadsheets: a title on top, page footers, subtotal rows, the header
repeated on every page, numbers stored as text like `(1,234.50)` or
`1.234,56 CR`, and dates in whatever order the system liked.

Open the command palette (Ctrl+K) and choose **Clean up this sheet (messy
export)…**.

## What the preview shows

- **Header row**: which row holds the column names. Anything above it
  (titles, run dates) is left out.
- **Rows left out, and why**: blank rows, subtotal and total rows, page
  footers (`Page 3 of 9`, `Printed by…`), and repeated headers.
- **Group labels filled down**: a column such as *Account* that only has a
  value on the first row of each group gets that value copied down, so every
  row stands on its own.
- **Each column's type**: numbers, dates or text, with how many values fit
  (the percentage) and the values that don't. Click one to jump to it in the
  sheet.

Numbers understood include accounting negatives `(1,234)`, trailing minus
`1234-`, `CR`/`DR`, currency symbols and codes, percentages and European
`1.234,56`. For dates, the day/month order is worked out per column from
the values that can only be read one way (like `25/03/2024`).

## Making the clean sheet

**Make the clean sheet** adds two sheets next to the original:

- **<name> clean**: the data as a proper table, with real numbers and dates.
  A value that didn't fit its column keeps its original text, so nothing is
  lost; it is easy to find with the jump-to links.
- **<name> dropped**: every row that was left out, where it was, and why.

The original sheet is untouched. One **Undo** (Ctrl+Z) takes both new
sheets away again.

## Spelling variants in a column

Names typed by different people drift: `Acme Ltd`, `ACME LTD.`, ` acme ltd`.
Select a cell in the column and pick **Fix spelling variants in this
column…** in the command palette. It groups values that are the same once
case, spacing, punctuation, `&`/`and` and *Limited/Ltd*, *Incorporated/Inc*,
*Company/Co* are ignored, and proposes changing each group to its most
common spelling. Tick the groups you want and **Change the ticked
spellings**; one **Undo** puts them back.

With a local AI model loaded ([The local AI](46-local-ai.md)), it
also asks the model for pairs the rules can't see, such as an abbreviation
and the full name. The model may only pair values that are already in the
column, and the commoner spelling is kept. Its groups are marked *model* and
start unticked.
