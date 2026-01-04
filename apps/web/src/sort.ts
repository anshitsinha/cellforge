import { radixSortIndices } from "@cellforge/core";
import type { EditableSource } from "./editable";
import type { SortMessage, SortRequest } from "./workers/sort.worker";

/**
 * Sorting a column, in three steps:
 *
 *  1. extractKeys  - turn the column into one float key per row plus a small
 *                    "kind" per row (number / text / blank). Text is replaced
 *                    by its rank among the column's distinct values, so the
 *                    worker only ever compares numbers.
 *  2. radix sort   - in a worker (see workers/sort.worker.ts). Linear time and
 *                    stable, so sorting by B then A gives A-then-B order.
 *  3. toBaseOrder  - the result is in view rows; map it to base rows so the
 *                    source can use it as its new row order.
 *
 * Nothing gets moved: the sheet just reads through the new index. Undo puts
 * the previous index back.
 *
 * Ordering rules match other spreadsheets: numbers before text, text compared
 * case-insensitively, blanks always last no matter the direction.
 */

const KIND_NUMBER = 0;
const KIND_TEXT = 1;
const KIND_BLANK = 2;
const ROWS_PER_SLICE = 1_000_000;

export interface SortKeys {
  keys: Float64Array;
  kinds: Uint8Array;
}

export async function extractKeys(
  source: EditableSource,
  col: number,
  descending: boolean,
  onProgress: (fraction: number) => void = () => {},
): Promise<SortKeys> {
  const n = source.rowCount;
  const keys = new Float64Array(n);
  const kinds = new Uint8Array(n);

  // When descending, text should come before numbers (the whole order flips)
  // but blanks still go last - so swap the number/text kind values.
  const numberKind = descending ? KIND_TEXT : KIND_NUMBER;
  const textKind = descending ? KIND_NUMBER : KIND_TEXT;

  const column = source.baseColumn(col);
  const order = source.rowOrder;

  if (column?.kind === "number") {
    // fast path: untouched numeric column straight out of the Float64Array
    const values = column.values;
    for (let r = 0; r < n; r++) {
      const v = values[order ? order[r] : r];
      if (Number.isNaN(v)) kinds[r] = KIND_BLANK;
      else {
        keys[r] = v;
        kinds[r] = numberKind;
      }
    }
    return { keys, kinds };
  }

  if (column?.kind === "string") {
    // fast path: rank the dictionary once, then each row is a lookup
    const rank = rankStrings(column.dict);
    for (let r = 0; r < n; r++) {
      const code = column.codes[order ? order[r] : r];
      if (code === 0) kinds[r] = KIND_BLANK;
      else {
        keys[r] = rank[code - 1];
        kinds[r] = textKind;
      }
    }
    return { keys, kinds };
  }

  // Generic path (edited columns, the synthetic demo): getCell per row.
  // Text values are first given an id in first-seen order, then ids are
  // rewritten to ranks once all distinct values are known.
  const ids = new Map<string, number>();
  const distinct: string[] = [];
  for (let start = 0; start < n; start += ROWS_PER_SLICE) {
    const end = Math.min(n, start + ROWS_PER_SLICE);
    for (let r = start; r < end; r++) {
      const v = source.getCell(r, col);
      if (typeof v === "number") {
        keys[r] = v;
        kinds[r] = numberKind;
      } else if (v === null || v === "") {
        kinds[r] = KIND_BLANK;
      } else {
        const s = v.toLowerCase();
        let id = ids.get(s);
        if (id === undefined) {
          id = distinct.length;
          distinct.push(s);
          ids.set(s, id);
        }
        keys[r] = id;
        kinds[r] = textKind;
      }
    }
    onProgress(end / n);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (distinct.length) {
    const rank = rankStrings(distinct);
    for (let r = 0; r < n; r++) if (kinds[r] === textKind) keys[r] = rank[keys[r]];
  }
  return { keys, kinds };
}

/** rank[i] = position of strings[i] in case-insensitive sorted order. */
function rankStrings(strings: string[]): Float64Array {
  const lower = strings.map((s) => s.toLowerCase());
  const byValue = lower.map((_, i) => i).sort((a, b) => (lower[a] < lower[b] ? -1 : lower[a] > lower[b] ? 1 : 0));
  const rank = new Float64Array(strings.length);
  // equal strings (e.g. "North" and "north") must get the same rank
  let r = 0;
  byValue.forEach((i, pos) => {
    if (pos > 0 && lower[i] !== lower[byValue[pos - 1]]) r = pos;
    rank[i] = r;
  });
  return rank;
}

/** Convert a sorted list of view rows into a base-row order, in place. */
export function toBaseOrder(source: EditableSource, viewOrder: Uint32Array): Uint32Array {
  const current = source.rowOrder;
  if (current) for (let i = 0; i < viewOrder.length; i++) viewOrder[i] = current[viewOrder[i]];
  return viewOrder;
}

/** Same thing on the current thread - used by tests. */
export async function sortedOrder(source: EditableSource, col: number, descending: boolean): Promise<Uint32Array> {
  const { keys, kinds } = await extractKeys(source, col, descending);
  return toBaseOrder(source, radixSortIndices(keys, kinds, descending));
}

/** Run the sort in a worker. Returns a cancel function alongside the result. */
export function sortInWorker(
  request: SortRequest,
  onProgress: (fraction: number) => void,
): { result: Promise<{ order: Uint32Array; ms: number }>; cancel: () => void } {
  const worker = new Worker(new URL("./workers/sort.worker.ts", import.meta.url), { type: "module" });
  let reject!: (e: Error) => void;
  const result = new Promise<{ order: Uint32Array; ms: number }>((res, rej) => {
    reject = rej;
    worker.onmessage = (e: MessageEvent<SortMessage>) => {
      if (e.data.type === "progress") onProgress(e.data.fraction);
      else {
        worker.terminate();
        res({ order: e.data.order, ms: e.data.ms });
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || "Sort failed"));
    };
  });
  // transfer the key buffers - they can be close to a GB at 100M rows
  worker.postMessage(request, [request.keys.buffer, request.kinds.buffer]);
  return {
    result,
    cancel: () => {
      worker.terminate();
      reject(new Error("Sort cancelled"));
    },
  };
}
