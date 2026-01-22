# User research

What our niche (finance, audit, ops and compliance analysts) actually complains
about, gathered from public forums and reviews in November 2026. Findings are
paraphrased; follow the links for the originals. Each finding maps to features
in [VISION.md](VISION.md) and milestones in [PLAN.md](PLAN.md).

Reddit was not reachable for this round (it blocks automated access); the same
users post on the forums below.

## Findings

### 1. Reconciliation eats days, and the hard part is messy references
- A user with 6,000+ bank transactions a month spends **over a week** on each
  reconciliation by hand. Their sample month shows why simple matching fails:
  the ledger splits one cheque into `279388A` + `279388B` while the bank shows a
  single `279388`; cheque numbers repeat (`000002` a dozen times); one cash
  deposit in the ledger arrives as two bank lines; a 7,991.10 vs 7,991.00
  keying difference; a duplicated bank line; bank charges never booked; items
  clearing 1–2 days later.
  ([MrExcel](https://www.mrexcel.com/board/threads/bank-reconciliation-with-the-help-of-vba.1150680/))
- In a large company, reconciling bank accounts took one person six days;
  balance sheet accounts with thousands of entries across 60 business units and
  narratives in many languages are reconciled in Excel by taking the opening
  detail, adding the month's transactions, eliminating entries that reverse each
  other, and presenting the closing breakdown.
  ([AccountingWEB](https://www.accountingweb.co.uk/any-answers/balance-sheet-reconciliations))
- Month-end consolidation spreadsheets become error-prone because formulas have
  few built-in checks back to the source entities.
  ([AccountingWEB](https://www.accountingweb.co.uk/community/industry-insights/is-your-month-end-consolidation-of-accounts-process-overly-complex))

**→ Features:** reference normalisation (suffixes, leading zeros, spaces),
many-to-one and one-to-many **sum matching**, repeated references resolved by
amount + date window, near-amount "probable keying error" flags, duplicate
detection inside each side, unbooked items turned into proposed adjusting
entries, **outstanding items carried into next month's reconciliation**, the
standard bank-rec statement, open-item matching (auto-clearing entries that
reverse each other) for balance sheet accounts, tie-back checks to source.

### 2. Bank statements arrive as PDFs; converting them is where errors creep in
- Practitioners convert PDF statements with paid tools (AutoEntry, Dext,
  DocuClipper, others) or Power Query, then sort by description, add category
  and VAT columns, fill categories down in bulk, and pivot. Converted output
  often has multi-line entries split apart, garbled dates and duplicate lines,
  and some find they spend longer correcting conversion software than working
  by hand. One accountant built a rules sheet ("description contains X → map
  to column Y") with buttons to import, apply rules and export a cash book.
  ([AccountingWEB](https://www.accountingweb.co.uk/comment/1111192))

**→ Features:** local PDF statement import with multi-line merging, date
repair and **running-balance validation** (opening + lines = closing, per page,
so conversion errors are caught, not trusted); **categorisation rules** that
learn from manual tagging; bulk tagging of filtered rows; an "uncategorised"
queue; export templates for accounting software imports.

### 3. Big models crawl, even when they aren't "big data"
- A 28 MB workbook with 40+ identical income-statement sheets (one per market):
  inserting a row takes about 90 seconds, monthly formulas are re-pointed by
  hand, and the output is a bound PDF book.
  ([MrExcel](https://www.mrexcel.com/board/threads/automating-a-big-monthly-file-a-pain-to-work-in.851262/))
- Filled-down derived columns, autofilters, subtotals and pivots slow large
  sheets to a crawl; shared files lock up colleagues.
  ([AccountingWEB](https://www.accountingweb.co.uk/any-answers/huge-excel-workbook))
- Excel struggles from ~100K rows; users want "just the basics", such as a
  formula down a column and pivots, on 1M+ rows locally.
  ([Hacker News](https://news.ycombinator.com/item?id=43405806))
- Power Query refresh in Excel re-runs every query in full; big workbooks run out
  of memory. ([P3 Adaptive](https://p3adaptive.com/power-query-refresh-speeds-suck/))

**→ Features:** instant structural edits at any size; **one template, many
entities** (generate and consolidate per-market reports from one definition);
automatic period roll-forward; report books (PDF with contents and page
numbers); incremental recipe refresh (only reprocess what changed); a
"performance doctor" for imported `.xlsx` files.

### 4. Audit tools are expensive, hard to learn, and still choke
- ACL is around $6,000 a year and sold in license packs; IDEA has a steep
  learning curve, weak training and freezes when loading large data.
  ([PeerSpot](https://www.peerspot.com/products/acl-analytics-pros-and-cons),
  [G2](https://www.g2.com/products/caseware-idea/reviews?page=3&qs=pros-and-cons),
  [TrustRadius](https://www.trustradius.com/products/caseware-idea/reviews))
- Excel's duplicate detection only looks at one column and can't do fuzzy
  matching; messy vendor master data (one firm under several codes) silently
  breaks duplicate-payment tests.
  ([technology4business](https://group.technology4business.co.uk/blog/challenges-of-using-excel-for-finding-duplicates-a-comprehensive-guide),
  [AuditNet deck](https://www.slideshare.net/slideshow/when-is-a-duplicate-not-a-duplicate-detecting-errors-and-fraud/236204045))
- DataSnipper (evidence matching inside Excel) is loved for tracing values to
  source documents, but reviewers report bloated, slow or corrupted workbooks
  from embedded documents, a "validation" mark that doesn't actually check
  amounts, and pricing that shuts out small firms.
  ([Capterra](https://www.capterra.com/p/10002513/DataSnipper/reviews/),
  [G2](https://www.g2.com/products/datasnipper/reviews?qs=pros-and-cons))
- Tick marks pasted as pictures are slow to manage; workpapers in Excel have no
  gate that stops sign-off while review notes are open.
  ([Journal of Accountancy](https://www.journalofaccountancy.com/issues/2017/nov/effective-audit-documentation.html))

**→ Features:** the audit analytics suite at no cost; multi-column and fuzzy
duplicates; vendor master clean-up before testing; **evidence linking** (attach
PDFs, link cells to highlighted regions, extract values locally, and a
"validated" mark that really compares the numbers), with documents stored
outside the workbook so it never bloats; native tick marks; review-note gating.

### 5. They cannot put client data into cloud AI or cloud spreadsheets
- Tax bodies call pasting client data into ChatGPT a confidentiality breach; in
  the US it can violate IRC §7216.
  ([Accounting Times](https://www.accountingtimes.com.au/tax/tax-practitioners-warned-against-entering-confidential-info-into-chatgpt),
  [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2023/12/30/how-accounting-firms-should-and-should-not-use-chatgpt/99561/))
- On a cloud spreadsheet launch, commenters refused to hand over production
  credentials or gigabytes of data, asked what happens if the company is
  acquired or shuts down, and asked for a local/desktop version.
  ([Hacker News](https://news.ycombinator.com/item?id=39551064))

**→ Features:** local AI; nothing uploaded; works offline and air-gapped; an
**open, documented file format** so work outlives the product; reversible
pseudonymisation (the key never leaves the PC).

### 6. Excel habits we must respect
- Bankers navigate with Alt-key ribbon shortcuts; without them a tool is "a very
  hard sell". Data validation, conditional formatting, frozen headers, pasting
  formulas across ranges, and iterative calculation are expected.
  ([Hacker News](https://news.ycombinator.com/item?id=39551064))
- Long-standing wishes: ranges that grow when rows are added, telling hard-coded
  inputs from formulas at a glance, "who changed the formula in E5?", better
  formula explanations, regex find/replace, joins without VBA, typed columns
  that refuse to add dollars to euros, quote-qualified CSV and clean HTML export.
  ([Hacker News](https://news.ycombinator.com/item?id=429477))
- Formula errors spread silently; "FINAL_v2" copies mean departments use
  different numbers; real losses include JPMorgan's copy-paste error and a
  missing minus sign at Fidelity.
  ([G2](https://www.g2.com/products/microsoft-excel/reviews?qs=pros-and-cons),
  [Martus](https://www.martussolutions.com/blog/spreadsheet-horror-stories-5-common-pitfalls-and-how-to-fix-them),
  [EuSPRIG](https://eusprig.org/research-info/horror-stories/))

**→ Features:** Excel key-tip compatibility (Alt sequences); iterative
calculation; self-expanding tables; input-vs-formula highlighting; cell
history ("blame"); currency-typed columns; one workbook with named versions
instead of copies; sign-flip and outlier checks on key totals.

## Test fixture

The MrExcel bank/ledger month (split cheques, repeated numbers, split deposits,
keying error, duplicate line, unbooked charges, clearing lag) is the model for
the reconciliation engine's first acceptance test: a synthetic dataset with
the same patterns, at 6,000 and at 6,000,000 transactions.
