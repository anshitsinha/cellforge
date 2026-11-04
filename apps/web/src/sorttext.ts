/**
 * The one line that reports a finished sort ("Sorted 1,772 rows by Amount,
 * largest first"), so a sort never ends on its progress toast.
 */

export interface SortKeyInfo {
  /** the column's header, or its letter */
  name: string;
  descending: boolean;
  /** the column holds numbers or dates (largest first) rather than text (Z to A) */
  numeric: boolean;
}

export function sortDirection(k: Pick<SortKeyInfo, "descending" | "numeric">): string {
  if (k.numeric) return k.descending ? "largest first" : "smallest first";
  return k.descending ? "Z to A" : "A to Z";
}

/** "Sorted 1,772 rows by Amount, largest first" / "… by Vendor (A to Z), then Amount (largest first)" */
export function sortedMessage(rows: number, keys: readonly SortKeyInfo[], locale?: string): string {
  const n = new Intl.NumberFormat(locale).format(Math.max(0, rows));
  const noun = rows === 1 ? "row" : "rows";
  if (!keys.length) return `Sorted ${n} ${noun}`;
  if (keys.length === 1) return `Sorted ${n} ${noun} by ${keys[0].name}, ${sortDirection(keys[0])}`;
  return `Sorted ${n} ${noun} by ${keys.map((k) => `${k.name} (${sortDirection(k)})`).join(", then ")}`;
}
