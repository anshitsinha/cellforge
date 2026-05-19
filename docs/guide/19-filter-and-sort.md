# Filtering and sorting

## Filter

Press **Ctrl+Shift+L** (or choose **Filter** in the command palette) to put
a ▼ button on each column header. Click one, or press **Alt+↓** in that
column, to open its filter:

- **Sort A → Z / Z → A** sorts by this column, keeping the header row on top.
- **The list of values** shows every different value with how many rows
  have it, **(Blanks)** first. Untick values to hide their rows. **Search**
  narrows the list; **Select all**, **Clear** and **Invert** work on the
  values you can see. Text is matched ignoring case, so `North` and `north`
  are one value.
- **Filter by condition**: text contains / doesn't contain / begins / ends /
  is exactly; numbers greater or less than, between, top N, bottom N, above
  or below average; dates before, after, on or between.

Filters on several columns combine: a row shows only if it passes all of
them. A filtered column's button shows a funnel. The list for one column
only shows values from rows the other filters leave visible.

As in Excel, a filter doesn't re-run while you edit. **Reapply filter**
(**Ctrl+Alt+L**) runs it again. **Clear filter** shows every row; pressing
**Ctrl+Shift+L** again removes the buttons and the filter.

Filters stay on the same rows when you sort, and are saved with the file.
Every filter change is one step in Undo and History.

## Sort by several columns

**Sort by several columns…** in the command palette: pick a column and an
order for each level (sort by Region, then by Amount largest first, …) and
whether the first row is a header that stays on top.

## Filter views

A view is a filter and a sort saved under a name. In the command palette,
**Save the current filter and sort as a named view** saves one; each saved
view then appears as **Switch to view: …**. Switching is one undo step.
