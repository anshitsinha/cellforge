/**
 * Before a CSV opens: what was detected (encoding, delimiter), the first
 * rows as they'll come in, and the options to change that.
 */
import { previewCsv, type CsvOptions, type Encoding } from "@cellforge/core";
import { openDialog } from "./ui/dialog";
import "./toolkit.css";

const DELIMS: [string, string][] = [
  ["", "Detect"],
  [",", "Comma ,"],
  [";", "Semicolon ;"],
  ["\t", "Tab"],
  ["|", "Bar |"],
];
const ENCODINGS: [Encoding | "", string][] = [
  ["", "Detect"],
  ["utf-8", "UTF-8"],
  ["windows-1252", "Windows (Western)"],
  ["utf-16le", "UTF-16"],
];

/** Ask how to read a CSV; resolves with the options, or null if cancelled. */
export async function askCsvOptions(file: File): Promise<CsvOptions | null> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.innerHTML = `
          <div class="tk-grid import-options-grid">
            <label class="tk-field"><span class="tk-field__label">Delimiter</span><select class="opt-delim">${DELIMS.map(([v, t]) => `<option value="${v === "\t" ? "tab" : v}">${t}</option>`).join("")}</select></label>
            <label class="tk-field"><span class="tk-field__label">Encoding</span><select class="opt-enc">${ENCODINGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
            <label class="tk-field"><span class="tk-field__label">Skip rows at the top</span><input class="opt-skip" type="number" min="0" value="0" /></label>
            <label class="tk-check"><input class="opt-header" type="checkbox" checked /> First row has the column names</label>
          </div>
          <p class="tk-muted import-detected"></p>
          <div class="table-wrap import-preview"></div>`;
    const $ = <T extends HTMLElement>(sel: string) => back.querySelector(sel) as T;
    const delim = $<HTMLSelectElement>(".opt-delim");
    const encSel = $<HTMLSelectElement>(".opt-enc");
    const skip = $<HTMLInputElement>(".opt-skip");
    const header = $<HTMLInputElement>(".opt-header");
    const detected = $<HTMLElement>(".import-detected");
    const preview = $<HTMLElement>(".import-preview");

    const options = (): CsvOptions => ({
      ...(delim.value ? { delimiter: delim.value === "tab" ? "\t" : delim.value } : {}),
      ...(encSel.value ? { encoding: encSel.value as Encoding } : {}),
      skipRows: Math.max(0, Number(skip.value) || 0),
      header: header.checked,
    });

    // what Detect found, passed on so the import splits the file the same way
    // (ties go to the locale's delimiter: ";" where the comma is the decimal)
    let detectedDelimiter = ",";
    const render = () => {
      const p = previewCsv(head, options());
      detectedDelimiter = p.delimiter;
      const dName = DELIMS.find(([v]) => v === p.delimiter)?.[1] ?? JSON.stringify(p.delimiter);
      detected.textContent = `Reading it as ${ENCODINGS.find(([v]) => v === p.encoding)?.[1] ?? p.encoding}, split by ${dName.toLowerCase()}.`;
      const table = document.createElement("table");
      table.className = "data-table data-table--dense";
      p.rows.slice(0, 10).forEach((row, i) => {
        const tr = document.createElement("tr");
        for (const cell of row.slice(0, 12)) {
          const td = document.createElement(i === 0 && header.checked ? "th" : "td");
          td.textContent = cell;
          tr.append(td);
        }
        table.append(tr);
      });
      preview.replaceChildren(table);
    };
    for (const el of [delim, encSel, skip, header]) el.addEventListener("input", render);
    render();

    let answer: CsvOptions | null = null;
    const dlg = openDialog({
      title: `Open ${file.name}`,
      subtitle: "Check how the file splits into columns",
      size: "lg",
      body: [...back.childNodes],
      actions: [
        { label: "Cancel", dismiss: true },
        {
          label: "Open",
          kind: "primary",
          onClick: () => {
            const o = options();
            answer = o.delimiter ? o : { ...o, delimiter: detectedDelimiter };
          },
        },
      ],
      initialFocus: "primary",
    });
    void dlg.closed.then((r) => resolve(r === "dismiss" ? null : answer));
  });
}
