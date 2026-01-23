import "./style.css";
import { marked } from "marked";
import { counts, parsePlan, type Status } from "@cellforge/plan";

interface State {
  plan: string;
  planUpdated: number;
  commits: { hash: string; when: number; subject: string }[];
  now: number;
}

const app = document.getElementById("app")!;
const liveText = document.getElementById("live-text")!;
const live = document.getElementById("live")!;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const inline = (md: string) => marked.parseInline(md) as string;

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const BOX: Record<Status, string> = { done: "✓", doing: "", todo: "" };

let filter: Status | "all" = "all";
let last: State | null = null;
let lastKey = "";

function render(state: State) {
  const plan = parsePlan(state.plan);
  const all = plan.milestones.flatMap((m) => m.items);
  const total = counts(all);
  const now = plan.now;
  const stepsDone = now ? now.steps.filter((s) => s.done).length : 0;
  const currentStep = now ? now.steps.findIndex((s) => !s.done) : -1;

  const stepList = (cls: string) =>
    now
      ? `<ol class="${cls}">${now.steps
          .map((s, i) => {
            const state = s.done ? "done" : i === currentStep ? "current" : "";
            return `<li class="${state}"><span class="box">${s.done ? "✓" : ""}</span><span>${inline(s.text)}</span>${
              i === currentStep ? `<em class="here">working on this</em>` : ""
            }</li>`;
          })
          .join("")}</ol>`
      : "";

  const milestones = plan.milestones
    .map((m) => {
      const c = counts(m.items);
      const items = m.items.filter((i) => filter === "all" || i.status === filter);
      if (!items.length) return "";
      return `<section class="milestone ${m.status}">
        <h3><span class="mid">${m.id}</span>${esc(m.title)}<span class="mcount">${c.done}/${c.total}</span></h3>
        <div class="mbar"><span style="width:${c.percent}%"></span></div>
        <ul>${items
          .map(
            (i) => `<li class="item ${i.status}"><span class="box">${BOX[i.status]}</span><div>${inline(i.text)}${
              i.status === "doing" ? `<span class="tag">in progress</span>${stepList("substeps")}` : ""
            }</div></li>`,
          )
          .join("")}</ul>
      </section>`;
    })
    .join("");

  app.innerHTML = `
    <section class="summary">
      <div class="big">${total.percent}<small>%</small></div>
      <div class="nums">
        <span><b>${total.done}</b> done</span>
        <span><b>${total.doing}</b> in progress</span>
        <span><b>${total.total - total.done - total.doing}</b> planned</span>
        <span><b>${plan.milestones.filter((m) => m.status === "done").length}/${plan.milestones.length}</b> milestones</span>
      </div>
      <div class="bar"><span style="width:${total.percent}%"></span></div>
    </section>

    <div class="grid">
      <section class="now">
        <p class="eyebrow"><span class="pulse"></span>Working on now</p>
        ${
          now
            ? `<h2>${inline(now.title)}</h2>
               <p class="meta">${stepsDone} of ${now.steps.length} steps done${
                 currentStep >= 0 ? ` · current: <b>${inline(now.steps[currentStep].text)}</b>` : ""
               }</p>
               <div class="bar amber"><span style="width:${now.steps.length ? (stepsDone / now.steps.length) * 100 : 0}%"></span></div>
               ${stepList("steps")}`
            : `<p class="meta">Nothing in progress.</p>`
        }
      </section>

      <section class="activity">
        <p class="eyebrow">Recent commits</p>
        <ul>${state.commits
          .slice(0, 12)
          .map((c) => `<li><code>${esc(c.hash)}</code><span>${esc(c.subject)}</span><time>${ago(state.now - c.when)}</time></li>`)
          .join("")}</ul>
      </section>
    </div>

    <div class="filters">
      ${(["all", "doing", "done", "todo"] as const)
        .map((f) => `<button data-f="${f}" class="${f === filter ? "on" : ""}">${{ all: "All", doing: "In progress", done: "Done", todo: "Planned" }[f]}</button>`)
        .join("")}
    </div>
    <div class="milestones">${milestones}</div>
  `;
  for (const b of app.querySelectorAll<HTMLButtonElement>("[data-f]")) {
    b.addEventListener("click", () => {
      filter = b.dataset.f as Status | "all";
      if (last) render(last);
    });
  }
}

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const state = (await res.json()) as State;
    // re-render only when something changed, so scroll position and hover stay put
    const key = `${state.planUpdated}|${state.commits[0]?.hash}`;
    if (key !== lastKey) {
      const y = window.scrollY;
      render(state);
      window.scrollTo(0, y);
      lastKey = key;
    }
    last = state;
    live.classList.remove("down");
    liveText.textContent = `live · plan updated ${ago(state.now - state.planUpdated)}`;
  } catch {
    live.classList.add("down");
    liveText.textContent = "reconnecting…";
  }
}

void poll();
setInterval(poll, 2000);
