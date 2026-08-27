import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ColumnData } from "../src/columns";
import { dateToSerial } from "../src/numfmt";
import { parseSql, resultRows, runSql, SqlError, sqlTableNames, type SqlTable } from "../src/sql";
import type { Expr, From, Select } from "../src/sql/ast";

type V = string | number | null;

function text(name: string, values: (string | null)[]): ColumnData {
  const dict: string[] = [];
  const at = new Map<string, number>();
  const codes = Uint32Array.from(values, (v) => {
    if (v === null) return 0;
    let c = at.get(v);
    if (c === undefined) {
      c = dict.push(v);
      at.set(v, c);
    }
    return c;
  });
  return { kind: "string", name, codes, dict };
}
const num = (name: string, values: (number | null)[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values, (v) => v ?? NaN) });

/** A table from rows; a column is numeric when every value is a number or null. */
function table(name: string, header: string[], rows: V[][], numFmts?: string[]): SqlTable {
  const columns = header.map((h, c) => {
    const vals = rows.map((r) => r[c]);
    return vals.every((v) => v === null || typeof v === "number") ? num(h, vals as (number | null)[]) : text(h, vals.map((v) => (v === null ? null : String(v))));
  });
  return { name, columns, numFmts };
}

const d = (s: string) => {
  const [y, m, dd] = s.split("-").map(Number);
  return dateToSerial(y, m, dd);
};

const gl = table(
  "GL",
  ["Date", "Account", "Description", "Amount", "Ref"],
  [
    [d("2024-01-05"), "4000", "Sales A", 100, "INV1"],
    [d("2024-01-20"), "4000", "Sales B", 250.5, "INV2"],
    [d("2024-02-03"), "4000", "Sales C", 75, "INV3"],
    [d("2024-02-10"), "5000", "Rent", -1200, "RENT2"],
    [d("2024-01-10"), "5000", "Rent", -1200, "RENT1"],
    [d("2024-02-28"), "6000", "Bank fee", -12.34, null],
    [d("2024-03-01"), "6000", "Bank fee", -12.34, "FEE3"],
    [d("2024-03-15"), "4000", "Sales A", 100, "INV1"],
  ],
  ["dd/mm/yyyy", "", "", "#,##0.00", ""],
);
const bank = table(
  "Bank Feb",
  ["Ref", "Amount"],
  [
    ["INV1", 100],
    ["INV2", 250.5],
    ["XYZ", 9],
    [null, 5],
  ],
);
const people = table(
  "people",
  ["id", "name", "dept", "salary"],
  [
    [1, "Ann", "Ops", 100],
    [2, "bob", "Ops", 80],
    [3, "Cy", "Fin", 120],
    [4, "Dee", null, 90],
    [5, "eve", "Fin", null],
  ],
);
const depts = table(
  "depts",
  ["dept", "floor"],
  [
    ["Ops", 1],
    ["Fin", 2],
    ["HR", 3],
  ],
);
const TABLES = [gl, bank, people, depts];

const rows = (sql: string, tables: SqlTable[] = TABLES): V[][] => resultRows(runSql(sql, tables)) as V[][];
const col = (sql: string, tables: SqlTable[] = TABLES): V[] => rows(sql, tables).map((r) => r[0]);
const names = (sql: string): string[] => runSql(sql, TABLES).columns.map((c) => c.name);
function errorOf(sql: string, tables: SqlTable[] = TABLES): SqlError {
  try {
    runSql(sql, tables);
  } catch (e) {
    if (e instanceof SqlError) return e;
    throw e;
  }
  throw new Error(`no error for ${sql}`);
}

// ------------------------------------------------------------------ parse --

describe("parse errors", () => {
  it("point at the position", () => {
    const e = errorOf("SELEC * FROM GL");
    expect(e.line).toBe(1);
    expect(e.column).toBe(1);
    expect(e.reason).toMatch(/Expected SELECT/);
    const e2 = errorOf("SELECT Amount\nFROM GL\nWHERE Amount >");
    expect(e2.line).toBe(3);
    expect(e2.reason).toMatch(/ends too early/);
    expect(e2.message).toMatch(/line 3, column 15/);
  });
  it("explain common mistakes", () => {
    expect(errorOf("SELECT 'abc FROM GL").reason).toMatch(/never closed/);
    expect(errorOf('SELECT "abc FROM GL').reason).toMatch(/never closed/);
    expect(errorOf("SELECT * FROM 'GL'").reason).toMatch(/double quotes/);
    expect(errorOf("SELECT (1 + 2 FROM GL").reason).toMatch(/Expected "\)"/);
    expect(errorOf("SELECT 1 + 2) FROM GL").reason).toMatch(/without a matching/);
    expect(errorOf("SELECT * FROM GL WHERE Amount > 1 GROUP Account").reason).toMatch(/Expected BY/);
    expect(errorOf("SELECT * FROM GL a JOIN Bank b").reason).toMatch(/Expected ON/);
    expect(errorOf("SELECT * FROM GL GROUP BY Account WHERE Amount > 0").reason).toMatch(/WHERE goes before/);
    expect(errorOf("SELECT FROM GL").reason).toMatch(/what to select/);
    expect(errorOf("").reason).toMatch(/empty/);
    expect(errorOf("SELECT 1; SELECT 2").reason).toMatch(/only one query/);
    expect(errorOf("SELECT * FROM GL WHERE Amount ! 3").reason).toMatch(/Unexpected character/);
    expect(errorOf("SELECT CASE WHEN 1 THEN 2 FROM GL").reason).toMatch(/Expected END/);
    expect(errorOf("SELECT order FROM GL").reason).toMatch(/keyword/);
    expect(errorOf("SELECT 2024Sales FROM GL").reason).toMatch(/quote names/);
    expect(errorOf("SELECT /* x FROM GL").reason).toMatch(/comment/);
    expect(errorOf("SELECT * FROM GL WHERE d = DATE '2024-02-30'").reason).toMatch(/isn't a date/);
  });
  it("parses the full grammar", () => {
    const q = parseSql(`
      WITH m AS (SELECT Account, SUM(Amount) AS total FROM GL GROUP BY Account)
      SELECT DISTINCT a.Account AS acct, -- comment
             CASE WHEN total > 0 THEN 'cr' ELSE 'dr' END kind
      FROM m a LEFT OUTER JOIN (SELECT * FROM GL) g ON a.Account = g.Account
      WHERE g.Ref IS NOT NULL AND g.Amount NOT BETWEEN 1 AND 2 AND g.Ref NOT IN ('x') AND g.Ref NOT LIKE 'Z%'
      GROUP BY 1, 2 HAVING COUNT(*) >= 1
      UNION ALL SELECT 'x', 'y'
      ORDER BY 1 DESC NULLS LAST, 2 LIMIT 10 OFFSET 2;`);
    expect(q.with).toHaveLength(1);
    expect(q.body.k).toBe("setop");
    expect(q.order).toHaveLength(2);
  });
  it("reads identifiers in quotes and brackets", () => {
    const q = parseSql('SELECT "Sales 2024", [Account Name], `x y` FROM "Bank Feb"');
    const s = q.body as Select;
    expect(s.items.map((i) => (i.e as Extract<Expr, { k: "col" }>).name)).toEqual(["Sales 2024", "Account Name", "x y"]);
    expect((s.from as Extract<From, { k: "table" }>).name).toBe("Bank Feb");
  });
});

// --------------------------------------------------------------- features --

describe("select", () => {
  it("selects, filters, names columns", () => {
    expect(rows("SELECT name, salary * 2 AS double FROM people WHERE salary > 85 ORDER BY id")).toEqual([
      ["Ann", 200],
      ["Cy", 240],
      ["Dee", 180],
    ]);
    expect(names("SELECT name, salary * 2, SUM(salary) OVER () total FROM people")).toEqual(["name", "salary * 2", "total"]);
    expect(names("SELECT * FROM depts")).toEqual(["dept", "floor"]);
    expect(names("SELECT p.*, d.floor FROM people p JOIN depts d ON p.dept = d.dept")).toEqual(["id", "name", "dept", "salary", "floor"]);
  });
  it("is case-insensitive for names and keywords", () => {
    expect(col("select NAME from PEOPLE where ID = 3")).toEqual(["Cy"]);
  });
  it("tables and columns with spaces", () => {
    expect(col('SELECT [Amount] FROM "Bank Feb" WHERE "Ref" = \'XYZ\'')).toEqual([9]);
  });
  it("SELECT without FROM", () => {
    expect(rows("SELECT 1 + 2, 'a' || 'b', 7 / 2, 7 % 3, 1 / 0")).toEqual([[3, "ab", 3.5, 1, null]]);
  });
  it("DISTINCT", () => {
    expect(col("SELECT DISTINCT dept FROM people ORDER BY dept")).toEqual(["Fin", "Ops", null]);
    expect(rows("SELECT DISTINCT Account, Description FROM GL ORDER BY 1, 2")).toHaveLength(5);
  });
  it("ORDER BY directions, NULLS, positions, aliases, expressions", () => {
    expect(col("SELECT salary FROM people ORDER BY salary")).toEqual([80, 90, 100, 120, null]);
    expect(col("SELECT salary FROM people ORDER BY salary DESC")).toEqual([null, 120, 100, 90, 80]);
    expect(col("SELECT salary FROM people ORDER BY salary NULLS FIRST")).toEqual([null, 80, 90, 100, 120]);
    expect(col("SELECT salary FROM people ORDER BY salary DESC NULLS LAST")).toEqual([120, 100, 90, 80, null]);
    expect(col("SELECT name FROM people ORDER BY name")).toEqual(["Ann", "bob", "Cy", "Dee", "eve"]);
    expect(col("SELECT name, salary s FROM people ORDER BY s DESC NULLS LAST, 1")).toEqual(["Cy", "Ann", "Dee", "bob", "eve"]);
    expect(col("SELECT name FROM people ORDER BY LENGTH(name) DESC, id")).toEqual(["Ann", "bob", "Dee", "eve", "Cy"]);
    expect(col("SELECT name FROM people ORDER BY dept, id")).toEqual(["Cy", "eve", "Ann", "bob", "Dee"]);
  });
  it("LIMIT and OFFSET", () => {
    expect(col("SELECT id FROM people ORDER BY id LIMIT 2")).toEqual([1, 2]);
    expect(col("SELECT id FROM people ORDER BY id LIMIT 2 OFFSET 3")).toEqual([4, 5]);
    expect(col("SELECT id FROM people ORDER BY id OFFSET 4")).toEqual([5]);
    expect(col("SELECT id FROM people ORDER BY id FETCH FIRST 1 ROWS ONLY")).toEqual([1]);
    expect(errorOf("SELECT id FROM people LIMIT -1").reason).toMatch(/whole number/);
  });
});

describe("NULL and three-valued logic", () => {
  it("comparisons with NULL are unknown, so WHERE drops them", () => {
    expect(col("SELECT id FROM people WHERE dept = 'Ops' OR dept <> 'Ops' ORDER BY id")).toEqual([1, 2, 3, 5]);
    expect(col("SELECT id FROM people WHERE NOT (dept = 'Ops')")).toEqual([3, 5]);
    expect(col("SELECT id FROM people WHERE dept IS NULL")).toEqual([4]);
    expect(col("SELECT id FROM people WHERE salary IS NOT NULL AND dept IS NOT NULL")).toEqual([1, 2, 3]);
  });
  it("AND / OR / NOT truth tables", () => {
    expect(rows("SELECT NULL AND FALSE, NULL AND TRUE, NULL OR TRUE, NULL OR FALSE, NOT NULL, TRUE AND TRUE")).toEqual([["FALSE", null, "TRUE", null, null, "TRUE"]]);
  });
  it("NULL in arithmetic and text", () => {
    expect(rows("SELECT 1 + NULL, 'a' || NULL, CONCAT('a', NULL, 'b'), NULL = NULL, NULL IS NULL")).toEqual([[null, null, "ab", null, "TRUE"]]);
  });
  it("IN with NULLs", () => {
    expect(rows("SELECT 1 IN (1, NULL), 2 IN (1, NULL), 2 NOT IN (1, NULL), 2 NOT IN (1, 3), NULL IN (1)")).toEqual([["TRUE", null, null, "TRUE", null]]);
    // NOT IN a list with NULL keeps nothing
    expect(col("SELECT id FROM people WHERE dept NOT IN ('Ops', NULL)")).toEqual([]);
  });
  it("aggregates skip NULLs; empty sums are NULL, counts are 0", () => {
    expect(rows("SELECT COUNT(*), COUNT(salary), SUM(salary), AVG(salary), MIN(dept) FROM people")).toEqual([[5, 4, 390, 97.5, "Fin"]]);
    expect(rows("SELECT COUNT(*), SUM(salary), MAX(name) FROM people WHERE id > 100")).toEqual([[0, null, null]]);
    expect(rows("SELECT dept, COUNT(*) FROM people WHERE id > 100 GROUP BY dept")).toEqual([]);
  });
  it("GROUP BY puts NULLs in one group", () => {
    expect(rows("SELECT dept, COUNT(*) n FROM people GROUP BY dept ORDER BY dept NULLS FIRST")).toEqual([
      [null, 1],
      ["Fin", 2],
      ["Ops", 2],
    ]);
  });
  it("IS DISTINCT FROM, IS TRUE", () => {
    expect(rows("SELECT NULL IS DISTINCT FROM NULL, 1 IS DISTINCT FROM NULL, 1 IS NOT DISTINCT FROM 1, NULL IS TRUE, (1 = 1) IS TRUE, NULL IS NOT TRUE")).toEqual([["FALSE", "TRUE", "TRUE", "FALSE", "TRUE", "TRUE"]]);
  });
});

describe("expressions", () => {
  it("CASE, both forms", () => {
    expect(col("SELECT CASE WHEN salary >= 100 THEN 'high' WHEN salary < 100 THEN 'low' ELSE 'none' END FROM people ORDER BY id")).toEqual(["high", "low", "high", "low", "none"]);
    expect(col("SELECT CASE dept WHEN 'Ops' THEN 1 WHEN 'Fin' THEN 2 END FROM people ORDER BY id")).toEqual([1, 1, 2, null, 2]);
    expect(col("SELECT CASE WHEN id = 1 THEN 'x' ELSE id END FROM people WHERE id <= 2 ORDER BY id")).toEqual(["x", "2"]);
  });
  it("IN, BETWEEN", () => {
    expect(col("SELECT id FROM people WHERE dept IN ('Ops', 'HR') ORDER BY id")).toEqual([1, 2]);
    expect(col("SELECT id FROM people WHERE id IN (2, 4, 9) ORDER BY id")).toEqual([2, 4]);
    expect(col("SELECT id FROM people WHERE salary BETWEEN 90 AND 100 ORDER BY id")).toEqual([1, 4]);
    expect(col("SELECT id FROM people WHERE salary NOT BETWEEN 90 AND 100 ORDER BY id")).toEqual([2, 3]);
    expect(col("SELECT id FROM people WHERE id IN (salary / 100, 3) ORDER BY id")).toEqual([1, 3]);
  });
  it("LIKE and ILIKE", () => {
    expect(col("SELECT Description FROM GL WHERE Description LIKE 'Sales%' ORDER BY Description")).toEqual(["Sales A", "Sales A", "Sales B", "Sales C"]);
    expect(col("SELECT name FROM people WHERE name LIKE '_o_'")).toEqual(["bob"]);
    expect(col("SELECT name FROM people WHERE name ILIKE 'b%' OR name ILIKE 'E%' ORDER BY id")).toEqual(["bob", "eve"]);
    expect(col("SELECT name FROM people WHERE name NOT LIKE '%e%' ORDER BY id")).toEqual(["Ann", "bob", "Cy"]);
    expect(rows("SELECT '50%' LIKE '50!%' ESCAPE '!', '501' LIKE '50!%' ESCAPE '!', 'a.c' LIKE 'a.c', 'abc' LIKE 'a.c'")).toEqual([["TRUE", "FALSE", "TRUE", "FALSE"]]);
  });
  it("COALESCE, NULLIF, GREATEST, LEAST", () => {
    expect(col("SELECT COALESCE(dept, 'none') FROM people ORDER BY id")).toEqual(["Ops", "Ops", "Fin", "none", "Fin"]);
    expect(col("SELECT COALESCE(salary, 0) FROM people ORDER BY id")).toEqual([100, 80, 120, 90, 0]);
    expect(col("SELECT NULLIF(dept, 'Ops') FROM people ORDER BY id")).toEqual([null, null, "Fin", null, "Fin"]);
    expect(rows("SELECT GREATEST(1, 5, 3), LEAST(4, 2, NULL), COALESCE(NULL, NULL)")).toEqual([[5, 2, null]]);
  });
  it("string functions", () => {
    expect(rows("SELECT LOWER('AbC'), UPPER('abc'), TRIM('  x '), LTRIM(' x'), RTRIM('x '), LENGTH('hello'), LEN('ab')")).toEqual([["abc", "ABC", "x", "x", "x", 5, 2]]);
    expect(rows("SELECT SUBSTR('abcdef', 2, 3), SUBSTRING('abcdef', 3), SUBSTRING('abcdef' FROM 2 FOR 2), LEFT('abcdef', 2), RIGHT('abcdef', 2)")).toEqual([["bcd", "cdef", "bc", "ab", "ef"]]);
    expect(rows("SELECT REPLACE('a-b-c', '-', '/'), CONCAT('a', 1, 'b'), 'x' || 2 || 'y', POSITION('c' IN 'abc'), STRPOS('abc', 'b'), LPAD('7', 3, '0')")).toEqual([["a/b/c", "a1b", "x2y", 3, 2, "007"]]);
    expect(col("SELECT UPPER(name) || '-' || dept FROM people ORDER BY id")).toEqual(["ANN-Ops", "BOB-Ops", "CY-Fin", null, "EVE-Fin"]);
  });
  it("number functions and casts", () => {
    expect(rows("SELECT ROUND(2.345, 2), ROUND(-2.5), ROUND(1234.5, -2), TRUNC(2.789, 1), ABS(-3), FLOOR(2.7), CEIL(2.1), MOD(7, 3), POWER(2, 10), SQRT(16)")).toEqual([[2.35, -3, 1200, 2.7, 3, 2, 3, 1, 1024, 4]]);
    expect(rows("SELECT CAST('12.5' AS NUMBER), CAST(12.7 AS INTEGER), CAST(42 AS TEXT), CAST('abc' AS NUMBER), CAST('2024-01-31' AS DATE)")).toEqual([[12.5, 12, "42", null, d("2024-01-31")]]);
  });
  it("text that holds numbers compares as numbers", () => {
    expect(col("SELECT Account FROM GL WHERE Account = 5000")).toEqual(["5000", "5000"]);
    expect(col("SELECT COUNT(*) FROM GL WHERE Account > 4500")).toEqual([4]);
    expect(rows("SELECT '10' + 5, '10' = 10, 'abc' = 1")).toEqual([[15, "TRUE", null]]);
  });
  it("text order is case-insensitive (ties broken exactly), equality is exact", () => {
    expect(rows("SELECT 'apple' < 'Banana', 'a' = 'A', 'B' < 'a', MIN(name), MAX(name) FROM people")).toEqual([["TRUE", "FALSE", "FALSE", "Ann", "eve"]]);
  });
});

describe("dates (Excel serials)", () => {
  it("date literals, parts, truncation, month ends", () => {
    expect(rows("SELECT DATE '2024-03-31', YEAR(DATE '2024-03-31'), MONTH(DATE '2024-03-31'), DAY(DATE '2024-03-31'), QUARTER(DATE '2024-03-31')")).toEqual([[d("2024-03-31"), 2024, 3, 31, 1]]);
    expect(rows("SELECT DATE_TRUNC('month', DATE '2024-03-31'), DATE_TRUNC('year', DATE '2024-03-31'), DATE_TRUNC('quarter', DATE '2024-05-31'), DATE_TRUNC('week', DATE '2024-03-31')")).toEqual([[d("2024-03-01"), d("2024-01-01"), d("2024-04-01"), d("2024-03-25")]]);
    expect(rows("SELECT EOMONTH(DATE '2024-01-15'), EOMONTH(DATE '2024-01-15', 1), DATE(2024, 2, 29), EXTRACT(YEAR FROM DATE '2023-07-01')")).toEqual([[d("2024-01-31"), d("2024-02-29"), d("2024-02-29"), 2023]]);
    expect(rows("SELECT DATE '2024-03-31' - DATE '2024-03-01', DATE '2024-03-01' + 30, DATEDIFF('month', DATE '2024-01-31', DATE '2024-03-01')")).toEqual([[30, d("2024-03-31"), 2]]);
    expect(errorOf("SELECT DATE_TRUNC('fortnight', DATE '2024-01-01')").reason).toMatch(/doesn't know the unit/);
  });
  it("dates compare with date literals and ISO text", () => {
    expect(col("SELECT Ref FROM GL WHERE Date >= DATE '2024-02-01' AND Date < '2024-03-01' ORDER BY Date")).toEqual(["INV3", "RENT2", null]);
  });
  it("keeps date formats on the result", () => {
    const r = runSql("SELECT Date, DATE_TRUNC('month', Date) m, YEAR(Date) y, Amount, Date + 1 FROM GL", TABLES);
    expect(r.numFmts).toEqual(["dd/mm/yyyy", "yyyy-mm-dd", "", "#,##0.00", "dd/mm/yyyy"]);
  });
  it("dates in text show as ISO dates", () => {
    expect(col("SELECT 'on ' || DATE '2024-03-31'")).toEqual(["on 2024-03-31"]);
  });
});

describe("GROUP BY", () => {
  it("totals by account and month", () => {
    expect(rows("SELECT Account, DATE_TRUNC('month', Date) AS month, SUM(Amount) AS total, COUNT(*) AS n FROM GL GROUP BY Account, month ORDER BY Account, month")).toEqual([
      ["4000", d("2024-01-01"), 350.5, 2],
      ["4000", d("2024-02-01"), 75, 1],
      ["4000", d("2024-03-01"), 100, 1],
      ["5000", d("2024-01-01"), -1200, 1],
      ["5000", d("2024-02-01"), -1200, 1],
      ["6000", d("2024-02-01"), -12.34, 1],
      ["6000", d("2024-03-01"), -12.34, 1],
    ]);
  });
  it("by position and by expression", () => {
    expect(rows("SELECT YEAR(Date), MONTH(Date), SUM(Amount) FROM GL GROUP BY 1, 2 ORDER BY 1, 2").map((r) => r[1])).toEqual([1, 2, 3]);
    expect(rows("SELECT UPPER(dept), COUNT(*) FROM people GROUP BY UPPER(dept) ORDER BY 1")).toEqual([
      ["FIN", 2],
      ["OPS", 2],
      [null, 1],
    ]);
  });
  it("HAVING finds duplicates", () => {
    expect(rows("SELECT Ref, COUNT(*) AS n, SUM(Amount) FROM GL WHERE Ref IS NOT NULL GROUP BY Ref HAVING COUNT(*) > 1")).toEqual([["INV1", 2, 200]]);
    expect(rows("SELECT Account, Amount, COUNT(*) FROM GL GROUP BY Account, Amount HAVING COUNT(*) > 1 ORDER BY Account")).toEqual([
      ["4000", 100, 2],
      ["5000", -1200, 2],
      ["6000", -12.34, 2],
    ]);
  });
  it("all the aggregates", () => {
    expect(rows("SELECT dept, COUNT(DISTINCT name), SUM(salary), AVG(salary), MIN(salary), MAX(salary), MEDIAN(salary) FROM people WHERE dept IS NOT NULL GROUP BY dept ORDER BY dept")).toEqual([
      ["Fin", 2, 120, 120, 120, 120, 120],
      ["Ops", 2, 180, 90, 80, 100, 90],
    ]);
    const [[sd, sdp, v, med]] = rows("SELECT STDDEV(x), STDDEV_POP(x), VARIANCE(x), MEDIAN(x) FROM (SELECT 2 x UNION ALL SELECT 4 UNION ALL SELECT 4 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 5 UNION ALL SELECT 7 UNION ALL SELECT 9) t") as number[][];
    expect(sdp).toBeCloseTo(2, 10);
    expect(sd).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(v).toBeCloseTo(32 / 7, 10);
    expect(med).toBe(4.5);
    expect(rows("SELECT COUNT(DISTINCT Account), SUM(DISTINCT Amount), STRING_AGG(DISTINCT Account, '|') FROM GL")).toEqual([[3, 100 + 250.5 + 75 - 1200 - 12.34, "4000|5000|6000"]]);
  });
  it("sums cents exactly over many rows", () => {
    const n = 100_000;
    const t = { name: "t", columns: [num("x", Array.from({ length: n }, () => 0.1))] };
    expect(col("SELECT SUM(x) FROM t", [t])[0]).toBe(10000);
  });
  it("errors for columns not grouped, aggregates in WHERE", () => {
    expect(errorOf("SELECT Account, Description, SUM(Amount) FROM GL GROUP BY Account").reason).toMatch(/"Description" isn't in GROUP BY/);
    expect(errorOf("SELECT Account FROM GL WHERE SUM(Amount) > 0 GROUP BY Account").reason).toMatch(/use HAVING/);
    expect(errorOf("SELECT SUM(SUM(Amount)) FROM GL").reason).toMatch(/inside another aggregate/);
    expect(errorOf("SELECT * FROM GL HAVING Amount > 1").reason).toMatch(/HAVING needs GROUP BY/);
    expect(errorOf("SELECT ROW_NUMBER() FROM GL").reason).toMatch(/needs OVER/);
  });
});

describe("joins", () => {
  it("inner, left, right, full", () => {
    expect(rows("SELECT p.name, d.floor FROM people p JOIN depts d ON p.dept = d.dept ORDER BY p.id")).toEqual([
      ["Ann", 1],
      ["bob", 1],
      ["Cy", 2],
      ["eve", 2],
    ]);
    expect(rows("SELECT p.name, d.floor FROM people p LEFT JOIN depts d ON p.dept = d.dept ORDER BY p.id").map((r) => r[1])).toEqual([1, 1, 2, null, 2]);
    expect(rows("SELECT d.dept, p.name FROM people p RIGHT JOIN depts d ON p.dept = d.dept WHERE p.id IS NULL")).toEqual([["HR", null]]);
    expect(rows("SELECT p.name, d.dept FROM people p FULL OUTER JOIN depts d ON p.dept = d.dept ORDER BY p.id NULLS LAST")).toEqual([
      ["Ann", "Ops"],
      ["bob", "Ops"],
      ["Cy", "Fin"],
      ["Dee", null],
      ["eve", "Fin"],
      [null, "HR"],
    ]);
  });
  it("unmatched items with LEFT JOIN ... IS NULL", () => {
    expect(rows('SELECT g.Ref, g.Amount FROM GL g LEFT JOIN "Bank Feb" b ON g.Ref = b.Ref WHERE b.Ref IS NULL ORDER BY g.Date')).toEqual([
      ["RENT1", -1200],
      ["INV3", 75],
      ["RENT2", -1200],
      [null, -12.34],
      ["FEE3", -12.34],
    ]);
  });
  it("extra ON conditions decide the match (not a filter afterwards)", () => {
    expect(rows("SELECT p.name, d.floor FROM people p LEFT JOIN depts d ON p.dept = d.dept AND d.floor > 1 ORDER BY p.id").map((r) => r[1])).toEqual([null, null, 2, null, 2]);
    expect(rows("SELECT p.name, d.dept FROM people p JOIN depts d ON p.salary > 110 AND d.floor = 3")).toEqual([["Cy", "HR"]]);
  });
  it("multi-column keys, USING, CROSS JOIN, comma joins", () => {
    expect(rows("SELECT a.Ref, b.Amount FROM GL a JOIN \"Bank Feb\" b ON a.Ref = b.Ref AND a.Amount = b.Amount ORDER BY a.Date")).toEqual([
      ["INV1", 100],
      ["INV2", 250.5],
      ["INV1", 100],
    ]);
    expect(rows("SELECT name, floor FROM people JOIN depts USING (dept) WHERE id = 3")).toEqual([["Cy", 2]]);
    expect(col("SELECT COUNT(*) FROM people CROSS JOIN depts")).toEqual([15]);
    expect(col("SELECT COUNT(*) FROM people p, depts d WHERE p.dept = d.dept")).toEqual([4]);
  });
  it("NULL keys never match", () => {
    const a = table("a", ["k"], [["x"], [null]]);
    const b = table("b", ["k"], [["x"], [null]]);
    expect(col("SELECT COUNT(*) FROM a JOIN b ON a.k = b.k", [a, b])).toEqual([1]);
  });
  it("numbers match numeric text", () => {
    const a = table("a", ["acct"], [[4000], [5000]]);
    expect(col("SELECT COUNT(*) FROM a JOIN GL g ON a.acct = g.Account", [a, gl])).toEqual([6]);
  });
  it("ambiguous and unknown names", () => {
    expect(errorOf("SELECT dept FROM people p JOIN depts d ON p.dept = d.dept").reason).toMatch(/more than one table.*p\.dept/);
    expect(errorOf("SELECT x.name FROM people p").reason).toMatch(/no table or alias "x"/);
    expect(errorOf("SELECT nmae FROM people").reason).toMatch(/no column "nmae".*Columns: id, name/);
    expect(errorOf("SELECT Desc_ription FROM GL").reason).toMatch(/Did you mean Description/);
    expect(errorOf("SELECT * FROM nope").reason).toMatch(/no table.*Tables: GL, "Bank Feb"/);
    expect(errorOf("SELECT * FROM people JOIN people ON 1 = 1").reason).toMatch(/used for two tables/);
  });
});

describe("set operations, subqueries, CTEs", () => {
  it("UNION ALL, UNION, EXCEPT, INTERSECT", () => {
    expect(col("SELECT dept FROM people UNION ALL SELECT dept FROM depts")).toHaveLength(8);
    expect(col("SELECT dept FROM people UNION SELECT dept FROM depts ORDER BY 1")).toEqual(["Fin", "HR", "Ops", null]);
    expect(col("SELECT dept FROM depts EXCEPT SELECT dept FROM people")).toEqual(["HR"]);
    expect(col("SELECT dept FROM depts INTERSECT SELECT dept FROM people ORDER BY dept")).toEqual(["Fin", "Ops"]);
    expect(rows("SELECT 1, 'a' UNION ALL SELECT 2.5, 'b' ORDER BY 1 DESC")).toEqual([
      [2.5, "b"],
      [1, "a"],
    ]);
    expect(errorOf("SELECT 1 UNION SELECT 1, 2").reason).toMatch(/same number of columns/);
  });
  it("subqueries in FROM, IN, as values, EXISTS", () => {
    expect(col("SELECT t.total FROM (SELECT dept, SUM(salary) total FROM people GROUP BY dept) t WHERE t.dept = 'Ops'")).toEqual([180]);
    expect(col("SELECT name FROM people WHERE dept IN (SELECT dept FROM depts WHERE floor = 2) ORDER BY id")).toEqual(["Cy", "eve"]);
    expect(col("SELECT name FROM people WHERE dept NOT IN (SELECT dept FROM depts WHERE floor = 2) ORDER BY id")).toEqual(["Ann", "bob"]);
    expect(col("SELECT name FROM people WHERE salary > (SELECT AVG(salary) FROM people) ORDER BY id")).toEqual(["Ann", "Cy"]);
    expect(col("SELECT COUNT(*) FROM people WHERE EXISTS (SELECT 1 FROM depts WHERE floor = 3)")).toEqual([5]);
    expect(errorOf("SELECT (SELECT dept FROM depts)").reason).toMatch(/at most one row/);
  });
  it("WITH (CTEs), chained", () => {
    expect(
      rows(`WITH m AS (SELECT Account, SUM(Amount) AS total FROM GL GROUP BY Account),
                 big AS (SELECT * FROM m WHERE ABS(total) > 100)
            SELECT Account, total FROM big ORDER BY Account`),
    ).toEqual([
      ["4000", 525.5],
      ["5000", -2400],
    ]);
    expect(errorOf("WITH a AS (SELECT * FROM a) SELECT * FROM a").reason).toMatch(/recursive/);
  });
});

describe("window functions", () => {
  it("ROW_NUMBER, RANK, DENSE_RANK", () => {
    expect(rows("SELECT name, ROW_NUMBER() OVER (ORDER BY salary DESC NULLS LAST), RANK() OVER (ORDER BY dept), DENSE_RANK() OVER (ORDER BY dept) FROM people ORDER BY id")).toEqual([
      ["Ann", 2, 3, 2],
      ["bob", 4, 3, 2],
      ["Cy", 1, 1, 1],
      ["Dee", 3, 5, 3],
      ["eve", 5, 1, 1],
    ]);
    expect(col("SELECT ROW_NUMBER() OVER (PARTITION BY dept ORDER BY id) FROM people ORDER BY id")).toEqual([1, 2, 1, 1, 2]);
  });
  it("running balance with SUM OVER", () => {
    expect(rows("SELECT Ref, SUM(Amount) OVER (PARTITION BY Account ORDER BY Date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance FROM GL WHERE Account = '4000' ORDER BY Date")).toEqual([
      ["INV1", 100],
      ["INV2", 350.5],
      ["INV3", 425.5],
      ["INV1", 525.5],
    ]);
    // RANGE (the default with ORDER BY) includes rows with the same date
    const t = table("t", ["d", "x"], [[1, 1], [1, 2], [2, 3]]);
    expect(col("SELECT SUM(x) OVER (ORDER BY d) FROM t", [t])).toEqual([3, 3, 6]);
    expect(col("SELECT SUM(x) OVER (ORDER BY d ROWS UNBOUNDED PRECEDING) FROM t", [t])).toEqual([1, 3, 6]);
    expect(col("SELECT SUM(x) OVER () FROM t", [t])).toEqual([6, 6, 6]);
  });
  it("moving windows, AVG, MIN, MAX, COUNT", () => {
    const t = table("t", ["i", "x"], [[1, 5], [2, 1], [3, 4], [4, null], [5, 2]]);
    expect(rows("SELECT SUM(x) OVER w1, AVG(x) OVER w1, MIN(x) OVER w1, MAX(x) OVER w2, COUNT(x) OVER w2, COUNT(*) OVER w2 FROM t ORDER BY i".replace(/w1/g, "(ORDER BY i ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)").replace(/w2/g, "(ORDER BY i ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING)"), [t])).toEqual([
      [5, 5, 5, 5, 2, 2],
      [6, 3, 1, 4, 2, 2],
      [5, 2.5, 1, 4, 1, 2],
      [4, 4, 4, 2, 1, 2],
      [2, 2, 2, 2, 1, 1],
    ]);
    expect(col("SELECT MIN(name) OVER (PARTITION BY dept) FROM people ORDER BY id")).toEqual(["Ann", "Ann", "Cy", "Dee", "Cy"]);
  });
  it("LAG, LEAD, FIRST_VALUE, LAST_VALUE", () => {
    expect(rows("SELECT id, LAG(salary) OVER (ORDER BY id), LEAD(name, 2, 'end') OVER (ORDER BY id), FIRST_VALUE(name) OVER (PARTITION BY dept ORDER BY id), LAST_VALUE(name) OVER (PARTITION BY dept ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM people ORDER BY id")).toEqual([
      [1, null, "Cy", "Ann", "bob"],
      [2, 100, "Dee", "Ann", "bob"],
      [3, 80, "eve", "Cy", "eve"],
      [4, 120, "end", "Dee", "Dee"],
      [5, 90, "end", "Cy", "eve"],
    ]);
  });
  it("windows over grouped results", () => {
    const r2 = (rs: V[][]) => rs.map((r) => r.map((x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x)));
    expect(r2(rows("SELECT MONTH(Date) m, SUM(Amount) s, SUM(SUM(Amount)) OVER (ORDER BY MONTH(Date)) running, RANK() OVER (ORDER BY SUM(Amount) DESC) FROM GL GROUP BY MONTH(Date) ORDER BY m"))).toEqual([
      [1, -849.5, -849.5, 2],
      [2, -1137.34, -1986.84, 3],
      [3, 87.66, -1899.18, 1],
    ]);
  });
});

describe("the guide's examples run", () => {
  const md = readFileSync(new URL("../../../docs/guide/41-sql.md", import.meta.url), "utf8");
  const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).filter((q) => !q.includes("GL March"));
  const bankTable = { ...bank, name: "Bank" };
  it("has examples", () => expect(blocks.length).toBeGreaterThan(6));
  blocks.forEach((q, k) => it(`example ${k + 1}`, () => expect(runSql(q, [gl, bankTable]).columns.length).toBeGreaterThan(0)));
  it("finds the unmatched ledger lines", () => {
    expect(col(blocks.find((q) => q.includes("WHERE b.Ref IS NULL"))!, [gl, bankTable])).toHaveLength(5);
  });
});

describe("sorting big inputs", () => {
  const n = 20_000;
  const R = rng(5);
  const g = Array.from({ length: n }, () => (R() < 0.1 ? null : ["b", "A", "a", "c"][Math.floor(R() * 4)]));
  const x = Array.from({ length: n }, () => (R() < 0.1 ? null : Math.floor(R() * 50) - 25));
  const t = { name: "t", columns: [num("id", Array.from({ length: n }, (_, i) => i)), text("g", g), num("x", x)] };
  // the same order by hand: g ascending (nulls last, case-insensitive), x descending (nulls first), id
  const ci = (a: string, b: string) => (a.toLowerCase() !== b.toLowerCase() ? (a.toLowerCase() < b.toLowerCase() ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0);
  const want = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ga = g[a];
    const gb = g[b];
    if (ga !== gb) {
      if (ga === null) return 1;
      if (gb === null) return -1;
      const c = ci(ga, gb);
      if (c) return c;
    }
    const xa = x[a];
    const xb = x[b];
    if (xa !== xb) {
      if (xa === null) return -1;
      if (xb === null) return 1;
      return xb - xa;
    }
    return a - b;
  });
  it("radix sort on several keys, with NULL placement", () => {
    expect(col("SELECT id FROM t ORDER BY g, x DESC", [t])).toEqual(want);
  });
  it("top rows with LIMIT / OFFSET match the full sort", () => {
    expect(col("SELECT id FROM t ORDER BY g, x DESC LIMIT 25 OFFSET 40", [t])).toEqual(want.slice(40, 65));
    expect(col("SELECT id FROM t ORDER BY g, x DESC LIMIT 0", [t])).toEqual([]);
  });
});

describe("misc", () => {
  it("lists the tables a query reads", () => {
    expect(sqlTableNames('WITH m AS (SELECT * FROM GL) SELECT * FROM m JOIN "Bank Feb" b ON 1=1 WHERE x IN (SELECT y FROM people)').sort()).toEqual(["Bank Feb", "GL", "people"]);
  });
  it("loads tables on demand through a lookup", () => {
    const asked: string[] = [];
    const r = runSql("SELECT COUNT(*) FROM people", (name) => {
      asked.push(name);
      return TABLES.find((t) => t.name.toLowerCase() === name.toLowerCase());
    });
    expect(resultRows(r)).toEqual([[5]]);
    expect(asked).toEqual(["people"]);
  });
  it("never hands back the input's buffers", () => {
    const r = runSql("SELECT * FROM people", TABLES);
    expect((r.columns[0] as { values: Float64Array }).values).not.toBe((people.columns[0] as { values: Float64Array }).values);
    expect((r.columns[1] as { codes: Uint32Array }).codes).not.toBe((people.columns[1] as { codes: Uint32Array }).codes);
  });
  it("booleans come out as TRUE / FALSE text", () => {
    expect(col("SELECT salary > 90 FROM people ORDER BY id")).toEqual(["TRUE", "FALSE", "TRUE", "FALSE", null]);
  });
  it("stops runaway joins", () => {
    const big = { name: "big", columns: [num("k", Array.from({ length: 3000 }, () => 1))] };
    expect(() => runSql("SELECT * FROM big a JOIN big b ON a.k = b.k", [big], { maxRows: 1_000_000 })).toThrow(/more than 1,000,000 rows/);
  });
});

// ------------------------------------------------- fuzz vs a reference --

/**
 * A plain row-at-a-time interpreter of the same AST, written for clarity, not
 * speed. The fuzz test checks the vectorised engine against it.
 */
type RV = string | number | boolean | null;
type RefTable = { cols: string[]; rows: RV[][] };
type Row = Map<string, RV>;

function cmpText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function refCompare(a: RV, b: RV): number | null {
  if (a === null || b === null) return null;
  if (typeof a === "string" && typeof b === "string") return cmpText(a, b);
  const x = typeof a === "boolean" ? +a : +a;
  const y = typeof b === "boolean" ? +b : +b;
  return x < y ? -1 : x > y ? 1 : 0;
}
function refEq(a: RV, b: RV): boolean | null {
  if (a === null || b === null) return null;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return refCompare(a, b) === 0;
}
const AGGS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

function refEval(e: Expr, row: Row, group?: Row[]): RV {
  switch (e.k) {
    case "lit":
      return e.v;
    case "col": {
      const key = e.table ? `${e.table.toLowerCase()}.${e.name.toLowerCase()}` : [...row.keys()].find((k) => k.endsWith(`.${e.name.toLowerCase()}`))!;
      return row.get(key) ?? null;
    }
    case "unary": {
      const v = refEval(e.e, row, group);
      if (v === null) return null;
      return e.op === "NOT" ? !v : -(v as number);
    }
    case "bin": {
      const a = refEval(e.l, row, group);
      const b = refEval(e.r, row, group);
      switch (e.op) {
        case "AND":
          return a === false || b === false ? false : a === null || b === null ? null : true;
        case "OR":
          return a === true || b === true ? true : a === null || b === null ? null : false;
        case "=":
          return refEq(a, b);
        case "<>": {
          const r = refEq(a, b);
          return r === null ? null : !r;
        }
        case "<":
        case "<=":
        case ">":
        case ">=": {
          const c = refCompare(a, b);
          if (c === null) return null;
          return e.op === "<" ? c < 0 : e.op === "<=" ? c <= 0 : e.op === ">" ? c > 0 : c >= 0;
        }
        case "||":
          return a === null || b === null ? null : String(a) + String(b);
      }
      if (a === null || b === null) return null;
      const x = a as number;
      const y = b as number;
      switch (e.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return y === 0 ? null : x / y;
        case "%":
          return y === 0 ? null : x % y;
      }
      return null;
    }
    case "isnull": {
      const v = refEval(e.e, row, group) === null;
      return e.not ? !v : v;
    }
    case "between": {
      const v = refEval(e.e, row, group);
      const lo = refCompare(v, refEval(e.lo, row, group));
      const hi = refCompare(v, refEval(e.hi, row, group));
      const a = lo === null ? null : lo >= 0;
      const b = hi === null ? null : hi <= 0;
      const r = a === false || b === false ? false : a === null || b === null ? null : true;
      return e.not && r !== null ? !r : r;
    }
    case "in": {
      const v = refEval(e.e, row, group);
      let r: boolean | null = false;
      for (const it of e.list!) {
        const q = refEq(v, refEval(it, row, group));
        if (q === true) {
          r = true;
          break;
        }
        if (q === null) r = null;
      }
      return e.not && r !== null ? !r : r;
    }
    case "like": {
      const v = refEval(e.e, row, group);
      const p = refEval(e.pat, row, group);
      if (v === null || p === null) return null;
      const re = new RegExp(`^${String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]")}$`, e.ci ? "i" : "");
      const r = re.test(String(v));
      return e.not ? !r : r;
    }
    case "case": {
      for (const w of e.whens) if (refEval(w.when, row, group) === true) return refEval(w.then, row, group);
      return e.else ? refEval(e.else, row, group) : null;
    }
    case "fn": {
      if (AGGS.has(e.name)) {
        const rows = group!;
        if (e.star) return rows.length;
        let vals = rows.map((r) => refEval(e.args[0], r)).filter((v) => v !== null);
        if (e.distinct) vals = [...new Set(vals)];
        if (e.name === "COUNT") return vals.length;
        if (!vals.length) return null;
        if (e.name === "SUM") return (vals as number[]).reduce((a, b) => a + b, 0);
        if (e.name === "AVG") return (vals as number[]).reduce((a, b) => a + b, 0) / vals.length;
        return vals.reduce((a, b) => ((refCompare(a, b)! < 0) === (e.name === "MIN") ? a : b));
      }
      const args = e.args.map((a) => refEval(a, row, group));
      switch (e.name) {
        case "COALESCE":
          return args.find((a) => a !== null) ?? null;
        case "NULLIF":
          return refEq(args[0], args[1]) === true ? null : args[0];
        case "UPPER":
          return args[0] === null ? null : String(args[0]).toUpperCase();
        case "LOWER":
          return args[0] === null ? null : String(args[0]).toLowerCase();
        case "LENGTH":
          return args[0] === null ? null : String(args[0]).length;
        case "ABS":
          return args[0] === null ? null : Math.abs(args[0] as number);
      }
      throw new Error(`ref: no ${e.name}`);
    }
  }
  throw new Error(`ref: no ${e.k}`);
}

function refFrom(f: From, tables: Record<string, RefTable>): Row[] {
  if (f.k === "table") {
    const t = tables[f.name];
    const alias = (f.alias ?? f.name).toLowerCase();
    return t.rows.map((r) => new Map(t.cols.map((c, k) => [`${alias}.${c.toLowerCase()}`, r[k]])));
  }
  if (f.k !== "join") throw new Error("ref: from");
  const L = refFrom(f.l, tables);
  const R = refFrom(f.r, tables);
  const nullRow = (sample: Row[], from: From): Row => {
    const t = tables[(from as { name: string }).name];
    const alias = ((from as { alias?: string }).alias ?? (from as { name: string }).name).toLowerCase();
    void sample;
    return new Map(t.cols.map((c) => [`${alias}.${c.toLowerCase()}`, null]));
  };
  const out: Row[] = [];
  const matchedR = new Set<number>();
  for (const l of L) {
    let any = false;
    R.forEach((r, j) => {
      const row = new Map([...l, ...r]);
      if (!f.on || refEval(f.on, row) === true) {
        out.push(row);
        matchedR.add(j);
        any = true;
      }
    });
    if (!any && (f.type === "left" || f.type === "full")) out.push(new Map([...l, ...nullRow(R, f.r)]));
  }
  if (f.type === "full" || f.type === "right") R.forEach((r, j) => matchedR.has(j) || out.push(new Map([...nullRow(L, f.l), ...r])));
  return out;
}

function refRun(sql: string, tables: Record<string, RefTable>): RV[][] {
  const sel = parseSql(sql).body as Select;
  let rows = refFrom(sel.from!, tables);
  if (sel.where) rows = rows.filter((r) => refEval(sel.where!, r) === true);
  let out: RV[][];
  const grouped = sel.groupBy.length > 0 || sel.items.some((it) => JSON.stringify(it.e).match(/"name":"(COUNT|SUM|AVG|MIN|MAX)"/));
  if (grouped) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = JSON.stringify(sel.groupBy.map((g) => refEval(g, r)));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    if (!sel.groupBy.length && !groups.size) groups.set("[]", []);
    let gs = [...groups.values()];
    if (sel.having) gs = gs.filter((g) => refEval(sel.having!, g[0] ?? new Map(), g) === true);
    out = gs.map((g) => sel.items.map((it) => refEval(it.e, g[0] ?? new Map(), g)));
  } else out = rows.map((r) => sel.items.map((it) => refEval(it.e, r)));
  if (sel.distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const k = JSON.stringify(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out;
}

/** Rows in a canonical form (numbers rounded, booleans as text), sorted. */
function canon(rows: RV[][]): string[] {
  return rows
    .map((r) => JSON.stringify(r.map((v) => (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? Number(v.toPrecision(10)) + 0 : v))))
    .sort();
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

describe("fuzz: vectorised engine = row-by-row reference", () => {
  const R = rng(20241116);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(R() * a.length)];
  const maybe = (p: number) => R() < p;

  const GRPS = ["a", "B", "b", "c"];
  const STRS = ["apple", "Apple", "banana", "cherry", "date", "fig%"];
  function makeTables(n: number, m: number) {
    const t: RefTable = { cols: ["id", "grp", "x", "y", "s"], rows: [] };
    for (let i = 0; i < n; i++) t.rows.push([i, maybe(0.15) ? null : pick(GRPS), maybe(0.2) ? null : Math.round(R() * 20 - 8) / (maybe(0.3) ? 4 : 1), Math.floor(R() * 5), maybe(0.15) ? null : pick(STRS)]);
    const u: RefTable = { cols: ["id", "grp", "z"], rows: [] };
    for (let i = 0; i < m; i++) u.rows.push([Math.floor(R() * n), maybe(0.1) ? null : pick(GRPS), maybe(0.2) ? null : Math.floor(R() * 10)]);
    const toSql = (name: string, rt: RefTable): SqlTable => table(name, rt.cols, rt.rows as V[][]);
    return { ref: { t, u }, sql: [toSql("t", t), toSql("u", u)] };
  }

  const numE = (dep: number): string => {
    if (dep <= 0 || maybe(0.4)) return pick(["t.x", "t.y", "t.id", String(Math.floor(R() * 9) - 3), "2.5"]);
    switch (Math.floor(R() * 6)) {
      case 0:
        return `(${numE(dep - 1)} ${pick(["+", "-", "*"])} ${numE(dep - 1)})`;
      case 1:
        return `(${numE(dep - 1)} / ${numE(dep - 1)})`;
      case 2:
        return `CASE WHEN ${boolE(dep - 1)} THEN ${numE(dep - 1)} ELSE ${numE(dep - 1)} END`;
      case 3:
        return `COALESCE(t.x, ${numE(dep - 1)})`;
      case 4:
        return `NULLIF(${numE(dep - 1)}, ${Math.floor(R() * 4)})`;
      default:
        return `ABS(${numE(dep - 1)})`;
    }
  };
  const strE = (dep: number): string => {
    if (dep <= 0 || maybe(0.5)) return pick(["t.s", "t.grp", `'${pick(STRS)}'`]);
    switch (Math.floor(R() * 4)) {
      case 0:
        return `UPPER(${strE(dep - 1)})`;
      case 1:
        return `LOWER(${strE(dep - 1)})`;
      case 2:
        return `(${strE(dep - 1)} || '-')`;
      default:
        return `COALESCE(${strE(dep - 1)}, 'none')`;
    }
  };
  const boolE = (dep: number): string => {
    const leaf = () => {
      switch (Math.floor(R() * 8)) {
        case 0:
          return `${numE(1)} ${pick(["=", "<>", "<", "<=", ">", ">="])} ${numE(1)}`;
        case 1:
          return `${strE(1)} ${pick(["=", "<>", "<", ">="])} ${strE(1)}`;
        case 2:
          return `${pick(["t.x", "t.s", "t.grp"])} IS ${pick(["", "NOT "])}NULL`;
        case 3:
          return `${numE(1)} ${pick(["", "NOT "])}BETWEEN ${numE(0)} AND ${numE(0)}`;
        case 4:
          return `t.y ${pick(["", "NOT "])}IN (${[1, 2, 3].map(() => (maybe(0.15) ? "NULL" : Math.floor(R() * 5))).join(", ")})`;
        case 5:
          return `t.grp ${pick(["", "NOT "])}IN ('a', '${pick(GRPS)}'${maybe(0.2) ? ", NULL" : ""})`;
        case 6:
          return `${pick(["t.s", "t.grp"])} ${pick(["LIKE", "NOT LIKE", "ILIKE"])} '${pick(["a%", "%e%", "_pple", "B%", "%", "b_n%"])}'`;
        default:
          return `${pick(["t.x", "t.y"])} ${pick(["<", ">="])} ${Math.floor(R() * 8) - 3}`;
      }
    };
    if (dep <= 0 || maybe(0.4)) return leaf();
    switch (Math.floor(R() * 3)) {
      case 0:
        return `(${boolE(dep - 1)} AND ${boolE(dep - 1)})`;
      case 1:
        return `(${boolE(dep - 1)} OR ${boolE(dep - 1)})`;
      default:
        return `NOT (${boolE(dep - 1)})`;
    }
  };

  const templates: Array<() => string> = [
    () => `SELECT t.id, ${numE(2)}, ${strE(2)}, ${boolE(2)} FROM t WHERE ${boolE(2)}`,
    () => `SELECT t.grp, COUNT(*), COUNT(t.x), SUM(t.x), AVG(t.x), MIN(t.s), MAX(t.x), COUNT(DISTINCT t.s) FROM t WHERE ${boolE(1)} GROUP BY t.grp${maybe(0.5) ? ` HAVING COUNT(*) > ${Math.floor(R() * 4)}` : ""}`,
    () => {
      const k = strE(1);
      return `SELECT ${k}, t.y, SUM(${numE(1)}), MIN(${strE(1)}) FROM t GROUP BY ${k}, t.y`;
    },
    () => `SELECT COUNT(*), SUM(t.x), MIN(t.grp), MAX(t.s) FROM t WHERE ${boolE(2)}`,
    () => `SELECT DISTINCT t.grp, ${pick(["t.s", "t.y", "UPPER(t.s)"])} FROM t WHERE ${boolE(1)}`,
    () => `SELECT t.id, t.grp, u.z FROM t ${pick(["JOIN", "LEFT JOIN", "FULL JOIN", "RIGHT JOIN"])} u ON t.grp = u.grp${maybe(0.5) ? ` AND ${pick(["u.z > t.y", "t.x < u.z", "u.z IS NOT NULL"])}` : ""}${maybe(0.4) ? ` WHERE ${pick(["u.z IS NULL", "t.id IS NULL", "t.x > 0", "u.z < 5"])}` : ""}`,
    () => `SELECT t.id, u.z FROM t ${pick(["JOIN", "LEFT JOIN", "FULL JOIN"])} u ON t.id = u.id AND t.grp = u.grp`,
    () => `SELECT u.grp, COUNT(*), SUM(t.x), COUNT(u.z) FROM t LEFT JOIN u ON t.id = u.id GROUP BY u.grp`,
  ];

  for (let round = 0; round < 40; round++) {
    it(`round ${round}`, () => {
      const n = 1 + Math.floor(R() * 60);
      const { ref, sql: tables } = makeTables(n, Math.floor(R() * 40));
      for (let k = 0; k < 12; k++) {
        const q = pick(templates)();
        const want = canon(refRun(q, ref));
        let got: string[];
        try {
          got = canon(resultRows(runSql(q, tables)) as RV[][]);
        } catch (e) {
          throw new Error(`${q}\n${(e as Error).message}`);
        }
        if (JSON.stringify(got) !== JSON.stringify(want)) expect({ q, got }).toEqual({ q, got: want });
      }
    });
  }
});
