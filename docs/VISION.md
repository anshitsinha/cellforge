# Vision

**cellforge is a spreadsheet you can talk to. It runs entirely on your own computer, handles data
of any size, and shows its work.**

It has everything Excel and Google Sheets do, plus what they can't: hundreds of
millions of rows, re-runnable cleanup recipes, instant analysis, and an AI assistant
that runs locally in the browser. Nothing (data, prompts, models) ever
leaves the machine.

## Who it's for

People who have outgrown Excel but aren't programmers:

- the ops analyst whose 4M-row export Excel won't open
- the finance team rebuilding the same monthly report from a fresh CSV
- the auditor who has to check someone else's workbook and can't upload it anywhere
- the researcher or journalist with a 2 GB dataset and a deadline

Today they're told to learn SQL or Python, or to paste their data into a chatbot.
cellforge gives them the answer in the tool they already understand.

## Principles

1. **Local only.** One PC, one browser tab. No servers, no accounts, no uploads,
   no telemetry. The AI runs on the user's GPU. Works offline once loaded.
2. **Familiar first.** Anyone who knows Excel is productive in the first minute:
   same formulas, same shortcuts, `.xlsx` in and out.
3. **No limits.** Size is never the reason something doesn't work. 100M rows
   scroll, sort, filter, pivot and chart.
4. **Everything is an action.** Every change, whether typed, clicked, replayed or
   suggested by the AI, is a typed, undoable, recordable action. That one idea
   gives us undo, recipes, provenance, audit trails and the AI's tool interface.
5. **The AI plans, the engine computes.** The model never reads millions of rows
   or does arithmetic. It turns intent into formulas, queries and actions; the
   engine executes them exactly on all the data. Every AI result can be traced
   to the steps that produced it.
6. **Show the work.** Any number can be explained: its formula chain, the recipe
   step or AI action that produced it, and the rows behind it.
7. **No bloat.** Heavy parts (query engine, AI models, file codecs) load only
   when first used. The base app opens instantly.

## What makes it different

| | Excel / Sheets | Chatbot + Python / SQL | cellforge |
| --- | --- | --- | --- |
| Data size | 1M rows / 10M cells | any, but you write code | 100M+ rows, no code |
| Privacy | cloud or local | data goes to a server | never leaves the PC |
| Natural language | limited, cloud | yes | yes, local |
| Exact results on full data | yes | if the code is right | yes: AI plans, engine computes |
| Re-run on next month's file | Power Query, if you find it | re-run the notebook | Recipes, built in |
| Audit trail | none | the chat log | every action, every number |
| Setup | install / account | environment, packages | open a tab |

## Pillars

### 1. A complete spreadsheet
Everything people use in Excel and Google Sheets: multiple sheets, the full
function library (including dynamic arrays, `LET`, `LAMBDA`, `XLOOKUP`,
`FILTER`, `QUERY`), formatting, conditional formatting, validation, filters,
tables, pivots, charts, freeze panes, comments, named ranges, print, `.xlsx`
round-trip.

### 2. No limits
A columnar engine that loads multi-GB CSV, Parquet and `.xlsx`, and a query engine
for joins, group-bys and window functions on full tables. Charts downsample
millions of points on the fly.

### 3. Recipes
Cleanup steps (filter, dedupe, split, change type, computed column, join) are
recorded as a visible, editable list. Drop in next month's file and re-run.

### 4. Explore
Drag columns to group and pivot 100M rows in about a second. Click any aggregate
to see the rows behind it. Duplicate a sheet as a scenario and compare.

### 5. Local AI
Ask in plain language, typed or spoken: questions, transformations, charts,
reports. Runs on [kiln](https://github.com/anshitsinha/kiln), our WebGPU
inference engine, with output constrained to valid actions.
- **Ask:** answers come with the formula or query that produced them
- **Audit:** finds inconsistent formulas, hard-coded numbers, ranges that miss rows,
  broken references and duplicate keys, explains them and offers fixes
- **Explain:** any cell, in plain words
- **Clean:** normalises dates, names and categories, and fuzzy-deduplicates
- **Insights:** anomalies, trends, simple forecasts, "what drove this change?"
- **Bring data in:** tables from PDFs and screenshots, read locally

### 6. Show the work
Version timeline, file compare, per-cell provenance, report mode (narrative +
live tables and charts), PDF export.

## Non-goals

- Servers, accounts, cloud sync, telemetry
- Real-time multi-user collaboration
- VBA / macros (recipes and `LAMBDA` cover the real needs, safely)
- A desktop install (the browser is the platform)
