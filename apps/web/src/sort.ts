import type { EditableSource } from "./editable";

/**
 * Compute a new view -> base row order that sorts the sheet by one column.
 *
 * Nothing gets moved: we sort an index array and hand it to the source as its
 * row order. Undo just puts the previous order back.
 *
 * Ordering follows the usual spreadsheet rules: numbers before text, text
 * compared case-insensitively, and blanks always last no matter the direction.
 * The sort is stable, so sorting by B then by A gives A-then-B order.
 */
export function sortedOrder(source: EditableSource, col: number, descending: boolean): Uint32Array {
  const n = source.rowCount;

  // pull the keys out once up front - calling getCell inside the comparator
  // would be ~n*log(n) lookups instead of n
  const nums = new Float64Array(n);
  const kind = new Uint8Array(n); // 0 = number, 1 = text, 2 = blank
  let texts: (string | undefined)[] | null = null;

  for (let r = 0; r < n; r++) {
    const v = source.getCell(r, col);
    if (typeof v === "number") {
      nums[r] = v;
    } else if (v === null || v === "") {
      kind[r] = 2;
    } else {
      kind[r] = 1;
      texts ??= new Array(n);
      texts[r] = v.toLowerCase();
    }
  }

  const dir = descending ? -1 : 1;
  const view = new Uint32Array(n);
  for (let i = 0; i < n; i++) view[i] = i;

  view.sort((a, b) => {
    const ka = kind[a];
    const kb = kind[b];
    if (ka === 2 || kb === 2) return ka - kb; // blanks last, regardless of direction
    if (ka !== kb) return (ka - kb) * dir;
    if (ka === 0) return (nums[a] - nums[b]) * dir;
    const ta = texts![a]!;
    const tb = texts![b]!;
    return (ta < tb ? -1 : ta > tb ? 1 : 0) * dir;
  });

  // `view` is in terms of current view rows; convert to base rows so the
  // result is a complete order on its own
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = source.toBase(view[i]);
  return order;
}
