/**
 * Review mode in the app: palette commands for tick marks, review notes,
 * sign-off and workpaper references; the review status panel (every sheet,
 * who signed what, what changed since, open notes); and the tick-mark
 * legend sheet.
 */
import type { Action } from "@cellforge/actions";
import { Table, type ColumnData } from "@cellforge/core";
import { columnLetter, type CellRange } from "@cellforge/grid";
import { EditableSource } from "./editable";
import { allMarks, changedSince, reviewerName, setReviewerName, type SheetReview } from "./review";
import type { Workbook } from "./workbook";
import "./review.css";
import { button, el, emptyState, field, headline, navigator, plural, report, section } from "./toolkit";
import { openDialog } from "./ui/dialog";
import { openSidePanel } from "./ui/sidepanel";
import { toast } from "./ui/toast";

export interface ReviewDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  range: () => CellRange;
  cell: () => { row: number; col: number };
  run: (a: Action) => Promise<unknown>;
  putBlob: (v: unknown) => string;
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (t: string) => void;
  focusGrid: () => void;
}

function ask(title: string, label: string, value = "", multiline = false, hint?: string): Promise<string | null> {
  const input = multiline ? el("textarea", { rows: 4, value }) : el("input", { type: "text", value });
  input.className = "note-field";
  let answer: string | null = null;
  const dlg = openDialog({
    title,
    size: "sm",
    body: [field(label, input, hint)],
    actions: [
      { label: "Cancel", dismiss: true },
      { label: "Save", kind: "primary", onClick: () => void (answer = input.value.trim()) },
    ],
    initialFocus: input,
  });
  (input as HTMLElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (!(input instanceof HTMLTextAreaElement) || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      dlg.button("Save")?.click();
    }
  });
  return dlg.closed.then((r) => (r === "dismiss" ? null : answer));
}

/** The reviewer's name or initials: asked once, then remembered in this browser. */
export async function whoAmI(): Promise<string | null> {
  const known = reviewerName();
  if (known) return known;
  const name = await ask("Your name or initials", "Your name or initials (for sign-offs and review notes; kept in this browser)");
  if (name) setReviewerName(name);
  return name || null;
}

/** The palette commands for review mode. */
export function reviewCommands(d: ReviewDeps): { id: string; title: string; hint: string; run: () => unknown }[] {
  const wb = d.workbook();
  const sheetId = d.activeSheet();
  const src = wb.get(sheetId).source;
  const { row, col } = d.cell();
  const here = src.extraAt(row, col);
  const sr = wb.review.sheets[sheetId] ?? {};
  const signed = async (role: "prepared" | "reviewed", remove = false) => {
    const block = remove ? null : signOffBlock(role, sr, src.openReviewNotes().length);
    if (block) {
      toast({ kind: "warning", title: `Can't sign off ${wb.get(sheetId).name} yet`, text: block, action: { label: "Show review", run: () => openReviewStatus(d) } });
      return;
    }
    const by = await whoAmI();
    if (by) {
      await d.run({ type: "review.signoff", params: { role, by, ...(remove ? { remove: true } : {}) } });
      report(d.status, remove ? `Removed the ${role} sign-off` : `${wb.get(sheetId).name} signed off as ${role} by ${by}`);
    }
    d.focusGrid();
  };
  const marks = allMarks(wb.review).map((m) => {
    const on = !!here?.marks?.includes(m.id);
    return {
      id: `mark:${m.id}`,
      title: `${on ? "Remove" : "Tick mark"} ${m.glyph}: ${m.label}`,
      hint: "tick mark tickmark audit review agreed footed traced vouched",
      run: () => d.run({ type: "review.mark", params: { range: d.range(), mark: m.id, on: !on } }),
    };
  });
  return [
    ...marks,
    {
      id: "review-note",
      title: here?.review ? "Edit review note…" : "Add a review note…",
      hint: "review note query point reviewer question open",
      run: async () => {
        const by = await whoAmI();
        if (!by) return;
        const text = await ask(`Review note on ${columnLetter(col)}${row + 1}`, "Review note", here?.review?.text ?? "", true);
        if (text) await d.run({ type: "review.note", params: { row, col, text, by } });
        d.focusGrid();
      },
    },
    ...(here?.review && !here.review.cleared
      ? [{ id: "review-clear", title: "Clear review note (dealt with)", hint: "review note clear resolve", run: async () => { const by = await whoAmI(); if (by) await d.run({ type: "review.note", params: { row, col, by, clear: true } }); } }]
      : []),
    ...(here?.review?.cleared ? [{ id: "review-reopen", title: "Reopen review note", hint: "review note reopen", run: async () => { const by = await whoAmI(); if (by) await d.run({ type: "review.note", params: { row, col, by, reopen: true } }); } }] : []),
    { id: "review-status", title: "Review status (sign-offs, open notes)…", hint: "review status sign off prepared reviewed open notes workpapers", run: () => openReviewStatus(d) },
    sr.prepared ? { id: "unsign-prepared", title: "Remove prepared-by sign-off", hint: "review sign off remove", run: () => signed("prepared", true) } : { id: "sign-prepared", title: "Sign off this sheet as prepared", hint: "review sign off prepared by preparer", run: () => signed("prepared") },
    sr.reviewed ? { id: "unsign-reviewed", title: "Remove reviewed-by sign-off", hint: "review sign off remove", run: () => signed("reviewed", true) } : { id: "sign-reviewed", title: "Sign off this sheet as reviewed", hint: "review sign off reviewed by reviewer", run: () => signed("reviewed") },
    {
      id: "wp-ref",
      title: "Workpaper reference…",
      hint: "workpaper reference index wp ref B-3",
      run: async () => {
        const ref = await ask("Workpaper reference for this sheet", "Workpaper reference, e.g. B-3", sr.ref ?? "");
        if (ref !== null) await d.run({ type: "review.ref", params: { ref: ref || null } });
        d.focusGrid();
      },
    },
    { id: "mark-legend", title: "Add a tick-mark legend sheet", hint: "tick mark legend key review", run: () => addLegend(d) },
  ];
}

/** A sheet listing every tick mark and what it means. */
async function addLegend(d: ReviewDeps): Promise<void> {
  const marks = allMarks(d.workbook().review);
  const text = (name: string, values: string[]): ColumnData => ({ kind: "string", name, codes: Uint32Array.from(values, (_, i) => i + 1), dict: values });
  const source = new EditableSource(new Table([text("Mark", marks.map((m) => m.glyph)), text("Meaning", marks.map((m) => m.label))]), 5);
  marks.forEach((m, i) => source.styles.apply(0, [[i, i]], { color: m.color, bold: true }));
  await d.run({ type: "sheet.insert", params: { name: "Tick-mark legend", source: d.putBlob(source), origin: "The tick marks used in this workbook" } });
}

export type ReviewState = "not started" | "prepared" | "reviewed" | "changed";

/**
 * Where a sheet stands: not started, prepared, reviewed, or changed since a
 * sign-off (which needs signing again). Pure; also for sheet-tab badges.
 */
export function reviewState(sr: SheetReview, changedSincePrepared: number, changedSinceReviewed: number): ReviewState {
  if ((sr.reviewed && changedSinceReviewed) || (sr.prepared && changedSincePrepared)) return "changed";
  if (sr.reviewed) return "reviewed";
  if (sr.prepared) return "prepared";
  return "not started";
}

/** Why a sign-off can't be given yet, or null when it can. Pure. */
export function signOffBlock(role: "prepared" | "reviewed", sr: SheetReview, openNotes: number): string | null {
  if (openNotes) return `${openNotes} review note${openNotes === 1 ? " is" : "s are"} still open on this sheet. Clear ${openNotes === 1 ? "it" : "them"} first.`;
  if (role === "reviewed" && !sr.prepared) return "Sign it off as prepared first.";
  return null;
}

const STATE_LABEL: Record<ReviewState, string> = { "not started": "Not signed off", prepared: "Prepared", reviewed: "Reviewed", changed: "Changed since sign-off" };
const STATE_TONE: Record<ReviewState, string> = { "not started": "", prepared: "cf-badge--accent", reviewed: "cf-badge--success", changed: "cf-badge--warning" };

const when = (at: number) => {
  const d = new Date(at);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit" });
};

/** The review panel: every sheet's sign-offs, with buttons to sign, and the open review notes. */
export function openReviewStatus(d: ReviewDeps): void {
  const goTo = navigator(d.goTo);
  openSidePanel({
    id: "review",
    title: "Review and sign-off",
    subtitle: "Prepare, review and sign off each sheet",
    onClose: () => d.focusGrid(),
    render: (p) => {
      const draw = () => {
        const wb = d.workbook();
        const sheets = wb.sheets.filter((s) => !s.hidden);
        const rows = sheets.map((sheet) => {
          const sr = wb.review.sheets[sheet.id] ?? {};
          const cp = sr.prepared ? changedSince(sr.prepared, wb.evidence.log, sheet.name) : 0;
          const cr = sr.reviewed ? changedSince(sr.reviewed, wb.evidence.log, sheet.name) : 0;
          return { sheet, sr, cp, cr, state: reviewState(sr, cp, cr), open: sheet.source.openReviewNotes() };
        });
        const reviewed = rows.filter((r) => r.state === "reviewed").length;
        const notes = rows.reduce((t, r) => t + r.open.length, 0);
        const changed = rows.filter((r) => r.state === "changed").length;
        const me = reviewerName();

        const head = headline({
          value: `${reviewed} of ${sheets.length}`,
          unit: sheets.length === 1 ? "sheet reviewed" : "sheets reviewed",
          progress: sheets.length ? reviewed / sheets.length : 0,
          tone: reviewed === sheets.length && !notes ? "match" : "accent",
          caption:
            reviewed === sheets.length && !notes
              ? "Every sheet is prepared and reviewed, with no open notes."
              : [notes ? `${plural(notes, "open review note")} to clear` : "", changed ? `${plural(changed, "sheet")} changed since sign-off` : "", `${plural(rows.filter((r) => r.state === "not started").length, "sheet")} not signed off yet`].filter(Boolean).join(" · ") + ".",
        });
        const who = el(
          "div",
          { className: "rv-who" },
          el("span", { className: "tk-muted", textContent: me ? "Signing as " : "Sign-offs record your name and the time." }),
          me ? el("strong", { textContent: me }) : null,
          button(me ? "Change" : "Set your name", async () => {
            const name = await ask("Your name or initials", "Name or initials", me ?? "", false, "Shown on sign-offs and review notes. Kept in this browser only.");
            if (name) setReviewerName(name);
            draw();
          }, "ghost"),
        );

        const sign = async (sheetId: string, role: "prepared" | "reviewed", remove = false) => {
          const by = await whoAmI();
          if (!by) return;
          await d.run({ type: "review.signoff", params: { role, by, sheet: sheetId, ...(remove ? { remove: true } : {}) } });
          const name = d.workbook().get(sheetId).name;
          report(d.status, remove ? `Removed the ${role} sign-off on ${name}` : `${name} signed off as ${role} by ${by}`);
          draw();
        };

        const cards = rows.map(({ sheet, sr, cp, cr, state, open }) => {
          const card = el("section", { className: `rv-sheet rv-sheet--${state.replace(" ", "-")}` });
          card.setAttribute("aria-label", `${sheet.name}: ${STATE_LABEL[state]}`);
          const ref = button(sr.ref ? sr.ref : "Add ref", async () => {
            const v = await ask(`Workpaper reference for ${sheet.name}`, "Reference", sr.ref ?? "", false, "For example B-3. Leave empty to remove it.");
            if (v === null) return;
            await d.run({ type: "review.ref", params: { ref: v || null, sheet: sheet.id } });
            draw();
          }, "ghost");
          ref.classList.add("rv-ref");
          ref.title = "Workpaper reference";
          card.append(
            el("header", { className: "rv-sheet__head" }, ref, el("strong", { className: "rv-sheet__name", textContent: sheet.name }), el("span", { className: `cf-badge ${STATE_TONE[state]}`, textContent: STATE_LABEL[state] })),
          );
          const line = (role: "prepared" | "reviewed", changedN: number) => {
            const s = sr[role];
            const label = role === "prepared" ? "Prepared" : "Reviewed";
            const row = el("div", { className: "rv-line" }, el("span", { className: "rv-line__role", textContent: label }));
            if (s) {
              row.append(el("span", { className: "rv-line__who" }, el("strong", { textContent: s.by }), el("span", { className: "tk-muted", textContent: ` · ${when(s.at)}` })));
              if (changedN) row.append(el("span", { className: "rv-line__warn", textContent: `${plural(changedN, "change")} since` }));
              const again = changedN ? button("Sign again", () => sign(sheet.id, role), "secondary") : null;
              if (again) again.classList.add("btn-sm");
              const undo = button("Remove", () => sign(sheet.id, role, true), "ghost");
              undo.classList.add("btn-sm");
              undo.setAttribute("aria-label", `Remove the ${role} sign-off on ${sheet.name}`);
              row.append(el("span", { className: "rv-line__acts" }, again, undo));
            } else {
              const block = signOffBlock(role, sr, open.length);
              const b = button(role === "prepared" ? "Sign off as preparer" : "Sign off as reviewer", () => sign(sheet.id, role), "secondary");
              b.classList.add("btn-sm");
              if (block) {
                b.disabled = true;
                b.title = block;
              }
              row.append(el("span", { className: "rv-line__who tk-muted", textContent: block && role === "reviewed" && !sr.prepared ? "After preparation" : block ? "Notes open" : "Not yet" }), el("span", { className: "rv-line__acts" }, b));
            }
            return row;
          };
          card.append(line("prepared", cp), line("reviewed", cr));
          if (open.length) {
            const list = el("ul", { className: "rv-notes" });
            for (const n of open) {
              const cell = `${columnLetter(n.col)}${n.row + 1}`;
              const go = el("button", { type: "button", className: "rv-note", title: goTo ? `Go to ${cell}` : "" });
              go.append(el("span", { className: "rv-note__cell", textContent: cell }), el("span", { className: "rv-note__text", textContent: n.note.text }), el("span", { className: "tk-muted", textContent: n.note.by }));
              go.disabled = !goTo;
              go.addEventListener("click", () => goTo?.(sheet.id, n.row, n.col));
              list.append(el("li", {}, go));
            }
            card.append(el("div", { className: "rv-notes__title", textContent: `${plural(open.length, "open review note")}` }), list);
          }
          return card;
        });
        p.body.replaceChildren(head, who, section("Sheets", ...cards));
        if (!sheets.length) p.body.append(emptyState({ icon: "signoff", title: "No sheets yet", text: "Open or paste the working papers first." }));
      };
      draw();
      const legend = button("Add tick-mark legend", () => addLegend(d), "secondary");
      p.footer.append(el("div", { className: "tk-panel-actions" }, legend));
    },
  });
}
