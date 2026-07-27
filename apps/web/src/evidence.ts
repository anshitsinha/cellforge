/**
 * Evidence: what was done to a workbook and what went into it, in a form a
 * reviewer can check.
 *
 * - The action log: every change (and undo, redo, open, import) with its
 *   time, sheet and description, each entry's SHA-256 covering its content
 *   and the previous entry's hash. Changing or removing an entry breaks the
 *   chain from there on, which verify() reports.
 * - Input fingerprints: SHA-256 of every file opened, imported or combined.
 * - The evidence pack: one .zip with the workbook, its recipes, the
 *   fingerprints, the log and a readable summary.
 */
import type { Action } from "@cellforge/actions";

export interface LogEntry {
  i: number;
  at: number;
  kind: "run" | "undo" | "redo" | "open" | "import" | "recipe";
  label: string;
  sheet?: string;
  /** the action, as applied (blob ids inside refer to the session they ran in) */
  action?: Action;
  prev: string;
  hash: string;
}

export interface Fingerprint {
  name: string;
  size: number;
  sha256: string;
  at: number;
  kind: "open" | "import" | "combine" | "statement" | "recipe input";
  /** very big files: hashed from their first and last 64 MB plus their size */
  sampled?: boolean;
}

export interface Evidence {
  log: LogEntry[];
  inputs: Fingerprint[];
}

const GENESIS = "0".repeat(64);
const SAMPLE = 64 * 1024 * 1024;
const WHOLE_UP_TO = 512 * 1024 * 1024;

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with keys in a fixed order, so the same entry always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

const body = (e: Omit<LogEntry, "hash">) => canonical({ i: e.i, at: e.at, kind: e.kind, label: e.label, sheet: e.sheet, action: e.action, prev: e.prev });

/** Add an entry to the log, chained to the last one. */
export async function appendLog(log: LogEntry[], entry: Pick<LogEntry, "kind" | "label" | "sheet" | "action"> & { at?: number }): Promise<LogEntry> {
  const prev = log.length ? log[log.length - 1].hash : GENESIS;
  const e: Omit<LogEntry, "hash"> = { i: log.length, at: entry.at ?? Date.now(), kind: entry.kind, label: entry.label, prev, ...(entry.sheet ? { sheet: entry.sheet } : {}), ...(entry.action ? { action: entry.action } : {}) };
  const full: LogEntry = { ...e, hash: await sha256Hex(body(e)) };
  log.push(full);
  return full;
}

/** Check the chain: every entry's hash matches its content and the one before. */
export async function verifyLog(log: readonly LogEntry[]): Promise<{ ok: boolean; brokenAt?: number; reason?: string; head: string }> {
  let prev = GENESIS;
  for (const [n, e] of log.entries()) {
    if (e.i !== n) return { ok: false, brokenAt: n, reason: `entry ${n + 1} is numbered ${e.i + 1}: an entry was removed or moved`, head: prev };
    if (e.prev !== prev) return { ok: false, brokenAt: n, reason: `entry ${n + 1} doesn't follow the one before it`, head: prev };
    const h = await sha256Hex(body(e));
    if (h !== e.hash) return { ok: false, brokenAt: n, reason: `entry ${n + 1} was changed after it was written`, head: prev };
    prev = e.hash;
  }
  return { ok: true, head: prev };
}

/** A file's fingerprint (whole-file SHA-256 up to 512 MB; sampled above that). */
export async function fingerprint(file: Blob & { name: string }, kind: Fingerprint["kind"]): Promise<Fingerprint> {
  let sampled = false;
  let bytes: Uint8Array;
  if (file.size <= WHOLE_UP_TO) bytes = new Uint8Array(await file.arrayBuffer());
  else {
    sampled = true;
    const head = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer());
    const tail = new Uint8Array(await file.slice(file.size - SAMPLE).arrayBuffer());
    const size = new TextEncoder().encode(String(file.size));
    bytes = new Uint8Array(head.length + tail.length + size.length);
    bytes.set(head, 0);
    bytes.set(tail, head.length);
    bytes.set(size, head.length + tail.length);
  }
  return { name: file.name, size: file.size, sha256: await sha256Hex(bytes), at: Date.now(), kind, ...(sampled ? { sampled: true } : {}) };
}

const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** The readable summary that goes in the pack. */
export function summary(name: string, ev: Evidence, recipes: { name: string; steps: { label: string; enabled: boolean }[] }[], verified: { ok: boolean; reason?: string; head: string }): string {
  const lines = [
    `# Evidence pack: ${name}`,
    "",
    `Made ${when(Date.now())} with cellforge, on this computer (nothing was uploaded).`,
    "",
    "## Inputs",
    "",
    ev.inputs.length ? "| File | Size | SHA-256 | When | How |\n|---|---:|---|---|---|" : "No files were opened or imported in this workbook's recorded history.",
    ...ev.inputs.map((f) => `| ${f.name} | ${f.size.toLocaleString("en")} bytes | \`${f.sha256}\`${f.sampled ? " (sampled)" : ""} | ${when(f.at)} | ${f.kind} |`),
    "",
    "## Action log",
    "",
    `${ev.log.length} entries. Chain ${verified.ok ? "intact" : `BROKEN: ${verified.reason}`}. Last hash: \`${verified.head}\`.`,
    "",
    ...ev.log.slice(-200).map((e) => `${e.i + 1}. ${when(e.at)}: ${e.kind === "run" ? "" : `${e.kind}: `}${e.label}${e.sheet ? ` (${e.sheet})` : ""}`),
    ...(ev.log.length > 200 ? ["", `(the last 200 of ${ev.log.length} entries; all are in log.json)`] : []),
    "",
    "## Recipes",
    "",
    ...(recipes.length ? recipes.flatMap((r) => [`### ${r.name}`, "", ...r.steps.map((s, i) => `${i + 1}. ${s.label}${s.enabled ? "" : " (switched off)"}`), ""]) : ["None saved."]),
    "",
    "## Checking this pack",
    "",
    "Open cellforge, choose **Verify an evidence pack…** and pick this file: it re-checks the log's hash chain and lists the input fingerprints. To check an input, compute its SHA-256 (for example `certutil -hashfile file SHA256` on Windows or `shasum -a 256 file` on a Mac) and compare.",
  ];
  return lines.join("\n");
}
