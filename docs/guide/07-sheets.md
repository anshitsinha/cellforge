# Working with sheets

A workbook holds as many sheets as you like. Their tabs sit along the bottom
of the window.

| To… | Do this |
| --- | --- |
| Add a sheet | Click **+** at the left of the tabs |
| Switch sheets | Click a tab, or press **Ctrl+PgUp** / **Ctrl+PgDn** |
| Rename | Double-click the tab, type, press **Enter** (**Esc** cancels) |
| Reorder | Drag a tab onto another tab |
| Duplicate, hide, delete, colour | Right-click the tab |
| Find a sheet | Click **≡** and type part of its name. Hidden sheets are listed too; clicking one unhides it |

Everything here can be undone with **Ctrl+Z**, including deleting a sheet:
undo brings it back with all its data. Undo always changes the sheet where
the change happened, even if you've switched to another one since.

Each sheet remembers its own selection, so switching back puts you where you
were.

## Names

Sheet names follow Excel's rules so files stay compatible: up to 31
characters, unique (ignoring upper/lower case), not empty, without
`\ / ? * [ ] :`, and not starting or ending with an apostrophe.

## Opening files

**Open CSV** and **New** start a new workbook. A CSV opens as one sheet named
after the file. **New** and **100M demo** ask before discarding unsaved changes.

Formulas that refer to other sheets (`=Sales!B4`) are coming next; see
[progress](#/progress).
