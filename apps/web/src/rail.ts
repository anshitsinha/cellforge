/**
 * The left rail: one button per main job (Data, Reconcile, Audit tests,
 * Evidence & review, Reports, AI). Each opens a hub in the side panel that
 * lists that job's tools with one line each and says what to do next, so
 * the depth of the product is visible without knowing the palette.
 *
 * The rail collapses to icons only (remembered); the AI button opens the
 * AI panel itself.
 */
import type { AppCommand, SheetContext } from "./commands";
import { icon, type IconName } from "./ui/icons";
import { onSidePanelChange, openSidePanel, toggleSidePanel } from "./ui/sidepanel";

export interface Hub {
  id: string;
  label: string;
  icon: IconName;
  title: string;
  subtitle: string;
  /** the menu that has every command of this job */
  menu: string;
  sections: { title: string; ids: string[] }[];
  next: (ctx: SheetContext) => string;
}

export const HUBS: Hub[] = [
  {
    id: "hub-data",
    label: "Data",
    icon: "table",
    title: "Data",
    subtitle: "Bring data in, clean it and combine it",
    menu: "Data",
    sections: [
      { title: "Bring data in", ids: ["open", "statement", "combine-files", "combine-folder"] },
      { title: "Clean and shape", ids: ["cleanup", "variants", "transform-dedupe", "transform-split", "transform-unpivot", "transform-extract", "mapping-table"] },
      { title: "Combine", ids: ["join-sheets", "compare-versions"] },
      { title: "Check and repeat", ids: ["data-checks", "profiles", "validation", "recipes"] },
    ],
    next: (c) =>
      c.empty
        ? "Open a file, or drop one anywhere on the window: CSV, Excel, JSON, Parquet or a PDF bank statement."
        : "If this came from another system's report, run Clean up first: it unwraps headers, drops subtotals and fixes numbers stored as text.",
  },
  {
    id: "hub-reconcile",
    label: "Reconcile",
    icon: "reconcile",
    title: "Reconcile",
    subtitle: "Match two sides and explain what's left",
    menu: "Reconcile",
    sections: [
      { title: "Bank and accounts", ids: ["reconcile", "openitems-bankstatement", "openitems-rollforward", "openitems-openitems", "openitems-statementrec"] },
      { title: "Trial balance", ids: ["tb-map", "tb-compare", "gl-tb-tie"] },
      { title: "Compare", ids: ["compare-versions", "join-sheets"] },
    ],
    next: (c) =>
      c.sheetCount < 2
        ? "Put the two sides on two sheets: import the bank statement (PDF or CSV), then open or paste the ledger on another sheet."
        : "Open Reconcile two sheets and pick the two sides. Matches are made in passes; whatever is left goes on its own sheet with the reason.",
  },
  {
    id: "hub-audit",
    label: "Audit",
    icon: "audit",
    title: "Audit tests",
    subtitle: "Test whole populations, not samples",
    menu: "Audit",
    sections: [
      { title: "Journal entries", ids: ["je-journal", "audit-duplicates", "audit-sequence", "audit-benford", "je-overlaps"] },
      { title: "Analytics", ids: ["audit-stratify", "audit-topn", "audit-pareto", "audit-ageing"] },
      { title: "Sampling, schedules and privacy", ids: ["audit-sample", "je-footing", "je-rollforward", "je-pii"] },
    ],
    next: (c) =>
      c.empty
        ? "Open the general ledger or journal export first. Every test runs on all of it, even at millions of lines."
        : "Start with Journal entry tests on the ledger: it scores every entry against the usual red flags and lists the riskiest first.",
  },
  {
    id: "hub-review",
    label: "Review",
    icon: "shield",
    title: "Evidence & review",
    subtitle: "Trace every number and sign it off",
    menu: "Review",
    sections: [
      { title: "Trace", ids: ["explain", "documents", "evidence-open"] },
      { title: "Review", ids: ["review-status", "review-note", "sign-prepared", "unsign-prepared", "sign-reviewed", "unsign-reviewed", "wp-ref", "mark-legend"] },
      { title: "Seal and share", ids: ["evidence-pack", "evidence-verify", "share-check"] },
    ],
    next: () => "Link the supporting document to each key figure, tick what you checked, sign the sheet off, then save an evidence pack.",
  },
  {
    id: "hub-reports",
    label: "Reports",
    icon: "report",
    title: "Reports",
    subtitle: "Turn the work into something to send",
    menu: "Reports",
    sections: [
      { title: "Build", ids: ["reports", "pivot", "chart", "time-periods", "time-bva"] },
      { title: "Send", ids: ["export-xlsx", "export", "time-journal", "share-check"] },
    ],
    next: () => "Reports starts from a pack (rec pack, close pack, findings) and prints to PDF. Summarise with a pivot first if you need totals by line.",
  },
];

export interface RailDeps {
  commands: () => AppCommand[];
  context: () => SheetContext;
  /** the AI button */
  openAi: () => void;
  aiPanelId: string;
  /** decorate the AI button (status dot); called once with the button */
  decorateAi?: (button: HTMLButtonElement) => void;
}

const COLLAPSED_KEY = "cellforge.rail.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fill a hub's side panel body. Exported for the AI-less fallback and tests of the markup. */
export function renderHub(body: HTMLElement, hub: Hub, commands: AppCommand[], ctx: SheetContext): void {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const next = document.createElement("div");
  next.className = "cf-hub__next";
  next.append(icon("info", { size: 16 }));
  const nt = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = "Next step. ";
  nt.append(strong, hub.next(ctx));
  next.append(nt);
  body.append(next);
  for (const s of hub.sections) {
    const cmds = s.ids.map((id) => byId.get(id)).filter((c): c is AppCommand => !!c);
    if (!cmds.length) continue;
    const sec = document.createElement("section");
    sec.className = "cf-section cf-hub__section";
    const h = document.createElement("h3");
    h.className = "cf-section__title";
    h.textContent = s.title;
    const list = document.createElement("div");
    list.className = "cf-hub__list";
    for (const c of cmds) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cf-hub__tool";
      const ic = document.createElement("span");
      ic.className = "cf-hub__icon";
      ic.append(icon(c.icon, { size: 16 }));
      const text = document.createElement("span");
      text.className = "cf-hub__text";
      const t = document.createElement("span");
      t.className = "cf-hub__title";
      t.textContent = c.title.replace(/…$/, "");
      const dsc = document.createElement("span");
      dsc.className = "cf-hub__desc";
      dsc.textContent = c.description;
      text.append(t, dsc);
      b.append(ic, text);
      if (c.keys) {
        const k = document.createElement("kbd");
        k.textContent = c.keys;
        b.append(k);
      }
      b.addEventListener("click", () => void Promise.resolve(c.run()));
      list.append(b);
    }
    sec.append(h, list);
    body.append(sec);
  }
  const more = document.createElement("p");
  more.className = "cf-hub__more";
  more.innerHTML = `Everything for this job is also in the <strong></strong> menu, and <kbd>Ctrl</kbd> <kbd>K</kbd> finds any command.`;
  more.querySelector("strong")!.textContent = hub.menu;
  body.append(more);
}

export function openHub(hub: Hub, d: Pick<RailDeps, "commands" | "context">, toggle = false): void {
  const opts = {
    id: hub.id,
    title: hub.title,
    subtitle: hub.subtitle,
    render: (p: { body: HTMLElement }) => renderHub(p.body, hub, d.commands(), d.context()),
  };
  if (toggle) toggleSidePanel(opts);
  else openSidePanel(opts);
}

export function setupRail(root: HTMLElement, d: RailDeps): { collapsed: () => boolean; toggle: () => void; open: (id: string) => void } {
  root.setAttribute("aria-label", "Jobs");
  let collapsed = readCollapsed();
  const buttons = new Map<string, HTMLButtonElement>();

  const make = (id: string, label: string, ic: IconName, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cf-rail__item";
    b.dataset.panel = id;
    b.setAttribute("aria-label", title);
    b.title = title;
    b.append(icon(ic, { size: 20 }));
    const l = document.createElement("span");
    l.className = "cf-rail__label";
    l.textContent = label;
    b.append(l);
    b.addEventListener("click", onClick);
    buttons.set(id, b);
    return b;
  };

  const list = document.createElement("div");
  list.className = "cf-rail__list";
  for (const hub of HUBS) list.append(make(hub.id, hub.label, hub.icon, `${hub.title}: ${hub.subtitle.toLowerCase()}`, () => openHub(hub, d, true)));
  const sep = document.createElement("div");
  sep.className = "cf-rail__sep";
  list.append(sep);
  const ai = make(d.aiPanelId, "AI", "sparkles", "AI: ask in plain words, on this computer", () => d.openAi());
  ai.classList.add("cf-rail__ai");
  const dot = document.createElement("span");
  dot.className = "ai-dot";
  ai.append(dot);
  d.decorateAi?.(ai);
  list.append(ai);

  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "cf-rail__collapse";
  const paint = () => {
    root.classList.toggle("is-collapsed", collapsed);
    collapse.replaceChildren(icon(collapsed ? "chevron-right" : "chevron-left", { size: 16 }));
    const t = collapsed ? "Show labels" : "Hide labels";
    collapse.title = t;
    collapse.setAttribute("aria-label", t);
    collapse.setAttribute("aria-pressed", String(!collapsed));
  };
  const toggle = () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* remembered for this tab only */
    }
    paint();
  };
  collapse.addEventListener("click", toggle);
  root.append(list, collapse);
  paint();

  // the button of the panel showing lights up
  onSidePanelChange((id) => {
    for (const [pid, b] of buttons) {
      const on = pid === id;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  });

  // arrow keys move along the rail
  root.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...root.querySelectorAll<HTMLButtonElement>("button")];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
  });

  return {
    collapsed: () => collapsed,
    toggle,
    open: (id) => {
      const hub = HUBS.find((h) => h.id === id);
      if (hub) openHub(hub, d);
    },
  };
}
