# Scenarios: what if…

A scenario is a named set of values for your model's input cells: *Base*,
*Best case*, *Worst case*. Open **Scenarios (what-if: base, best, worst)…**
from the command palette (Ctrl+K).

1. Select the input cells (growth rate, price, headcount…) and click
   **Use the selected cells** under *Inputs*.
2. Select the cells you want to compare (revenue, margin, cash at year end)
   and click **Use the selected cells** under *Results*.
3. **Add the current inputs as a scenario** saves what's in the inputs now,
   usually as *Base*. Add more, then type each one's values in the table
   (formulas are fine). Rename scenarios by editing their names.

**Compare on a new sheet** works out every scenario and adds a sheet with
one row per result: each scenario's value, and how far it is from the first
(base) scenario. The comparison runs on a copy of the workbook, so your
inputs aren't changed.

**Show** puts a scenario's values into the input cells so you can look
around the model with them; it's one step, so Undo goes back.

Inputs and results can be on different sheets. Scenarios are saved with the
workbook.
