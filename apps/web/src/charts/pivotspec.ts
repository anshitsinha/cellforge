/**
 * Pivots as saved data, for pivot charts and report tables: the engine's
 * PivotSpec holds filter members in Sets, which don't survive JSON, so a
 * saved pivot keeps them as lists, plus the field names so the pivot still
 * finds its fields after columns move.
 */
import type { DateGroup, PivotKey, PivotSpec } from "@cellforge/core";
import { defaultSpec, type ChartSpec, type ChartType, type SavedPivot } from "./model";

const asField = (f: number | { field: number; group?: DateGroup }) => (typeof f === "number" ? { field: f } : { field: f.field, ...(f.group ? { group: f.group } : {}) });

/** A PivotSpec as JSON-safe data. `names` are the sheet's field names. */
export function savePivot(spec: PivotSpec, names?: readonly string[]): SavedPivot {
  return {
    rows: spec.rows.map(asField),
    cols: spec.cols.map(asField),
    values: spec.values.map((v) => ({ field: v.field, agg: v.agg, ...(v.showAs ? { showAs: v.showAs } : {}) })),
    filters: (spec.filters ?? []).map((f) => ({ field: f.field, ...(f.group ? { group: f.group } : {}), keep: [...f.keep] })),
    ...(spec.subtotals !== undefined ? { subtotals: spec.subtotals } : {}),
    ...(spec.grandTotals !== undefined ? { grandTotals: spec.grandTotals } : {}),
    ...(names ? { names: [...names] } : {}),
  };
}

/**
 * The engine spec for a saved pivot. With the sheet's field names, fields
 * are found by name when a column has moved; a field that is gone is an
 * error that says which one.
 */
export function loadPivot(saved: SavedPivot, names?: readonly string[]): PivotSpec {
  const map = (field: number): number => {
    const want = saved.names?.[field];
    if (!names) return field;
    if (want === undefined) {
      if (field >= names.length) throw new Error(`The pivot reads column ${field + 1}, which the sheet doesn't have any more.`);
      return field;
    }
    if (names[field] === want) return field;
    const at = names.indexOf(want);
    if (at < 0) throw new Error(`The pivot's field "${want}" isn't on the sheet any more.`);
    return at;
  };
  return {
    rows: saved.rows.map((f) => ({ ...f, field: map(f.field) })),
    cols: saved.cols.map((f) => ({ ...f, field: map(f.field) })),
    values: saved.values.map((v) => ({ ...v, field: map(v.field) })),
    filters: saved.filters.map((f) => ({ field: map(f.field), ...(f.group ? { group: f.group } : {}), keep: new Set(f.keep) })),
    ...(saved.subtotals !== undefined ? { subtotals: saved.subtotals } : {}),
    ...(saved.grandTotals !== undefined ? { grandTotals: saved.grandTotals } : {}),
  };
}

/**
 * Keep only rows whose `field` is `value` (on top of the pivot's own
 * filters). Text that reads as a number matches the number too.
 */
export function withMemberFilter(spec: PivotSpec, field: number, value: PivotKey): PivotSpec {
  const keep = new Set<PivotKey>([value]);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) keep.add(Number(value));
  if (typeof value === "number") keep.add(String(value));
  return { ...spec, filters: [...(spec.filters ?? []), { field, keep }] };
}

/** The chart types that suit a pivot. */
export const PIVOT_CHART_TYPES: ChartType[] = ["column", "bar", "line", "pie"];

/** A new pivot chart of `pivot` on sheet `sheetId`. */
export function pivotChartSpec(id: string, sheetId: string, pivot: SavedPivot, type: ChartType = "column", title = ""): ChartSpec {
  const spec = defaultSpec(id, { sheetId, top: 0, left: 0, bottom: 0, right: 0 }, type);
  spec.title = title;
  spec.pivot = { sheetId, pivot };
  spec.place = "auto";
  return spec;
}
