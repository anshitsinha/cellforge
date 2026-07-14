import type { CellValue, DataSource } from "@cellforge/grid";

const ROWS_PER_CHUNK = 20_000;

/** Quote a field only when it has to be (delimiter, quote or newline in it). */
export function csvField(value: CellValue): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize the sheet to CSV in chunks, yielding to the event loop between
 * them so the page stays responsive and progress can be shown.
 *
 * Output is a list of string parts rather than one giant string - Blob
 * accepts an array, and V8 has a max string length (~512MB) we'd hit on big
 * sheets otherwise.
 */
export async function exportCsv(
  source: DataSource,
  rows: number,
  cols: number,
  includeHeader: boolean,
  onProgress: (done: number) => void,
): Promise<Blob> {
  const parts: string[] = [];

  if (includeHeader) {
    const names: string[] = [];
    for (let c = 0; c < cols; c++) names.push(csvField(source.getColumnName?.(c) ?? ""));
    parts.push(names.join(",") + "\n");
  }

  for (let start = 0; start < rows; start += ROWS_PER_CHUNK) {
    const end = Math.min(rows, start + ROWS_PER_CHUNK);
    let chunk = "";
    for (let r = start; r < end; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        if (c > 0) line += ",";
        line += csvField(source.getCell(r, c));
      }
      chunk += line + "\n";
    }
    parts.push(chunk);
    onProgress(end);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // give the browser a moment to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
