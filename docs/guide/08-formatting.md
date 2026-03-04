# Formatting

The bar under the toolbar formats whatever is selected. Every change can be
undone with **Ctrl+Z**.

## Text

- **B**, *I*, U and S: bold, italic, underline and strikethrough
  (**Ctrl+B**, **Ctrl+I**, **Ctrl+U**, **Ctrl+5**). Click again to turn it off.
- The number box sets the font size in points (10 is the default).
- **A** sets the text colour, the bucket sets the fill. Each remembers the
  last colour you picked; the stripe under it shows that colour.

## Alignment and wrapping

Numbers line up on the right and text on the left unless you choose
otherwise. The three alignment buttons set left, centre or right; clicking
the one that's already on goes back to the default.

**Wrap text** breaks long text into lines at spaces, inside the cell's
width. Rows don't grow to fit yet, so a wrapped cell shows its first lines
until row heights arrive.

## Borders

The **Borders** menu draws lines on the selection: all borders, the outline,
the inside lines, a single side, a thick bottom, or a **double bottom** (the
usual line under totals). **No borders** removes them. Default borders follow
the theme colour, so they show in light and dark mode.

## Format painter

Select a cell that looks the way you want, click the brush, then select the
cells to paint: they get exactly that cell's look (values don't change).
**Double-click** the brush to keep painting several places; **Esc** stops.

## Clear formatting

The last button (or **Ctrl+\**) removes every format from the selection and
leaves the values alone.

## How formatting behaves

- It belongs to the row, so it moves when you sort, insert or delete rows, and
  comes back if you undo a delete. Inserting or deleting columns moves it too.
- Formatting a whole column costs the same on a 100-million-row sheet as on a
  ten-row one, so it's instant.
- **Duplicate sheet** copies the formatting.
- CSV files don't store formatting, so **Export CSV** leaves it out.
