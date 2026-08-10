# Sharing safely

## Before you share

**Before you share: check for hidden content…** (command palette) lists what
someone you send the workbook to could find that may not be on screen, and
which file types carry it:

- hidden sheets, rows (including rows a filter hides) and columns
- notes, review notes (cleared ones too) and links
- formulas (they show how numbers were worked out; CSV keeps only results)
- columns that look like personal data: names, emails, phone numbers, card
  and bank account numbers, national ID numbers
- the action log (with values that were later changed or deleted) and
  saved versions, which only a `.cellforge` file carries

**Show** jumps to the sheet. To share less: delete what isn't needed, use
**PII scan and safe copy…** to mask personal data, export to Excel or CSV
(they leave the history and versions out), or save a password-protected
copy.

## Password-protected copies

**Save a password-protected copy…** saves the workbook encrypted with a
password (AES-256-GCM, with the key made from the password by PBKDF2,
310,000 rounds). Opening it in cellforge asks for the password. Without the
password the file can't be read, by anyone, including you, so keep it
somewhere safe, and send it separately from the file.

## Clearing what's kept in this browser

cellforge keeps your current workbook, its versions and a change journal in
this browser so nothing is lost if the tab closes. **Clear all data
cellforge keeps in this browser…** deletes all of it, along with settings
like recent commands and your reviewer name. Files you saved or exported
aren't touched. It can't be undone.

## Working offline

After your first visit, cellforge keeps its own files in the browser, so it
opens and works with no internet connection. Your data never leaves your
computer either way. To run it from a folder instead (for example on a
machine with no internet at all), build it with `npm run build` and serve
the `apps/web/dist` folder with any static web server.
