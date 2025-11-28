/// <reference lib="webworker" />
import { ColumnBuilder, CsvParser, detectDelimiter, transferablesOf } from "@cellforge/core";

/**
 * Parses a CSV file off the main thread and posts the finished columns back.
 *
 * Reads the File as a byte stream and decodes incrementally, so memory use is
 * roughly "the parsed columns" rather than "the whole file as one string" -
 * that matters once files get into the GBs.
 */

export type ImportMessage =
  | { type: "progress"; bytes: number; total: number; rows: number }
  | { type: "done"; columns: import("@cellforge/core").ColumnData[]; ms: number }
  | { type: "error"; message: string };

const PROGRESS_INTERVAL_MS = 150;

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  try {
    await importFile(e.data.file);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function importFile(file: File): Promise<void> {
  const started = performance.now();
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");

  let builders: ColumnBuilder[] | null = null;
  let rows = 0;
  let parser: CsvParser | null = null;

  const onRow = (fields: string[]) => {
    if (!builders) {
      // first record is the header. blank header names get spreadsheet-ish
      // fallbacks so the grid always has something to show
      builders = fields.map((name, i) => new ColumnBuilder(name.trim() || `column_${i + 1}`));
      return;
    }
    // a row with more fields than the header grows the table; older rows get
    // padded with blanks so every column stays the same length
    while (fields.length > builders.length) {
      const extra = new ColumnBuilder(`column_${builders.length + 1}`);
      extra.padTo(rows);
      builders.push(extra);
    }
    for (let c = 0; c < builders.length; c++) {
      builders[c].push(c < fields.length ? fields[c] : "");
    }
    rows++;
  };

  let bytes = 0;
  let lastProgress = 0;
  let first = true;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    let text = decoder.decode(value, { stream: true });

    if (first) {
      first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Excel's UTF-8 BOM
      parser = new CsvParser(onRow, detectDelimiter(text.slice(0, 64 * 1024)));
    }
    parser!.push(text);

    const now = performance.now();
    if (now - lastProgress > PROGRESS_INTERVAL_MS) {
      lastProgress = now;
      post({ type: "progress", bytes, total: file.size, rows });
    }
  }

  if (!parser) throw new Error("The file is empty.");
  parser.push(decoder.decode());
  parser.end();
  if (!builders) throw new Error("No header row found.");

  const columns = (builders as ColumnBuilder[]).map((b) => b.finish());
  self.postMessage(
    { type: "done", columns, ms: performance.now() - started } satisfies ImportMessage,
    transferablesOf(columns),
  );
}

function post(msg: ImportMessage) {
  self.postMessage(msg);
}
