# Explain: where a number came from

Select a cell and press **Ctrl+Shift+E** (or **Explain this number (where
it came from)…** in the command palette). A panel shows the number's
family tree:

- A **formula** shows its formula, and under it every cell it reads, each
  explained the same way, down to the starting values.
- A value **typed in** shows when it was typed (in this session).
- A value **imported** shows where its sheet came from (the file it was
  opened or combined from, or the sheet it was cleaned from) and, when the
  sheet has a *source file*, *original row* or *page* column, that row's
  values, so you can find it in the original file.
- A value that's **part of a formula's result** (a spilled array such as
  `=SEQUENCE(5)` or `=FILTER(…)`) points to the formula that made it.
- A big **range** (more than six cells) is summed up: how many cells, how
  many numbers, and their total.

Click any cell name in the tree to go to it. A cell that appears twice is
explained once ("explained above").

**Copy the write-up** puts the same explanation on the clipboard as plain
sentences, ready for a working paper:

> B9 is 1,234.50, worked out as =SUM(B2:B8).
>   B2:B8 has 7 cells, 7 of them numbers adding up to 1,234.5; that sheet
>   came from: Imported from march.csv.
