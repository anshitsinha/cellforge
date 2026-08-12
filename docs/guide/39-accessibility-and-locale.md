# Accessibility and locale

## Screen readers

The sheet is drawn on a canvas, which a screen reader can't read. So
cellforge tells it what's going on in plain sentences:

- **Moving around:** the cell you land on, its column name, what it shows
  and its formula. For example: "B5, Amount, 1,234.50, formula
  =SUM(B2:B4)". Empty cells say "blank"; errors say "error #DIV/0!".
- **Selecting:** the range and its size: "B2:D10 selected, 9 rows by 3
  columns, 27 cells".
- **Editing:** what the cell now shows: "B5 set to 12", "B5 cleared", or
  "B5 now shows error #NAME?".

These are spoken politely, after whatever the screen reader is saying, and
only once you stop moving, so holding an arrow key doesn't flood you.

The grid is named "Spreadsheet grid" and carries a short description of
its keys, which most screen readers read when you first reach it.

## Keys in the grid

Everything you can do with the mouse in the grid you can do from the
keyboard.

| Keys | Action |
| --- | --- |
| Arrows, Tab, Enter, PgUp / PgDn, Home / End | Move |
| Shift + any of those | Extend the selection |
| Ctrl + arrows, Ctrl + Home / End | Jump to the edge |
| Ctrl + A | Select everything |
| Type, or F2 | Edit a cell (Enter saves, Esc cancels) |
| Delete | Clear the selection |
| Shift + F10, or the Menu key | Open the cell menu (insert, delete, hide...) |
| Alt + ↓ | Open a cell's list, or the column's filter |
| Space | Tick or untick a tick box cell |
| Ctrl + K | Find any command, including column width, row height and freeze panes |
| Esc, then Tab | Leave the grid for the next control on the page |

Tab on its own moves one cell to the right, as in Excel. To leave the grid,
press Esc first; the next Tab then moves on to the rest of the page.

All the other shortcuts are in [Keyboard shortcuts](#/guide/05-shortcuts).

## Dialogs

Every dialog:

- is announced as a dialog, with its heading as its name;
- keeps Tab and Shift + Tab inside it until it closes;
- closes with Esc (the same as pressing Cancel);
- puts focus back where you were when it closes.

Buttons that show only a symbol (×, ↑, ↓, ✕) have a spoken name such as
"Close" or "Move up".

## Seeing focus, motion and contrast

- **Focus:** whatever the keyboard is on has a visible ring, including the
  grid itself.
- **Less motion:** if your system is set to reduce motion, the grid stops
  gliding after a swipe, and the app's transitions are switched off.
- **High contrast:** in Windows High Contrast (or any forced-colours mode)
  the grid paints with your system colours: your background, your text
  colour for the cells and grid lines, and your highlight colour for the
  selection.
- **Contrast:** text colours meet WCAG AA (at least 4.5 to 1) in both the
  light and dark themes.

## Locale: how numbers and dates look

The locale decides how numbers, dates and formulas are written. Choose one
in the command palette (type "locale"). The choice is kept in this browser.

| Locale | Number | Typed date | Formula | CSV |
| --- | --- | --- | --- | --- |
| English (United States) | 1,234.56 | 3/14/2024 | `=ROUND(A1,2)` | comma |
| English (United Kingdom) | 1,234.56 | 14/03/2024 | `=ROUND(A1,2)` | comma |
| English (India) | 12,34,567.89 | 14/03/2024 | `=ROUND(A1,2)` | comma |
| Deutsch (Deutschland) | 1.234,56 | 14.03.2024 | `=ROUND(A1;2)` | semicolon |
| Français (France) | 1 234,56 | 14/03/2024 | `=ROUND(A1;2)` | semicolon |

What changes:

- **Display.** The decimal and thousands separators in every number
  format. India groups in lakhs and crores (12,34,567). France separates
  thousands with a narrow space.
- **Typing.** In Germany or France, typing `1,5` gives one and a half, and
  `1.234,56` (or `1 234,56`) gives 1234.56. A dot followed by three digits
  is a thousands separator there; `1.5` still reads as one and a half.
- **Dates.** In the UK, India, Germany and France, `3/4/2024` is the 3rd
  of April. In Germany you can also type `15.1.2024`. A date in the form
  `2024-01-15` works everywhere.
- **Formulas.** Where the comma is the decimal, arguments are separated by
  `;` on screen. You can type either style: `=ROUND(A1*1,5;2)` and
  `=ROUND(A1*1.5,2)` both work. A formula with no `;` whose commas are only
  ever between two digits is read the local way, so `=A1*1,5` is A1 times
  one and a half.
- **CSV files.** Where the comma is the decimal, a CSV with no clear
  delimiter is read with `;`.

What doesn't change:

- **The file.** Workbooks store numbers, formulas and format codes the
  same way in every locale, as Excel does. A file made in Germany opens
  correctly in the UK, showing UK separators.
- **Function names.** They stay in English (`SUM`, not `SUMME`).
- **Format codes.** A code is still written `#,##0.00`; the locale only
  decides which characters it prints.
