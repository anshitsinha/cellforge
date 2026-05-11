# Inspecting a formula

Select a cell and press **Ctrl+[** (or right-click → **Inspect this cell**).
The panel on the right shows:

- **Worth a look**: things an auditor would flag:
  - a formula that **differs from the ones above and below it** (the
    classic overwritten or mis-copied row);
  - **numbers typed into the formula** (`=B2*1.2`): assumptions are easier
    to check and change in their own labelled cell. Column numbers,
    rounding digits and the like aren't flagged;
  - **#REF!** inside the formula, which means it pointed at cells that were
    deleted;
  - a reference to an **empty cell**, often a broken link or a forgotten input.
- **How it's worked out**: the formula split into its parts, each with its
  value, nested the way it's calculated. Follow it down to see exactly
  where a surprising number comes from.
- **Reads**: every cell and range the formula uses (names and table
  references are followed to the real cells), outlined in **blue** on the
  sheet.
- **Read by**: every formula, on any sheet, that uses this cell, outlined
  in **green**. Check it before you change or delete something.

Click any of them to go there. The panel follows the selection, so you can
walk through a model cell by cell.
