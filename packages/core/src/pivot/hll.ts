/**
 * HyperLogLog distinct-count estimate: 2^p one-byte registers (16 KB at the
 * default p = 14) give about 0.8% standard error at any count. Used by the
 * column profile once a column has too many distinct numbers to count exactly.
 */

/** 32-bit finaliser from MurmurHash3. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** Hash of a number's bits (0 and -0 hash the same). */
export function hashNumber(x: number): number {
  f64[0] = x === 0 ? 0 : x;
  return mix32(u32[0] ^ mix32(u32[1] + 0x9e3779b9));
}

/** FNV-1a over UTF-16 code units, then mixed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

export class HyperLogLog {
  readonly registers: Uint8Array;
  private readonly p: number;

  constructor(p = 14) {
    this.p = p;
    this.registers = new Uint8Array(1 << p);
  }

  /** Add a 32-bit hash. */
  add(hash: number): void {
    const idx = hash >>> (32 - this.p);
    const rest = (hash << this.p) | (1 << (this.p - 1)); // guard bit so clz32 stays in range
    const rank = Math.clz32(rest) + 1;
    if (rank > this.registers[idx]) this.registers[idx] = rank;
  }

  addNumber(x: number): void {
    this.add(hashNumber(x));
  }

  addString(s: string): void {
    this.add(hashString(s));
  }

  merge(other: HyperLogLog): void {
    const a = this.registers;
    const b = other.registers;
    for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i];
  }

  estimate(): number {
    const m = this.registers.length;
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < m; i++) {
      const r = this.registers[i];
      sum += 2 ** -r;
      if (!r) zeros++;
    }
    const alpha = 0.7213 / (1 + 1.079 / m);
    const e = (alpha * m * m) / sum;
    // small range: linear counting is more accurate
    if (e <= 2.5 * m && zeros) return Math.round(m * Math.log(m / zeros));
    return Math.round(e);
  }
}
