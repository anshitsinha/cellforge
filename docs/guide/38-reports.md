# Reports and pivot charts

## Pivot charts

In the pivot table builder (**Pivot table…**), lay out the pivot, pick
Column, Bar, Line or Pie next to **Chart this pivot**, and click it. The
chart sits over the sheet like any other chart and shows the pivot's rows
(without subtotals and grand totals) with one series per value, or per
column item when a field is on Columns.

A pivot chart works the pivot out again whenever the data changes, so it
always matches the sheet. It finds its fields by name, so it still works
after columns move; if a field's column is deleted, the chart says which
one is missing. To change what it shows, change the pivot and chart it
again.

## Reports

**Reports…** opens the report builder. A report is a list of blocks,
printed in order:

- **Heading**: levels 1 to 3. Levels 1 and 2 go in the PDF's contents
  page and bookmarks.
- **Text**: a paragraph. It can hold live values (see below).
- **Table**: a range of cells (`A1:D20`, or whole columns `A:D`), shown
  the way the cells show; or a pivot (pick Rows, an optional Columns field,
  a value and how to summarise it). Numbers line up on the right; rows
  starting with "Total" and pivot totals are bold.
- **Chart**: one of the workbook's charts, including pivot charts.
- **Page break**: what follows starts on a new page.

Use ↑ and ↓ to reorder blocks and ✕ to remove one. The preview on the
right updates as you type. The report is saved with the workbook; each
change is one undo step.

## Live values in text

Put a formula between `{{=` and `}}`:

    Revenue rose {{=TEXT(Summary!B5/Summary!B4-1,"0%")}} on last year.

Formulas are worked out as if typed on the sheet chosen in **Formulas
read**, so `B5` means that sheet's B5; other sheets work as usual
(`Summary!B5`). A plain number comes out with thousands separators and,
if it has a fraction, two decimals; use `TEXT()` for any other format. A
formula that gives an error shows the error (`#DIV/0!`) and is listed
under **Check** in the preview.

## Parameters: one template for many entities

**Add parameter** gives the report a name and a value, like `entity` =
`North` or `period` = `2026-03-31`.

- In text, `{{entity}}` is replaced by the value.
- Inside a formula, `{entity}` is the value: text in quotes, numbers as
  numbers, and a date written `yyyy-mm-dd` as a date. So
  `{{=SUMIFS(C:C,A:A,{entity})}}` adds up column C for the entity.
- A table or chart can be cut to one entity: set **Rows** to "Only this
  entity" and pick the column that holds it.

To run the report for every entity, set **Run** to "Once for each entity"
and say where the values are: a column of a sheet (each distinct value,
sorted) or a list you type. Tick **Also a consolidated report** for a
report over all of them first: filters on that parameter are off, `{{entity}}`
shows "All", and `{entity}` is `"*"`, so `SUMIFS` with it adds up every
entity.

## Period roll-forward

**Roll forward a period** moves every parameter that looks like a period
on by one, in the same style: `2026-03-31` → `2026-04-30` (month ends stay
month ends), `2026-03` → `2026-04`, `Mar 2026` → `Apr 2026`, `Q4 2026` →
`Q1 2027`, `FY2026` → `FY2027`, `2026` → `2027`. **Roll back a period**
goes the other way. The parameter you run for each of isn't touched.
Write the report's formulas in terms of `{period}` (for example
`EDATE({period},-12)` for the same month last year) and next month's pack
is one click.

## PDF and printing

**Export PDF** writes the report as a PDF on A4 or Letter, portrait or
landscape: tables carry on over pages with their header row repeated,
charts are drawn as pictures, and every page has "Page n of N" at the
foot. Run for each entity, it writes a report book: a contents page with
page numbers, then one report per entity, each starting on a new page,
with bookmarks for every report and heading.

**Print** prints the preview through the browser (which can also save a
PDF). The PDF is made in your browser; nothing is uploaded.
