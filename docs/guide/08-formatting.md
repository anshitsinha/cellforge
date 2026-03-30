# Formatting

The bar under the toolbar formats whatever is selected. Every change can be
undone with **Ctrl+Z**.

## Text

- **B**, *I*, U and S: bold, italic, underline and strikethrough
  (**Ctrl+B**, **Ctrl+I**, **Ctrl+U**, **Ctrl+5**). Click again to turn it off.
- The number box sets the font size in points (10 is the default).
- **A** sets the text colour, the bucket sets the fill. Each remembers the
  last colour you picked; the stripe under it shows that colour.

## Alignment and wrapping

Numbers line up on the right and text on the left unless you choose
otherwise. The three alignment buttons set left, centre or right; clicking
the one that's already on goes back to the default.

**Wrap text** breaks long text into lines at spaces, inside the cell's
width. Rows don't grow to fit yet, so a wrapped cell shows its first lines
until row heights arrive.

## Borders

The **Borders** menu draws lines on the selection: all borders, the outline,
the inside lines, a single side, a thick bottom, or a **double bottom** (the
usual line under totals). **No borders** removes them. Default borders follow
the theme colour, so they show in light and dark mode.

## Number formats

A number format changes how a number looks, never the number itself:
`1234.5` can show as `$1,234.50`, `1.2K` or `123450%`, and formulas still
see 1234.5.

- The **format menu** has the common ones: Number, Currency, Accounting,
  negatives in red, Thousands (`1K`), Millions (`1.2M`), Percent,
  Scientific, dates, times, durations and Text.
- **$**, **%** and **,** apply currency, percent and a thousands separator
  (**Ctrl+Shift+4**, **Ctrl+Shift+5**, **Ctrl+Shift+1**).
- **.0+** and **.0−** show one more or one fewer decimal place.
- **Custom…** takes any Excel format code, with a live preview.

### Typing formatted numbers

Type a number the way you'd write it and cellforge stores the number and
picks the matching format, as Excel does:

| You type | Stored | Shown |
| --- | --- | --- |
| `12.5%` | 0.125 | 12.5% |
| `$1,234.50` | 1234.5 | $1,234.50 |
| `($20)` | −20 | ($20) |
| `1,234,567` | 1234567 | 1,234,567 |
| `2024-01-15` or `1/15/2024` | 45306 | the date |
| `1:30 PM` | 0.5625 | 1:30 PM |

A cell that already has a format keeps it. Dates are counted in days from
1900, exactly like Excel, so date maths (`=B2-A2` for days between) works
and files from Excel agree to the day. `1/2/2024` is read month first; if
the first number can't be a month (`15/1/2024`), it's read day first.

Cells formatted as **Text** keep exactly what you type: `00123` stays
`00123` and `1-2` stays `1-2`.

### Format codes

Codes work as in Excel. Up to four parts separated by `;` style positive
numbers, negatives, zero and text:

| Code | 1234.5 shows | Notes |
| --- | --- | --- |
| `0.00` | 1234.50 | `0` always shows a digit |
| `#,##0` | 1,235 | `#` only when needed; `,` groups thousands |
| `#,##0.00;[Red](#,##0.00)` | 1,234.50 | negatives red, in parentheses |
| `#,##0,"K"` | 1K | each trailing comma divides by 1,000 |
| `0.0%` | 123450.0% | `%` multiplies by 100 |
| `0.00E+00` | 1.23E+03 | scientific |
| `"Total: "#,##0` | Total: 1,235 | text in quotes is shown as is |
| `[>=1000]#,##0,"K";0` | 1K | conditions pick the part |
| `yyyy-mm-dd` | 1903-05-18 | dates: `d dd ddd dddd`, `m mm mmm mmmm`, `yy yyyy` |
| `[h]:mm` | 29628:00 | elapsed hours past 24 |

Colours you can use: `[Black]`, `[White]`, `[Red]`, `[Green]`, `[Blue]`,
`[Yellow]`, `[Magenta]`, `[Cyan]`.

## Format painter

Select a cell that looks the way you want, click the brush, then select the
cells to paint: they get exactly that cell's look (values don't change).
**Double-click** the brush to keep painting several places; **Esc** stops.

## Clear formatting

The last button (or **Ctrl+\**) removes every format from the selection and
leaves the values alone.

## How formatting behaves

- It belongs to the row, so it moves when you sort, insert or delete rows, and
  comes back if you undo a delete. Inserting or deleting columns moves it too.
- Formatting a whole column costs the same on a 100-million-row sheet as on a
  ten-row one, so it's instant.
- **Duplicate sheet** copies the formatting.
- CSV files don't store formatting, so **Export CSV** leaves it out.

## Merge cells and Centre Across Selection

Select the cells, then right-click:

- **Merge cells** joins them into one cell. If several of them had values,
  the first one (reading left to right, top to bottom) is kept in the
  top-left cell and the others are cleared; undo brings them back.
- **Merge and centre** does the same and centres the text (also the
  merge button on the format bar; click it again to unmerge).
- **Merge across** merges each selected row on its own, handy for a block
  of labels.
- **Unmerge cells** splits every merged block the selection touches.
- **Centre across selection (no merge)** centres text over the empty cells
  to its right *without* merging. It looks the same, but you can still
  select, sort and paste each cell normally, which is why many finance teams
  prefer it.

Clicking anywhere in a merged block selects the whole block, and the arrow
keys step over it. Inserting rows or columns inside a merged block grows it;
deleting some of its rows or columns shrinks it. Sorting asks you to unmerge
first, as Excel does.

## Row heights

Drag the line under a row number to change that row's height; with several
whole rows selected, they all change. Double-click the line, or right-click
and choose **Fit row height**, to fit the row to its text, which is how a
wrapped cell gets the room to show every line. Heights stay with their rows
when you sort.

Double-click the line between two column letters to fit the column to the
widest value on screen.

## Freeze panes

Right-click and choose **Freeze top row**, **Freeze first column**, or
**Freeze above row N and left of X** to keep everything above and to the
left of the selected cell on screen while you scroll. A darker line marks
the frozen edge. **Unfreeze panes** turns it off. Freezing is per sheet and
can be undone.
