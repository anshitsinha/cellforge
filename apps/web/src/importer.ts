import { Table } from "@cellforge/core";
import type { ImportMessage } from "./workers/import.worker";

export interface ImportProgress {
  bytes: number;
  total: number;
  rows: number;
}

/**
 * Parse a CSV in a worker. A fresh worker per import keeps things simple and
 * means a cancelled/failed import can't leave state behind.
 */
export function importCsv(
  file: File,
  onProgress: (p: ImportProgress) => void,
): { result: Promise<{ table: Table; ms: number }>; cancel: () => void } {
  const worker = new Worker(new URL("./workers/import.worker.ts", import.meta.url), {
    type: "module",
  });

  let reject!: (err: Error) => void;
  const result = new Promise<{ table: Table; ms: number }>((res, rej) => {
    reject = rej;
    worker.onmessage = (e: MessageEvent<ImportMessage>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        onProgress(msg);
      } else if (msg.type === "done") {
        worker.terminate();
        res({ table: new Table(msg.columns), ms: msg.ms });
      } else {
        worker.terminate();
        rej(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || "Import failed"));
    };
  });

  worker.postMessage({ file });

  return {
    result,
    cancel: () => {
      worker.terminate();
      reject(new Error("Import cancelled"));
    },
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
