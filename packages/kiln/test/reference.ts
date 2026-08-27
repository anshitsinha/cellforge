// A deliberately plain float reference for the llama forward pass: whole
// sequence at once, no KV cache, float64 everywhere, rotary embedding
// written as complex multiplication. Used to check the real implementation.
import type { TinyModel } from "./tiny";

export function referenceLogits(m: TinyModel, tokens: number[], ropeStyle: "norm" | "neox" = m.cfg.arch === "qwen2" ? "neox" : "norm"): Float64Array[] {
  const { dim, nLayers, nHeads, nKvHeads, ffnDim, vocab, headDim, normEps, ropeBase } = m.cfg;
  const W = (name: string) => {
    const w = m.floats.get(name);
    if (!w) throw new Error(`no ${name}`);
    return w;
  };
  const n = tokens.length;
  const linear = (x: Float64Array, w: Float32Array, outDim: number, inDim: number, bias?: Float32Array) => {
    const y = new Float64Array(outDim);
    for (let o = 0; o < outDim; o++) {
      let s = bias ? bias[o]! : 0;
      for (let i = 0; i < inDim; i++) s += w[o * inDim + i]! * x[i]!;
      y[o] = s;
    }
    return y;
  };
  const rms = (x: Float64Array, w: Float32Array) => {
    let ss = 0;
    for (const v of x) ss += v * v;
    const r = 1 / Math.sqrt(ss / x.length + normEps);
    return x.map((v, i) => v * r * w[i]!);
  };
  const rope = (v: Float64Array, heads: number, pos: number) => {
    const out = new Float64Array(v);
    for (let h = 0; h < heads; h++) {
      for (let i = 0; i < headDim / 2; i++) {
        const theta = pos / Math.pow(ropeBase, (2 * i) / headDim);
        const [ia, ib] = ropeStyle === "norm" ? [h * headDim + 2 * i, h * headDim + 2 * i + 1] : [h * headDim + i, h * headDim + i + headDim / 2];
        // (re + i*im) * (cos + i*sin)
        const re = v[ia]!, im = v[ib]!;
        out[ia] = re * Math.cos(theta) - im * Math.sin(theta);
        out[ib] = re * Math.sin(theta) + im * Math.cos(theta);
      }
    }
    return out;
  };
  const emb = W("token_embd.weight");
  let X = tokens.map((t) => Float64Array.from(emb.subarray(t * dim, (t + 1) * dim)));
  const qDim = nHeads * headDim, kvDim = nKvHeads * headDim;
  for (let l = 0; l < nLayers; l++) {
    const p = `blk.${l}.`;
    const H = X.map((x) => rms(x, W(p + "attn_norm.weight")));
    const Q = H.map((h, pos) => rope(linear(h, W(p + "attn_q.weight"), qDim, dim, m.floats.get(p + "attn_q.bias")), nHeads, pos));
    const K = H.map((h, pos) => rope(linear(h, W(p + "attn_k.weight"), kvDim, dim, m.floats.get(p + "attn_k.bias")), nKvHeads, pos));
    const V = H.map((h) => linear(h, W(p + "attn_v.weight"), kvDim, dim, m.floats.get(p + "attn_v.bias")));
    X = X.map((x, pos) => {
      const att = new Float64Array(qDim);
      for (let h = 0; h < nHeads; h++) {
        const kvh = Math.floor((h * nKvHeads) / nHeads);
        const s: number[] = [];
        for (let t = 0; t <= pos; t++) {
          let d = 0;
          for (let i = 0; i < headDim; i++) d += Q[pos]![h * headDim + i]! * K[t]![kvh * headDim + i]!;
          s.push(d / Math.sqrt(headDim));
        }
        const mx = Math.max(...s);
        const e = s.map((v) => Math.exp(v - mx));
        const z = e.reduce((a, b) => a + b, 0);
        for (let t = 0; t <= pos; t++) for (let i = 0; i < headDim; i++) att[h * headDim + i] += (e[t]! / z) * V[t]![kvh * headDim + i]!;
      }
      const o = linear(att, W(p + "attn_output.weight"), dim, qDim);
      const x2 = x.map((v, i) => v + o[i]!);
      const h2 = rms(x2, W(p + "ffn_norm.weight"));
      const g = linear(h2, W(p + "ffn_gate.weight"), ffnDim, dim);
      const u = linear(h2, W(p + "ffn_up.weight"), ffnDim, dim);
      const act = g.map((v, i) => (v / (1 + Math.exp(-v))) * u[i]!);
      const d = linear(act, W(p + "ffn_down.weight"), dim, ffnDim);
      return x2.map((v, i) => v + d[i]!);
    });
    void n;
  }
  const out = m.cfg.tied ? emb : W("output.weight");
  return X.map((x) => linear(rms(x, W("output_norm.weight")), out, vocab, dim));
}
