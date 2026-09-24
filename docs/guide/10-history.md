# History and versions

Open the history panel with **View > Show history and versions** or **Ctrl+Shift+H**.

## This session

Every change you've made, in order, with the time. Click any of them to go
back to just after it; the later ones turn grey and you can click them to go
forward again. It's the same as pressing undo or redo several times, so
nothing is lost until you make a new change from an earlier point.

## Versions

Type a name ("sent to auditor", "before restatement") and press **Save** to
remember the workbook exactly as it is now. Versions are saved inside the
workbook, so they're still there next week and in the `.cellforge` file
you send someone.

For each version:

- **Compare** lists every cell that changed since then: where it is, what
  it was (struck through) and what it is now, including formulas and their
  results. Click a cell to go to it. Sorting doesn't confuse it: rows are
  matched by identity, not position, so a re-sorted sheet only shows real
  changes (and a note that the order changed).
- **Go back** makes every sheet what it was in that version. It's an
  ordinary change, so **Undo** takes you forward again.
- **Delete** forgets the version (undo brings it back).

## One cell's story

With the panel open, select a cell to see what it was in each saved
version, every value typed into it this session (with times), and what it is
now. It follows the row, so sorting doesn't mix up its history.

Comparing checks every cell that was typed, pasted, filled or calculated.
Values in imported data that were never edited can't change, so they're
skipped, which keeps comparing instant on huge files.
