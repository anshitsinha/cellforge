# Pivot tables and column profiles

## Pivot tables

A pivot table adds up a sheet by groups: sales by region and product,
spend by vendor and month, journal lines by account. Open the sheet with
the data and choose **Pivot table…** from the command palette (Ctrl+K).
The builder opens in the side panel, beside the data, and the result builds
live as you add fields. On an empty pivot it offers a first one to try,
such as the amount by vendor; IDs and account codes go to Rows, not Values.

The fields are the sheet's columns. Their names come from the column
headers of an imported sheet, or else from the first row of the sheet.
Each field shows whether it holds numbers, dates or text.

### Building the pivot

There are four boxes:

- **Rows**: items down the side. With two or more fields, each item of the
  first is broken down by the second, and so on.
- **Columns**: items across the top.
- **Values**: what to add up or count.
- **Filters**: which items to include (see *Filters* below).

Drag a field into a box. Or click it: numbers go to **Values**, text and
dates go to **Rows**. Every field in a box has:

- **↑** and **↓** to change the order (the order of Rows and Columns sets
  the nesting).
- **Move to…** to put it in another box.
- **✕** to take it out. Dragging it back to the field list does the same.

You can also drag fields within a box and between boxes. Everything works
from the keyboard with Tab, Enter and the arrow keys.

The preview below the boxes updates as you go. The line above it says how
many rows were read and how long it took.

### Summaries

Each field in **Values** has a summary:

- **Sum**, **Average**, **Min**, **Max**, **Median** and **StdDev**
  (sample standard deviation, as Excel's STDEV) use the numbers in the
  field. Blank cells and text are left out.
- **Count** counts the cells that are not blank. Use it on any field, text
  included.
- **Distinct count** counts the different values.

A cell with no rows behind it is empty. A cell whose rows have no numbers
in the field is empty for Sum, Average and so on, and 0 for Count.

**Show as** changes what the number means:

- **% of grand total**, **% of row total**, **% of column total**: the
  value as a share of that total.
- **Running total**: adds up down the rows. It starts again inside each
  group of the outer row field, so with Year then Month on Rows you get a
  year-to-date total. With nothing on Rows, it runs across the columns.

The same field can be in **Values** more than once, for example as Sum and
as % of grand total side by side.

### Totals

Tick or untick **Subtotals** (a total row after each group of an outer row
field, and the same for columns) and **Grand totals** (the last row and
column).

### Dates

A date field on Rows or Columns starts grouped by month. Change it to
**Years**, **Quarters**, **Months** or **Days**, or **No date grouping** for
each distinct date and time. To get months under each year, add the date
field, set it to **Years**, then add it again (it comes in as months).

Months show as `2024-03 Mar` so they sort in date order. Quarters show as
`2024 Q1`.

Text columns that hold dates (like `15/01/2024`) can be grouped too. They
are read day first. Text that isn't a date stays as its own item.

### Filters

Each field in **Filters** shows its items as a checklist, with the number of
rows for each. Untick items to leave their rows out of the whole pivot.
**All** and **None** tick or untick everything; the search box finds items
in a long list. A date field in Filters lists years at first; change the
grouping to pick quarters, months or days.

Filters on the sheet itself (from the filter buttons in the header) do not
apply to the pivot: it always reads every row.

### Blank cells

Blank cells in a Rows or Columns field are grouped as **(blank)**, shown
last. In Filters you can untick (blank) like any other item.

### Show the rows behind a number

Click a number in the result, then **Show rows** (or double-click
it, or press Enter on it). A new sheet opens with every row behind that
number, all columns, and a **Row** column with the row number in the
original sheet. This works for totals and subtotals too.

### Add as sheet

**Add as sheet** adds the whole pivot as a sheet, in the number format picked above the result. It has one
column for each Rows field, then one column for each item across the top
(and each value, when there are several). Item labels are repeated on every
row, so you can filter and sort the result. Subtotal rows read
`East Total`; the last row is `Grand total`. Numbers keep the format of the
source column; shares are shown as percentages. One **Undo** removes the
sheet.

The pivot on the new sheet is a copy: it doesn't update when the data
changes. Open **Pivot table…** again to redo it. The boxes remember the
last layout for each sheet until you reload the page.

### Limits

A pivot can have up to 2,000,000 combinations of row items and column
items. If a layout has more, you are asked to use fewer fields or move one
to Filters. The preview shows the first 300 rows and 60 value columns; the
sheet has everything.

On a 10 million row sheet a pivot with two text fields on Rows and one sum
takes well under a second.

## Column profiles

**Column profiles** (Ctrl+K, then *Column profiles*) shows one card per
column of the sheet, so you can see what's in a file before you work on it.

Every card shows the number of rows, blank cells and distinct values
("all different" means every value appears once, as in an ID column).

- **Numbers**: min, max, sum, mean, median and standard deviation, how many
  are negative or zero, and how many aren't whole numbers. A small
  histogram shows how the values are spread.
- **Dates** (numbers shown as dates): the first and last date, the median
  date, and a histogram over time.
- **Text**: the shortest and longest length, how many values are numbers or
  dates stored as text (worth fixing with **Clean up** before adding them
  up), and the most common **patterns**. In a pattern every letter is `A`
  and every digit is `9`, so `INV-0042` is `AAA-9999`. A column of
  references with two patterns usually has a few typed differently.
- **Most common**: the values that appear most, with their counts.

On big columns some figures are estimates, and are marked:

- Distinct counts of numbers are exact up to 100,000 different values.
  Beyond that they are estimated (within about 1%) and shown as
  "about 9,870,000".
- The median and the most common values of a column with more than
  4 million numbers come from an even sample of 4 million, marked
  "(est.)".

Text columns are always counted exactly. Cards appear one by one, so a wide
sheet fills in while you read.
