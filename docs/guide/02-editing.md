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

## Copy, cut and paste

**Ctrl+C**, **Ctrl+X** and **Ctrl+V** work with Excel and Google Sheets, in
both directions. After pasting, the pasted area is selected so you can see
where it went.

## Clear

Select cells and press **Delete**.

## Limits for now

- Clearing, copying or filling a sorted sheet works on up to 1,000,000 cells
  at a time.
- One sheet per file; multiple sheets are being built right now
  ([progress](#/progress)).
