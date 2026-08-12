/**
 * The supporting-documents panel: attach PDFs and images, look through them,
 * drag a box round the figure that supports the selected cell and link the
 * two, and check every link on the sheet against the documents.
 *
 * PDFs are shown as their text, placed where it sits on the page (enough to
 * find and box a figure in a bank letter or an invoice); images as images.
 */
import type { Action } from "@cellforge/actions";
import type { PdfPage } from "@cellforge/core";
import { columnLetter } from "@cellforge/grid";
import { attachDocument, checkLink, documentBytes, pdfPages, regionText, type DocBytes, type DocMeta, type EvidenceLink, type Region } from "./docstore";
import type { Workbook } from "./workbook";

export interface DocDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  cell: () => { row: number; col: number };
  store: () => DocBytes | null;
  run: (a: Action) => Promise<unknown>;
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (t: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function pickDocuments(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", multiple: true, accept: ".pdf,image/*" });
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** A PDF page as positioned text, at a given width in CSS pixels. */
function pdfPageView(page: PdfPage, width: number): HTMLElement {
  const scale = width / page.width;
  const box = el("div", { className: "doc-page" });
  box.style.width = `${width}px`;
  box.style.height = `${page.height * scale}px`;
  for (const it of page.items) {
    const span = el("span", { textContent: it.text });
    span.style.left = `${it.x * scale}px`;
    span.style.top = `${(it.y - it.size) * scale}px`;
    span.style.fontSize = `${Math.max(6, it.size * scale)}px`;
    box.append(span);
  }
  return box;
}

/** Drag a rectangle on a page; calls back with it as fractions of the page. */
function regionPicker(box: HTMLElement, onPick: (r: Region) => void, initial?: Region): void {
  const mark = el("div", { className: "doc-region" });
  const show = (r: Region | undefined) => {
    mark.hidden = !r;
    if (!r) return;
    mark.style.left = `${r.x * 100}%`;
    mark.style.top = `${r.y * 100}%`;
    mark.style.width = `${r.w * 100}%`;
    mark.style.height = `${r.h * 100}%`;
  };
  box.append(mark);
  show(initial);
  let start: { x: number; y: number } | null = null;
  const at = (e: PointerEvent) => {
    const b = box.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  box.addEventListener("pointerdown", (e) => {
    start = at(e);
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  box.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = at(e);
    show({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
  });
  box.addEventListener("pointerup", (e) => {
    if (!start) return;
    const p = at(e);
    const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    start = null;
    if (r.w > 0.005 && r.h > 0.003) onPick(r);
  });
}

export function openDocuments(d: DocDeps, focus?: EvidenceLink): void {
  document.querySelector(".doc-panel")?.remove();
  const panel = el("aside", { className: "recipe-panel doc-panel" });
  panel.setAttribute("aria-label", "Supporting documents");
  document.body.append(panel);
  let current: { doc: DocMeta; page: number } | null = null;
  let picked: Region | null = null;

  const close = () => panel.remove();
  const store = d.store();

  async function render() {
    const wb = d.workbook();
    panel.replaceChildren();
    const x = el("button", { type: "button", textContent: "×", title: "Close" });
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    panel.append(el("div", { className: "recipe-head" }, el("strong", { textContent: "Supporting documents" }), x));
    if (!store) {
      panel.append(el("p", { className: "cleanup-warn", textContent: "This browser isn't letting cellforge keep files, so documents can't be attached here." }));
      return;
    }
    const attach = el("button", { type: "button", textContent: "Attach documents…" });
    attach.addEventListener("click", async () => {
      const files = await pickDocuments();
      if (!files.length) return;
      const docs = [...wb.documents];
      for (const f of files) {
        const meta = await attachDocument(store, f);
        if (!docs.some((dd) => dd.sha256 === meta.sha256)) docs.push(meta);
      }
      await d.run({ type: "documents.set", params: { docs } });
      d.status(`Attached ${files.length} document${files.length === 1 ? "" : "s"}`);
      void render();
    });
    const check = el("button", { type: "button", textContent: "Check this sheet's evidence links" });
    check.addEventListener("click", () => void checkAll());
    panel.append(el("div", { className: "numfmt-actions" }, attach, check));

    const list = el("ul", { className: "recipe-saved" });
    for (const doc of wb.documents) {
      const open = el("button", { type: "button", textContent: "Open" });
      open.addEventListener("click", () => {
        current = { doc, page: 1 };
        picked = null;
        void render();
      });
      list.append(el("li", {}, el("span", { textContent: `${doc.name} (${Math.ceil(doc.size / 1024)} KB)`, title: `SHA-256 ${doc.sha256}` }), open));
    }
    if (!wb.documents.length) list.append(el("li", { className: "hp-muted", textContent: "No documents yet. Attach bank letters, invoices, confirmations…" }));
    panel.append(list);

    if (current) {
      const { doc } = current;
      const viewer = el("div", { className: "doc-viewer" });
      panel.append(el("strong", { textContent: doc.name }), viewer);
      const width = Math.min(380, panel.clientWidth - 30 || 360);
      const { row, col } = d.cell();
      const existing = wb.get(d.activeSheet()).source.extraAt(row, col)?.evidence;
      const shown = existing?.doc === doc.sha256 && existing.page === current.page ? existing.region : undefined;
      if (doc.type === "application/pdf") {
        let pages: PdfPage[];
        try {
          pages = await pdfPages(store, doc.sha256);
        } catch (e) {
          viewer.append(el("p", { className: "cleanup-warn", textContent: (e as Error).message }));
          return;
        }
        const page = pages[current.page - 1];
        const prev = el("button", { type: "button", textContent: "‹", disabled: current.page <= 1 });
        prev.setAttribute("aria-label", "Previous page");
        const next = el("button", { type: "button", textContent: "›", disabled: current.page >= pages.length });
        next.setAttribute("aria-label", "Next page");
        prev.addEventListener("click", () => {
          current!.page--;
          void render();
        });
        next.addEventListener("click", () => {
          current!.page++;
          void render();
        });
        viewer.append(el("div", { className: "doc-nav" }, prev, ` page ${current.page} of ${pages.length} `, next));
        if (!page.items.length) viewer.append(el("p", { className: "hp-muted", textContent: "This page has no text (a scan?). Box the area anyway to link it; it can't be checked automatically." }));
        const view = pdfPageView(page, width);
        viewer.append(view);
        const picked0 = el("p", { className: "hp-muted", textContent: "Drag a box round the figure that supports the selected cell." });
        viewer.append(picked0);
        regionPicker(view, (r) => {
          picked = r;
          picked0.textContent = `Boxed: ${regionText(page, r).replace(/\n/g, " · ") || "(no text)"}`;
        }, shown);
      } else if (doc.type.startsWith("image/")) {
        const bytes = await documentBytes(store, doc.sha256);
        const box = el("div", { className: "doc-page doc-image" });
        box.style.width = `${width}px`;
        if (bytes) box.append(el("img", { src: URL.createObjectURL(new Blob([bytes as BlobPart], { type: doc.type })), alt: doc.name }));
        viewer.append(box);
        regionPicker(box, (r) => (picked = r), shown);
      } else viewer.append(el("p", { className: "hp-muted", textContent: "This kind of file can't be shown here." }));

      const link = el("button", { type: "button", textContent: `Link ${columnLetter(col)}${row + 1} to this` });
      link.addEventListener("click", async () => {
        const target: EvidenceLink = { doc: doc.sha256, page: current!.page, ...(picked ? { region: picked } : {}) };
        await d.run({ type: "evidence.link", params: { row, col, link: target } });
        const r = await checkLink(store, wb.documents, target, wb.get(d.activeSheet()).source.getCell(row, col));
        d.status(r.status === "agrees" ? `Linked; the document shows the same figure (${r.found?.join(", ")}).` : r.status === "differs" ? `Linked, but the document shows ${r.found?.join(", ")}.` : "Linked.");
      });
      panel.append(el("div", { className: "numfmt-actions" }, link));
    }
    const report = el("div", { className: "doc-report" });
    panel.append(report);

    async function checkAll() {
      const sheetId = d.activeSheet();
      const src = wb.get(sheetId).source;
      const links = src.allExtras().filter((e) => e.extra.evidence);
      report.replaceChildren(el("strong", { textContent: `${links.length} evidence link${links.length === 1 ? "" : "s"} on this sheet` }));
      for (const l of links) {
        const r = await checkLink(store!, wb.documents, l.extra.evidence!, src.getCell(l.row, l.col));
        const go = el("button", { type: "button", className: "hp-cell", textContent: `${columnLetter(l.col)}${l.row + 1}` });
        go.addEventListener("click", () => d.goTo(sheetId, l.row, l.col));
        const words = { agrees: "agrees with the document", differs: `differs: the document shows ${r.found?.join(", ") ?? "?"}`, "no number": "no number in the boxed area", "not checkable": "linked (not a text PDF region, so not checked)" }[r.status];
        report.append(el("div", { className: r.status === "differs" ? "cleanup-warn" : "" }, go, ` ${words}`));
      }
    }
  }
  if (focus) {
    const doc = d.workbook().documents.find((x) => x.sha256 === focus.doc);
    if (doc) current = { doc, page: focus.page ?? 1 };
  }
  panel.addEventListener("keydown", (e) => e.key === "Escape" && close());
  void render();
}
