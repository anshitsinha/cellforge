/**
 * The AI panel: the one place for the local AI. It shows what state the AI
 * is in, what this computer can run, the recommended models with Download /
 * Use / Remove, "I already have a .gguf file", what stays private, and what
 * the AI can do, with examples that run.
 *
 * It lives in the shared side panel (id "ai"), so it sits beside the grid
 * and Back returns to it after a tool it opened. Download and load results
 * also show as toasts, wherever the user is.
 *
 * For the app shell's "Ask AI" button: `aiStatus()`, `onAiStatus(cb)` and
 * `aiBadge(status)` give the state, a dot colour and a label; clicking the
 * button calls `openAiPanel(deps)` (or `toggleAiPanel(deps)`).
 */
import "./aipanel.css";
import { confirmDialog } from "./ui/confirm";
import { icon } from "./ui/icons";
import { closeSidePanel, currentSidePanel, openSidePanel, toggleSidePanel, type SidePanelContext } from "./ui/sidepanel";
import { toast } from "./ui/toast";
import type { HardwareInfo } from "@cellforge/kiln";
import { AI_MODELS, formatBytes, modelFit, recommendModel, type CatalogModel } from "./aimodels";
import { aiStatus, cachedHardware, localAi, onAiStatus, pickModelFile, type AiStatus } from "./localmodel";

export { aiStatus, onAiStatus, type AiStatus } from "./localmodel";

export interface AiPanelDeps {
  /** open the ask bar, optionally with a request typed in */
  askBar: (text?: string) => void;
  /** the palette's commands; examples run "explain", "categorise", "variants" and "ask-guide" */
  commands: () => readonly { id: string; title: string; run: () => unknown }[];
  /** open "Ask the guide" with a question */
  askGuide?: (question: string) => void;
  focusGrid?: () => void;
}

export interface AiBadge {
  /** off: no model / kept but not loaded; busy: downloading or loading; ready; error (also a paused download) */
  dot: "off" | "busy" | "ready" | "error";
  /** short text for a chip next to the button, e.g. "Qwen2.5 1.5B" or "42%" ("" when there's nothing to add) */
  text: string;
  /** a full sentence for the tooltip / aria-label */
  title: string;
}

/** What an "Ask AI" button should show for a status. */
export function aiBadge(s: AiStatus = aiStatus()): AiBadge {
  const pct = s.download && s.download.total ? Math.floor((s.download.loaded / s.download.total) * 100) : 0;
  switch (s.state) {
    case "ready":
      return { dot: "ready", text: s.ready!.name.replace(/ Instruct$/, ""), title: `Local AI ready: ${s.ready!.name}, on the ${s.ready!.backend === "GPU" ? "graphics card" : "processor"}` };
    case "downloading":
      return { dot: "busy", text: `${pct}%`, title: s.label };
    case "loading":
      return { dot: "busy", text: "", title: s.label };
    case "paused":
      return { dot: "off", text: "", title: "Local AI: the model download is paused" };
    case "error":
      return { dot: "error", text: "", title: `Local AI: ${s.error ?? "something went wrong"}` };
    case "stored":
      return { dot: "off", text: "", title: `Local AI: ${s.label}` };
    default:
      return { dot: "off", text: "", title: "Ask AI: set up the local AI (runs on this computer)" };
  }
}

// ------------------------------------------------------------------ DOM --

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(e.dataset, dataset);
  for (const k of kids) if (k) e.append(k);
  return e;
}

const kitIcon = (name: string) => {
  const i = icon(name);
  i.classList.add("aip-icon");
  return i;
};

const BTN = { primary: "btn-primary", secondary: "btn-secondary", quiet: "btn-ghost", danger: "btn-danger-ghost" } as const;
const button = (text: string, onClick: () => unknown, kind: keyof typeof BTN = "secondary", title?: string) => {
  const b = h("button", { type: "button", className: `${BTN[kind]} btn-sm`, textContent: text });
  if (title) b.title = title;
  b.addEventListener("click", () => void onClick());
  return b;
};

/** A Remove button that asks first (the shared confirm dialog). */
const confirmButton = (text: string, question: { title: string; text: string; confirm: string }, onClick: () => unknown) =>
  button(text, async () => {
    if (await confirmDialog({ ...question, danger: true })) await onClick();
  }, "danger");

const progressBar = (fraction: number | null, label: string) => {
  const bar = h("div", { className: "aip-progress" + (fraction === null ? " aip-progress-indeterminate" : "") }, h("div", { className: "aip-progress-fill" }));
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", label);
  if (fraction !== null) {
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    setProgress(bar, fraction);
  }
  bar.dataset.progress = "";
  return bar;
};
function setProgress(bar: HTMLElement, fraction: number) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", String(Math.floor(pct)));
}

const downloadText = (d: NonNullable<AiStatus["download"]>) =>
  d.phase === "checking" ? "Checking the file is complete and unchanged…" : `${Math.floor((d.loaded / d.total) * 100)}% · ${formatBytes(d.loaded)} of ${formatBytes(d.total)}`;

const speed = (tps: number | null) => (tps === null ? null : tps >= 10 ? `about ${Math.round(tps)} tokens a second` : `about ${tps.toFixed(1)} tokens a second`);

// ---------------------------------------------------------------- panel --

export const AI_PANEL_ID = "ai";

export const isAiPanelOpen = () => currentSidePanel() === AI_PANEL_ID;

export function closeAiPanel() {
  if (isAiPanelOpen()) closeSidePanel();
}

const panelOptions = (deps: AiPanelDeps) => {
  watchAiToasts();
  return {
    id: AI_PANEL_ID,
    title: "Private AI",
    subtitle: "Runs on this computer · nothing is sent anywhere",
    render: (p: SidePanelContext) => {
      const built = buildAiPanel(deps);
      p.body.append(built.root);
      return built.dispose;
    },
    onClose: () => deps.focusGrid?.(),
  };
};

/** Open the AI panel in the side panel (it replaces whatever tool is showing; Back returns to it). */
export function openAiPanel(deps: AiPanelDeps): void {
  if (isAiPanelOpen()) return;
  openSidePanel(panelOptions(deps));
}

/** For a toolbar button: open the AI panel, or close it if it's showing. */
export function toggleAiPanel(deps: AiPanelDeps): void {
  toggleSidePanel(panelOptions(deps));
}

let toastsOn = false;
/**
 * Results of downloads and loads as toasts, wherever the user is. Started by
 * the first openAiPanel(); a shell may call it at start-up too.
 */
export function watchAiToasts(): void {
  if (toastsOn) return;
  toastsOn = true;
  let prev = aiStatus();
  onAiStatus((s) => {
    const was = prev;
    prev = s;
    if (s.error && s.error !== was.error) toast({ kind: "error", title: "Local AI", text: s.error });
    else if (s.state === "ready" && was.state !== "ready" && s.ready) {
      const r = s.ready;
      toast({ kind: "success", title: `Local AI ready: ${r.name}`, text: [r.backend === "GPU" ? "Runs on the graphics card" : "Runs on the processor", speed(r.tokensPerSecond)].filter(Boolean).join(", ") + ". Try it with Ctrl+/." });
    } else if (was.download && !was.download.paused && s.download?.paused && !s.error) toast({ kind: "info", text: `Download of ${was.download.name} paused. Resume it in the AI panel.` });
  });
}

/** The panel's content and its clean-up, for whichever host shows it. */
export function buildAiPanel(deps: AiPanelDeps): { root: HTMLElement; dispose: () => void } {
  const root = h("div", { className: "ai-panel" });

  let hw: HardwareInfo | null = null;
  let hwFailed = false;
  let showOthers = false;
  void cachedHardware()
    .then((x) => (hw = x))
    .catch(() => (hwFailed = true))
    .finally(() => draw(aiStatus(), true));

  const runCommand = (id: string) => deps.commands().find((c) => c.id === id)?.run();
  const recommended = () => (hw ? recommendModel(hw) : (AI_MODELS.find((m) => m.size === "Medium") ?? AI_MODELS[0]));

  let lastKey = "";
  const draw = (s: AiStatus, force = false) => {
    const key = JSON.stringify([s.state, s.error, s.loading, s.ready, s.stored, s.download && [s.download.id, s.download.paused, s.download.phase], showOthers]);
    if (!force && key === lastKey) {
      // only the numbers moved: update progress in place (keeps keyboard focus on Pause/Cancel)
      if (s.download) {
        for (const bar of root.querySelectorAll<HTMLElement>("[data-progress]")) if (!bar.classList.contains("aip-progress-indeterminate")) setProgress(bar, s.download.loaded / s.download.total);
        for (const t of root.querySelectorAll<HTMLElement>("[data-progress-text]")) t.textContent = downloadText(s.download);
      }
      return;
    }
    lastKey = key;
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    root.replaceChildren(hero(), steps(s), ...[kept(s)].filter((x): x is HTMLElement => !!x), uses(s), fine());
    if (focused) root.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus();
  };

  // ---- hero ------------------------------------------------------------

  const hero = () =>
    h(
      "header",
      { className: "aip-hero" },
      h("h2", { className: "aip-title", textContent: "An AI assistant that never sees the internet." }),
      h("p", {
        className: "aip-lede",
        textContent: "Say what you want in plain English and see what will change before anything does. The model runs inside this tab: nothing you type, and none of your data, leaves this computer.",
      }),
    );

  // ---- the three steps -------------------------------------------------

  const step = (n: number, state: "done" | "current" | "todo", title: string, text: string, ...body: Kid[]) => {
    const mark = h("span", { className: "aip-step-n" });
    mark.setAttribute("aria-hidden", "true");
    if (state === "done") mark.append(kitIcon("check"));
    else mark.textContent = String(n);
    const li = h("li", { className: `aip-step aip-step--${state}` }, mark, h("p", { className: "aip-step-text" }, h("b", { textContent: title }), text ? " " + text : ""));
    // what the step holds (buttons, the model card, progress) uses the card's full width
    for (const k of body) {
      if (k instanceof HTMLElement) k.classList.add("aip-step-extra");
      if (k) li.append(k);
    }
    li.setAttribute("aria-label", `Step ${n}${state === "done" ? ", done" : state === "current" ? ", next" : ""}: ${title}`);
    return li;
  };

  const steps = (s: AiStatus) => {
    const haveModel = s.stored.some((x) => !x.partial) || !!s.ready;
    const ready = s.state === "ready";
    const ol = h("ol", { className: "aip-steps" });
    ol.setAttribute("aria-label", "Getting started with the local AI");

    const tryBar = button("Open the ask bar", () => deps.askBar(), "quiet");
    tryBar.dataset.focusKey = "try-bar";
    ol.append(step(1, "done", "Start without a model.", "The ask bar (Ctrl+/) already understands common requests: sort, filter, highlight, freeze, find duplicates.", ready ? null : h("div", { className: "aip-actions" }, tryBar)));

    ol.append(
      step(
        2,
        haveModel ? "done" : "current",
        "Get a model.",
        haveModel ? "It's kept in this browser's private storage." : "One download, kept in this browser for next time.",
        haveModel ? null : getModel(s),
      ),
    );

    const third = ready ? "done" : haveModel ? "current" : "todo";
    ol.append(step(3, third, "Load it once.", ready ? "" : "It loads by itself the first time something needs it, and stays for next time. Remove it whenever you like.", loadState(s)));
    return ol;
  };

  /** Why the recommendation fits, in a few words. */
  const fitLine = (x: HardwareInfo) => {
    const gpu = x.webgpu && !x.webgpu.isFallbackAdapter;
    const mem = x.deviceMemoryGB === null ? null : x.deviceMemoryGB >= 8 ? "8 GB+ memory" : `${x.deviceMemoryGB} GB memory`;
    return `Fits this computer: ${[mem, gpu ? "a graphics card the browser can use" : "no graphics card the browser can use", x.storageAvailableBytes !== null ? `${formatBytes(x.storageAvailableBytes)} free` : null].filter(Boolean).join(", ")}.`;
  };

  const pickFile = async () => {
    const file = await pickModelFile();
    if (file) await localAi.install(file).catch(() => undefined);
  };

  /** Step 2: the recommended model, big, with the other sizes behind a toggle. */
  const getModel = (s: AiStatus) => {
    const wrap = h("div", { className: "aip-get" });
    const rec = recommended();
    wrap.append(modelCard(rec, s, true));
    const others = AI_MODELS.filter((m) => m.id !== rec.id);
    const toggle = button(showOthers ? "Hide other sizes" : `Other sizes: ${others.map((m) => m.size).join(", ")}`, () => {
      showOthers = !showOthers;
      draw(aiStatus(), true);
    }, "quiet");
    toggle.dataset.focusKey = "others";
    toggle.setAttribute("aria-expanded", String(showOthers));
    const pick = button("I already have a .gguf file…", pickFile, "quiet");
    pick.dataset.focusKey = "pick";
    wrap.append(h("div", { className: "aip-get-more" }, toggle, pick));
    if (showOthers) for (const m of others) wrap.append(modelCard(m, s, false));
    if (s.error && !s.stored.some((x) => !x.partial)) wrap.append(errorBox(s));
    return wrap;
  };

  /** Step 3: loading, ready, or kept but not loaded yet. */
  const loadState = (s: AiStatus): HTMLElement | null => {
    if (s.state === "loading") {
      return h("div", { className: "aip-load" }, progressBar(null, "Loading"), h("p", { className: "aip-muted aip-small", textContent: `${s.loading!.name}: ${s.loading!.step}` }));
    }
    if (s.state === "ready") {
      const r = s.ready!;
      const tryIt = button("Try it in the ask bar", () => deps.askBar(), "primary");
      tryIt.dataset.focusKey = "try-ready";
      const unload = button("Unload", () => localAi.unload(), "quiet", "Free the memory; the model stays kept and loads again when needed");
      unload.dataset.focusKey = "unload";
      const card = h(
        "div",
        { className: "aip-ready" },
        h("div", { className: "aip-ready-head" }, h("span", { className: "aip-dot aip-dot--ready" }), h("strong", { textContent: r.name }), h("span", { className: "cf-badge cf-badge--success", textContent: "Ready" })),
        h("p", { className: "aip-facts", textContent: [formatBytes(r.size), r.backend === "GPU" ? "on the graphics card" : "on the processor", speed(r.tokensPerSecond)].filter(Boolean).join(" · ") }),
      );
      if (r.gpuFailed) card.append(h("p", { className: "aip-note", textContent: "The graphics card couldn't run it, so it runs on the processor instead. Answers will be slower." }));
      else if (r.backend === "CPU") card.append(h("p", { className: "aip-note", textContent: "This browser can't use the graphics card for AI, so the model runs on the processor: it works, more slowly. The Small model suits this best." }));
      card.append(h("div", { className: "aip-actions" }, tryIt, unload));
      return card;
    }
    if (s.stored.some((x) => !x.partial)) {
      const b = button("Load it now", () => localAi.restore(), "primary");
      b.dataset.focusKey = "load-now";
      const box = h("div", { className: "aip-actions" }, b);
      return s.error ? h("div", { className: "aip-get" }, errorBox(s), box) : box;
    }
    return null;
  };

  const errorBox = (s: AiStatus) => {
    const d = s.download;
    const row = h("div", { className: "aip-actions" });
    if (d?.paused) {
      const m = AI_MODELS.find((x) => x.id === d.id);
      if (m) row.append(button("Resume", () => localAi.downloadModel(m), "primary"));
    }
    row.append(button("Dismiss", () => localAi.clearError(), "quiet"));
    const box = h("div", { className: "aip-error" }, h("p", { textContent: s.error ?? "" }), row);
    box.setAttribute("role", "alert");
    return box;
  };

  const pauseCancel = (where: string) => {
    const p = button("Pause", () => localAi.pause());
    p.dataset.focusKey = `pause-${where}`;
    const c = button("Cancel", () => localAi.cancel(), "quiet", "Stop and delete what has arrived");
    c.dataset.focusKey = `cancel-${where}`;
    return h("div", { className: "aip-actions" }, p, c);
  };

  const modelCard = (m: CatalogModel, s: AiStatus, hero: boolean) => {
    const partial = s.stored.find((x) => x.file === m.file && x.partial);
    const d = s.download?.id === m.id ? s.download : null;
    const fit = hw ? modelFit(hw, m) : null;
    const el = h("article", { className: "aip-model" + (hero ? " aip-model--hero" : "") });
    const head = h("div", { className: "aip-model-head" }, h("span", { className: "aip-size", textContent: m.size }));
    if (hero) head.append(h("span", { className: "cf-badge cf-badge--accent", textContent: hw ? "Recommended for this computer" : "Recommended" }));
    el.append(head, h("h4", { className: "aip-model-name", textContent: m.name }), h("p", { className: "aip-model-for", textContent: m.goodFor }));
    const facts = h("ul", { className: "aip-chips" });
    facts.setAttribute("aria-label", "Details");
    for (const f of [`${formatBytes(m.bytes)} download`, `${m.minMemoryGB} GB memory`, m.gpu === "recommended" ? "graphics card recommended" : "no graphics card needed"]) facts.append(h("li", { textContent: f }));
    facts.append(h("li", {}, h("a", { href: m.licence.url, target: "_blank", rel: "noopener noreferrer", textContent: m.licence.name, title: `Licence. File: ${m.file} (${m.quant})` })));
    el.append(facts);
    if (/non-commercial/i.test(m.licence.note)) el.append(h("p", { className: "aip-note", textContent: m.licence.note }));
    if (hero && hw) el.append(h("p", { className: "aip-why" }, kitIcon("check"), h("span", { textContent: fitLine(hw) })));
    else if (hero && hwFailed) el.append(h("p", { className: "aip-why", textContent: "Couldn't check this computer, so this is the usual choice." }));
    if (fit && !fit.fits) el.append(h("p", { className: "aip-warn", textContent: `May not run well here: ${fit.reasons.join("; ")}.` }));

    const busyElsewhere = !!s.download && !s.download.paused && !d;
    if (d && !d.paused) {
      el.append(progressBar(d.phase === "checking" ? null : d.loaded / d.total, `Downloading ${m.name}`), h("p", { className: "aip-muted aip-small", dataset: { progressText: "" }, textContent: downloadText(d) }));
      if (d.phase === "downloading") el.append(pauseCancel(m.id));
    } else if (d?.paused || partial) {
      const have = d?.loaded ?? partial!.bytes;
      el.append(progressBar(have / m.bytes, `${m.name} partly downloaded`), h("p", { className: "aip-muted aip-small", textContent: `Paused at ${Math.floor((have / m.bytes) * 100)}% · ${formatBytes(have)} of ${formatBytes(m.bytes)}` }));
      const r = button(`Resume · ${formatBytes(m.bytes - have)} left`, () => localAi.downloadModel(m), "primary", `Carries on downloading from ${m.site}`);
      r.dataset.focusKey = `resume-${m.id}`;
      r.disabled = busyElsewhere;
      const c = button("Cancel", () => localAi.discardPartial(m), "quiet", "Delete the part that has arrived");
      c.dataset.focusKey = `discard-${m.id}`;
      el.append(h("div", { className: "aip-actions" }, r, c));
    } else if (!s.stored.some((x) => x.file === m.file)) {
      const b = button(`Download ${formatBytes(m.bytes)} from ${m.site}`, () => localAi.downloadModel(m), hero ? "primary" : "secondary", busyElsewhere ? "One download at a time" : `Downloads ${m.file} from ${m.page}`);
      b.disabled = busyElsewhere;
      b.dataset.focusKey = `download-${m.id}`;
      if (hero) b.classList.add("aip-cta");
      el.append(h("div", { className: "aip-actions" }, b, h("a", { className: "aip-small", href: m.page, target: "_blank", rel: "noopener noreferrer", textContent: "About this model" })));
    }
    return el;
  };

  // ---- models kept -----------------------------------------------------

  const kept = (s: AiStatus): HTMLElement | null => {
    const files = s.stored.filter((x) => !x.partial);
    if (!files.length) return null;
    const sec = h("section", { className: "cf-section aip-section" }, h("h3", { className: "cf-section__title", textContent: "Models in this browser" }));
    for (const f of files) {
      const inUse = s.ready?.file === f.file;
      const row = h("div", { className: "aip-kept" }, h("div", { className: "aip-kept-name" }, h("strong", { textContent: f.name, title: f.file }), h("span", { className: "aip-muted aip-small", textContent: formatBytes(f.bytes) })));
      if (inUse) row.append(h("span", { className: "cf-badge cf-badge--success", textContent: "In use" }));
      else {
        const loadingThis = s.state === "loading" && s.loading?.name === f.name;
        const u = button(loadingThis ? "Loading…" : "Use", () => localAi.useStored(f.file).catch(() => undefined));
        u.disabled = loadingThis;
        u.dataset.focusKey = `use-${f.file}`;
        row.append(u);
      }
      const r = confirmButton(
        "Remove",
        { title: `Remove ${f.name}?`, text: `It is deleted from this browser and frees ${formatBytes(f.bytes)}.${f.catalogId ? " You can download it again later." : " The file on your disk isn't touched."}`, confirm: "Remove model" },
        () => localAi.remove(f.file),
      );
      r.dataset.focusKey = `remove-${f.file}`;
      row.append(r);
      sec.append(row);
    }
    const toggle = button(showOthers ? "Hide other sizes" : "Get another size", () => {
      showOthers = !showOthers;
      draw(aiStatus(), true);
    }, "quiet");
    toggle.dataset.focusKey = "another";
    toggle.setAttribute("aria-expanded", String(showOthers));
    const pick = button("I already have a .gguf file…", pickFile, "quiet");
    pick.dataset.focusKey = "pick-kept";
    sec.append(h("div", { className: "aip-get-more" }, toggle, pick));
    // downloads of another size (in progress or paused) stay visible
    for (const m of AI_MODELS) {
      const busy = s.download?.id === m.id || s.stored.some((x) => x.file === m.file && x.partial);
      const has = s.stored.some((x) => x.file === m.file && !x.partial);
      if (!has && (busy || showOthers)) sec.append(modelCard(m, s, false));
    }
    return sec;
  };

  // ---- what it does ----------------------------------------------------

  const uses = (s: AiStatus) => {
    const ready = s.state === "ready";
    const sec = h("section", { className: "cf-section aip-section" }, h("h3", { className: "cf-section__title", textContent: "What you can do with it" }));
    const items: { title: string; text: string; go: () => unknown; plain?: string }[] = [
      { title: "Ask in your own words", text: "“Make the header row stand out and keep it on screen.” You see the plan first, and every step can be undone.", go: () => deps.askBar("make the header row stand out and keep it on screen") },
      { title: "Explain this number", text: "Rephrases a formula in sentences; every figure it mentions is checked.", go: () => runCommand("explain"), plain: "Plain reading without a model" },
      { title: "Suggest categories", text: "Fills rows no rule covers, choosing only from categories you already use.", go: () => runCommand("categorise") },
      { title: "Find spelling variants", text: "Also spots abbreviations and typos, like “Acme Ltd” and “ACME Limited”.", go: () => runCommand("variants"), plain: "Rules only without a model" },
    ];
    const ul = h("ul", { className: "aip-uses" });
    for (const it of items) {
      const b = h("button", { type: "button", className: "aip-use" }, h("b", { textContent: it.title }), h("span", { textContent: it.text }));
      if (it.plain && !ready) b.append(h("small", { textContent: it.plain }));
      b.dataset.focusKey = `use-${it.title}`;
      b.addEventListener("click", () => void it.go());
      ul.append(h("li", {}, b));
    }
    sec.append(ul);
    return sec;
  };

  const fine = () => {
    const a = h("button", { type: "button", className: "aip-link", textContent: "Read the guide" });
    a.addEventListener("click", () => void (deps.askGuide ? deps.askGuide("local AI model download") : runCommand("ask-guide")));
    return h("p", { className: "aip-fine" }, kitIcon("shield"), h("span", {}, "The only network use is a download you start, from the site named on its button. No account, no tracking. ", a));
  };

  const unsubscribe = onAiStatus((s) => draw(s));
  draw(aiStatus(), true);
  return { root, dispose: unsubscribe };
}
