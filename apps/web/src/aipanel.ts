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
import { AI_MODELS, describeHardware, formatBytes, modelFit, recommendModel, type CatalogModel } from "./aimodels";
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
    title: "Local AI",
    subtitle: "Runs on this computer",
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
  const body = root;

  let hw: HardwareInfo | null = null;
  let hwFailed = false;
  void cachedHardware()
    .then((x) => (hw = x))
    .catch(() => (hwFailed = true))
    .finally(() => draw(aiStatus(), true));

  /** run something from the panel (a tool opening in the side panel replaces this one; Back returns) */
  const thenClose = (f: () => unknown) => () => void f();
  const runCommand = (id: string) => deps.commands().find((c) => c.id === id)?.run();

  let lastKey = "";
  const draw = (s: AiStatus, force = false) => {
    const key = JSON.stringify([s.state, s.error, s.loading, s.ready, s.stored, s.download && [s.download.id, s.download.paused, s.download.phase]]);
    if (!force && key === lastKey) {
      // only the numbers moved: update progress in place (keeps keyboard focus on Pause/Cancel)
      if (s.download) {
        for (const bar of body.querySelectorAll<HTMLElement>("[data-progress]")) if (!bar.classList.contains("aip-progress-indeterminate")) setProgress(bar, s.download.loaded / s.download.total);
        for (const t of body.querySelectorAll<HTMLElement>("[data-progress-text]")) t.textContent = downloadText(s.download);
      }
      return;
    }
    lastKey = key;
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    body.replaceChildren(privacy(), statusCard(s), computer(), models(s), ownFile(s), uses(s), more());
    if (focused) body.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus();
  };

  // ---- sections --------------------------------------------------------

  const privacy = () =>
    h(
      "section",
      { className: "aip-privacy" },
      kitIcon("shield"),
      h(
        "p",
        {},
        h("strong", { textContent: "Runs on this computer." }),
        " Your sheets and what you type are never sent anywhere. The only time cellforge uses the network for AI is a model download you start, from the site named on the button.",
      ),
    );

  const statusCard = (s: AiStatus) => {
    const card = h("section", { className: `aip-status aip-status-${s.state}` });
    card.setAttribute("aria-live", "polite");
    const dot = h("span", { className: "aip-dot" });
    const title = h("h3", {});
    const lines = h("div", { className: "aip-status-text" });
    const actions = h("div", { className: "aip-actions" });
    const d = s.download;
    switch (s.state) {
      case "none":
        title.textContent = "No AI model yet";
        lines.append(
          h("p", {
            textContent: "Pick a model below. It downloads once, is kept in this browser, and works offline after that. Everything else in cellforge works without it.",
          }),
        );
        break;
      case "stored": {
        title.textContent = "Kept in this browser, not loaded yet";
        lines.append(h("p", { textContent: `${s.label.replace(/; it loads when needed$/, "")}. It loads by itself the first time a feature needs it, or load it now.` }));
        const b = button("Load it now", () => localAi.restore(), "primary");
        b.classList.add("aip-primary-action");
        b.dataset.focusKey = "load-now";
        actions.append(b);
        break;
      }
      case "downloading":
        title.textContent = d!.phase === "checking" ? `Checking ${d!.name}` : `Downloading ${d!.name}`;
        lines.append(progressBar(d!.phase === "checking" ? null : d!.loaded / d!.total, "Download progress"), h("p", { className: "aip-muted", dataset: { progressText: "" }, textContent: downloadText(d!) }));
        if (d!.phase === "downloading") actions.append(pauseCancel());
        break;
      case "paused":
        title.textContent = "Download paused";
        if (d) {
          lines.append(progressBar(d.loaded / d.total, "Download progress"), h("p", { className: "aip-muted", textContent: `${d.name}: ${downloadText(d)}. It carries on from here when you resume.` }));
        } else {
          const p = s.stored.find((x) => x.partial);
          lines.append(h("p", { className: "aip-muted", textContent: `${p?.name ?? "A model"} is partly downloaded (${formatBytes(p?.bytes ?? 0)}). Resume it from its card below.` }));
        }
        break;
      case "loading":
        title.textContent = `Loading ${s.loading!.name}`;
        lines.append(progressBar(null, "Loading"), h("p", { className: "aip-muted", textContent: s.loading!.step }));
        break;
      case "ready": {
        const r = s.ready!;
        title.textContent = `Ready: ${r.name}`;
        const where = r.backend === "GPU" ? "runs on the graphics card" : "runs on the processor";
        lines.append(h("p", { textContent: [formatBytes(r.size), where, speed(r.tokensPerSecond)].filter(Boolean).join(" · ") }));
        if (r.gpuFailed) lines.append(h("p", { className: "aip-note", textContent: "The graphics card couldn't run it, so it runs on the processor instead. Answers will be slower." }));
        else if (r.backend === "CPU")
          lines.append(h("p", { className: "aip-note", textContent: "This browser has no graphics card it can use for AI (WebGPU), so the model runs on the processor. That works, but answers take longer; the Small model suits this best." }));
        actions.append(button("Try it in the ask bar", thenClose(() => deps.askBar()), "primary"), button("Unload", () => localAi.unload(), "quiet", "Free the memory; the model stays kept and loads again when needed"));
        break;
      }
      case "error":
        title.textContent = "Something needs your attention";
        break;
    }
    if (s.error) {
      const err = h("div", { className: "aip-error" }, h("p", { textContent: s.error }));
      const row = h("div", { className: "aip-actions" });
      if (d?.paused) {
        const m = AI_MODELS.find((x) => x.id === d.id);
        if (m) row.append(button("Resume", () => localAi.downloadModel(m), "primary"));
      }
      row.append(button("Dismiss", () => localAi.clearError(), "quiet"));
      err.append(row);
      lines.append(err);
    }
    card.append(h("div", { className: "aip-status-head" }, dot, title), lines);
    if (actions.childElementCount) card.append(actions);
    return card;
  };

  const pauseCancel = (where = "status") => {
    const p = button("Pause", () => localAi.pause());
    p.dataset.focusKey = `pause-${where}`;
    const c = button("Cancel", () => localAi.cancel(), "quiet", "Stop and delete what has arrived");
    c.dataset.focusKey = `cancel-${where}`;
    return h("span", { className: "aip-inline" }, p, c);
  };

  const computer = () => {
    const sec = h("section", { className: "cf-section aip-section" }, h("h3", { className: "cf-section__title", textContent: "This computer" }));
    if (!hw) sec.append(h("p", { className: "aip-muted", textContent: hwFailed ? "Couldn't check this computer; all models are shown." : "Checking what this computer can run…" }));
    else {
      const rec = recommendModel(hw);
      sec.append(h("p", { textContent: describeHardware(hw) }), h("p", { className: "aip-muted" }, "Recommended here: ", h("strong", { textContent: `${rec.size} (${rec.name})` }), "."));
    }
    return sec;
  };

  const models = (s: AiStatus) => {
    const sec = h("section", { className: "cf-section aip-section" }, h("h3", { className: "cf-section__title", textContent: "Recommended models" }));
    const rec = hw ? recommendModel(hw) : null;
    const list = h("div", { className: "aip-cards" });
    for (const m of AI_MODELS) list.append(card(m, s, rec?.id === m.id));
    sec.append(list, h("p", { className: "aip-muted aip-small", textContent: "All three are Qwen2.5 Instruct models by Alibaba Cloud, published on Hugging Face. Each download is checked against its published size and fingerprint (SHA-256) before it's used." }));
    return sec;
  };

  const card = (m: CatalogModel, s: AiStatus, recommended: boolean) => {
    const stored = s.stored.find((x) => x.file === m.file && !x.partial);
    const partial = s.stored.find((x) => x.file === m.file && x.partial);
    const inUse = s.ready?.file === m.file;
    const loadingThis = s.state === "loading" && s.loading?.name === m.name;
    const d = s.download?.id === m.id ? s.download : null;
    const fit = hw ? modelFit(hw, m) : null;

    const el = h("article", { className: "aip-card" + (recommended ? " aip-card-recommended" : "") + (inUse ? " aip-card-inuse" : "") });
    const badges = h("div", { className: "aip-badges" });
    if (inUse) badges.append(h("span", { className: "cf-badge cf-badge--success", textContent: "In use" }));
    if (recommended) badges.append(h("span", { className: "cf-badge cf-badge--accent", textContent: "Recommended" }));
    el.append(h("div", { className: "aip-card-head" }, h("h4", {}, h("span", { className: "aip-size", textContent: m.size }), " ", m.name), badges));
    el.append(h("p", { textContent: m.goodFor }));
    const facts = h("p", { className: "aip-facts" });
    facts.append(
      `${formatBytes(m.bytes)} download · ${m.quant} · needs ${m.minMemoryGB} GB memory${m.gpu === "recommended" ? ", graphics card recommended" : ""} · Licence: `,
      h("a", { href: m.licence.url, target: "_blank", rel: "noopener noreferrer", textContent: m.licence.name }),
    );
    el.append(facts);
    if (m.licence.note && /non-commercial|read the licence/i.test(m.licence.note)) el.append(h("p", { className: "aip-note", textContent: m.licence.note }));
    if (fit && !fit.fits) el.append(h("p", { className: "aip-warn", textContent: `May not run well here: ${fit.reasons.join("; ")}.` }));

    const actions = h("div", { className: "aip-actions" });
    const busyElsewhere = !!s.download && !s.download.paused && !d;
    if (d && !d.paused) {
      el.append(progressBar(d.phase === "checking" ? null : d.loaded / d.total, `Downloading ${m.name}`), h("p", { className: "aip-muted", dataset: { progressText: "" }, textContent: downloadText(d) }));
      if (d.phase === "downloading") actions.append(pauseCancel(m.id));
    } else if (d?.paused || partial) {
      const have = d?.loaded ?? partial!.bytes;
      el.append(progressBar(have / m.bytes, `${m.name} partly downloaded`), h("p", { className: "aip-muted", textContent: `Paused at ${Math.floor((have / m.bytes) * 100)}% · ${formatBytes(have)} of ${formatBytes(m.bytes)}` }));
      const r = button(`Resume (${formatBytes(m.bytes - have)} left from ${m.site})`, () => localAi.downloadModel(m), "primary");
      r.dataset.focusKey = `resume-${m.id}`;
      r.disabled = busyElsewhere;
      const c = button("Cancel", () => localAi.discardPartial(m), "quiet", "Delete the part that has arrived");
      c.dataset.focusKey = `discard-${m.id}`;
      actions.append(r, c);
    } else if (stored) {
      if (!inUse) {
        const u = button(loadingThis ? "Loading…" : "Use", () => localAi.useStored(m.file).catch(() => undefined), "primary");
        u.disabled = loadingThis;
        u.dataset.focusKey = `use-${m.id}`;
        actions.append(u);
      }
      const r = confirmButton("Remove", { title: `Remove ${m.name}?`, text: `It is deleted from this browser and frees ${formatBytes(m.bytes)}. You can download it again later.`, confirm: "Remove model" }, () => localAi.remove(m.file));
      r.dataset.focusKey = `remove-${m.id}`;
      actions.append(r, h("span", { className: "aip-muted aip-small", textContent: "Kept in this browser" }));
    } else {
      const b = button(`Download ${formatBytes(m.bytes)} from ${m.site}`, () => localAi.downloadModel(m), recommended ? "primary" : "secondary", busyElsewhere ? "One download at a time" : `Downloads ${m.file} from ${m.page}`);
      b.disabled = busyElsewhere;
      b.dataset.focusKey = `download-${m.id}`;
      if (recommended && s.state === "none") b.classList.add("aip-primary-action");
      actions.append(b, h("a", { className: "aip-small", href: m.page, target: "_blank", rel: "noopener noreferrer", textContent: "About this model" }));
    }
    el.append(actions);
    return el;
  };

  const ownFile = (s: AiStatus) => {
    const sec = h("section", { className: "cf-section aip-section" }, h("h3", { className: "cf-section__title", textContent: "Your own model file" }));
    const own = s.stored.filter((x) => !x.catalogId && !x.partial);
    for (const f of own) {
      const inUse = s.ready?.file === f.file;
      const row = h("div", { className: "aip-own" }, h("span", { className: "aip-own-name", textContent: f.name, title: f.file }), h("span", { className: "aip-muted aip-small", textContent: formatBytes(f.bytes) }));
      if (inUse) row.append(h("span", { className: "cf-badge cf-badge--success", textContent: "In use" }));
      else {
        const u = button("Use", () => localAi.useStored(f.file).catch(() => undefined));
        u.dataset.focusKey = `use-own-${f.file}`;
        row.append(u);
      }
      const r = confirmButton("Remove", { title: `Remove ${f.name}?`, text: `It is deleted from this browser and frees ${formatBytes(f.bytes)}. The file on your disk isn't touched.`, confirm: "Remove model" }, () => localAi.remove(f.file));
      r.dataset.focusKey = `remove-own-${f.file}`;
      row.append(r);
      sec.append(row);
    }
    const pick = button("I already have a .gguf file…", async () => {
      const file = await pickModelFile();
      if (file) await localAi.install(file).catch(() => undefined);
    });
    pick.dataset.focusKey = "pick";
    sec.append(
      h("div", { className: "aip-actions" }, pick),
      h("p", { className: "aip-muted aip-small", textContent: "Qwen2, Llama or Mistral instruct models in Q4_K_M, Q4_0 or Q8_0 work best. The file is copied into this browser's private storage, so it's there next time." }),
    );
    return sec;
  };

  const uses = (s: AiStatus) => {
    const ready = s.state === "ready";
    const sec = h("section", { className: "cf-section aip-section" }, h("h3", { className: "cf-section__title", textContent: "What you can do with it" }));
    const items: { title: string; text: string; example?: string; go: () => unknown; works?: string }[] = [
      {
        title: "Ask in your own words",
        text: "The ask bar (Ctrl+/) already understands common requests. With the model it also takes ones in your own words, shows what it will do, and every step can be undone.",
        example: "make the header row stand out and keep it on screen",
        go: thenClose(() => deps.askBar("make the header row stand out and keep it on screen")),
      },
      {
        title: "Explain this number",
        text: "Select a cell with a formula, then press Explain with the local model for a short explanation in sentences. Every figure it mentions is checked.",
        go: thenClose(() => runCommand("explain")),
        works: "Works without the model too (plain reading).",
      },
      {
        title: "Suggest categories",
        text: "In Categorise, the model suggests categories for rows no rule covers, picking only from categories you already use.",
        go: thenClose(() => runCommand("categorise")),
      },
      {
        title: "Find spelling variants",
        text: "Fix spelling variants in a column: the model also spots abbreviations and typos (\"Acme Ltd\" and \"ACME Limited\").",
        go: thenClose(() => runCommand("variants")),
        works: "Works without the model too (rules only).",
      },
      {
        title: "Ask the guide",
        text: "F1: questions in your own words, answered from the user guide on this computer.",
        go: thenClose(() => (deps.askGuide ? deps.askGuide("") : runCommand("ask-guide"))),
        works: "Doesn't need the model.",
      },
    ];
    const ul = h("ul", { className: "aip-uses" });
    for (const it of items) {
      const b = h("button", { type: "button", className: "aip-use" }, h("strong", { textContent: it.title }), h("span", { textContent: it.text }));
      if (it.example) b.append(h("em", { textContent: `Try: “${it.example}”` }));
      if (it.works) b.append(h("small", { textContent: it.works }));
      b.dataset.focusKey = `use-${it.title}`;
      b.addEventListener("click", () => void it.go());
      ul.append(h("li", {}, b));
    }
    if (!ready) sec.append(h("p", { className: "aip-muted", textContent: "Until a model is loaded, these work their plain way (the ask bar with its known requests, explanations without the model's sentences)." }));
    sec.append(ul);
    return sec;
  };

  const more = () => {
    const sec = h("section", { className: "cf-section aip-section aip-more" });
    const b = button("Read the guide: Local AI", thenClose(() => (deps.askGuide ? deps.askGuide("local AI model download") : runCommand("ask-guide"))), "quiet");
    sec.append(b);
    return sec;
  };

  const unsubscribe = onAiStatus((s) => draw(s));
  draw(aiStatus(), true);
  return { root, dispose: unsubscribe };
}
