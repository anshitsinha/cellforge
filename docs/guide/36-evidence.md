# Evidence packs

cellforge keeps a record of how a workbook got to where it is, so a
reviewer can check it.

## What's recorded

- **Every change**: each edit, format, sort, filter, clean-up, recipe run,
  undo and redo, with the time, the sheet and what it did.
- **Every file read in**: opened, imported (bank statements), or combined.
  Each gets a SHA-256 fingerprint, its name and size. (Files over 512 MB are
  fingerprinted from their first and last 64 MB and their size, and marked
  "sampled".)

The record is a *hash chain*: each entry's fingerprint covers what it says
and the fingerprint of the entry before. Changing, removing or reordering
any entry breaks the chain from that point, and verifying says where. The
record is saved with the workbook.

## Saving a pack

**Save an evidence pack…** (command palette) downloads one .zip holding:

- `SUMMARY.md`: a readable summary: the input files with their
  fingerprints, the log, and the saved recipes
- `log.json` and `inputs.json`: the full record
- `recipes.json`: the saved recipes
- the workbook itself (`.cellforge`)

## Checking a pack

**Verify an evidence pack…** re-checks the chain and lists the input files
with their fingerprints. To check that an input is the same file you have,
compute its SHA-256 (`certutil -hashfile file SHA256` on Windows,
`shasum -a 256 file` on a Mac) and compare.

The record shows what was done in cellforge. It can't show what happened to
a file before it was opened here, which is why the inputs' fingerprints are
included.
