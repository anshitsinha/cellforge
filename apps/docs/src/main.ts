import "./style.css";
import { marked } from "marked";
import { counts, parsePlan, type Status } from "./plan";
import { findPage, pages, planMarkdown, routeForLink } from "./pages";
import { buildIndex, search, slugify, terms } from "./search";

const content = document.getElementById("content")!;
const nav = document.getElementById("nav")!;
const searchInput = document.getElementById("search") as HTMLInputElement;
const index = buildIndex(pages);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ------------------------------------------------------------------ nav --

function renderNav() {
  const link = (href: string, label: string) => `<a href="${href}" data-href="${href}">${esc(label)}</a>`;
  const plan = parsePlan(planMarkdown);
  const all = plan.milestones.flatMap((m) => m.items);
  const c = counts(all);
  nav.innerHTML = `
    ${link("#/progress", `Progress · ${c.done}/${c.total}`)}
    <h4>User guide</h4>
    ${pages.filter((p) => p.section === "guide").map((p) => link(`#/guide/${p.slug}`, p.title)).join("")}
    <h4>Developer guide</h4>
    ${pages.filter((p) => p.section === "dev").map((p) => link(`#/dev/${p.slug}`, p.title)).join("")}
  `;
}

function markActive(route: string) {
  for (const a of nav.querySelectorAll<HTMLAnchorElement>("a")) {
    a.classList.toggle("active", route.startsWith(a.dataset.href!.slice(1)));
  }
}

// -------------------------------------------------------------- markdown --

marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slugify(text.replace(/<[^>]+>/g, ""));
      return `<h${depth} id="${id}"><a class="anchor" href="#" data-anchor="${id}">#</a>${text}</h${depth}>`;
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const route = routeForLink(href);
      if (route) return `<a href="${route}">${text}</a>`;
      const external = /^https?:/i.test(href);
      return `<a href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`;
    },
  },
});

function renderMarkdown(markdown: string) {
  const html = marked.parse(markdown) as string;
  content.innerHTML = `<article class="prose">${html}</article>`;
  for (const a of content.querySelectorAll<HTMLAnchorElement>("a[data-anchor]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.anchor!)?.scrollIntoView({ behavior: "smooth" });
    });
  }
  // tables scroll sideways on phones instead of breaking the layout
  for (const t of content.querySelectorAll("table")) {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.append(t);
  }
}

// -------------------------------------------------------------- progress --

const ICON: Record<Status, string> = { done: "✓", doing: "●", todo: "" };
const LABEL: Record<Status, string> = { done: "Done", doing: "Building now", todo: "Planned" };

function inline(md: string) {
  return marked.parseInline(md) as string;
}

function renderProgress(filter: Status | "all" = "all") {
  const plan = parsePlan(planMarkdown);
  const all = plan.milestones.flatMap((m) => m.items);
  const total = counts(all);
  const now = plan.now;
  const nowDone = now ? now.steps.filter((s) => s.done).length : 0;

  const nowCard = now
    ? `<section class="now" id="now">
        <div class="now-head">
          <span class="pulse"></span>
          <div>
            <p class="eyebrow">Building right now</p>
            <h2>${inline(now.title)}</h2>
          </div>
          <span class="now-count">${nowDone}/${now.steps.length} steps</span>
        </div>
        <div class="bar"><span style="width:${now.steps.length ? (nowDone / now.steps.length) * 100 : 0}%"></span></div>
        <ol class="steps">
          ${now.steps.map((s) => `<li class="${s.done ? "done" : ""}"><span class="box">${s.done ? "✓" : ""}</span>${inline(s.text)}</li>`).join("")}
        </ol>
      </section>`
    : "";

  const filters = (["all", "doing", "done", "todo"] as const)
    .map((f) => `<button class="${f === filter ? "on" : ""}" data-filter="${f}">${f === "all" ? "All" : LABEL[f]}</button>`)
    .join("");

  const milestones = plan.milestones
    .map((m) => {
      const c = counts(m.items);
      const items = m.items.filter((i) => filter === "all" || i.status === filter);
      if (!items.length) return "";
      const open = m.status === "doing" || filter !== "all";
      return `<details class="milestone ${m.status}" ${open ? "open" : ""}>
        <summary>
          <span class="mid">${m.id}</span>
          <span class="mtitle">${esc(m.title)}</span>
          <span class="mcount">${c.done}/${c.total}</span>
          <span class="mbar"><span style="width:${c.percent}%"></span></span>
        </summary>
        <ul class="items">
          ${items
            .map((i) => {
              const expanded =
                i.status === "doing" && now
                  ? `<ol class="substeps">${now.steps
                      .map((s) => `<li class="${s.done ? "done" : ""}"><span class="box">${s.done ? "✓" : ""}</span>${inline(s.text)}</li>`)
                      .join("")}</ol>`
                  : "";
              return `<li class="item ${i.status}"><span class="box">${ICON[i.status]}</span><div>${inline(i.text)}${
                i.status === "doing" ? `<span class="tag">building now</span>` : ""
              }${expanded}</div></li>`;
            })
            .join("")}
        </ul>
      </details>`;
    })
    .join("");

  content.innerHTML = `
    <article class="progress">
      <p class="eyebrow">Live from docs/PLAN.md</p>
      <h1>Progress</h1>
      <p class="lede">Everything cellforge will do, and exactly where the build is. This page is generated
      from the plan, so it's always current.</p>
      <div class="stats">
        <div><b>${total.percent}%</b><span>complete</span></div>
        <div><b>${total.done}</b><span>done</span></div>
        <div><b>${total.doing}</b><span>building now</span></div>
        <div><b>${total.total - total.done - total.doing}</b><span>planned</span></div>
        <div><b>${plan.milestones.filter((m) => m.status === "done").length}/${plan.milestones.length}</b><span>milestones</span></div>
      </div>
      <div class="bar big"><span style="width:${total.percent}%"></span></div>
      ${nowCard}
      <div class="filters" role="group" aria-label="Filter items">${filters}</div>
      ${milestones}
    </article>`;
  for (const b of content.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    b.addEventListener("click", () => renderProgress(b.dataset.filter as Status | "all"));
  }
}

// ---------------------------------------------------------------- home --

function renderHome() {
  const plan = parsePlan(planMarkdown);
  const c = counts(plan.milestones.flatMap((m) => m.items));
  content.innerHTML = `
    <article class="home">
      <p class="eyebrow">Documentation</p>
      <h1>cellforge</h1>
      <p class="lede">A spreadsheet that runs entirely on your computer, handles data of any size,
      and proves every number. <em>Open anything. Prove everything. Upload nothing.</em></p>
      <div class="cards">
        <a class="card" href="#/guide/01-getting-started"><h3>User guide</h3><p>Open data, edit, formulas, big files, shortcuts, privacy.</p></a>
        <a class="card" href="#/dev/development"><h3>Developer guide</h3><p>Setup, architecture, the action model, how to contribute.</p></a>
        <a class="card" href="#/progress"><h3>Progress · ${c.percent}%</h3><p>The full feature checklist and what's being built right now: ${plan.now ? esc(plan.now.title) : "—"}.</p></a>
      </div>
      <h2>Ask the docs</h2>
      <p>Type a question in the search box (press <kbd>/</kbd>), e.g. <a href="#/ask?q=how%20do%20I%20undo%20a%20sort">how do I undo a sort?</a>
      Answers are found in these pages on your device. The local AI assistant will answer in its own words
      once it lands (milestone M9).</p>
    </article>`;
}

// ------------------------------------------------------------ search / ask --

function renderAsk(query: string) {
  const results = search(index, query);
  const isQuestion = /\?\s*$|^(how|what|why|can|does|do|where|when|is|which)\b/i.test(query.trim());
  const words = terms(query);
  const mark = (text: string) => {
    let out = esc(text);
    for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return out;
  };
  const best = results[0];
  content.innerHTML = `
    <article class="ask">
      <p class="eyebrow">${isQuestion ? "Ask the docs" : "Search"}</p>
      <h1>${esc(query)}</h1>
      ${
        !results.length
          ? `<p class="lede">Nothing in the docs mentions that yet. Try other words, or check the <a href="#/progress">progress page</a>. It may be planned.</p>`
          : isQuestion
            ? `<section class="answer">
                <p class="eyebrow">Best answer from the docs</p>
                <h3><a href="#/${best.page.section}/${best.page.slug}?h=${best.anchor}">${esc(best.page.title)} › ${esc(best.heading)}</a></h3>
                <p>${mark(best.text)}</p>
                <p class="note">Found on your device from these pages. The local AI assistant (M9) will answer in its own words, with these same sources.</p>
              </section>`
            : ""
      }
      <ul class="results">
        ${results
          .slice(isQuestion ? 1 : 0)
          .map(
            (r) => `<li><a href="#/${r.page.section}/${r.page.slug}?h=${r.anchor}">
              <span class="where">${r.page.section === "guide" ? "User guide" : "Developer"} › ${esc(r.page.title)}</span>
              <b>${esc(r.heading)}</b>
              <span class="snip">${mark(r.text)}</span></a></li>`,
          )
          .join("")}
      </ul>
    </article>`;
}

let searchTimer = 0;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const q = searchInput.value.trim();
    if (q) history.replaceState(null, "", `#/ask?q=${encodeURIComponent(q)}`);
    route();
  }, 120);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------------------------------------------------------------- router --

function route() {
  const hash = location.hash.slice(1) || "/";
  const [path, queryString] = hash.split("?");
  const params = new URLSearchParams(queryString);
  const parts = path.split("/").filter(Boolean);
  markActive(path);
  document.body.classList.remove("nav-open");

  if (parts[0] === "progress") {
    renderProgress();
    document.title = "Progress · cellforge docs";
  } else if (parts[0] === "ask") {
    const q = params.get("q") ?? "";
    if (searchInput.value.trim() !== q) searchInput.value = q;
    renderAsk(q);
    document.title = `${q} · cellforge docs`;
  } else if ((parts[0] === "guide" || parts[0] === "dev") && parts[1]) {
    const page = findPage(parts[0], parts[1]);
    if (page) {
      renderMarkdown(page.markdown);
      document.title = `${page.title} · cellforge docs`;
      const h = params.get("h");
      if (h) requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView());
      else content.scrollTo?.(0, 0);
    } else {
      content.innerHTML = `<article class="prose"><h1>Not found</h1><p><a href="#/">Back to the docs</a></p></article>`;
    }
  } else {
    renderHome();
    document.title = "cellforge docs";
  }
  if (!params.get("h")) window.scrollTo(0, 0);
}

document.getElementById("menu")!.addEventListener("click", () => document.body.classList.toggle("nav-open"));
window.addEventListener("hashchange", route);
renderNav();
route();

// live updates while PLAN.md or any page is edited
if (import.meta.hot) {
  import.meta.hot.accept(["./pages"], () => location.reload());
}
