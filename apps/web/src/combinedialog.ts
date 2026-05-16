/**
 * Combine files: pick a folder (or several files), see how their columns
 * line up, rename or merge columns, then add one sheet with every row.
 */
import type { Action } from "@cellforge/actions";
import { alignColumns, columnKey, combineParts, Table, type AlignedColumn, type FilePart } from "@cellforge/core";
import { COMBINABLE, readPart } from "./combine";
import { EditableSource } from "./editable";

export interface CombineDeps {
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

interface DirHandle {
  name: string;
  values(): AsyncIterable<{ kind: string; name: string; getFile?: () => Promise<File> }>;
}

/** Ask for a folder (where the browser can) or for files. */
export async function pickFiles(folder: boolean): Promise<{ files: File[]; label: string } | null> {
  const w = window as unknown as { showDirectoryPicker?: () => Promise<DirHandle> };
  if (folder && w.showDirectoryPicker) {
    let dir: DirHandle;
    try {
      dir = await w.showDirectoryPicker();
    } catch {
      return null; // cancelled
    }
    const files: File[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && COMBINABLE.test(entry.name) && entry.getFile) files.push(await entry.getFile());
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { files, label: dir.name };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (folder) input.setAttribute("webkitdirectory", "");
    input.accept = ".csv,.tsv,.txt,.xlsx,.xlsm,.json,.jsonl,.ndjson,.parquet";
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])].filter((f) => COMBINABLE.test(f.name));
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      resolve(files.length ? { files, label: folder ? (files[0].webkitRelativePath.split("/")[0] || "Combined") : "Combined" } : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export async function openCombine(d: CombineDeps, folder: boolean): Promise<void> {
  const picked = await pickFiles(folder);
  if (!picked) return;
  if (!picked.files.length) {
    d.status("No CSV, Excel, JSON or Parquet files in that folder.");
    return;
  }
  const parts: FilePart[] = [];
  const failed: string[] = [];
  for (const [i, f] of picked.files.entries()) {
    d.status(`Reading ${f.name} (${i + 1} of ${picked.files.length})…`);
    try {
      parts.push(await readPart(f));
    } catch (e) {
      failed.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  d.status("Ready");
  if (!parts.length) {
    d.status(`Couldn't read any of the files. ${failed[0] ?? ""}`);
    return;
  }
  showAlignment(d, parts, failed, picked.label);
}

export function showAlignment(d: CombineDeps, parts: FilePart[], failed: string[], label: string): void {
  const renames: Record<string, string> = {};
  const names = new Map<string, string>(); // key -> name chosen for the result
  const headers = parts.map((p) => p.columns.map((c) => c.name));
  let aligned: AlignedColumn[] = alignColumns(headers, renames);

  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog" role="dialog" aria-label="Combine files"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const h = document.createElement("h3");
  h.textContent = `Combine ${parts.length} file${parts.length === 1 ? "" : "s"}`;
  const summary = document.createElement("p");
  const wrap = document.createElement("div");
  wrap.className = "import-preview";
  const note = document.createElement("p");
  note.className = "hp-muted";
  note.textContent =
    "Columns are matched by name, ignoring case, spaces and punctuation. Give two columns the same name to merge them. A \"source file\" column says where each row came from.";
  body.append(h, summary, wrap, note);
  if (failed.length) {
    const bad = document.createElement("p");
    bad.className = "cleanup-warn";
    bad.textContent = `Couldn't read: ${failed.join("; ")}`;
    body.append(bad);
  }

  const render = () => {
    const rows = parts.reduce((n, p) => n + (p.columns[0] ? (p.columns[0].kind === "number" ? p.columns[0].values.length : p.columns[0].codes.length) : 0), 0);
    const partial = aligned.filter((a) => a.from.some((c) => c === null)).length;
    summary.textContent =
      `${rows.toLocaleString()} rows, ${aligned.length} columns.` +
      (partial ? ` ${partial} column${partial === 1 ? " is" : "s are"} only in some files (blank for the others).` : " Every file has every column.");
    const table = document.createElement("table");
    table.className = "cleanup-cols";
    const head = document.createElement("tr");
    head.innerHTML = "<th>Column in the result</th>";
    for (const p of parts) {
      const th = document.createElement("th");
      th.textContent = p.name;
      head.append(th);
    }
    table.append(head);
    for (const a of aligned) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = names.get(a.key) ?? a.name;
      input.setAttribute("aria-label", `Name for ${a.name}`);
      input.addEventListener("change", () => {
        const name = input.value.trim();
        if (!name) {
          input.value = names.get(a.key) ?? a.name;
          return;
        }
        // naming it like another column merges the two
        const other = aligned.find((x) => x !== a && (columnKey(names.get(x.key) ?? x.name) === columnKey(name)));
        if (other && !a.key.includes("#")) {
          renames[a.key] = other.key;
          aligned = alignColumns(headers, renames);
        } else names.set(a.key, name);
        render();
      });
      td.append(input);
      tr.append(td);
      a.from.forEach((c, f) => {
        const cell = document.createElement("td");
        if (c === null) {
          cell.textContent = "—";
          cell.className = "cleanup-warn";
          cell.title = "This file hasn't got this column";
        } else cell.textContent = parts[f].columns[c].name;
        tr.append(cell);
      });
      table.append(tr);
    }
    wrap.replaceChildren(table);
  };
  render();

  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  actions.innerHTML = `<button type="button" data-act="cancel">Cancel</button><button type="button" data-act="ok">Combine</button>`;
  body.append(actions);
  const close = () => {
    back.remove();
    d.focusGrid();
  };
  actions.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "cancel") close();
    else if (act === "ok") {
      back.remove();
      const final = aligned.map((a) => ({ ...a, name: names.get(a.key) ?? a.name }));
      const { columns, numFmts } = combineParts(parts, final);
      const table = new Table(columns);
      const source = new EditableSource(table, 10);
      void d
        .run({ type: "sheet.insert", params: { name: label, source: d.putBlob(source), numFmts: numFmts.map((f) => f ?? "") } })
        .then(() => {
          d.status(`Combined ${parts.length} files: ${table.rowCount.toLocaleString()} rows`);
          d.focusGrid();
        });
    }
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(back);
  actions.querySelector<HTMLButtonElement>("[data-act=ok]")!.focus();
}
