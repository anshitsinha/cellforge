import type { CellValue } from "./types";

const numberFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 6,
});

export function formatCell(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "number") {
    // Intl is slow-ish, but we only format visible cells (~a few hundred per
    // frame) so it's fine for now. Revisit if profiling says otherwise.
    return Number.isInteger(value) ? String(value) : numberFormat.format(value);
  }
  return value;
}
