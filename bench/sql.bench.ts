// Timing for the SQL engine on big synthetic tables.
// Run with: npx vite-node bench/sql.bench.ts [rows] [joinRows]
import type { ColumnData } from "../packages/core/src/columns";
import { runSql, type SqlTable } from "../packages/core/src/sql";

const N = Number(process.argv[2] ?? 10_000_000);
const M = Number(process.argv[3] ?? 1_000_000);
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;

const regions = ["North", "South", "East", "West", "Central", "Export", "Online", "Other"];
const region = new Uint32Array(N);
const amount = new Float64Array(N);
const account = new Float64Array(N);
const date = new Float64Array(N);
for (let i = 0; i < N; i++) {
  region[i] = 1 + Math.floor(rnd() * regions.length);
  amount[i] = Math.round(rnd() * 1e7) / 100;
  account[i] = 1000 + Math.floor(rnd() * 500);
  date[i] = 45000 + Math.floor(rnd() * 730);
}
const t: SqlTable = {
  name: "t",
  columns: [
    { kind: "string", name: "region", codes: region, dict: regions },
    { kind: "number", name: "amount", values: amount },
    { kind: "number", name: "account", values: account },
    { kind: "number", name: "date", values: date },
  ],
  numFmts: ["", "#,##0.00", "", "yyyy-mm-dd"],
};

const ka = new Float64Array(M);
const kb = new Float64Array(M);
const xa = new Float64Array(M);
const yb = new Float64Array(M);
for (let i = 0; i < M; i++) {
  ka[i] = i;
  kb[i] = Math.floor(rnd() * M * 1.1);
  xa[i] = rnd() * 100;
  yb[i] = rnd() * 100;
}
const a: SqlTable = { name: "a", columns: [{ kind: "number", name: "id", values: ka }, { kind: "number", name: "x", values: xa }] as ColumnData[] };
const b: SqlTable = { name: "b", columns: [{ kind: "number", name: "id", values: kb }, { kind: "number", name: "y", values: yb }] as ColumnData[] };
const tables = [t, a, b];

const time = (sql: string) => {
  const t0 = performance.now();
  const r = runSql(sql, tables);
  console.log(`${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${String(r.rowCount).padStart(8)} rows  ${sql}`);
};

console.log(`${N.toLocaleString()} rows; joins ${M.toLocaleString()} x ${M.toLocaleString()}`);
time("SELECT region, SUM(amount) FROM t GROUP BY region");
time("SELECT region, SUM(amount) FROM t GROUP BY region");
time("SELECT region, account, SUM(amount), COUNT(*) FROM t GROUP BY region, account");
time("SELECT DATE_TRUNC('month', date) m, SUM(amount) FROM t GROUP BY m ORDER BY m");
time("SELECT account, AVG(amount), MAX(amount) FROM t WHERE amount > 50000 GROUP BY account");
time("SELECT COUNT(*) FROM t WHERE region = 'East' AND amount BETWEEN 100 AND 200");
time("SELECT * FROM t ORDER BY amount DESC LIMIT 10");
time("SELECT region, amount FROM t ORDER BY region, amount DESC");
time("SELECT a.id, a.x, b.y FROM a JOIN b ON a.id = b.id");
time("SELECT a.id FROM a LEFT JOIN b ON a.id = b.id WHERE b.id IS NULL");
time("SELECT a.id, b.y FROM a FULL JOIN b ON a.id = b.id");
time("SELECT id, x, SUM(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM a");
