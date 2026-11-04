/**
 * The start screen: what a new or empty workbook shows instead of a blank
 * grid. Open or drop a file, start one of the finance workflows (with
 * sample data or an empty template), or set up the private AI.
 *
 * It covers the workspace (not the top bar or menus), goes away as soon as
 * a workbook is loaded, and comes back from File > New or Help > Start
 * screen. Esc or "Blank workbook" dismisses it.
 */
import { SAMPLES, type SampleKind } from "./samples";
import type { TemplateKind } from "./templates";
import { icon, type IconName } from "./ui/icons";
import { recentDetail, type RecentEntry } from "./persist";

export interface StartScreenDeps {
  openFile: () => void;
  importStatement: () => void;
  openSample: (kind: SampleKind) => void;
  startTemplate: (kind: TemplateKind) => void;
  /** a new blank workbook (asks first if there is work to lose) */
  blank: () => void;
  /** Esc: back to the sheet as it is */
  dismiss: () => void;
  openAi: () => void;
  /** workbooks kept in this browser, newest first */
  recent?: () => readonly RecentEntry[];
  openRecent?: (id: string) => void;
  /** the AI's status for the AI card */
  aiBadge: () => { dot: string; text: string; title: string };
  onAiStatus: (cb: () => void) => void;
}

interface Flow {
  sample: SampleKind;
  template?: TemplateKind;
  icon: IconName;
  steps: string[];
  ownLabel: string;
}

/** The workflow cards, in order. Titles and summaries come from samples.ts. */
export const FLOWS: Flow[] = [
  { sample: "bank-rec", template: "bankrec", icon: "reconcile", steps: ["Cash book", "Bank statement", "Rec"], ownLabel: "Empty bank rec" },
  { sample: "close", template: "close", icon: "scale", steps: ["Trial balances", "Mapping", "Flux"], ownLabel: "Empty close workbook" },
  { sample: "audit", template: "audit", icon: "audit", steps: ["Journal", "12 red-flag tests", "Results"], ownLabel: "Empty audit workbook" },
  { sample: "big", icon: "database", steps: ["100M lines", "Sort", "Pivot"], ownLabel: "Open a big file" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void, ic?: IconName): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  if (ic) b.append(icon(ic));
  b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

export function setupStartScreen(host: HTMLElement, d: StartScreenDeps): { show: () => void; hide: () => void; refreshRecent: () => void; readonly visible: boolean } {
  host.className = "cf-start";
  host.hidden = true;
  host.setAttribute("aria-label", "Start");
  host.setAttribute("role", "region");

  const inner = el("div", "cf-start__inner");

  // --- heading
  const head = el("header", "cf-start__head");
  const h1 = el("h1", "cf-start__title", "What are you working on today?");
  h1.id = "cf-start-title";
  h1.tabIndex = -1;
  host.setAttribute("aria-labelledby", h1.id);
  const sub = el("p", "cf-start__sub");
  sub.append(el("span", "cf-start__dot"), "Everything runs on this computer. Nothing you open is uploaded.");
  head.append(sub, h1);

  // --- open a file + AI
  const top = el("div", "cf-start__top");
  const drop = el("div", "cf-start__drop");
  const dropIcon = el("span", "cf-start__drop-icon");
  dropIcon.append(icon("upload", { size: 22 }));
  const dropText = el("div", "cf-start__drop-text");
  dropText.append(el("h2", "", "Open a file or drop it here"), el("p", "", "Excel, CSV, Parquet, JSON or a .cellforge workbook. A PDF bank statement becomes a sheet of transactions."));
  const dropActions = el("div", "cf-start__actions");
  dropActions.append(
    button("Open a file…", "btn-primary", d.openFile, "open"),
    button("Import a bank statement", "btn-secondary", d.importStatement, "upload"),
    button("Blank workbook", "btn-ghost", d.blank, "plus"),
  );
  dropText.append(dropActions);
  drop.append(dropIcon, dropText);
  drop.addEventListener("dragover", () => drop.classList.add("is-over"));
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", () => drop.classList.remove("is-over"));

  const ai = el("div", "cf-start__ai");
  const aiHead = el("div", "cf-start__ai-head");
  const aiIcon = el("span", "cf-start__ai-icon");
  aiIcon.append(icon("sparkles", { size: 20 }));
  const aiStatus = el("span", "cf-start__ai-status");
  const aiDot = el("span", "ai-dot");
  const aiState = el("span");
  aiStatus.append(aiDot, aiState);
  aiHead.append(aiIcon, aiStatus);
  const aiTitle = el("h2", "", "Private AI");
  const aiText = el("p", "", "Ask in plain words: \"flag weekend postings over 10,000\". The model runs on this computer, so your data never leaves it.");
  const aiButton = button("Set up private AI", "btn-secondary", d.openAi, "sparkles");
  ai.append(aiHead, aiTitle, aiText, aiButton);
  const paintAi = () => {
    const b = d.aiBadge();
    aiDot.dataset.state = b.dot;
    aiState.textContent = b.dot === "ready" ? `Ready${b.text ? ` · ${b.text}` : ""}` : b.dot === "busy" ? `Setting up${b.text ? ` · ${b.text}` : "…"}` : b.dot === "error" ? "Needs attention" : "Not set up";
    aiStatus.title = b.title;
    aiButton.lastChild!.textContent = b.dot === "ready" ? "Open AI" : b.dot === "off" ? "Set up private AI" : "Show progress";
  };
  d.onAiStatus(paintAi);
  paintAi();
  top.append(drop, ai);

  // --- recent workbooks (kept in this browser)
  const recentBox = el("section", "cf-start__recent");
  recentBox.setAttribute("aria-labelledby", "cf-start-recent");
  const paintRecent = () => {
    const list = d.recent?.() ?? [];
    recentBox.replaceChildren();
    recentBox.hidden = !list.length;
    if (!list.length) return;
    const h = el("h2", "", "Recent");
    h.id = "cf-start-recent";
    const row = el("ul", "cf-start__recent-list");
    for (const r of list.slice(0, 6)) {
      const li = el("li");
      const b = el("button", "cf-recent");
      b.type = "button";
      b.title = r.sheetNames?.length ? `Sheets: ${r.sheetNames.join(", ")}` : r.name;
      const ic = el("span", "cf-recent__icon");
      ic.append(icon("document", { size: 18 }));
      const txt = el("span", "cf-recent__text");
      txt.append(el("span", "cf-recent__name", r.name), el("span", "cf-recent__meta", recentDetail(r)));
      b.append(ic, txt);
      b.addEventListener("click", () => d.openRecent?.(r.id));
      li.append(b);
      row.append(li);
    }
    recentBox.append(h, row);
  };
  paintRecent();

  // --- workflows
  const flowsHead = el("div", "cf-start__section-head");
  flowsHead.append(el("h2", "", "Start a workflow"), el("p", "", "Each opens a workbook laid out for the job, with fictional sample data so you can try it first."));
  const flows = el("div", "cf-start__flows");
  for (const f of FLOWS) {
    const s = SAMPLES.find((x) => x.kind === f.sample);
    if (!s) continue;
    const card = el("article", "cf-flow");
    const ic = el("span", "cf-flow__icon");
    ic.append(icon(f.icon, { size: 20 }));
    const h = el("h3", "", s.title);
    const p = el("p", "", s.summary);
    const steps = el("ol", "cf-flow__steps");
    for (const st of f.steps) steps.append(el("li", "", st));
    const acts = el("div", "cf-flow__actions");
    const tryIt = button("Try with sample data", "btn-primary btn-sm", () => d.openSample(f.sample));
    tryIt.setAttribute("aria-label", `${s.title}: try with sample data`);
    const own = button(f.ownLabel, "btn-ghost btn-sm", () => (f.template ? d.startTemplate(f.template) : d.openFile()));
    acts.append(tryIt, own);
    card.append(ic, h, p, steps, acts);
    flows.append(card);
  }

  // --- blank
  const foot = el("footer", "cf-start__foot");
  const hint = el("span", "cf-start__hint");
  hint.innerHTML = `<kbd>Esc</kbd> goes to the sheet · <kbd>Ctrl</kbd> <kbd>K</kbd> finds any command · <kbd>F1</kbd> asks the guide`;
  foot.append(hint);

  inner.append(head, top, recentBox, flowsHead, flows, foot);
  host.append(inner);

  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      d.dismiss();
    }
  });

  let visible = false;
  return {
    refreshRecent: paintRecent,
    show: () => {
      paintRecent();
      host.hidden = false;
      visible = true;
      document.body.classList.add("is-start");
      h1.focus({ preventScroll: true });
    },
    hide: () => {
      if (!visible) return;
      host.hidden = true;
      visible = false;
      document.body.classList.remove("is-start");
    },
    get visible() {
      return visible;
    },
  };
}
