# Charts

Select the cells to chart, including the header row and the label column,
then choose **Insert chart…** from the command palette (Ctrl+K). If only
one cell is selected, the chart uses everything on the sheet.

The chart opens in a window over the sheet. Drag its title bar to move it,
and drag the bottom-right corner to resize it. Open as many as you like.
Charts redraw when you change the cells they read.

## The chart window

- **Edit** shows the options beside the chart. Every change shows straight
  away. Esc hides them again.
- **PNG** downloads the chart as an image, for a report or an email.
- **✕** closes the chart.

Point at a bar, a slice or a point to see its label and value.

## Chart types

- **Column** and **Bar**: compare amounts across categories. Tick
  **Stacked** to stack the series.
- **Line** and **Area**: values over time. When the first column holds
  dates or numbers the horizontal axis is a real scale, so uneven dates are
  spaced correctly.
- **Pie**: shares of a total, first series only. Negative values are left
  out. More than eight slices: the smallest go into **Other**.
- **Scatter**: the first column is x, each other column is a set of y values.
- **Combo**: columns and lines together. Under **Series**, tick **Line** to
  draw a series as a line and **Right** to put it on a right-hand axis
  (for a percentage next to amounts, say). By default the last series is a
  line.
- **Histogram**: how the values in the first series are spread. Bin widths
  are chosen for you (Freedman–Diaconis, or Sturges for fewer bins), or set
  **Bin width** yourself. The value on a bin edge goes in the bin above it.
- **Waterfall**: how an opening figure gets to a closing one. Rows labelled
  Opening, Closing, Total, Subtotal, Balance or Net are drawn as totals from
  zero. A total row with no value shows the running total; one with a value
  resets the running total to it.
- **Pareto**: the categories sorted largest first, with a cumulative
  percentage line on the right. Use it to see which few items make up most
  of a total.
- **Benford (first digits)**: how often each first digit (1–9) appears in
  all the numbers in the range, against the share Benford's law expects.
  The note under the chart gives the mean absolute deviation and Nigrini's
  verdict: close, acceptable or marginal conformity, or nonconformity. It
  needs at least 100 numbers to say anything.
- **Ageing**: select a column of dates (invoice or due dates) and,
  optionally, the amounts beside them. Each item goes in a bucket by its age
  in days: Not due, 0–30, 31–60, 61–90, 91–120 and 120+. Change the
  buckets under **Buckets (days)**, and the date to age from under
  **Age at** (today if empty; type a cell such as `H1` to read it from the
  sheet). Without amounts the chart counts items.

## Options

- **Data range**: type a range like `A1:C20`, or whole columns like `A:C`
  (cut to the rows in use). It refers to the sheet you are on.
- **Series in**: columns or rows. **First row has the names** and **First
  column has the labels** say whether the header row and label column are
  part of the data. They are guessed when you insert the chart.
- **Title** and **axis titles**.
- **Value axis min / max** and **X axis min / max**: leave empty for
  automatic, type a number, or type a cell like `F1` to read the limit from
  the sheet. A limit in a cell updates the chart when the cell changes.
- **Number format**: for the value axis and tooltips, like `#,##0` or
  `0.0%`. Empty uses the format of the first value cell. Dates in the label
  column keep their date format.

## Big data

Line, area and scatter charts handle millions of points. cellforge only
draws what can show on screen: for lines, the first, last, lowest and
highest point in each pixel column (or a shape-keeping sample for smaller
sets), so spikes and dips are never lost; for scatter, one point per
pixel. Tooltips still give the exact value from the sheet.

Column and bar charts show up to 2,000 bars; use a line or a histogram for
more.

## Colours

Series colours are chosen to stay apart for people with colour-blindness,
and charts follow the light or dark look of your system. A chart has at
most eight series; select fewer columns, or use a pivot first, if you have
more.

## Not yet

Charts are not saved in the file yet: they close when you close the
workbook.
