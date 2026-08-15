/**
 * The report action: "report.set" adds, changes or (with report null)
 * removes a report saved with the workbook, and returns its own inverse so
 * undo works. Reports live on workbook.reports.
 */
import { type ActionRegistry, s } from "@cellforge/actions";
import type { SheetCtx } from "../actions";
import type { Workbook } from "../workbook";
import { reportProblem, type Report } from "./model";

/** The workbook's reports (workbook.reports; an empty list on a workbook that has none yet). */
export function reportsOf(wb: Workbook): Report[] {
  return (wb as unknown as { reports?: Report[] }).reports ?? [];
}

function setReports(wb: Workbook, list: Report[]): void {
  (wb as unknown as { reports: Report[] }).reports = list;
}

export function registerReportActions(registry: ActionRegistry<SheetCtx>): void {
  registry.register<{ id: string; report: Report | null }>({
    type: "report.set",
    title: "Add, change or remove a report (report null removes it)",
    schema: s.object({ id: s.string("report id"), report: s.anyOf({ type: "object", properties: {}, additionalProperties: true }, s.null()) }),
    describe: (p) => (p.report ? `report "${p.report.title}"` : "delete report"),
    recordable: true,
    apply(ctx, p) {
      if (p.report) {
        const problem = reportProblem({ ...p.report, id: p.id });
        if (problem) throw new Error(problem);
      }
      const list = reportsOf(ctx.workbook);
      const i = list.findIndex((r) => r.id === p.id);
      const before = i >= 0 ? structuredClone(list[i]) : null;
      if (!p.report && !before) return null;
      if (p.report && before && JSON.stringify({ ...p.report, id: p.id }) === JSON.stringify(before)) return null;
      const next = list.filter((r) => r.id !== p.id);
      if (p.report) next.splice(i >= 0 ? i : next.length, 0, { ...structuredClone(p.report), id: p.id });
      setReports(ctx.workbook, next);
      return { type: "report.set", params: { id: p.id, report: before } };
    },
  });
}
