/**
 * Sharing safely: what a workbook holds that the person you send it to
 * might not expect (hidden sheets and rows, notes, links, personal data, and
 * the history only a .cellforge file carries); a password-protected export;
 * and clearing everything cellforge keeps in this browser.
 */
import { scanPii } from "@cellforge/core";
import type { Workbook } from "./workbook";

export interface ShareFinding {
  /** what kind of thing */
  kind: "hidden sheet" | "hidden rows" | "hidden columns" | "notes" | "review notes" | "links" | "personal data" | "history" | "versions" | "names" | "formulas";
  /** plain description */
  text: string;
  /** which file types carry it */
  carriedBy: ("cellforge" | "xlsx" | "csv")[];
  sheetId?: string;
}

/** Everything a recipient could find in the workbook beyond what's on screen. */
export function shareCheck(wb: Workbook, opts: { piiRows?: number } = {}): ShareFinding[] {
  const out: ShareFinding[] = [];
  for (const s of wb.sheets) {
    const src = s.source;
    if (s.hidden) out.push({ kind: "hidden sheet", text: `"${s.name}" is hidden but still in the file.`, carriedBy: ["cellforge", "xlsx"], sheetId: s.id });
    const hiddenRows = src.hiddenRowIntervals().reduce((n, [a, b]) => n + b - a + 1, 0);
    const filtered = src.filter ? src.filteredRowIds.length : 0;
    if (hiddenRows) {
      out.push({
        kind: "hidden rows",
        text: `"${s.name}" has ${hiddenRows.toLocaleString()} hidden row${hiddenRows === 1 ? "" : "s"}${filtered ? ` (${filtered.toLocaleString()} hidden by a filter)` : ""}; their data is still in the file.`,
        carriedBy: ["cellforge", "xlsx"],
        sheetId: s.id,
      });
    }
    const hiddenCols = [...src.hiddenColumns].length;
    if (hiddenCols) out.push({ kind: "hidden columns", text: `"${s.name}" has ${hiddenCols} hidden column${hiddenCols === 1 ? "" : "s"}.`, carriedBy: ["cellforge", "xlsx"], sheetId: s.id });
    const extras = src.allExtras();
    const notes = extras.filter((x) => x.extra.note).length;
    const reviews = extras.filter((x) => x.extra.review).length;
    const links = extras.filter((x) => x.extra.link && !x.extra.link.startsWith("#")).length;
    if (notes) out.push({ kind: "notes", text: `"${s.name}" has ${notes} note${notes === 1 ? "" : "s"}.`, carriedBy: ["cellforge", "xlsx"], sheetId: s.id });
    if (reviews) out.push({ kind: "review notes", text: `"${s.name}" has ${reviews} review note${reviews === 1 ? "" : "s"} (cleared ones too).`, carriedBy: ["cellforge"], sheetId: s.id });
    if (links) out.push({ kind: "links", text: `"${s.name}" has ${links} link${links === 1 ? "" : "s"} to web addresses.`, carriedBy: ["cellforge", "xlsx"], sheetId: s.id });
    const fc = src.formulaCells();
    const formulas = fc.cells.length + fc.fills.length;
    if (formulas) out.push({ kind: "formulas", text: `"${s.name}" has formulas; they show how numbers were worked out (CSV keeps only results).`, carriedBy: ["cellforge", "xlsx"], sheetId: s.id });
    // personal data: scan the first rows of each column
    const { rows, cols } = src.usedRange();
    const take = Math.min(rows, opts.piiRows ?? 2000);
    const columns = Array.from({ length: Math.min(cols, 200) }, (_, c) => ({
      name: src.getColumnName(c) ?? (typeof src.getCell(0, c) === "string" ? String(src.getCell(0, c)) : ""),
      values: Array.from({ length: take }, (_, r) => src.getCell(r, c)),
    }));
    const pii = scanPii(columns).filter((p) => p.kind);
    if (pii.length) {
      out.push({
        kind: "personal data",
        text: `"${s.name}" looks like it holds personal data: ${pii.map((p) => `${p.name || `column ${p.col + 1}`} (${p.kind})`).join(", ")}. "PII scan and safe copy…" can mask it.`,
        carriedBy: ["cellforge", "xlsx", "csv"],
        sheetId: s.id,
      });
    }
  }
  if (wb.definedNames.length) out.push({ kind: "names", text: `${wb.definedNames.length} defined name${wb.definedNames.length === 1 ? "" : "s"}.`, carriedBy: ["cellforge", "xlsx"] });
  if (wb.evidence.log.length) {
    out.push({
      kind: "history",
      text: `The action log has ${wb.evidence.log.length.toLocaleString()} entries, including values that were later changed or deleted.`,
      carriedBy: ["cellforge"],
    });
  }
  if (wb.versions.length) out.push({ kind: "versions", text: `${wb.versions.length} saved version${wb.versions.length === 1 ? "" : "s"}, each a full copy of the workbook at that point.`, carriedBy: ["cellforge"] });
  return out;
}

// ------------------------------------------------------- password-protected files --

const MAGIC = new TextEncoder().encode("CFENC1");
const ITERATIONS = 310_000;

async function keyFrom(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a file's bytes with a password: "CFENC1" + salt (16) + iv (12) + AES-GCM ciphertext. */
export async function encryptFile(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes as BufferSource));
  const out = new Uint8Array(MAGIC.length + 16 + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + 16);
  out.set(ct, MAGIC.length + 28);
  return out;
}

export function isEncrypted(bytes: Uint8Array): boolean {
  return bytes.length > MAGIC.length + 28 && MAGIC.every((b, i) => bytes[i] === b);
}

export async function decryptFile(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (!isEncrypted(bytes)) throw new Error("This file isn't password-protected.");
  const salt = bytes.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = bytes.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const key = await keyFrom(password, salt);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, bytes.subarray(MAGIC.length + 28) as BufferSource));
  } catch {
    throw new Error("That password doesn't open this file.");
  }
}

// ------------------------------------------------------------ local data --

/** Remove everything cellforge keeps in this browser: autosaves, versions, the journal, settings. */
export async function clearLocalData(store: { list(): Promise<string[]>; remove(name: string): Promise<void> } | null): Promise<number> {
  let removed = 0;
  if (store) {
    for (const name of await store.list()) {
      await store.remove(name);
      removed++;
    }
  }
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("cellforge")) {
        localStorage.removeItem(k);
        removed++;
      }
    }
  } catch {
    // storage blocked: nothing kept there anyway
  }
  try {
    for (const k of await caches.keys()) {
      if (k.startsWith("cellforge")) {
        await caches.delete(k);
        removed++;
      }
    }
  } catch {
    // no Cache API (tests, old browsers)
  }
  return removed;
}
