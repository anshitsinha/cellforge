# Recipes: doing it again next month

While you work, cellforge writes down each step: edits, formats, sorts,
filters, clean-ups, conditional formats, validation, inserted rows and
columns, and so on. Open **Recipes: this session's steps and saved
recipes…** from the command palette (Ctrl+K) to see them, each with how long
it took.

Undo takes a step off the list and Redo puts it back, so the list is always
the work as it stands.

## Tidying the steps

- Untick a step to leave it out.
- **↑ / ↓** change the order; **✕** removes a step.
- **Edit** shows the step's settings as JSON (cells, ranges, values); change
  them and **Save**. They're checked before they're accepted.
- **Show** steps the workbook back to just after that step, so you can see
  what it looked like then; **Back to now** returns.

## Saving and running

**Save as a recipe…** names the steps and saves them with the workbook. Saved
recipes are listed below the steps, and each also appears in the command
palette as **Run recipe: …**.

A recipe finds sheets by name, so it works on next month's workbook if the
sheets are called the same. Running a recipe is one undo step. If a step
can't run (a sheet is missing, a range doesn't fit), nothing is changed and
the message says which step it was.

## Running on new files

**On files…** next to a saved recipe (or **Run recipe on files: …** in the
command palette) runs it on files instead of this workbook. The recipe's
inputs are the sheets it works on, by name; pick a file (CSV, Excel, JSON
or Parquet) for each. For a recipe with one input, **Run on a folder…** runs
it once per file in the folder.

Each run happens in a separate, fresh workbook, so this one isn't changed
until you choose where the results go: added here as new sheets (named
after the file), or downloaded as one Excel file per run. A report lists
every run, whether it worked, the step that failed if one did, and how long
it took.

Tools that read files (opening, combining, importing statements) and tools
that build result sheets from a dialog aren't recorded yet; run those, then
the recipe.
