# Notes and links

## Notes

A note is a comment on a cell: "agreed to the bank letter", "ask Sam about
this one". Select the cell and press **Shift+F2** (or **Add a note…** in the
command palette). Ctrl+Enter saves.

A cell with a note has a red triangle in its corner (an orange one means
cellforge has something to explain about the result, like a lookup that
found nothing). Rest the pointer on the cell to read the note. To change
it, press Shift+F2 again; to remove it, **Delete note**, or empty it and
save.

Notes stay with their cell when you sort, filter, or insert and delete rows
and columns.

## Links

**Insert link…** puts a link on the cell. It can be:

- a web address: `https://…`
- an email: `mailto:someone@example.com`
- a place in this workbook: `#Sheet2!A1`, `#'Bank rec'!C10`, or `#` and a
  defined name

Linked cells show blue and underlined. **Ctrl+click** (Cmd+click on a Mac)
follows the link; a plain click just selects the cell, so it's easy to edit.
Web addresses open in a new tab; workbook links jump to the cell.

The `HYPERLINK` function works too:
`=HYPERLINK("https://example.com/inv/" & A2, "Invoice " & A2)` shows
"Invoice …" and Ctrl+click opens the address built from A2.

For safety, only web, email and workbook links open; anything else (such
as `javascript:` addresses in a file from someone else) is refused.

Notes and links are saved with the file, come in with Excel files and go
out with **Export Excel**, and every change is one undo step.
