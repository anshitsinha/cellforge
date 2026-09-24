/**
 * The shared dialog of the data tools (transformtools.ts, timetools.ts):
 * the tool's fields, then a live preview of what it will do (worked out as
 * the fields change), and one primary button that does it. Errors show in
 * the preview, never only in the status bar.
 */
import "./analysis.css";
import "./transformtools.css";
import "./timetools.css";
import { openDialog } from "./ui/dialog";
import { icon } from "./ui/icons";
import { toast } from "./ui/toast";

export interface ToolPreview {
  lines: { text: string; warn?: boolean }[];
  table?: string[][];
  /** Does the work, or null when there's nothing to do. */
  apply: (() => Promise<void>) | null;
  ok: string;
}

export interface ToolSpec {
  title: string;
  intro: string;
  fields: HTMLElement[];
  compute(): ToolPreview;
}

const NUMERIC = /^[-+(]?[$€£¥]?\s?[\d,.\s]+%?\)?$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A dialog that says why the tool can't run here. */
export function openToolNotice(title: string, text: string, focusGrid: () => void): void {
  const box = el("div", "an-empty");
  box.append(el("p", undefined, text));
  openDialog({ title, size: "sm", body: box, actions: [{ label: "OK", kind: "primary", id: "ok" }], initialFocus: "primary", onClose: () => focusGrid() });
}

/** Open a tool. `focus` is a selector for the field to start in. */
export function openToolDialog(tool: ToolSpec, opts: { focusGrid: () => void; focus?: string }): void {
  const fields = el("div", "fields tool-fields");
  fields.append(...tool.fields);
  const result = el("section", "an-section tool-result");
  const head = el("div", "an-section__head");
  head.append(el("h3", "an-section__title", "Preview"));
  const out = el("div", "tx-result");
  out.setAttribute("aria-live", "polite");
  result.append(head, out);
  const body = el("div", "an-stack an-stack--loose tool-dlg");
  body.append(fields, result);

  let preview: ToolPreview | null = null;
  let timer = 0;
  const dlg = openDialog({
    title: tool.title,
    subtitle: tool.intro,
    size: "lg",
    body,
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: "Apply",
        id: "ok",
        kind: "primary",
        onClick: () => {
          clearTimeout(timer);
          update();
          const apply = preview?.apply;
          if (!apply) return false;
          const what = preview!.ok;
          void apply()
            .then(() => toast({ kind: "success", text: `${what}: done. Ctrl+Z undoes it.` }))
            .catch((e: unknown) => toast({ kind: "error", title: `${tool.title} didn't work`, text: (e as Error).message }))
            .finally(() => opts.focusGrid());
        },
      },
    ],
    initialFocus: (opts.focus && fields.querySelector<HTMLElement>(opts.focus)) || fields.querySelector<HTMLElement>("select, input") || undefined,
    onClose: (r) => {
      clearTimeout(timer);
      if (r === "dismiss") opts.focusGrid();
    },
  });
  const okBtn = dlg.button("ok")!;

  function update() {
    out.replaceChildren();
    try {
      preview = tool.compute();
    } catch (e) {
      preview = null;
      const n = el("div", "an-note an-note--error");
      n.append(icon("error"), el("span", undefined, (e as Error).message));
      out.append(n);
      okBtn.disabled = true;
      okBtn.title = "Fix the problem above first";
      return;
    }
    for (const l of preview.lines) {
      if (l.warn) {
        const n = el("div", "an-note an-note--warning");
        n.append(icon("warning"), el("span", undefined, l.text));
        out.append(n);
      } else out.append(el("p", "tool-line", l.text));
    }
    if (preview.table && preview.table.length) {
      const [header, ...rows] = preview.table;
      const wrap = el("div", "table-wrap tool-table");
      const table = el("table", "data-table data-table--dense");
      const thead = el("thead");
      const tr = el("tr");
      // right-align columns whose cells read as numbers
      const numeric = header.map((_, c) => rows.length > 0 && rows.every((r) => !r[c] || NUMERIC.test(r[c])) && rows.some((r) => r[c]));
      header.forEach((v, c) => {
        const th = el("th", numeric[c] ? "num" : undefined, v);
        th.scope = "col";
        tr.append(th);
      });
      thead.append(tr);
      const tbody = el("tbody");
      for (const row of rows) {
        const r = el("tr");
        row.forEach((v, c) => r.append(el("td", numeric[c] ? "num" : undefined, v)));
        tbody.append(r);
      }
      table.append(thead, tbody);
      wrap.append(table);
      out.append(wrap);
    }
    if (!out.childElementCount) out.append(el("p", "an-hint", "Nothing to show yet."));
    okBtn.textContent = preview.ok;
    okBtn.disabled = !preview.apply;
    okBtn.title = preview.apply ? "" : "Nothing to do with these settings";
  }
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(update, 200);
  };
  fields.addEventListener("input", later);
  fields.addEventListener("change", later);
  update();
}
