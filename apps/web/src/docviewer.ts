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
import "./evidence.css";
import { button, el, emptyState, headline, navigator, notice, report, section } from "./toolkit";
import { icon, iconButton } from "./ui/icons";
import { openSidePanel } from "./ui/sidepanel";
import { renderTable } from "./ui/table";

export interface DocDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  cell: () => { row: number; col: number };
  store: () => DocBytes | null;
  run: (a: Action) => Promise<unknown>;
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (t: string) => void;
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
  let current: { doc: DocMeta; page: number } | null = null;
  let picked: Region | null = null;
  let checked: HTMLElement | null = null;
  const store = d.store();
  const goTo = navigator(d.goTo);
  if (focus) {
    const doc = d.workbook().documents.find((x) => x.sha256 === focus.doc);
    if (doc) current = { doc, page: focus.page ?? 1 };
  }

  openSidePanel({
    id: "documents",
    title: "Supporting documents",
    subtitle: "Evidence linked to the numbers",
    render: (p) => {
      let gen = 0;
      const attach = async () => {
        if (!store) return;
        const files = await pickDocuments();
        if (!files.length) return;
        const wb = d.workbook();
        const docs = [...wb.documents];
        for (const f of files) {
          const meta = await attachDocument(store, f);
          if (!docs.some((dd) => dd.sha256 === meta.sha256)) docs.push(meta);
        }
        await d.run({ type: "documents.set", params: { docs } });
        report(d.status, `Attached ${files.length} document${files.length === 1 ? "" : "s"}`);
        if (files.length === 1) {
          const doc = d.workbook().documents.find((x) => x.name === files[0].name);
          if (doc) current = { doc, page: 1 };
        }
        void render();
      };
      const attachBtn = button("Attach documents…", attach, "primary", "upload");
      if (store) p.footer.append(attachBtn);

      async function render() {
        const mine = ++gen;
        const wb = d.workbook();
        const parts: Node[] = [];
        if (!store) {
          p.body.replaceChildren(notice("This browser isn't letting cellforge keep files (private window or blocked storage), so documents can't be attached here.", "danger"));
          return;
        }
        attachBtn.style.display = wb.documents.length ? "" : "none";
        if (!wb.documents.length) {
          p.body.replaceChildren(
            emptyState({
              icon: "document",
              title: "Keep the evidence next to the numbers",
              text: "Attach bank letters, invoices and confirmations (PDF or images). Then select a cell, open the document and draw a box round the figure that supports it. cellforge checks the two agree.",
              action: button("Attach documents…", attach, "secondary", "upload"),
            }),
          );
          return;
        }
        // the documents
        const list = el("ul", { className: "dc-list" });
        for (const doc of wb.documents) {
          const open = current?.doc.sha256 === doc.sha256;
          const item = el("button", { type: "button", className: `dc-item${open ? " is-open" : ""}`, title: `SHA-256 ${doc.sha256}` });
          item.setAttribute("aria-pressed", String(open));
          item.append(icon(doc.type === "application/pdf" ? "document" : "open"), el("span", { className: "dc-item__name", textContent: doc.name }), el("span", { className: "tk-muted", textContent: `${Math.max(1, Math.ceil(doc.size / 1024)).toLocaleString()} KB` }));
          item.addEventListener("click", () => {
            current = open ? null : { doc, page: 1 };
            picked = null;
            void render();
          });
          list.append(el("li", {}, item));
        }
        parts.push(section(`Attached (${wb.documents.length})`, list));

        // the open document
        if (current) {
          const { doc } = current;
          const viewer = el("div", { className: "dc-viewer" });
          const { row, col } = d.cell();
          const cellName = `${columnLetter(col)}${row + 1}`;
          const existing = wb.get(d.activeSheet()).source.extraAt(row, col)?.evidence;
          const shown = existing?.doc === doc.sha256 && existing.page === current.page ? existing.region : undefined;
          const width = Math.max(240, (p.body.clientWidth || 360) - 34);
          const hint = el("p", { className: "tk-muted", textContent: `Draw a box round the figure that supports ${cellName} (the selected cell).` });
          if (doc.type === "application/pdf") {
            let pages: PdfPage[] | null = null;
            try {
              pages = await pdfPages(store, doc.sha256);
            } catch (e) {
              viewer.append(notice((e as Error).message, "danger"));
            }
            if (mine !== gen) return;
            if (pages) {
              const page = pages[current.page - 1];
              const prev = iconButton("chevron-left", "Previous page", { onClick: () => ((current!.page--), void render()) });
              const next = iconButton("chevron-right", "Next page", { onClick: () => ((current!.page++), void render()) });
              prev.disabled = current.page <= 1;
              next.disabled = current.page >= pages.length;
              viewer.append(el("div", { className: "dc-nav" }, prev, el("span", { textContent: `Page ${current.page} of ${pages.length}` }), next));
              if (!page.items.length) viewer.append(notice("This page has no text (a scan?). Box the area anyway to link it; it can't be checked automatically.", "info"));
              const view = pdfPageView(page, width);
              viewer.append(view, hint);
              regionPicker(view, (r) => {
                picked = r;
                hint.textContent = `Boxed: ${regionText(page, r).replace(/\n/g, " · ") || "(no text)"}`;
                link.disabled = false;
              }, shown);
            }
          } else if (doc.type.startsWith("image/")) {
            const bytes = await documentBytes(store, doc.sha256);
            if (mine !== gen) return;
            const box = el("div", { className: "doc-page doc-image" });
            box.style.width = `${width}px`;
            if (bytes) box.append(el("img", { src: URL.createObjectURL(new Blob([bytes as BlobPart], { type: doc.type })), alt: doc.name }));
            viewer.append(box, hint);
            regionPicker(box, (r) => {
              picked = r;
              hint.textContent = "Area boxed.";
              link.disabled = false;
            }, shown);
          } else viewer.append(notice("This kind of file can't be shown here.", "info"));

          const link = button(`Link ${cellName} to this`, async () => {
            const target: EvidenceLink = { doc: doc.sha256, page: current!.page, ...(picked ? { region: picked } : {}) };
            await d.run({ type: "evidence.link", params: { row, col, link: target } });
            const r = await checkLink(store, wb.documents, target, wb.get(d.activeSheet()).source.getCell(row, col));
            if (r.status === "agrees") report(d.status, `Linked ${cellName}: the document shows the same figure (${r.found?.join(", ")}).`);
            else if (r.status === "differs") report(d.status, `Linked ${cellName}, but the document shows ${r.found?.join(", ")}. Check the figure.`, "warning");
            else report(d.status, `Linked ${cellName} to ${doc.name}.`);
          }, "primary");
          link.disabled = !picked && !shown;
          link.title = link.disabled ? "Box the figure first" : "";
          parts.push(section(doc.name, viewer, el("div", { className: "tk-panel-actions" }, link)));
        }

        // check every link on this sheet
        const checkBtn = button("Check this sheet's evidence links", () => void checkAll(), "secondary", "check");
        parts.push(section("Check the links", el("p", { className: "tk-muted", textContent: "Compares every linked cell on this sheet with the figure boxed in its document." }), checkBtn, checked ?? el("div")));
        p.body.replaceChildren(...parts);
      }

      async function checkAll() {
        const wb = d.workbook();
        const sheetId = d.activeSheet();
        const src = wb.get(sheetId).source;
        const links = src.allExtras().filter((e) => e.extra.evidence);
        type Row = { cell: string; status: string; row: number; col: number; bad: boolean };
        const rows: Row[] = [];
        for (const l of links) {
          const r = await checkLink(store!, wb.documents, l.extra.evidence!, src.getCell(l.row, l.col));
          const words = { agrees: "Agrees with the document", differs: `Differs: the document shows ${r.found?.join(", ") ?? "?"}`, "no number": "No number in the boxed area", "not checkable": "Linked (not a text PDF area, so not checked)" }[r.status];
          rows.push({ cell: `${columnLetter(l.col)}${l.row + 1}`, status: words, row: l.row, col: l.col, bad: r.status === "differs" || r.status === "no number" });
        }
        const bad = rows.filter((r) => r.bad).length;
        checked = el(
          "div",
          { className: "dc-check" },
          headline({ value: `${rows.length - bad} of ${rows.length}`, unit: "links agree", tone: bad ? "mismatch" : "match", progress: rows.length ? (rows.length - bad) / rows.length : 0, caption: rows.length ? (bad ? `${bad} cell${bad === 1 ? "" : "s"} don't match the figure in the document.` : "Every linked cell matches its document.") : "No cell on this sheet is linked to a document yet." }),
          rows.length
            ? renderTable<Row>({
                columns: [
                  { key: "cell", label: "Cell", width: "4em" },
                  { key: "status", label: "Result" },
                ],
                rows,
                onRowClick: goTo ? (r) => goTo(sheetId, r.row, r.col) : undefined,
                maxHeight: "30vh",
              }).element
            : el("div"),
        );
        void render();
      }

      void render();
    },
  });
}
