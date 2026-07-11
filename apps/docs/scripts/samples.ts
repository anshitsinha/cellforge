/**
 * The sample files the tutorials use, generated so they can be rebuilt and
 * checked. Run `npm run samples -w @cellforge/docs` to write them to
 * apps/docs/public/samples/; samples.test.ts checks the written files match
 * and that cellforge reads them the way the tutorials say.
 *
 * Everything here is made up: the company, the vendors, the bank.
 */

// ------------------------------------------------------------- helpers --

const money = (n: number) => n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;
const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = (rows: string[][]) => rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
export const tsv = (rows: (string | number)[][]) => rows.map((r) => r.join("\t")).join("\n");

/** A small seeded random number generator, so the samples never change. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** 2024-mm-dd from a day of 2024 (1 = 1 January). */
function day2024(d: number): string {
  const t = new Date(Date.UTC(2024, 0, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// ------------------------------------------------------ monthly close --

/** Code, name, September balance, October balance (year to date, debits positive). */
export const ACCOUNTS: [string, string, number, number][] = [
  ["1000", "Cash at bank", 83250.0, 91030.5],
  ["1100", "Trade debtors", 112400.0, 128950.0],
  ["1200", "Inventory", 65300.0, 61200.0],
  ["1500", "Fixed assets", 150000.0, 150000.0],
  ["1510", "Accumulated depreciation", -45000.0, -46500.0],
  ["2000", "Trade creditors", -58900.0, -63410.25],
  ["2100", "VAT payable", -14200.0, -16850.0],
  ["2200", "Accruals", -6500.0, -18500.0],
  ["3000", "Share capital", -50000.0, -50000.0],
  ["3100", "Retained earnings", -120000.0, -120000.0],
  ["4000", "Sales", -540000.0, -602000.0],
  ["4100", "Other income", -3600.0, -3950.0],
  ["5000", "Cost of sales", 297000.0, 330100.0],
  ["6000", "Wages and salaries", 81000.0, 90000.0],
  ["6100", "Rent", 27000.0, 30000.0],
  ["6200", "Utilities", 5400.0, 6020.0],
  ["6300", "Marketing", 12350.0, 27909.75],
  ["6400", "Depreciation", 4500.0, 6000.0],
];

/** October's trial balance as the accounting system prints it: titles, debit and credit as text, a total and a footer. */
export function tbOctober(): string {
  const debit = (n: number) => (n > 0 ? money(n) : "");
  const credit = (n: number) => (n < 0 ? money(-n) : "");
  const dr = ACCOUNTS.reduce((s, a) => s + Math.max(a[3], 0), 0);
  const cr = ACCOUNTS.reduce((s, a) => s + Math.max(-a[3], 0), 0);
  return csv([
    ["Harbour Lane Supplies Ltd", "", "", ""],
    ["Trial balance as at 31 October 2024", "", "", ""],
    ["Printed 04/11/2024 09:12", "", "", ""],
    ["", "", "", ""],
    ["Account", "Account name", "Debit", "Credit"],
    ...ACCOUNTS.map(([code, name, , oct]) => [code, name, debit(oct), credit(oct)]),
    ["", "Total", money(dr), money(cr)],
    ["", "", "", ""],
    ["Page 1 of 1", "", "", ""],
  ]);
}

/** September's balances, to paste into a sheet of their own. */
export function tbSeptemberTsv(): string {
  return tsv([["Code", "Balance"], ...ACCOUNTS.map(([code, , sep]) => [code, sep.toFixed(2)])]);
}

// -------------------------------------------------- bank reconciliation --

export const OPENING_BALANCE = 24615.32;

/** The cash book (ledger) for October: date, reference, description, amount (receipts positive). */
export const CASH_BOOK: [string, string, string, number][] = [
  ["2024-10-01", "RCP-3101", "Receipt - Baker & Sons", 2400.0],
  ["2024-10-02", "PAY-7701", "Payment - Office rent October", -3000.0],
  ["2024-10-04", "PAY-7702", "Payment - Metro Electric", -486.2],
  ["2024-10-07", "RCP-3102", "Receipt - Greenfield Cafe", 1800.0],
  ["2024-10-07", "RCP-3103", "Receipt - Hill Street Deli", 1200.0],
  ["2024-10-10", "PAY-7703", "Payment - Coastal Packaging", -1243.0],
  ["2024-10-14", "RCP-3104", "Receipt - Baker & Sons", 5150.0],
  ["2024-10-15", "PAY-7704", "Payment - VAT return Q3", -7820.55],
  ["2024-10-18", "PAY-7705", "Payment - Fleet fuel cards", -642.18],
  ["2024-10-21", "RCP-3105", "Receipt - Riverside Hotel", 3275.4],
  ["2024-10-25", "PAY-7706", "Payment - Payroll October", -12480.0],
  ["2024-10-28", "RCP-3106", "Receipt - Greenfield Cafe", 960.0],
  ["2024-10-29", "CHQ-100245", "Cheque 100245 - Bright Signs", -1250.0],
  ["2024-10-30", "CHQ-100246", "Cheque 100246 - Lakeside Printing", -830.4],
  ["2024-10-31", "RCP-3107", "Receipt - Riverside Hotel", 4500.0],
];

/** The bank's side: day of October, description, amount (money out negative). */
export const BANK: [number, string, number][] = [
  [2, "BGC BAKER AND SONS LTD", 2400.0],
  [3, "SO HARBOUR PROPERTY RENT", -3000.0],
  [7, "DD METRO ELECTRIC", -486.2],
  [8, "COUNTER CREDIT 000123", 3000.0],
  [11, "FPO COASTAL PACKAGING", -1234.0],
  [14, "BGC BAKER AND SONS LTD", 5150.0],
  [16, "DD HMRC VAT", -7820.55],
  [18, "CARD FLEET FUEL CARDS", -642.18],
  [22, "BGC RIVERSIDE HOTEL", 3275.4],
  [25, "BACS PAYROLL OCT", -12480.0],
  [29, "BGC GREENFIELD CAFE", 960.0],
  [31, "ACCOUNT FEE OCTOBER", -35.0],
  [31, "INTEREST PAID", 12.48],
];

export const bankClosing = () => round2(BANK.reduce((s, b) => s + b[2], OPENING_BALANCE));
export const bookClosing = () => round2(CASH_BOOK.reduce((s, b) => s + b[3], OPENING_BALANCE));

export function cashBook(): string {
  return csv([["Date", "Reference", "Description", "Amount"], ...CASH_BOOK.map(([d, r, t, a]) => [d, r, t, a.toFixed(2)])]);
}

/** The same statement as a CSV download, for readers who'd rather not use the PDF. */
export function bankCsv(): string {
  let bal = OPENING_BALANCE;
  const rows = [["Date", "Description", "Paid out", "Paid in", "Balance"], ["01/10/2024", "Balance brought forward", "", "", money(bal)]];
  for (const [d, t, a] of BANK) {
    bal = round2(bal + a);
    rows.push([`${pad(d)}/10/2024`, t, a < 0 ? money(-a) : "", a > 0 ? money(a) : "", money(bal)]);
  }
  return csv(rows);
}

/** Helvetica advance widths (per 1000) for the characters the statement uses. */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const c of s) {
    if (/[0-9]/.test(c)) w += 556;
    else if (c === "," || c === "." || c === " ") w += 278;
    else if (/[A-Z]/.test(c)) w += 667;
    else w += 520;
  }
  return (w * size) / 1000;
}

/** The October statement as a one-page PDF with real text, like one downloaded from online banking. */
export function bankPdf(): Uint8Array {
  const size = 9;
  const H = 842;
  const items: [number, number, string][] = []; // x, y from top, text
  const right = (x: number, y: number, t: string) => items.push([round2(x - textWidth(t, size)), y, t]);
  items.push([40, 50, "Sample Bank"]);
  right(550, 50, "Page 1 of 1");
  items.push([40, 64, "Harbour Lane Supplies Ltd"]);
  items.push([40, 78, "Business current account 12345678   Sort code 00-00-00"]);
  items.push([40, 92, "Statement 1 October 2024 to 31 October 2024"]);
  const cols = { date: 40, desc: 90, out: 390, in: 460, bal: 550 }; // money columns: right edges
  let y = 125;
  items.push([cols.date, y, "Date"], [cols.desc, y, "Description"]);
  right(cols.out, y, "Paid out");
  right(cols.in, y, "Paid in");
  right(cols.bal, y, "Balance");
  y += 18;
  let bal = OPENING_BALANCE;
  items.push([cols.date, y, "01 Oct"], [cols.desc, y, "Balance brought forward"]);
  right(cols.bal, y, money(bal));
  for (const [d, t, a] of BANK) {
    y += 15;
    bal = round2(bal + a);
    items.push([cols.date, y, `${pad(d)} Oct`], [cols.desc, y, t]);
    right(a < 0 ? cols.out : cols.in, y, money(Math.abs(a)));
    right(cols.bal, y, money(bal));
  }
  y += 15;
  items.push([cols.date, y, "31 Oct"], [cols.desc, y, "Balance carried forward"]);
  right(cols.bal, y, money(bal));

  const esc = (t: string) => t.replace(/([()\\])/g, "\\$1");
  const content = items.map(([x, yy, t]) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${H - yy} Tm (${esc(t)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${H}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Title (Sample Bank statement October 2024) /Producer (cellforge docs) >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

// ----------------------------------------------------------- audit tests --

export const VENDORS = [
  "Baker & Sons", "Brightwater Logistics", "Coastal Packaging", "Delta Office Supplies", "Eastgate Cleaning",
  "Fleet Fuel Cards", "Greenline Waste", "Harbour Property", "Ironbridge Engineering", "Juniper IT Services",
  "Kestrel Couriers", "Lakeside Printing", "Metro Electric", "Northfield Water", "Oakridge Timber",
  "Pinecrest Catering", "Quayside Security", "Redwood Furniture", "Silverline Telecom", "Thornbury Legal",
];

export const INVOICE_GAP = ["INV-10213", "INV-10215"] as const; // three numbers missing
export const INVOICE_REUSED = "INV-10301";
export const DUPLICATE_PAIR = ["INV-10342", "INV-10348"] as const; // same vendor and amount
export const MISSPELT_VENDOR = ["Brightwater Logistics", "Brightwatter Logistics"] as const;

/** Purchase invoices for 2024, numbered INV-10001 on, with a few things for the tests to find. */
export function purchaseInvoices(): string[][] {
  const rand = mulberry32(2024);
  const users = ["ajones", "bpatel", "cwong"];
  const rows: string[][] = [];
  const count = 420;
  for (let i = 1; i <= count; i++) {
    const no = 10000 + i;
    const vendor = VENDORS[Math.floor(rand() * VENDORS.length)];
    const amount = round2(10 ** (1 + 4 * rand())); // spread evenly over 10 to 100,000 on a log scale, as Benford expects
    const date = day2024(1 + Math.floor(((i - 1) * 365) / count));
    const user = users[Math.floor(rand() * users.length)];
    rows.push([`INV-${no}`, date, vendor, amount.toFixed(2), user]);
  }
  const byNo = (inv: string) => rows.findIndex((r) => r[0] === inv);
  // the same vendor billed twice for the same amount, five days apart
  const first = rows[byNo(DUPLICATE_PAIR[0])];
  const second = rows[byNo(DUPLICATE_PAIR[1])];
  second[2] = first[2];
  second[3] = first[3];
  // a vendor name keyed with a typo
  const typo = rows.findIndex((r, i) => i > 250 && r[2] === MISSPELT_VENDOR[0]);
  rows[typo][2] = MISSPELT_VENDOR[1];
  // a number used twice
  const reused = byNo(INVOICE_REUSED);
  rows.splice(reused + 1, 0, [INVOICE_REUSED, rows[reused][1], "Kestrel Couriers", "418.60", "cwong"]);
  // three numbers missing
  const from = byNo(INVOICE_GAP[0]);
  rows.splice(from, byNo(INVOICE_GAP[1]) - from + 1);
  return [["Invoice", "Invoice date", "Vendor", "Amount", "Entered by"], ...rows];
}

/** A small schedule for footing, with one total keyed wrong (the Q3 total). */
export function footingTsv(): string {
  return tsv([
    ["Expense", "Q1", "Q2", "Q3", "Q4", "Total"],
    ["Rent", 9000, 9000, 9000, 9000, 36000],
    ["Wages", 26100, 27300, 27600, 28350, 109350],
    ["Utilities", 1980, 1710, 1650, 2140, 7480],
    ["Marketing", 3400, 5150, 3800, 15559.75, 27909.75],
    ["Total", 40480, 43160, 42950, 55049.75, 180739.75],
  ]);
}

// ----------------------------------------------------------- journal tests --

export const FLAGGED_ENTRIES = {
  /** posted on a Saturday night by a user who hardly posts, round amount, "adjust" in the text */
  weekend: "J-1043",
  unbalanced: "J-1050",
  backdated: "J-1057",
  belowLimit: "J-1060",
};

/** October's general ledger journals: one row per line. */
export function journals(): string[][] {
  const rand = mulberry32(1031);
  const users = ["ajones", "bpatel", "cwong"];
  const pairs: [string, string, string][] = [
    ["5000", "2000", "Purchase invoice"],
    ["1100", "4000", "Sales invoice"],
    ["1000", "1100", "Customer receipt"],
    ["2000", "1000", "Supplier payment"],
    ["6200", "2000", "Utility bill"],
    ["6000", "1000", "Payroll"],
  ];
  const rows: string[][] = [];
  const weekdays: number[] = [];
  for (let d = 275; d <= 305; d++) {
    const dow = new Date(Date.UTC(2024, 0, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays.push(d);
  }
  const line = (id: string, date: string, posted: string, user: string, account: string, text: string, dr: number, cr: number) =>
    rows.push([id, date, posted, user, account, text, dr ? dr.toFixed(2) : "", cr ? cr.toFixed(2) : ""]);
  for (let n = 1; n <= 64; n++) {
    const id = `J-${1000 + n}`;
    const day = weekdays[Math.floor(((n - 1) * weekdays.length) / 64)];
    const date = day2024(day);
    const posted = `${date} ${pad(9 + Math.floor(rand() * 8))}:${pad(Math.floor(rand() * 60))}`;
    const user = users[Math.floor(rand() * users.length)];
    if (id === FLAGGED_ENTRIES.weekend) {
      line(id, "2024-10-12", "2024-10-12 21:47", "dkhan", "6300", "Adjust marketing accrual", 25000, 0);
      line(id, "2024-10-12", "2024-10-12 21:47", "dkhan", "2200", "Adjust marketing accrual", 0, 25000);
      continue;
    }
    if (id === FLAGGED_ENTRIES.unbalanced) {
      line(id, date, posted, user, "5000", "Stock purchase", 4250, 0);
      line(id, date, posted, user, "2000", "Stock purchase", 0, 4205);
      continue;
    }
    if (id === FLAGGED_ENTRIES.backdated) {
      line(id, "2024-09-30", "2024-11-08 10:05", user, "6100", "September rent accrual", 3000, 0);
      line(id, "2024-09-30", "2024-11-08 10:05", user, "2200", "September rent accrual", 0, 3000);
      continue;
    }
    if (id === FLAGGED_ENTRIES.belowLimit) {
      line(id, date, posted, user, "1500", "Warehouse racking", 9850, 0);
      line(id, date, posted, user, "2000", "Warehouse racking", 0, 9850);
      continue;
    }
    const [dr, cr, text] = pairs[Math.floor(rand() * pairs.length)];
    let amount = round2(50 + rand() * 6000);
    if (amount % 1000 === 0) amount += 0.37;
    line(id, date, posted, user, dr, text, amount, 0);
    line(id, date, posted, user, cr, text, 0, amount);
  }
  return [["Journal", "Date", "Posted", "User", "Account", "Description", "Debit", "Credit"], ...rows];
}

// ----------------------------------------------------------------- files --

/** Every sample file, by name. */
export function sampleFiles(): Record<string, string | Uint8Array> {
  return {
    "tb-2024-10.csv": tbOctober(),
    "cash-book-2024-10.csv": cashBook(),
    "bank-statement-2024-10.pdf": bankPdf(),
    "bank-statement-2024-10.csv": bankCsv(),
    "purchase-invoices-2024.csv": csv(purchaseInvoices()),
    "journals-2024-10.csv": csv(journals()),
  };
}
