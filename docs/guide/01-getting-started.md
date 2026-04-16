# Getting started

cellforge is a spreadsheet that runs entirely in your browser, on your own
computer. Nothing you open or type is uploaded anywhere: there is no server
and no account.

## Open it

- **A blank sheet:** open the app. It starts with an empty sheet, like any spreadsheet.
- **Your own data:** click **Open**, or drag a `.csv`, `.tsv` or `.txt` file
  anywhere onto the window. Big files stream in, so the page stays responsive
  while they load.
- **The 100M-row demo:** click **100M demo** to see what scale feels like:
  a generated sales table with one hundred million rows.

## Find your way around

| Area | What it does |
| --- | --- |
| Toolbar | Undo / Redo, Fill down, Sort, New, Open, Save, Export, Demo; the format bar under it |
| Name box (left of the formula bar) | The selected cell, e.g. `B4` |
| Formula bar | What's in the cell: the formula itself, not its result |
| Grid | Your data. Only what's on screen is drawn, so size doesn't slow it down |
| Status bar | Row and column counts on the left; sum / average / count of the selection on the right |

## Save your work

You don't have to: cellforge **saves as you go**, on this computer, in the
browser's private storage. Close the tab, restart the computer, or have the
browser crash in the middle of an edit, and the next time you open
cellforge everything is back, including undo. The word next to the file
name says **saved** once a change is safely stored.

To keep a copy somewhere else, or to send one, press **Save** (**Ctrl+S**).
That writes one `.cellforge` file with every sheet, formula, format and
the imported data inside. **Open** (**Ctrl+O**) opens it again. In Chrome
and Edge, Ctrl+S after the first save updates the same file; in other
browsers each save downloads a new copy. **Ctrl+Shift+S** is Save as.

**Export CSV** still downloads the sheet on screen as plain values for
other tools.

A few things to know:

- Autosave keeps one workbook: opening or importing another replaces it,
  so **Save** first if you want to keep the current one.
- If cellforge is open in two tabs, only the first one autosaves; the
  other says so next to the file name.

## What's next

- [Editing](#/guide/02-editing): typing, undo, fill, sort, copy and paste
- [Formulas](#/guide/03-formulas)
- [Working with big data](#/guide/04-big-data)
- [Keyboard shortcuts](#/guide/05-shortcuts)
- [Privacy](#/guide/06-privacy)
- [Formatting](#/guide/08-formatting)
- [Command palette](#/guide/09-command-palette)
