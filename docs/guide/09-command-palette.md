# Command palette

Press **Ctrl+K** (Cmd+K on a Mac) anywhere, or click **Search commands** in
the top bar, and type what you want: "bold", "freeze", "benford",
"bank rec", "duplicate payments". Whole words count most, so "ai" finds the
AI commands before "Align left". Use the arrow keys and **Enter**, or
click. **Esc** closes it.

Every result shows its icon, a line saying what it does, and its keyboard
shortcut, so the palette also teaches them. Results are grouped the same
way as the menus: File, Edit, View, Insert, Format, Data, Analyse,
Reconcile, Audit, Evidence & review, Reports, AI and Help.

## With nothing typed

- **Recent**: the commands you used last.
- **Suggested for this sheet**: what fits what's on screen. Two sheets
  suggest **Reconcile two sheets…**; a ledger with amounts and users
  suggests **Journal entry tests…**, **Find duplicates…** and
  **Benford's law test…**; an empty workbook suggests opening a file.
- Then every group, to browse.

## Ask AI

The last row is always **Ask AI: "what you typed"**. When nothing matches
well, it's the one selected, so a question like "total of Amount by Vendor"
followed by **Enter** goes straight to the ask bar (**Ctrl+/**), which runs
commands, writes formulas and, with a [local AI model](#/guide/46-local-ai),
handles requests in your own words.

## What's in it

Everything in the menus, the left bar and the format bar: formatting,
number formats, borders, merging, inserting, deleting and hiding rows and
columns, freeze panes, sorting, filtering, fill, paste options, opening,
saving and exporting, and every finance and audit tool. Whatever you run
from the palette goes through undo like anything else.

## For developers

The raw actions behind every change (`Action: cells.set` and the rest, the
same building blocks the AI uses) are hidden. Add `?dev=1` to the address,
or set `cellforge.dev` to `1` in the browser's local storage, to list them
under **Developer: engine actions**. Choosing one opens a small form built
from the action's schema: ranges start as your current selection, and
**Run** applies it.
