# Getting started

cellforge is a spreadsheet for finance and audit work that runs entirely in
your browser, on your own computer. Nothing you open or type is uploaded
anywhere: there is no server and no account.

## The start screen

A new or empty workbook opens on the **start screen** instead of a blank
grid. From there you can:

- **Open a file or drop it here**: Excel (`.xlsx`), `.csv`, `.tsv`, `.txt`,
  JSON, Parquet or a `.cellforge` workbook. A **PDF bank statement** becomes
  a sheet of transactions. You can also drag a file anywhere onto the
  window, at any time. Big files stream in, so the page stays responsive
  while they load.
- **Start a workflow**: Bank reconciliation, Month-end close, Audit tests or
  a 100M-line ledger. **Try with sample data** opens the workbook with
  fictional data filled in, so you can try every step first; the second
  button opens the same layout empty, for your own data.
- **Set up private AI**: pick a model that runs on this computer (see
  [Local AI](#/guide/46-local-ai)).
- **Blank workbook** starts an empty sheet; **Esc** goes back to the sheet.

The start screen comes back from **File > New workbook** and
**Help > Start screen**. **Help > Sample data** opens the samples directly.

## Find your way around

| Area | What it does |
| --- | --- |
| Top bar | The file name and whether it's saved; Undo / Redo; **Search commands** (**Ctrl+K**); **Open**, **Save** (a menu with Save as and the Excel and CSV exports), **Share** (check for hidden content, a password-protected copy, an evidence pack); **Ask AI**; and **?** for help |
| Menu bar | **File, Edit, View, Insert, Format, Data, Reconcile, Audit, Review, Reports, AI, Help**. Every command, with its shortcut. **Alt** or **F10** moves to it from the keyboard |
| Format bar | Bold, sizes, number formats, colours, alignment, borders for the selection |
| Name box and formula bar | The selected cell (e.g. `B4`) and what's in it: the formula itself, not its result |
| Left bar | One button per job: **Data**, **Reconcile**, **Audit**, **Review**, **Reports** and **AI**. Each opens a panel with that job's tools, a line on what each does, and the next step |
| Side panel | Tools that need the sheet in view (the job panels, AI, history, explain, pivot fields) open on the right; the grid makes room |
| Grid | Your data. Only what's on screen is drawn, so size doesn't slow it down |
| Bottom bar | Sheet tabs on the left; the sheet's size and the selection's sum, average and count on the right |

Results, warnings and errors appear as short messages at the bottom of the
window. Errors stay until you close them.

**View > Theme** switches between light, dark and the computer's setting.
**View > Collapse the side bar** keeps only the icons on the left bar.

## Save your work

You don't have to: cellforge **saves as you go**, on this computer, in the
browser's private storage. Close the tab, restart the computer, or have the
browser crash in the middle of an edit, and the next time you open
cellforge everything is back, including undo. **Saved on this computer**
next to the file name means a change is safely stored.

To keep a copy somewhere else, or to send one, press **Save** (**Ctrl+S**).
That writes one `.cellforge` file with every sheet, formula, format and
the imported data inside. **Open** (**Ctrl+O**) opens it again. In Chrome
and Edge, Ctrl+S after the first save updates the same file; in other
browsers each save downloads a new copy. **Ctrl+Shift+S** is Save as.

The **Save** menu also has **Export Excel (.xlsx)** for the whole workbook
and **Export CSV** for the sheet on screen, as plain values for other tools.

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
- [History and versions](#/guide/10-history)
- [Excel files](#/guide/13-excel-files)
