# Find and replace

Press **Ctrl+F** to find, or **Ctrl+H** to find and replace. Both are also in
the command palette. It opens as a small card at the top right that stays
open, so you can see each match in the sheet while you work. The **Find**
and **Replace** tabs at its top switch between the two.

## Find

Type what you're looking for, then:

- **Enter** or **Next** jumps to the next match after the selected
  cell. At the end it starts again from the top.
- **Shift+Enter** or the up arrow button goes back.
- **Find all** lists every match with its address. Click an address to go
  to that cell. The list shows the first 1,000; the count tells you how
  many there are (up to 10,000).
- **Esc** closes the dialog and puts you back in the grid.

Empty cells never match.

## Options

- **Match case** (**Aa**): `North` doesn't find `north`. Off by default.
- **Whole cell** (**[ab]**): the whole cell has to match, not just part of it.
  `100` then finds `100` but not `1000`.
- **Regular expression** (**.***): the search is a JavaScript regular expression,
  so `INV-\d{4}` finds invoice numbers. To match the whole cell, tick
  **Whole cell** rather than adding `^` and `$`. If the expression is
  broken, the dialog says what's wrong as you type.
- **In the selection** (the range selected when you opened it), **In this
  sheet**, or **In all sheets** (hidden sheets are skipped).
- Under **More**:
- **Search**: **By rows** goes along each row before moving down; **By
  columns** goes down each column before moving right.
- **Look in**: **Values** searches what cells show, as formatted (`12%`,
  `$1,200`, a formula's result). **Formulas** searches what was typed: the
  formula itself, like `=SUM(B2:B9)`, and the number as you'd type it.

Hidden and filtered-out rows are searched too.

## Replace

Type the new text in **Replace with**, then:

- **Replace** changes the match in the selected cell and moves to the next
  one. If the selected cell doesn't match, it just moves to the next match.
- **Replace all** changes every match at once and tells you how many cells
  changed.

Replacing always works on what was typed (**Look in** is set to
**Formulas**), as in Excel:

- In a formula, only the formula text changes, and it stays a formula.
  Replacing `Sheet1!` with `Jan!` re-points every reference. If a regular
  expression removes the leading `=`, it's put back.
- Text stays text. Replacing in `'007` gives `'008`, not the number 8.
- Numbers are typed again, so replacing `12` with `13` in `1200` gives the
  number `1300`.
- Cells that don't match, or wouldn't change, are left alone.

With **Regular expression** on, `$1`, `$2`… in **Replace with** put back
what the groups matched. For example, find `(\w+), (\w+)` and replace with
`$2 $1` to turn `Smith, Jane` into `Jane Smith`. Without regular
expressions, `$` is just a dollar sign.

**Replace all** is one step in Undo and History, even across several
sheets. **Ctrl+Z** puts every cell back.
