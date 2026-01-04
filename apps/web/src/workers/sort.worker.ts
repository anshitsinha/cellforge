/// <reference lib="webworker" />
import { radixSortIndices } from "@cellforge/core";

export type SortRequest = { keys: Float64Array; kinds: Uint8Array; descending: boolean };
export type SortMessage =
  | { type: "progress"; fraction: number }
  | { type: "done"; order: Uint32Array; ms: number };

// The main thread only extracts keys; the actual sorting (the O(n) passes over
// up to 100M rows) happens here so the page keeps scrolling meanwhile.
self.onmessage = (e: MessageEvent<SortRequest>) => {
  const { keys, kinds, descending } = e.data;
  const started = performance.now();
  const order = radixSortIndices(keys, kinds, descending, (fraction) =>
    self.postMessage({ type: "progress", fraction } satisfies SortMessage),
  );
  self.postMessage(
    { type: "done", order, ms: performance.now() - started } satisfies SortMessage,
    [order.buffer],
  );
};
