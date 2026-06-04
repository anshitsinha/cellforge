# Conditional formatting

Conditional formatting changes how cells look depending on their values.
Select the cells, open the command palette (Ctrl+K) and choose
**Conditional formatting: new rule for the selection…**, or
**Conditional formatting: manage rules…** to see every rule on the sheet.

## Kinds of rule

- **Cell value is** greater than, less than, between, equal to… a number
  (or equal to a piece of text).
- **Text** contains, doesn't contain, begins with, ends with.
- **A date occurring** yesterday, today, in the last 7 days, this / last /
  next week or month, in the past or future.
- **Blank / not blank**, **errors / no errors**.
- **Duplicate** or **unique** values in the range.
- **Top or bottom** N items or N%, **above or below average**.
- **Formula is true**: write the formula for the first cell of the range,
  for example `=$C2>100`; it moves for the other cells like a copied formula,
  so `$` keeps a column or row fixed.
- **Colour scale**: two or three colours from lowest to highest.
- **Data bar**: a bar in each cell, growing from zero (negatives in red).
- **Icon set**: arrows, traffic lights, signs, flags or ratings in equal
  bands from the lowest value to the highest.

Highlight rules pick a look: a ready-made one (light red fill with dark red
text, …) or your own fill, text colour, bold and italic.

## Several rules

Rules higher in the manager's list win when two set the same thing; use ↑
and ↓ to change the order. **Stop here if this rule applies** stops later
rules for that cell. **Clear rules from the selection** deletes every rule
touching the selected cells.

Rules move with the cells when you insert or delete rows and columns, are
saved with the file, and every change is one undo step. Conditional
formatting doesn't change the cell's own format: the format bar still shows
what you set yourself.

## Excel files

Rules come in with `.xlsx` files and go out with **Export Excel**: value,
text, date, blank, error, duplicate, top / bottom, average and formula
rules, colour scales, data bars and icon sets. A rule cellforge can't show
yet (for example "greater than" another cell's value) is left out on
import.
