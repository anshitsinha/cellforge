/** Sharing safely in the app: the hidden-content check, password dialogs, clearing local data. */
import { shareCheck, type ShareFinding } from "./sharing";
import type { Workbook } from "./workbook";
import { button, el, field, headline, notice } from "./toolkit";
import { openDialog } from "./ui/dialog";
import { icon } from "./ui/icons";
import "./evidence.css";

/** Optional next steps the shell can offer from the share check. */
export interface ShareActions {
  /** open the PII scan and safe copy tool */
  piiScan?: () => void;
  /** save a password-protected copy */
  protectedCopy?: () => void;
}

const KIND_LABEL: Record<ShareFinding["kind"], string> = {
  "hidden sheet": "Hidden sheet",
  "hidden rows": "Hidden rows",
  "hidden columns": "Hidden columns",
  notes: "Notes",
  "review notes": "Review notes",
  links: "Links",
  "personal data": "Personal data",
  history: "Change history",
  versions: "Saved versions",
  names: "Defined names",
  formulas: "Formulas",
};

/** The "before you share" checklist. */
export function openShareCheck(wb: Workbook, goToSheet: (id: string) => void, more: ShareActions = {}): void {
  const findings = shareCheck(wb);
  const body: Node[] = [];
  let dlgClose: () => void = () => undefined;
  if (!findings.length) {
    body.push(headline({ value: "Clean", unit: "nothing hidden", tone: "match", caption: "Nothing hidden or personal found. What you see is what's in the file." }));
  } else {
    const personal = findings.some((f) => f.kind === "personal data");
    body.push(
      headline({
        value: String(findings.length),
        unit: findings.length === 1 ? "thing a recipient could find" : "things a recipient could find",
        tone: personal ? "mismatch" : "unmatched",
        caption: "Content that's in the file but may not be on screen. The ticks show which file type carries each one: Excel and CSV leave out the history and versions; CSV keeps only values.",
      }),
    );
    const table = el("table", { className: "data-table sh-table" });
    const head = table.createTHead().insertRow();
    for (const [t, cls] of [
      ["What", ""],
      [".cellforge", "sh-c"],
      ["Excel", "sh-c"],
      ["CSV", "sh-c"],
      ["", ""],
    ] as const) {
      const th = el("th", { scope: "col", textContent: t });
      if (cls) th.className = cls;
      head.append(th);
    }
    const tbody = table.createTBody();
    for (const f of findings) {
      const tr = tbody.insertRow();
      const what = tr.insertCell();
      what.append(el("span", { className: `cf-badge${f.kind === "personal data" ? " cf-badge--danger" : ""}`, textContent: KIND_LABEL[f.kind] }), el("div", { className: "sh-text", textContent: f.text }));
      for (const k of ["cellforge", "xlsx", "csv"] as const) {
        const td = tr.insertCell();
        td.className = "sh-c";
        if (f.carriedBy.includes(k)) {
          td.append(icon("check"));
          td.setAttribute("aria-label", "carried");
        } else {
          td.textContent = "—";
          td.setAttribute("aria-label", "not carried");
        }
      }
      const act = tr.insertCell();
      act.className = "sh-act";
      if (f.sheetId) {
        const b = button("Show", () => {
          dlgClose();
          goToSheet(f.sheetId!);
        }, "secondary");
        b.classList.add("btn-sm");
        b.setAttribute("aria-label", `Show ${f.text}`);
        act.append(b);
      } else if (f.kind === "personal data" && more.piiScan) {
        const b = button("Mask…", () => {
          dlgClose();
          more.piiScan!();
        }, "secondary");
        b.classList.add("btn-sm");
        act.append(b);
      }
    }
    const wrap = el("div", { className: "table-wrap" });
    wrap.append(table);
    body.push(wrap);
    body.push(el("p", { className: "tk-muted", textContent: "To share less: delete what the recipient doesn't need, export to Excel or CSV, or save a password-protected copy." }));
  }
  const d = openDialog({
    title: "Before you share",
    subtitle: "What's in this workbook beyond what's on screen",
    size: "lg",
    body,
    actions: [
      ...(more.protectedCopy ? [{ label: "Save a protected copy…", start: true, onClick: () => more.protectedCopy!() }] : []),
      { label: "Done", kind: "primary" as const, dismiss: true },
    ],
  });
  dlgClose = () => d.close();
}

/** Ask for a password (twice when setting one). Resolves with it, or null if cancelled. */
export function askPassword(title: string, confirm: boolean): Promise<string | null> {
  const p1 = el("input", { type: "password", autocomplete: confirm ? "new-password" : "current-password" });
  const p2 = el("input", { type: "password", autocomplete: "new-password" });
  const body: Node[] = [field("Password", p1)];
  if (confirm) {
    body.push(field("Type it again", p2));
    body.push(notice("At least 8 characters. There's no way to get the data back without it, so keep it somewhere safe, and send it separately from the file.", "info"));
  }
  let answer: string | null = null;
  const d = openDialog({
    title,
    size: "sm",
    body,
    initialFocus: p1,
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: confirm ? "Set password" : "Open",
        kind: "primary",
        onClick: () => {
          if (confirm && p1.value.length < 8) throw new Error("Use at least 8 characters.");
          if (confirm && p1.value !== p2.value) throw new Error("The two passwords don't match.");
          answer = p1.value;
        },
      },
    ],
  });
  for (const f of [p1, p2])
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        d.button(confirm ? "Set password" : "Open")?.click();
      }
    });
  return d.closed.then((r) => (r === "dismiss" ? null : answer));
}

/** Confirm clearing everything kept in this browser. */
export function confirmClear(): Promise<boolean> {
  const d = openDialog({
    title: "Clear everything cellforge keeps in this browser?",
    size: "sm",
    role: "alertdialog",
    initialFocus: "[data-act=cancel]",
    body: [
      "This deletes the autosaved workbook, its saved versions, the change journal and your settings (recent commands, your reviewer name, locale) from this browser.",
      "Files you saved or exported are not touched. This can't be undone.",
    ],
    actions: [
      { label: "Keep everything", id: "keep", dismiss: true },
      { label: "Clear it all", id: "clear", kind: "danger" },
    ],
  });
  return d.closed.then((r) => r === "clear");
}

