# Supporting documents (evidence)

Attach the documents that back up your numbers (bank letters, invoices,
confirmations, statements) and link each figure to the place it comes from.

## Attaching

**Supporting documents (attach, link cells as evidence)…** in the command
palette opens the documents panel. **Attach documents…** takes PDFs and
images. They're kept in this browser's private storage under their SHA-256
fingerprint, not inside the workbook file, so the workbook stays small and
the same document attached twice is kept once.

## Linking a cell

1. Select the cell (the balance per the bank letter, say).
2. In the documents panel, **Open** the document and go to the page.
3. Drag a box round the figure. The panel shows the text inside the box.
4. **Link B5 to this**. If the document is a PDF with text, cellforge reads
   the number in the box and tells you whether it agrees with the cell.

Linked cells show 📎 in the corner. **Show this cell's evidence** opens the
document at the linked page with the box drawn; **Remove this cell's
evidence link** removes it.

## Checking

**Check this sheet's evidence links** goes through every link on the sheet
and says, for each, whether the cell agrees with the document, differs (and
what the document shows), or can't be checked (a scan or an image).

## In the evidence pack

**Save an evidence pack…** includes the attached documents under
`documents/`. A document that isn't in this browser's storage any more (for
example on another computer) is listed in `documents/MISSING.txt` with its
fingerprint, so it can be found and compared.

PDFs are shown here as their text, placed where it sits on the page, which
is enough to find and box a figure; scanned PDFs (pictures of text) show no
text but can still be linked.
