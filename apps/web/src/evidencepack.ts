/** Saving and verifying an evidence pack (a .zip). */
import { unzip, zip, zipText } from "@cellforge/core";
import { summary, verifyLog, type Evidence, type LogEntry } from "./evidence";
import { packWorkbook, toFile } from "./persist";
import type { Workbook } from "./workbook";
import { changedSince } from "./review";
import { documentBytes, type DocBytes } from "./docstore";
import "./evidence.css";
import { count, el, headline, notice, plural, report, section } from "./toolkit";
import { openDialog } from "./ui/dialog";
import { renderTable } from "./ui/table";


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

/** What a pack will hold, for the summary before saving. Pure apart from the hash check. */
export async function packSummary(wb: Workbook): Promise<{ entries: number; ok: boolean; head: string; reason?: string; inputs: number; recipes: number; documents: number; sheets: number; reviewed: number; openNotes: number }> {
  const v = await verifyLog(wb.evidence.log);
  const visible = wb.sheets;
  return {
    entries: wb.evidence.log.length,
    ok: v.ok,
    head: v.head,
    reason: v.reason,
    inputs: wb.evidence.inputs.length,
    recipes: wb.recipes.length,
    documents: wb.documents.length,
    sheets: visible.length,
    reviewed: visible.filter((s) => wb.review.sheets[s.id]?.reviewed).length,
    openNotes: visible.reduce((t, s) => t + s.source.openReviewNotes().length, 0),
  };
}

/** Show what goes in the pack, then save it (a .zip download) when asked. */
export async function saveEvidencePack(wb: Workbook, name: string, status: (t: string) => void, docs: DocBytes | null = null): Promise<void> {
  const s = await packSummary(wb);
  const fileName = `${name} evidence ${new Date().toISOString().slice(0, 10)}.zip`;
  const lines = [
    { label: "Change log", value: `${count(s.entries)} entries` },
    { label: "Input files fingerprinted", value: count(s.inputs) },
    { label: "Supporting documents", value: count(s.documents) },
    { label: "Recipes (repeatable steps)", value: count(s.recipes) },
    { label: "Sheets reviewed", value: `${s.reviewed} of ${s.sheets}`, tone: s.reviewed === s.sheets ? ("match" as const) : undefined },
    { label: "Open review notes", value: s.openNotes ? count(s.openNotes) : "None", tone: s.openNotes ? ("mismatch" as const) : undefined },
  ];
  const body: Node[] = [
    headline({
      value: s.ok ? "Intact" : "Broken",
      unit: s.ok ? "change log, hash-chained" : "change log",
      tone: s.ok ? "match" : "mismatch",
      caption: s.ok ? "Every change since the workbook was opened is in the log, each entry chained to the one before by SHA-256. Anyone can check the pack later with Verify an evidence pack." : `The log doesn't check out: ${s.reason}.`,
      lines,
    }),
    el("div", { className: "ev-hash" }, el("span", { className: "tk-muted", textContent: "Last hash" }), el("code", { textContent: s.head })),
    el("p", { className: "tk-muted", textContent: `The pack (${fileName}) holds the workbook, a readable SUMMARY.md with the sign-offs, log.json, inputs.json, recipes.json${s.documents ? " and the documents" : ""}. It's made on this computer; nothing is uploaded.` }),
  ];
  if (s.openNotes) body.splice(1, 0, notice(`${plural(s.openNotes, "review note")} still open. The pack lists them; you may want to clear them first.`, "warning"));
  const dlg = openDialog({
    title: "Save an evidence pack",
    subtitle: name,
    size: "md",
    body,
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: "Save evidence pack",
        kind: "primary",
        icon: "download",
        onClick: async () => {
          const active = wb.sheets.find((x) => !x.hidden)?.id ?? wb.sheets[0].id;
          const bytes = await zip(await evidenceFiles(wb, active, name, docs));
          download(new Blob([bytes as BlobPart], { type: "application/zip" }), fileName);
          report(status, `Saved the evidence pack: ${plural(s.entries, "log entry", "log entries")}, ${plural(s.inputs, "input file")}`);
        },
      },
    ],
  });
  await dlg.closed;
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
    const inputs = result.evidence.inputs;
    openDialog({
      title: "Verify an evidence pack",
      subtitle: f.name,
      size: "lg",
      body: [
        headline({
          value: result.ok ? "Intact" : "Tampered",
          unit: result.ok ? `${plural(result.evidence.log.length, "log entry", "log entries")} check out` : "the log has been changed",
          tone: result.ok ? "match" : "mismatch",
          caption: result.message,
        }),
        section(
          "Input files recorded",
          renderTable<(typeof inputs)[number]>({
            columns: [
              { key: "name", label: "File" },
              { key: "size", label: "Bytes", format: "integer" },
              { key: "sha256", label: "SHA-256", format: (v, r) => `${String(v).slice(0, 16)}…${r.sampled ? " (sampled)" : ""}`, title: (r) => r.sha256 },
            ],
            rows: inputs,
            empty: "No input files were recorded.",
            maxHeight: "40vh",
          }).element,
        ),
      ],
      actions: [{ label: "Done", kind: "primary", dismiss: true }],
    });
  });
  input.click();
}
