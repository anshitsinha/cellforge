# When a lookup says #N/A

Most #N/A errors in real files aren't missing data. The value is there,
but stored differently. When VLOOKUP, XLOOKUP, MATCH or XMATCH finds nothing,
cellforge looks for the usual culprits:

- **Numbers stored as text**: the list holds `"1002"` (text, often from an
  export) and you're looking for the number 1002.
- **Extra spaces**: `"North "` with a trailing space, double spaces, or the
  invisible non-breaking spaces that web and PDF exports leave behind.
- **Text keys against numbers**: you're looking for `"7"` and the list holds 7.

If one of these is the reason, the cell gets a small **orange corner**.
Select it and the status bar says what's wrong, with a button to fix it
(**Trim the spaces** or **Convert to numbers**) for the whole column the
lookup reads. The fix is an ordinary change, so **Undo** reverses it.

You can also run the fixes yourself on any selection from the command
palette (**Ctrl+K**, "trim" or "convert to numbers").

To keep something as text on purpose, start it with an apostrophe:
`'007` stays `007`.
