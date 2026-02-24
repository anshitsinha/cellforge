# Editing

## Typing

Select a cell and start typing, or press **F2** or double-click to edit what's
already there. **Enter** saves and moves down, **Tab** moves right, **Esc**
cancels. You can also type in the formula bar.

- Numbers you type become numbers (they line up on the right and work in maths).
- Anything starting with `=` is a [formula](#/guide/03-formulas).
- Everything else is text.

## Undo and redo

Every change can be undone with **Ctrl+Z** and redone with **Ctrl+Y**,
including sorts of millions of rows. The status bar says what was undone.

Under the hood, every change is recorded as an *action*: a small, exact
description of what happened. That's what will let cellforge replay your
steps on next month's file, show where every number came from, and let the
assistant work safely. See [how it works](#/dev/ARCHITECTURE).

## Fill down

Select a cell and the cells below it, then press **Ctrl+D** (or **Fill ↓**).
The top cell is copied into every selected row; formulas adjust their
references as they go, just as in Excel.

Filling a formula down a huge column is instant: cellforge stores it once and,
where it can, compiles it into a fast loop. The status bar tells you whether a
fill was *compiled* or *interpreted*.

## Sort

Select any cell in a column and click **Sort A→Z** or **Sort Z→A**. All rows
are sorted together, even 100 million of them (it takes a few seconds and
shows progress).

Formulas move with their rows: if `B3` doubles the value in `A3` and sorting
moves that row to row 9, it still doubles its own row's value, now `A9`.
This matches Excel.

## Insert and delete rows and columns

Right-click a cell and choose **Insert row above / below**, **Delete row**,
**Insert column left / right** or **Delete column**. With several rows or
columns selected, that many are inserted or deleted. Shortcuts: **Ctrl+Alt+=** inserts above, **Ctrl+Alt+−** deletes
(**Ctrl++** and **Ctrl+−** work too where the browser doesn't use them for zoom).

Formulas everywhere adjust the way Excel's do:

- references to rows and columns that moved follow them, on every sheet;
- a range grows when you insert rows inside it, and shrinks when you delete some of its rows;
- a reference to a deleted cell becomes `#REF!`.

Undo puts the rows or columns back with their data, and every formula exactly
as it was. Column widths move with their columns. A sheet can have up to
16,384 columns, like Excel.
For now, inserting and deleting rows works on sheets of up to 20 million rows.

## Hide and unhide rows and columns

Select the rows or columns, right-click and choose **Hide**, or press
**Ctrl+9** (rows) / **Ctrl+0** (columns). To bring them back, select across
the hidden ones (say rows 3 to 8 when 4 to 7 are hidden) and choose
**Unhide**, or press **Ctrl+Shift+9** / **Ctrl+Shift+0**.

Hidden rows keep their numbers, so a thicker line in the row header shows
where some are tucked away. Formulas still see hidden cells: `=SUM(A1:A10)`
adds them up whether you can see them or not. Hidden rows stay hidden when
you sort, and hiding is undoable like everything else.

## Copy, cut and paste

**Ctrl+C**, **Ctrl+X** and **Ctrl+V** work with Excel and Google Sheets, in
both directions. After pasting, the pasted area is selected so you can see
where it went.

## Clear

Select cells and press **Delete**.

## Limits for now

- Clearing, copying or filling a sorted sheet works on up to 1,000,000 cells
  at a time.
