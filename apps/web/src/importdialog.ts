/**
 * Before a CSV opens: what was detected (encoding, delimiter), the first
 * rows as they'll come in, and the options to change that.
 */
import { previewCsv, type CsvOptions, type Encoding } from "@cellforge/core";

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
    back.className = "palette-backdrop";
    back.innerHTML = `
      <div class="palette import-dialog" role="dialog" aria-label="Open a text file">
        <form class="palette-form">
          <h3></h3>
          <div class="import-options">
            <label>Delimiter<select class="opt-delim">${DELIMS.map(([v, t]) => `<option value="${v === "\t" ? "tab" : v}">${t}</option>`).join("")}</select></label>
            <label>Encoding<select class="opt-enc">${ENCODINGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>
            <label>Skip rows at the top<input class="opt-skip" type="number" min="0" value="0" /></label>
            <label class="opt-check"><input class="opt-header" type="checkbox" checked /> First row has the column names</label>
          </div>
          <p class="hp-muted import-detected"></p>
          <div class="import-preview"></div>
          <div class="numfmt-actions"><button type="button" data-act="cancel">Cancel</button><button type="submit">Open</button></div>
        </form>
      </div>`;
    document.body.append(back);
    back.querySelector("h3")!.textContent = `Open ${file.name}`;
    const $ = <T extends HTMLElement>(s: string) => back.querySelector(s) as T;
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

    const render = () => {
      const p = previewCsv(head, options());
      const dName = DELIMS.find(([v]) => v === p.delimiter)?.[1] ?? JSON.stringify(p.delimiter);
      detected.textContent = `Reading it as ${ENCODINGS.find(([v]) => v === p.encoding)?.[1] ?? p.encoding}, split by ${dName.toLowerCase()}.`;
      const table = document.createElement("table");
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

    const done = (v: CsvOptions | null) => {
      back.remove();
      resolve(v);
    };
    back.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      done(options());
    });
    back.querySelector("[data-act=cancel]")!.addEventListener("click", () => done(null));
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
    (back.querySelector("button[type=submit]") as HTMLButtonElement).focus();
  });
}
