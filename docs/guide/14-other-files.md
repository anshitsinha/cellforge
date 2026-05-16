# Text, JSON and Parquet files

**Open** (Ctrl+O) or drag a file in. Everything is read on your computer.

## CSV and other text files

Before a `.csv`, `.tsv` or `.txt` file opens, cellforge shows its first rows
and what it worked out:

- **Encoding**: UTF-8, UTF-16, or the older Windows (Western) encoding many
  accounting systems still export. Wrong letters (`CafÃ©` instead of `Café`)
  mean the encoding needs changing.
- **Delimiter**: comma, semicolon (common in Europe), tab or bar.
- **Skip rows at the top**: for exports that start with a report title,
  date and blank line before the real header.
- **First row has the column names**: untick it when the data starts
  straight away; columns are then named column_1, column_2…

The preview updates as you change these; **Open** (or Enter) loads the file.
Big files stream in, so a multi-gigabyte export opens without freezing the
page.

## JSON

An array of records (`[{"id": 1, "name": "…"}, …]`), an array of arrays
(the first one names the columns), an object wrapping such a list
(`{"results": […]}`), or JSON Lines (one record per line, `.jsonl`).
Nested objects become columns like `address.city`; lists inside a record are
kept as text.

## Parquet

Flat Parquet files, the format data tools export to, open directly: plain
and dictionary-encoded columns, uncompressed, Snappy or gzip, numbers, text,
TRUE/FALSE, decimals, dates and timestamps (shown as dates). Files using
nested columns or Zstandard compression aren't supported yet; cellforge
says so instead of guessing.
