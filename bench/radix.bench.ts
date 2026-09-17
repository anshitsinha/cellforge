// Quick timing for the radix sort vs a comparator sort.
// Run with: npx vite-node bench/radix.bench.ts  (or tsx)
import { radixSortIndices } from "../packages/core/src/radix";

const N = Number(process.argv[2] ?? 20_000_000);
const keys = new Float64Array(N);
for (let i = 0; i < N; i++) keys[i] = Math.round((Math.random() - 0.5) * 1e6) / 100;

const copy = keys.slice();
let t = performance.now();
radixSortIndices(copy, null, false);
const radixMs = performance.now() - t;

// comparator sort on an index array - what sort.ts did before
const idx = new Uint32Array(N);
for (let i = 0; i < N; i++) idx[i] = i;
t = performance.now();
idx.sort((a, b) => keys[a] - keys[b]);
const cmpMs = performance.now() - t;

console.log(`${N.toLocaleString()} rows`);
console.log(`radix:      ${radixMs.toFixed(0)} ms`);
console.log(`comparator: ${cmpMs.toFixed(0)} ms (${(cmpMs / radixMs).toFixed(1)}x slower)`);
