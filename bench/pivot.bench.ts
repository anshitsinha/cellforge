// Timing for pivot tables and column profiles on big synthetic columns.
// Run with: npx vite-node bench/pivot.bench.ts [rows]
import type { ColumnData } from "../packages/core/src/columns";
import { pivot, profile } from "../packages/core/src/pivot";

const N = Number(process.argv[2] ?? 10_000_000);
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;

const regions = Array.from({ length: 12 }, (_, i) => `Region ${i + 1}`);
const accounts = Array.from({ length: 400 }, (_, i) => `Acct ${1000 + i}`);
const region = new Uint32Array(N);
const account = new Uint32Array(N);
const amount = new Float64Array(N);
const date = new Float64Array(N);
for (let i = 0; i < N; i++) {
  region[i] = 1 + Math.floor(rnd() * regions.length);
  account[i] = 1 + Math.floor(rnd() * accounts.length);
  amount[i] = Math.round(rnd() * 1e6) / 100;
  date[i] = 45000 + Math.floor(rnd() * 730);
}
const cols: ColumnData[] = [
  { kind: "string", name: "Region", codes: region, dict: regions },
  { kind: "string", name: "Account", codes: account, dict: accounts },
  { kind: "number", name: "Amount", values: amount },
  { kind: "number", name: "Date", values: date },
];

const time = (label: string, fn: () => unknown) => {
  const t = performance.now();
  fn();
  console.log(`${label.padEnd(58)} ${(performance.now() - t).toFixed(0).padStart(6)} ms`);
};

console.log(`${N.toLocaleString("en-US")} rows`);
time("warm-up (2 text rows, sum)", () => pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 2, agg: "sum" }] }));
time("2 text row fields x sum", () => pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 2, agg: "sum" }] }));
time("2 text row fields x sum, filter on region", () => pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 2, agg: "sum" }], filters: [{ field: 0, keep: new Set(regions.slice(0, 6)) }] }));
time("region rows x month cols x sum", () => pivot(cols, { rows: [0], cols: [{ field: 3, group: "month" }], values: [{ field: 2, agg: "sum" }] }));
time("2 text row fields x avg, stdev, min, max", () => pivot(cols, { rows: [0, 1], cols: [], values: (["avg", "stdev", "min", "max"] as const).map((agg) => ({ field: 2, agg })) }));
time("region rows x median", () => pivot(cols, { rows: [0], cols: [], values: [{ field: 2, agg: "median" }] }));
time("region rows x distinct accounts", () => pivot(cols, { rows: [0], cols: [], values: [{ field: 1, agg: "countDistinct" }] }));
const r = pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 2, agg: "sum" }] });
time("drill-down to one leaf cell", () => r.members(0, 0));
time("drill-down to the grand total", () => r.members(r.rowItems.length - 1, 0));
time("profile amount (numbers, past the distinct cap)", () => profile(cols[2]));
time("profile date (dates)", () => profile(cols[3], { date: true }));
time("profile account (text)", () => profile(cols[1]));
