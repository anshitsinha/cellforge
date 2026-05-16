# Combining many files

Twelve monthly exports, one per branch, one per bank account: open the
command palette (Ctrl+K) and choose **Combine all files in a folder…** or
**Combine several files…**.

CSV and other text files, Excel (`.xlsx`, first sheet), JSON and Parquet
can be mixed. Everything is read on your computer.

## How columns are lined up

Columns are matched by name, ignoring case, spaces and punctuation, so
`Invoice No.`, `invoice_no` and `INVOICE NO` are one column. Common
abbreviations are understood too: `Amt` is `Amount`, `Qty` is `Quantity`,
`Desc` is `Description`, `Ref` is `Reference`, `Acct` is `Account`.

Before combining, a table shows each column of the result and which column
of each file feeds it. A **—** means that file hasn't got the column; its
rows are left blank there.

- **Rename** a column by editing its name.
- **Merge** two columns by giving one the other's name (say `Cust` →
  `Customer`).

## The result

**Combine** adds one sheet with every row from every file, in file-name
order, and a **source file** column first so you always know where a row
came from. Numbers and dates written as text in the files (`(1,200.00)`,
`31/01/2024`) become real numbers and dates. A column that is numbers in
one file and text in another is kept as text, so nothing is lost.

One **Undo** removes the combined sheet.
