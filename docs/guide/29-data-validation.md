# Data validation, dropdowns and tick boxes

Data validation limits what can be typed into cells. Select the cells and
choose **Data validation (dropdown list, allowed values)…** in the command
palette (Ctrl+K).

## What a rule can allow

- **List of choices**: typed in, separated by commas (`Open, Approved,
  Rejected`), or taken from a range, even on another sheet
  (`=Lists!$A$2:$A$20`). The active cell shows a ▼ button; click it or press
  **Alt+↓** to pick, then ↑ ↓ and Enter.
- **Whole number** or **Number** between, above, below… some values.
- **Date** between, before, after… (type dates like `2024-01-31`). Date cells
  get a ▼ button too (or **Alt+↓**) that opens a calendar; dates the rule
  doesn't allow are greyed out. Arrow keys move the day, Enter picks it.
- **Text length** limits.
- **Custom formula** that must be TRUE, written for the first cell, like
  `=$C2>0`; it moves for the other cells as a copied formula would.
- **Tick boxes**: the cells show a box that a click or **Space** ticks
  (TRUE) or clears (FALSE). There's also **Tick boxes in the selection** in
  the command palette.

**Allow blank cells** is on unless you untick it.

## When a value breaks the rule

- **Stop**: the value isn't accepted and you're back in the cell to fix it.
- **Warning**: you're asked whether to keep it.
- **Information**: it's kept, with a note.

Add your own error message, and a message that shows under the cell when
it's selected (good for "Pick the approver from the list").

Rules apply to what's typed. To check cells that already hold values
(pasted, imported, or from before the rule), use **Circle invalid data**;
**Clear validation circles** removes the circles.

A new rule replaces older rules on the same cells. **Clear validation** in
the dialog removes rules from the cells. Rules move with inserted and
deleted rows and columns, are saved with the file, come in and go out with
Excel files (tick boxes go to Excel as a TRUE / FALSE list), and every
change is one undo step.
