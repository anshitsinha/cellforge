import type { CellValue, DataSource } from "@cellforge/grid";

/**
 * The big-scale demo: a general ledger of balanced two-line journal entries,
 * computed on demand from the row index. Nothing is stored, so we can "have"
 * 100M lines with zero memory. Every pair of rows is one entry (a debit line
 * and a credit line for the same amount), so the whole ledger balances, and
 * amounts are spread log-uniformly, so first digits follow Benford's law.
 *
 * All names are fictional. Columns E and F (Debit, Credit) are numbers; the
 * other side of each line is blank.
 */
export const LEDGER_HEADERS = ["Entry", "Date", "Account", "Account name", "Debit", "Credit", "Description", "User"];

/** [debit account, credit account, description stem] */
const KINDS: [number, number, string][] = [
  [1100, 4000, "Invoice"],
  [1000, 1100, "Receipt"],
  [5000, 2000, "Purchase invoice"],
  [2000, 1000, "Payment"],
  [6000, 1000, "Payroll"],
  [6100, 2000, "Rent"],
  [6200, 2000, "Utilities"],
  [6300, 2100, "Accrual"],
  [6400, 1500, "Depreciation"],
  [1200, 2000, "Stock receipt"],
];
// sales and purchases dominate; depreciation is rare
const KIND_WEIGHTS = [26, 24, 18, 16, 5, 2, 3, 3, 1, 2];
const KIND_TABLE = KIND_WEIGHTS.flatMap((w, i) => Array<number>(w).fill(i));

export const LEDGER_ACCOUNTS: Record<number, string> = {
  1000: "Cash at bank",
  1100: "Trade receivables",
  1200: "Inventory",
  1500: "Accumulated depreciation",
  2000: "Trade payables",
  2100: "Accrued expenses",
  4000: "Revenue",
  5000: "Cost of sales",
  6000: "Salaries and wages",
  6100: "Rent",
  6200: "Utilities",
  6300: "Professional fees",
  6400: "Depreciation",
};

const CUSTOMERS = ["Morrow Retail", "Nettle & Co", "Oakridge Clinics", "Pellam Hotels", "Quarry Lane Dental", "Rowan Schools Trust", "Sable Engineering", "Thistle Foods", "Umber Studios", "Vantage Kitchens"];
const SUPPLIERS = ["Arden Office Supplies", "Brightwater Utilities", "Calder Logistics", "Dunmore Insurance", "Elm Street Properties", "Fenwick Consulting", "Granite Telecom", "Ivel Software", "Juniper Catering", "Kestrel Print"];
const USERS = ["akhan", "bmorales", "cnguyen", "dokafor", "eschmidt", "fpatel"];

// ten years of postings, oldest first
const START = Date.UTC(2016, 10, 1);
const DAYS = 3652;

/** The 100M-line ledger behind "Try the 100M demo" (the name is kept for saved sessions). */
export class SyntheticSource implements DataSource {
  readonly colCount = LEDGER_HEADERS.length;

  constructor(readonly rowCount: number) {}

  getColumnName(col: number): string {
    return LEDGER_HEADERS[col];
  }

  getCell(row: number, col: number): CellValue {
    const entry = Math.floor(row / 2);
    const credit = row % 2 === 1;
    const h = hash(entry + 1);
    const kind = KINDS[KIND_TABLE[h % KIND_TABLE.length]];
    switch (col) {
      case 0:
        return 100001 + entry;
      case 1: {
        const entries = Math.max(1, Math.ceil(this.rowCount / 2));
        const day = Math.floor((entry / entries) * DAYS);
        return new Date(START + day * 86_400_000).toISOString().slice(0, 10);
      }
      case 2:
        return credit ? kind[1] : kind[0];
      case 3:
        return LEDGER_ACCOUNTS[credit ? kind[1] : kind[0]];
      case 4:
        return credit ? null : ledgerAmount(entry);
      case 5:
        return credit ? ledgerAmount(entry) : null;
      case 6: {
        const sale = kind[0] === 1100 || kind[1] === 1100;
        const party = sale ? CUSTOMERS[(h >>> 9) % CUSTOMERS.length] : SUPPLIERS[(h >>> 9) % SUPPLIERS.length];
        const ref = sale ? ` INV-${20000 + ((h >>> 5) % 80000)}` : "";
        return `${kind[2]}${ref} · ${party}`;
      }
      case 7:
        return USERS[(h >>> 13) % USERS.length];
      default:
        return null;
    }
  }
}

/** The amount of an entry (0-based): 10.00 to 100,000.00, log-uniform over whole decades, to the cent. */
export function ledgerAmount(entry: number): number {
  const u = (hash((entry + 1) ^ 0x5bd1e995) % 1_000_000) / 1_000_000;
  return Math.round(Math.pow(10, 1 + u * 4) * 100) / 100;
}

/** Cheap integer hash (murmur3 finalizer) so values look random but are stable. */
function hash(n: number): number {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
