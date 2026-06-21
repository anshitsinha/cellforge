/**
 * Pivot tables over typed columns.
 *
 * How it works:
 * 1. Each row and column field is coded: every data row gets its member's
 *    index (text fields reuse their dictionary codes).
 * 2. The row fields' codes combine into one number per row (mixed radix, so
 *    ascending numbers are the sorted order of the item paths), and the ones
 *    present become the row "leaves". Same for the column fields.
 * 3. Each data row lands in one leaf cell (row leaf x column leaf); one pass
 *    per value field adds it to that cell's count / sum / min / max.
 * 4. Subtotals and grand totals combine leaf cells: in sorted order every
 *    subtotal covers a contiguous run of leaves.
 * 5. Median and count of distinct values can't be combined that way, so for
 *    those the rows are bucketed by leaf cell (a counting sort) and gathered.
 *
 * Drill-down (which data rows make up a cell) is recomputed from the per-row
 * leaf cell, one pass over a Uint32Array, so nothing per cell is stored.
 */
import type { ColumnData } from "../columns";
import type { DateOrder } from "../clean/values";
import { codeField, type DateGroup, type FieldCoding, type PivotField, type PivotKey } from "./fields";

export type PivotAgg = "sum" | "count" | "countDistinct" | "avg" | "min" | "max" | "median" | "stdev";

/** "Show values as": the plain value, a share of a total, or a running total down the rows. */
export type ShowAs = "value" | "pctGrand" | "pctRow" | "pctCol" | "running";

export interface PivotValue {
  field: number;
  agg: PivotAgg;
  showAs?: ShowAs;
  /** header text; defaults to "Sum of Amount" and so on */
  name?: string;
}

/** Keep only the rows whose member of `field` is in `keep`. */
export interface PivotFilter {
  field: number;
  group?: DateGroup;
  keep: ReadonlySet<PivotKey>;
}

export interface PivotSpec {
  rows: (number | PivotField)[];
  cols: (number | PivotField)[];
  values: PivotValue[];
  filters?: PivotFilter[];
  /** subtotal rows / columns for every field but the innermost (default true) */
  subtotals?: boolean;
  /** grand total row and column (default true) */
  grandTotals?: boolean;
  /** how text dates are read when grouping them (default day first) */
  dateOrder?: DateOrder;
  /** most row leaf x column leaf combinations allowed (default 2,000,000) */
  maxCells?: number;
}

export const AGG_LABEL: Record<PivotAgg, string> = {
  sum: "Sum",
  count: "Count",
  countDistinct: "Distinct count",
  avg: "Average",
  min: "Min",
  max: "Max",
  median: "Median",
  stdev: "StdDev",
};

export interface PivotItem {
  kind: "leaf" | "subtotal" | "grand";
  /** 0 for the grand total, else how many fields the item fixes */
  depth: number;
  /** member index for each fixed field */
  path: number[];
  /** member label for each fixed field */
  labels: string[];
}

export interface PivotAxisField {
  field: number;
  group?: DateGroup;
  name: string;
  keys: PivotKey[];
  labels: string[];
}

export interface PivotResult {
  rowFields: PivotAxisField[];
  colFields: PivotAxisField[];
  valueNames: string[];
  values: PivotValue[];
  /** rows and columns of the result, in display order */
  rowItems: PivotItem[];
  colItems: PivotItem[];
  /** cells[v][r * colItems.length + c], NaN for an empty cell */
  cells: Float64Array[];
  /** the same before "show values as" */
  raw: Float64Array[];
  /** cells[v][r * colItems.length + c] */
  value(r: number, c: number, v: number): number;
  /** data rows that make up cell (r, c), ascending */
  members(r: number, c: number): Uint32Array;
  /** data rows that passed the filters */
  rowsUsed: number;
  /** data rows in all */
  rowCount: number;
  ms: number;
}

const NONE = 0xffffffff;

const asField = (f: number | PivotField): PivotField => (typeof f === "number" ? { field: f } : f);

interface Axis {
  /** leaf index of each row (NONE when filtered out) */
  leafOf: Uint32Array;
  /** member path of each leaf, flattened: leafPath[leaf * depth + k] */
  leafPath: Uint32Array;
  leaves: number;
  /** every node (leaves, subtotals, grand) in display order */
  nodes: Node[];
}

interface Node extends PivotItem {
  /** leaves start..end-1 */
  start: number;
  end: number;
  /** previous sibling's node index, for running totals (-1 for the first) */
  prev: number;
}

function buildAxis(codings: FieldCoding[], mask: Uint8Array | null, n: number): Axis {
  const k = codings.length;
  const leafOf = new Uint32Array(n);
  if (k === 0) {
    if (mask) for (let i = 0; i < n; i++) leafOf[i] = mask[i] ? 0 : NONE;
    return { leafOf, leafPath: new Uint32Array(0), leaves: 1, nodes: [{ kind: "grand", depth: 0, path: [], labels: [], start: 0, end: 1, prev: -1 }] };
  }
  const cards = codings.map((c) => Math.max(1, c.keys.length));
  let product = 1;
  for (const c of cards) product *= c;
  if (product > Number.MAX_SAFE_INTEGER) throw new Error("Too many combinations of items for these fields.");

  const c0 = codings[0].codes;
  const c1 = k > 1 ? codings[1].codes : null;
  const card1 = k > 1 ? cards[1] : 1;
  const comp = (i: number): number => {
    if (k === 1) return c0[i];
    if (k === 2) return c0[i] * card1 + c1![i];
    let x = 0;
    for (let f = 0; f < k; f++) x = x * cards[f] + codings[f].codes[i];
    return x;
  };

  let distinct: number[];
  if (product <= 1 << 24) {
    // direct table: composite -> leaf
    const table = new Int32Array(product);
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) {
        leafOf[i] = NONE;
        continue;
      }
      const x = comp(i);
      leafOf[i] = x;
      table[x] = 1;
    }
    distinct = [];
    for (let x = 0; x < product; x++) if (table[x]) {
      table[x] = distinct.length;
      distinct.push(x);
    }
    for (let i = 0; i < n; i++) if (leafOf[i] !== NONE) leafOf[i] = table[leafOf[i]];
  } else {
    const ids = new Map<number, number>();
    const tmp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) {
        tmp[i] = -1;
        continue;
      }
      const x = comp(i);
      tmp[i] = x;
      ids.set(x, 0);
    }
    distinct = [...ids.keys()].sort((a, b) => a - b);
    distinct.forEach((x, j) => ids.set(x, j));
    for (let i = 0; i < n; i++) leafOf[i] = tmp[i] < 0 ? NONE : ids.get(tmp[i])!;
  }

  const leaves = distinct.length;
  const leafPath = new Uint32Array(leaves * k);
  for (let j = 0; j < leaves; j++) {
    let x = distinct[j];
    for (let f = k - 1; f >= 0; f--) {
      leafPath[j * k + f] = x % cards[f];
      x = Math.floor(x / cards[f]);
    }
  }

  // nodes in display order: children, then the parent's subtotal; grand last
  const nodes: Node[] = [];
  const pathOf = (leaf: number, depth: number) => Array.from(leafPath.subarray(leaf * k, leaf * k + depth));
  const labelsOf = (path: number[]) => path.map((m, f) => codings[f].labels[m]);
  const emit = (start: number, end: number, depth: number): number => {
    // returns the node index of the group start..end at this depth
    if (depth === k) {
      const path = pathOf(start, k);
      nodes.push({ kind: "leaf", depth, path, labels: labelsOf(path), start, end, prev: -1 });
      return nodes.length - 1;
    }
    let prev = -1;
    let s = start;
    while (s < end) {
      let e = s + 1;
      while (e < end && leafPath[e * k + depth] === leafPath[s * k + depth]) e++;
      const idx = emit(s, e, depth + 1);
      nodes[idx].prev = prev;
      prev = idx;
      s = e;
    }
    const path = depth ? pathOf(start, depth) : [];
    nodes.push({ kind: depth ? "subtotal" : "grand", depth, path, labels: labelsOf(path), start, end, prev: -1 });
    return nodes.length - 1;
  };
  if (leaves) emit(0, leaves, 0);
  else nodes.push({ kind: "grand", depth: 0, path: [], labels: [], start: 0, end: 0, prev: -1 });
  return { leafOf, leafPath, leaves, nodes };
}

/** k-th smallest of a[0..len-1] (reorders a). */
function select(a: Float64Array, len: number, k: number): number {
  let lo = 0;
  let hi = len - 1;
  while (hi > lo) {
    const mid = (lo + hi) >>> 1;
    // median of three as the pivot
    let x = a[mid];
    const p = a[lo];
    const q = a[hi];
    if ((p <= x && x <= q) || (q <= x && x <= p)) {
      /* x */
    } else if ((x <= p && p <= q) || (q <= p && p <= x)) x = p;
    else x = q;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < x) i++;
      while (a[j] > x) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/** Median of the first len values of a (reorders a). */
export function medianOf(a: Float64Array, len: number): number {
  if (!len) return NaN;
  const h = len >> 1;
  const hi = select(a, len, h);
  if (len & 1) return hi;
  // the largest of the lower half
  let lo = -Infinity;
  for (let i = 0; i < h; i++) if (a[i] > lo) lo = a[i];
  return (lo + hi) / 2;
}

/** Build a pivot table. Throws when the fields would make too many combinations. */
export function pivot(columns: readonly ColumnData[], spec: PivotSpec): PivotResult {
  const t0 = performance.now();
  const n = columns.length ? (columns[0].kind === "number" ? columns[0].values.length : columns[0].codes.length) : 0;
  const order = spec.dateOrder ?? "dmy";
  const colOf = (f: number) => {
    const c = columns[f];
    if (!c) throw new Error(`There is no column ${f + 1}.`);
    return c;
  };

  const cache = new Map<string, FieldCoding>();
  const coding = (f: PivotField) => {
    const id = `${f.field}:${f.group ?? ""}`;
    let c = cache.get(id);
    if (!c) {
      c = codeField(colOf(f.field), f.group, order);
      cache.set(id, c);
    }
    return c;
  };

  // filters -> one row mask
  let mask: Uint8Array | null = null;
  for (const flt of spec.filters ?? []) {
    const c = coding(flt);
    const keepMember = Uint8Array.from(c.keys, (k) => (flt.keep.has(k) ? 1 : 0));
    if (!mask) {
      mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = keepMember[c.codes[i]];
    } else for (let i = 0; i < n; i++) if (mask[i] && !keepMember[c.codes[i]]) mask[i] = 0;
  }

  const rowF = spec.rows.map(asField);
  const colF = spec.cols.map(asField);
  const rowAxis = buildAxis(rowF.map(coding), mask, n);
  const colAxis = buildAxis(colF.map(coding), mask, n);
  const R = rowAxis.leaves;
  const C = colAxis.leaves;
  const maxCells = spec.maxCells ?? 2_000_000;
  if (R * C > maxCells)
    throw new Error(`This layout has ${(R * C).toLocaleString("en-US")} row and column combinations; the most is ${maxCells.toLocaleString("en-US")}. Use fewer fields, or move one to Filters.`);
  const cellCount = R * C;

  // leaf cell of every data row, and how many rows each holds
  const cellOf = rowAxis.leafOf;
  const rowsIn = new Float64Array(cellCount);
  let rowsUsed = 0;
  {
    const rl = rowAxis.leafOf;
    const cl = colAxis.leafOf;
    for (let i = 0; i < n; i++) {
      const r = rl[i];
      if (r === NONE) continue;
      const cell = r * C + cl[i];
      cellOf[i] = cell; // reuses the row leaf array
      rowsIn[cell]++;
      rowsUsed++;
    }
  }

  const rowNodes = rowAxis.nodes;
  const colNodes = colAxis.nodes;
  const RN = rowNodes.length;
  const CN = colNodes.length;

  /** Combine a per-leaf-cell stat into per node-pair values. */
  const combine = (leaf: Float64Array, op: "add" | "min" | "max"): Float64Array => {
    const init = op === "add" ? 0 : op === "min" ? Infinity : -Infinity;
    // stage 1: row nodes x column leaves
    const s1 = new Float64Array(RN * C).fill(init);
    for (let a = 0; a < RN; a++) {
      const { start, end } = rowNodes[a];
      const out = a * C;
      for (let r = start; r < end; r++) {
        const base = r * C;
        if (op === "add") for (let c = 0; c < C; c++) s1[out + c] += leaf[base + c];
        else if (op === "min") for (let c = 0; c < C; c++) s1[out + c] = Math.min(s1[out + c], leaf[base + c]);
        else for (let c = 0; c < C; c++) s1[out + c] = Math.max(s1[out + c], leaf[base + c]);
      }
    }
    // stage 2: row nodes x column nodes
    const s2 = new Float64Array(RN * CN).fill(init);
    for (let a = 0; a < RN; a++) {
      for (let b = 0; b < CN; b++) {
        const { start, end } = colNodes[b];
        let acc = init;
        const base = a * C;
        if (op === "add") for (let c = start; c < end; c++) acc += s1[base + c];
        else if (op === "min") for (let c = start; c < end; c++) acc = Math.min(acc, s1[base + c]);
        else for (let c = start; c < end; c++) acc = Math.max(acc, s1[base + c]);
        s2[a * CN + b] = acc;
      }
    }
    return s2;
  };

  const nodeRows = combine(rowsIn, "add");

  // rows bucketed by leaf cell, built only when median / distinct count need it
  let bucket: { offsets: Float64Array; order: Uint32Array } | null = null;
  const buckets = () => {
    if (bucket) return bucket;
    const offsets = new Float64Array(cellCount + 1);
    for (let c = 0; c < cellCount; c++) offsets[c + 1] = offsets[c] + rowsIn[c];
    const fill = offsets.slice(0, cellCount);
    const order = new Uint32Array(rowsUsed);
    for (let i = 0; i < n; i++) {
      if (rowAxis.leafOf[i] === NONE) continue;
      const cell = cellOf[i];
      order[fill[cell]++] = i;
    }
    bucket = { offsets, order };
    return bucket;
  };

  const valueNames: string[] = [];
  const full: Float64Array[] = [];
  let scratch: Float64Array | null = null;
  let stamp: Uint32Array | null = null;
  let stampGen = 0;

  for (const v of spec.values) {
    const col = colOf(v.field);
    valueNames.push(v.name ?? `${AGG_LABEL[v.agg]} of ${col.name || `Column ${v.field + 1}`}`);
    const out = new Float64Array(RN * CN).fill(NaN);
    const empty = (i: number) => !(nodeRows[i] > 0);

    if (v.agg === "median" || v.agg === "countDistinct") {
      const { offsets, order: ord } = buckets();
      for (let a = 0; a < RN; a++) {
        const rn = rowNodes[a];
        for (let b = 0; b < CN; b++) {
          const at = a * CN + b;
          if (empty(at)) continue;
          const cn = colNodes[b];
          // visit every data row of this node pair
          const visit = (fn: (i: number) => void) => {
            for (let r = rn.start; r < rn.end; r++)
              for (let c = cn.start; c < cn.end; c++) {
                const cell = r * C + c;
                for (let p = offsets[cell], e = offsets[cell + 1]; p < e; p++) fn(ord[p]);
              }
          };
          if (v.agg === "median") {
            if (col.kind !== "number") continue;
            const vals = col.values;
            if (!scratch || scratch.length < nodeRows[at]) scratch = new Float64Array(Math.max(nodeRows[at], 1024));
            const s = scratch;
            let len = 0;
            visit((i) => {
              const x = vals[i];
              if (x === x) s[len++] = x;
            });
            out[at] = medianOf(s, len);
          } else if (col.kind === "string") {
            if (!stamp || stamp.length < col.dict.length + 1) stamp = new Uint32Array(col.dict.length + 1);
            const st = stamp;
            const gen = ++stampGen;
            const codes = col.codes;
            let d = 0;
            visit((i) => {
              const x = codes[i];
              if (x && st[x] !== gen) {
                st[x] = gen;
                d++;
              }
            });
            out[at] = d;
          } else {
            const seen = new Set<number>();
            const vals = col.values;
            visit((i) => {
              const x = vals[i];
              if (x === x) seen.add(x);
            });
            out[at] = seen.size;
          }
        }
      }
    } else {
      // one pass over the data into per-leaf-cell stats
      const cnt = new Float64Array(cellCount);
      const need = { sum: v.agg === "sum" || v.agg === "avg" || v.agg === "stdev", min: v.agg === "min", max: v.agg === "max", sq: v.agg === "stdev" };
      const sum = need.sum ? new Float64Array(cellCount) : null;
      const sq = need.sq ? new Float64Array(cellCount) : null;
      const mn = need.min ? new Float64Array(cellCount).fill(Infinity) : null;
      const mx = need.max ? new Float64Array(cellCount).fill(-Infinity) : null;
      const leafOfRow = rowAxis.leafOf;
      if (col.kind === "string") {
        if (v.agg === "count") {
          const codes = col.codes;
          for (let i = 0; i < n; i++) if (leafOfRow[i] !== NONE && codes[i]) cnt[cellOf[i]]++;
        }
      } else {
        const vals = col.values;
        if (sq && sum) {
          // shifted by the mean so the sum of squares doesn't lose precision
          let ref = 0;
          let m = 0;
          for (let i = 0; i < n; i++) {
            const x = vals[i];
            if (x === x && leafOfRow[i] !== NONE) {
              ref += x;
              m++;
            }
          }
          ref = m ? ref / m : 0;
          for (let i = 0; i < n; i++) {
            const x = vals[i];
            if (x !== x || leafOfRow[i] === NONE) continue;
            const cell = cellOf[i];
            const d = x - ref;
            cnt[cell]++;
            sum[cell] += d;
            sq[cell] += d * d;
          }
        } else if (sum) {
          for (let i = 0; i < n; i++) {
            const x = vals[i];
            if (x !== x || leafOfRow[i] === NONE) continue;
            const cell = cellOf[i];
            cnt[cell]++;
            sum[cell] += x;
          }
        } else if (mn) {
          for (let i = 0; i < n; i++) {
            const x = vals[i];
            if (x !== x || leafOfRow[i] === NONE) continue;
            const cell = cellOf[i];
            cnt[cell]++;
            if (x < mn[cell]) mn[cell] = x;
          }
        } else if (mx) {
          for (let i = 0; i < n; i++) {
            const x = vals[i];
            if (x !== x || leafOfRow[i] === NONE) continue;
            const cell = cellOf[i];
            cnt[cell]++;
            if (x > mx[cell]) mx[cell] = x;
          }
        } else {
          for (let i = 0; i < n; i++) if (vals[i] === vals[i] && leafOfRow[i] !== NONE) cnt[cellOf[i]]++;
        }
      }
      const N = combine(cnt, "add");
      const S = sum ? combine(sum, "add") : null;
      const Q = sq ? combine(sq, "add") : null;
      const MN = mn ? combine(mn, "min") : null;
      const MX = mx ? combine(mx, "max") : null;
      for (let i = 0; i < RN * CN; i++) {
        if (empty(i)) continue;
        const k = N[i];
        switch (v.agg) {
          case "count":
            out[i] = k;
            break;
          case "sum":
            out[i] = k ? S![i] : NaN;
            break;
          case "avg":
            out[i] = k ? S![i] / k : NaN;
            break;
          case "min":
            out[i] = k ? MN![i] : NaN;
            break;
          case "max":
            out[i] = k ? MX![i] : NaN;
            break;
          case "stdev":
            out[i] = k > 1 ? Math.sqrt(Math.max(0, (Q![i] - (S![i] * S![i]) / k) / (k - 1))) : NaN;
            break;
        }
      }
    }
    full.push(out);
  }

  // show values as
  const rowGrand = RN - 1;
  const colGrand = CN - 1;
  const shown = spec.values.map((v, j) => {
    const a = full[j];
    const how = v.showAs ?? "value";
    if (how === "value") return a;
    const out = new Float64Array(RN * CN).fill(NaN);
    const div = (x: number, d: number) => (x === x && d ? x / d : NaN);
    if (how === "running") {
      // down the rows within each parent; across the columns when there are no row fields
      const alongRows = rowF.length > 0 || colF.length === 0;
      const nodes = alongRows ? rowNodes : colNodes;
      const other = alongRows ? CN : RN;
      const at = (i: number, o: number) => (alongRows ? i * CN + o : o * CN + i);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].prev;
        for (let o = 0; o < other; o++) {
          const own = a[at(i, o)];
          const before = p >= 0 ? out[at(p, o)] : NaN;
          out[at(i, o)] = own === own ? (before === before ? before + own : own) : before;
        }
      }
      return out;
    }
    for (let r = 0; r < RN; r++)
      for (let c = 0; c < CN; c++) {
        const d = how === "pctGrand" ? a[rowGrand * CN + colGrand] : how === "pctRow" ? a[r * CN + colGrand] : a[rowGrand * CN + c];
        out[r * CN + c] = div(a[r * CN + c], d);
      }
    return out;
  });

  // what's shown: leaves, plus subtotals and grand totals when asked for
  const subtotals = spec.subtotals !== false;
  const grand = spec.grandTotals !== false;
  const keep = (nodes: Node[], fields: number) =>
    nodes.map((nd, i) => ({ nd, i })).filter(({ nd }) => nd.kind === "leaf" || (nd.kind === "subtotal" && subtotals) || (nd.kind === "grand" && (grand || fields === 0)));
  const rowsShown = keep(rowNodes, rowF.length);
  const colsShown = keep(colNodes, colF.length);
  const W = colsShown.length;
  const pick = (a: Float64Array) => {
    const o = new Float64Array(rowsShown.length * W);
    rowsShown.forEach(({ i: r }, x) => colsShown.forEach(({ i: c }, y) => (o[x * W + y] = a[r * CN + c])));
    return o;
  };
  const cells = shown.map(pick);
  const raw = full.map(pick);
  const item = (nd: Node): PivotItem => ({ kind: nd.kind, depth: nd.depth, path: nd.path, labels: nd.labels });
  const axisFields = (fs: PivotField[]): PivotAxisField[] =>
    fs.map((f) => {
      const c = coding(f);
      return { field: f.field, ...(f.group ? { group: f.group } : {}), name: colOf(f.field).name || `Column ${f.field + 1}`, keys: c.keys, labels: c.labels };
    });

  const rowLeafRange = rowsShown.map(({ nd }) => [nd.start, nd.end] as const);
  const colLeafRange = colsShown.map(({ nd }) => [nd.start, nd.end] as const);
  const rowLeafOf = rowAxis.leafOf;
  return {
    rowFields: axisFields(rowF),
    colFields: axisFields(colF),
    valueNames,
    values: spec.values,
    rowItems: rowsShown.map(({ nd }) => item(nd)),
    colItems: colsShown.map(({ nd }) => item(nd)),
    cells,
    raw,
    value: (r, c, v) => cells[v][r * W + c],
    members(r, c) {
      const [rs, re] = rowLeafRange[r];
      const [cs, ce] = colLeafRange[c];
      const hit = new Uint32Array(nodeRows[rowsShown[r].i * CN + colsShown[c].i] || 0);
      let h = 0;
      for (let i = 0; i < n && h < hit.length; i++) {
        const cell = rowLeafOf[i];
        if (cell === NONE) continue;
        const rl = Math.floor(cell / C);
        if (rl < rs || rl >= re) continue;
        const cl = cell - rl * C;
        if (cl >= cs && cl < ce) hit[h++] = i;
      }
      return hit;
    },
    rowsUsed,
    rowCount: n,
    ms: performance.now() - t0,
  };
}
