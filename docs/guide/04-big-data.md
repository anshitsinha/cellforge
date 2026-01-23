# Working with big data

Excel stops at 1,048,576 rows. cellforge is built so that size isn't the
reason something doesn't work.

## What you can do at scale today

- **Open big CSV files.** Files are read in the background while the page
  stays usable; progress shows in the status bar.
- **Scroll 100 million rows** smoothly. Only the cells on screen are ever drawn.
- **Fill a formula down millions of rows** instantly; it's compiled into a fast loop.
- **Sort 100 million rows** in seconds.
- **Select a whole column** and see its sum, average and count.

Try it with the **100M demo** button.

## Why it's fast

Columns of numbers are stored as compact arrays, text that repeats (like a
region or status) is stored once, and your edits sit in a thin layer on top
of the original data instead of copying it. The details are in the
[architecture notes](#/dev/ARCHITECTURE).

## Memory

Sorting 100 million rows needs about 1.7 GB of free memory. Everything else
uses far less.
