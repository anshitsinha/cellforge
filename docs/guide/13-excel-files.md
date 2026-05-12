# Excel files

**Open** (Ctrl+O), or drag a file onto the window, reads `.xlsx` and `.xlsm`
workbooks straight into cellforge, on your computer; nothing is uploaded.
**Export Excel** writes the workbook back out as an `.xlsx` that Excel,
Google Sheets and LibreOffice open.

## What comes across

| | Opening | Exporting |
| --- | --- | --- |
| Every sheet, including hidden ones | ✓ | ✓ |
| Values, text, dates, TRUE/FALSE, errors | ✓ | ✓ |
| Formulas (recalculated by cellforge) | ✓ | ✓ |
| Fonts, bold/italic/underline, colours, fills, borders, alignment, wrap | ✓ | ✓ |
| Number formats, built-in and custom | ✓ | ✓ |
| Merged cells, column widths, row heights, hidden rows and columns | ✓ | ✓ |
| Freeze panes | ✓ | ✓ |
| Named ranges | ✓ | ✓ |
| Tables | as plain ranges | as plain ranges, with their look |
| Charts, pivot tables, macros, comments, conditional formatting | not yet | not yet |

Formulas using newer functions (XLOOKUP, FILTER, LET…) are written the way
Excel expects, so they work there too. Excel files hold at most 1,048,576
rows per sheet; for bigger sheets use **Save** (a `.cellforge` file).

Numbers are stored column by column, so even a workbook with hundreds of
thousands of rows opens compactly.
