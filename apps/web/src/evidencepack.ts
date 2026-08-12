/** Saving and verifying an evidence pack (a .zip). */
import { unzip, zip, zipText } from "@cellforge/core";
import { summary, verifyLog, type Evidence, type LogEntry } from "./evidence";
import { packWorkbook, toFile } from "./persist";
import type { Workbook } from "./workbook";
import { changedSince } from "./review";
import { documentBytes, type DocBytes } from "./docstore";

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Sheets with their workpaper references, sign-offs (and changes since) and open review notes. */
function reviewSection(wb: Workbook): string {
  const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const rows = wb.sheets.map((sh) => {
    const r = wb.review.sheets[sh.id] ?? {};
    const sign = (role: "prepared" | "reviewed") => {
      const x = r[role];
      if (!x) return "—";
      const n = changedSince(x, wb.evidence.log, sh.name);
      return `${x.by}, ${when(x.at)}${n ? ` (changed since: ${n})` : ""}`;
    };
    return `| ${r.ref ?? ""} | ${sh.name} | ${sign("prepared")} | ${sign("reviewed")} | ${sh.source.openReviewNotes().length} |`;
  });
  return ["", "", "## Workpapers", "", "| Ref | Sheet | Prepared | Reviewed | Open review notes |", "|---|---|---|---|---:|", ...rows, ""].join("\n");
}

/** The supporting documents, under documents/ (missing ones listed in documents/MISSING.txt). */
async function documentFiles(wb: Workbook, docs: DocBytes | null): Promise<[string, string | Uint8Array][]> {
  if (!wb.documents.length) return [];
  const out: [string, string | Uint8Array][] = [];
  const missing: string[] = [];
  const used = new Set<string>();
  for (const d of wb.documents) {
    const bytes = docs ? await documentBytes(docs, d.sha256) : null;
    if (!bytes) {
      missing.push(`${d.name} (SHA-256 ${d.sha256})`);
      continue;
    }
    let file = d.name.replace(/[\\/:*?"<>|]/g, "_");
    while (used.has(file.toLowerCase())) file = "_" + file;
    used.add(file.toLowerCase());
    out.push([`documents/${file}`, bytes]);
  }
  if (missing.length) out.push(["documents/MISSING.txt", `Not in this browser's storage, so not included:\n${missing.join("\n")}\n`]);
  return out;
}

/** The pack's files: the workbook, recipes, inputs, log and a readable summary. */
export async function evidenceFiles(wb: Workbook, active: string, name: string, docs: DocBytes | null = null): Promise<[string, string | Uint8Array][]> {
  const verified = await verifyLog(wb.evidence.log);
  const book = toFile(packWorkbook(wb, active, name));
  return [
    ["SUMMARY.md", summary(name, wb.evidence, wb.recipes, verified) + reviewSection(wb)],
    ["log.json", JSON.stringify(wb.evidence.log, null, 1)],
    ["inputs.json", JSON.stringify(wb.evidence.inputs, null, 1)],
    ["recipes.json", JSON.stringify(wb.recipes, null, 1)],
    [`${name}.cellforge`, new Uint8Array(await book.arrayBuffer())],
    ...(await documentFiles(wb, docs)),
  ];
}

export async function saveEvidencePack(wb: Workbook, name: string, status: (t: string) => void, docs: DocBytes | null = null): Promise<void> {
  status("Making the evidence pack…");
  const active = wb.sheets.find((s) => !s.hidden)?.id ?? wb.sheets[0].id;
  const bytes = await zip(await evidenceFiles(wb, active, name, docs));
  download(new Blob([bytes as BlobPart], { type: "application/zip" }), `${name} evidence ${new Date().toISOString().slice(0, 10)}.zip`);
  status(`Saved the evidence pack: ${wb.evidence.log.length} log entries, ${wb.evidence.inputs.length} input file${wb.evidence.inputs.length === 1 ? "" : "s"}`);
}

/** Check a pack: the log's chain, and list what it says went in. */
export async function verifyPack(bytes: Uint8Array): Promise<{ ok: boolean; message: string; evidence: Evidence }> {
  const files = await unzip(bytes);
  const logText = zipText(files.get("log.json"));
  if (!logText) return { ok: false, message: "This isn't an evidence pack (there's no log.json in it).", evidence: { log: [], inputs: [] } };
  const log = JSON.parse(logText) as LogEntry[];
  const inputs = JSON.parse(zipText(files.get("inputs.json")) || "[]") as Evidence["inputs"];
  const v = await verifyLog(log);
  return {
    ok: v.ok,
    message: v.ok ? `The log's ${log.length} entries are intact (last hash ${v.head.slice(0, 16)}…).` : `The log has been changed: ${v.reason}.`,
    evidence: { log, inputs },
  };
}

export function openVerifyPack(_wb: Workbook, status: (t: string) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    let result;
    try {
      result = await verifyPack(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      status(`Couldn't read ${f.name}: ${(e as Error).message}`);
      return;
    }
    const back = document.createElement("div");
    back.className = "palette-backdrop";
    back.innerHTML = `<div class="palette import-dialog" role="dialog"><div class="palette-form"><h3></h3><p></p><div class="import-preview"></div><div class="numfmt-actions"><button type="button">Close</button></div></div></div>`;
    back.querySelector("h3")!.textContent = `Evidence pack: ${f.name}`;
    const p = back.querySelector("p")!;
    p.textContent = result.message;
    if (!result.ok) p.className = "cleanup-warn";
    const t = document.createElement("table");
    t.className = "cleanup-cols";
    t.innerHTML = "<tr><th>Input file</th><th>Size</th><th>SHA-256</th></tr>";
    for (const i of result.evidence.inputs) {
      const tr = document.createElement("tr");
      for (const v of [i.name, i.size.toLocaleString(), i.sha256 + (i.sampled ? " (sampled)" : "")]) tr.append(Object.assign(document.createElement("td"), { textContent: v }));
      t.append(tr);
    }
    if (!result.evidence.inputs.length) t.append(Object.assign(document.createElement("tr"), { innerHTML: "<td colspan=3>No input files were recorded.</td>" }));
    back.querySelector(".import-preview")!.append(t);
    back.querySelector("button")!.addEventListener("click", () => back.remove());
    back.addEventListener("keydown", (e) => e.key === "Escape" && back.remove());
    document.body.append(back);
    back.querySelector("button")!.focus();
  });
  input.click();
}
