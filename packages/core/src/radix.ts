/**
 * Stable LSD radix sort of row indices by a numeric key, for sorting columns
 * with tens of millions of rows.
 *
 * A comparison sort (`Uint32Array.prototype.sort` with a comparator) on 100M
 * rows makes billions of JS callback calls. Radix sort instead makes a fixed
 * number of linear passes: each 64-bit float key is turned into an unsigned
 * integer with the same ordering, then the indices are bucketed 16 bits at a
 * time (4 passes), plus one pass on a small "kind" byte that puts numbers,
 * text and blanks in the right groups.
 *
 * Memory: the key buffer is rewritten in place, plus two Uint32Arrays of
 * indices (8 bytes per row).
 *
 * @param keys   one float per row. Overwritten (it's turned into sortable bits).
 * @param kinds  per-row group, sorted *after* the key so it ends up the
 *               primary order. 0 sorts first.
 * @param descending reverses key order (kinds are not reversed - the caller
 *               picks kind values so e.g. blanks stay last either way)
 */
export function radixSortIndices(
  keys: Float64Array,
  kinds: Uint8Array | null,
  descending: boolean,
  onProgress?: (fraction: number) => void,
): Uint32Array {
  const n = keys.length;
  // view the doubles as pairs of 32-bit words (little endian: [lo, hi])
  const words = new Uint32Array(keys.buffer, keys.byteOffset, n * 2);

  // Standard trick: flip the sign bit for positives, flip every bit for
  // negatives. The resulting unsigned 64-bit ints sort the same as the floats.
  // For descending we flip all bits once more.
  for (let i = 0; i < n; i++) {
    let hi = words[2 * i + 1];
    let lo = words[2 * i];
    if (hi & 0x80000000) {
      hi = ~hi;
      lo = ~lo;
    } else {
      hi |= 0x80000000;
    }
    if (descending) {
      hi = ~hi;
      lo = ~lo;
    }
    words[2 * i + 1] = hi >>> 0;
    words[2 * i] = lo >>> 0;
  }

  let idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  let tmp = new Uint32Array(n);
  const counts = new Uint32Array(65536);

  // (word, shift) for each 16-bit digit, least significant first
  const passes: [number, number][] = [
    [0, 0],
    [0, 16],
    [1, 0],
    [1, 16],
  ];
  const totalPasses = passes.length + (kinds ? 1 : 0);
  let done = 0;

  for (const [w, shift] of passes) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(words[2 * i + w] >>> shift) & 0xffff]++;
    // every key has the same digit here -> this pass wouldn't change anything
    if (counts[(words[w] >>> shift) & 0xffff] === n) {
      onProgress?.(++done / totalPasses);
      continue;
    }
    // counts -> starting offsets
    let sum = 0;
    for (let d = 0; d < 65536; d++) {
      const c = counts[d];
      counts[d] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const e = idx[i];
      tmp[counts[(words[2 * e + w] >>> shift) & 0xffff]++] = e;
    }
    [idx, tmp] = [tmp, idx];
    onProgress?.(++done / totalPasses);
  }

  if (kinds) {
    const kc = new Uint32Array(256);
    for (let i = 0; i < n; i++) kc[kinds[i]]++;
    if (kc[kinds[0]] !== n) {
      let sum = 0;
      for (let d = 0; d < 256; d++) {
        const c = kc[d];
        kc[d] = sum;
        sum += c;
      }
      for (let i = 0; i < n; i++) {
        const e = idx[i];
        tmp[kc[kinds[e]]++] = e;
      }
      [idx, tmp] = [tmp, idx];
    }
    onProgress?.(1);
  }

  return idx;
}
