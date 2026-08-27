/**
 * Kiln: tokenizer + model backend + sampler + grammar, behind the small
 * interface packages/ai expects:
 *
 *   interface ProposalModel { propose(prompt: string, grammar?: JsonSchema | null): Promise<string> }
 *
 * The KV cache is kept between calls and the longest common token prefix of
 * the previous context is reused, so a tool loop that re-sends a long system
 * prompt only pays for the new tail.
 */
import { parseGGUF, type GGUFFile } from "./gguf";
import { JsonGrammar, TokenMasker, type GrammarState, type JsonSchema } from "./grammar";
import { Model, type Backend } from "./model";
import { makeRng, sample, type SampleOptions } from "./sample";
import { Tokenizer } from "./tokenizer";
import { WebGpuBackend } from "./webgpu";

export interface ProposalModel {
  propose(prompt: string, grammar?: JsonSchema | null): Promise<string>;
}

export interface GenerateOptions extends SampleOptions {
  /** default 256 */
  maxTokens?: number;
  /** constrain the output to JSON matching this schema */
  schema?: JsonSchema | null;
  seed?: number;
  /** free generation only: stop when any of these strings appears */
  stop?: readonly string[];
  /** prepend BOS (default: tokenizer setting) */
  addBos?: boolean;
  /** called with each new piece of text */
  onText?: (piece: string) => void;
}

export interface GenerateResult {
  text: string;
  tokens: number[];
  promptTokens: number;
  /** prompt tokens served from the KV cache */
  reusedTokens: number;
  finish: "eos" | "stop" | "grammar" | "length";
  /** tokens forced by the grammar's completion at the end of the budget */
  forcedTokens: number;
  prefillMs: number;
  decodeMs: number;
  tokensPerSecond: number;
}

export interface LoadOptions {
  backend?: "auto" | "cpu" | "webgpu";
  /** KV cache size in tokens (default min(model context, 4096)) */
  contextLength?: number;
}

export class Kiln implements ProposalModel {
  /** token ids currently in the backend's KV cache */
  private history: number[] = [];
  private lastLogits: Float32Array | null = null;
  private masker: TokenMasker | null = null;
  /** default options for propose() */
  proposeOptions: GenerateOptions = { maxTokens: 256, temperature: 0 };

  constructor(
    readonly tokenizer: Tokenizer,
    readonly backend: Backend,
  ) {}

  static async load(input: ArrayBuffer | Uint8Array | GGUFFile, opts: LoadOptions = {}): Promise<Kiln> {
    const f = input instanceof ArrayBuffer || input instanceof Uint8Array ? parseGGUF(input) : input;
    const model = Model.fromGGUF(f);
    const tokenizer = Tokenizer.fromGGUF(f);
    const ctx = opts.contextLength ?? Math.min(model.config.contextLength, 4096);
    let backend: Backend | null = null;
    if (opts.backend !== "cpu") backend = await WebGpuBackend.create(model.config, model.weights, ctx);
    if (!backend && opts.backend === "webgpu") throw new Error("kiln: WebGPU is not available");
    return new Kiln(tokenizer, backend ?? model.cpu(ctx));
  }

  async propose(prompt: string, grammar?: JsonSchema | null): Promise<string> {
    const r = await this.generate(prompt, { ...this.proposeOptions, schema: grammar ?? null });
    return grammar ? r.text.trim() : r.text;
  }

  /** Clear the KV cache. */
  reset() {
    this.history = [];
    this.lastLogits = null;
    this.backend.truncate(0);
  }

  private async feed(ids: readonly number[]): Promise<Float32Array> {
    let logits = this.lastLogits;
    for (const id of ids) {
      logits = await this.backend.forward(id);
      this.history.push(id);
    }
    this.lastLogits = logits;
    return logits!;
  }

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
    const tk = this.tokenizer;
    const promptIds = tk.encode(prompt, { addBos: opts.addBos });
    if (promptIds.length === 0) throw new Error("kiln: empty prompt");
    const capacity = this.capacity();
    let maxTokens = opts.maxTokens ?? 256;

    // reuse the cached prefix; always re-run at least the last prompt token
    let common = 0;
    while (common < this.history.length && common < promptIds.length && this.history[common] === promptIds[common]) common++;
    if (common === promptIds.length) common--;
    this.backend.truncate(common);
    this.history.length = common;
    if (promptIds.length + 1 > capacity) throw new Error(`kiln: prompt of ${promptIds.length} tokens does not fit the ${capacity}-token context`);
    maxTokens = Math.min(maxTokens, capacity - promptIds.length);

    const t0 = performance.now();
    let logits = await this.feed(promptIds.slice(common));
    const t1 = performance.now();

    const rng = makeRng(opts.seed ?? 1234);
    const out: number[] = [];
    let finish: GenerateResult["finish"] = "length";
    let forced = 0;
    const emit = (ids: number[]) => {
      if (opts.onText) opts.onText(new TextDecoder().decode(tk.decodeBytes(ids)));
    };

    if (opts.schema) {
      const g = new JsonGrammar(opts.schema);
      const masker = (this.masker ??= new TokenMasker(tk));
      let st: GrammarState = g.initial();
      const need = g.completion(st);
      if (!need) throw new Error("kiln: the schema has no valid value");
      maxTokens = Math.max(maxTokens, Math.min(need.length, capacity - promptIds.length));
      for (let i = 0; ; i++) {
        if (g.isDone(st)) {
          finish = "grammar";
          break;
        }
        const remaining = maxTokens - i;
        const comp = g.completion(st)!;
        if (remaining <= 0 || comp.length >= remaining) {
          forced = this.forceBytes(comp, out, emit);
          finish = "grammar";
          break;
        }
        // near the budget, only allow tokens after which the document still fits
        const tight = comp.length + 64 >= remaining - 1 ? remaining - 1 : Infinity;
        const { mask, next } = masker.mask(g, st, tight);
        const stop = g.canStop(st);
        if (stop) for (const e of tk.eog) mask[e] = 1;
        const tok = sample(logits, opts, rng, mask, out);
        if (tok < 0) {
          forced = this.forceBytes(comp, out, emit);
          finish = "grammar";
          break;
        }
        if (stop && tk.eog.has(tok)) {
          finish = "eos";
          break;
        }
        st = next.get(tok)!;
        out.push(tok);
        emit([tok]);
        if (g.isDone(st)) {
          finish = "grammar";
          break;
        }
        logits = await this.feed([tok]);
      }
    } else {
      let text = "";
      for (let i = 0; i < maxTokens; i++) {
        const tok = sample(logits, opts, rng, null, out);
        if (tk.eog.has(tok)) {
          finish = "eos";
          break;
        }
        out.push(tok);
        emit([tok]);
        if (opts.stop?.length) {
          text = new TextDecoder().decode(tk.decodeBytes(out));
          if (opts.stop.some((s) => text.includes(s))) {
            finish = "stop";
            break;
          }
        }
        if (i + 1 < maxTokens) logits = await this.feed([tok]);
      }
    }
    const t2 = performance.now();
    let text = new TextDecoder().decode(tk.decodeBytes(out));
    if (finish === "stop" && opts.stop) {
      const cut = Math.min(...opts.stop.map((s) => text.indexOf(s)).filter((i) => i >= 0));
      text = text.slice(0, cut);
    }
    const generated = out.length - forced;
    return {
      text,
      tokens: out,
      promptTokens: promptIds.length,
      reusedTokens: common,
      finish,
      forcedTokens: forced,
      prefillMs: t1 - t0,
      decodeMs: t2 - t1,
      tokensPerSecond: generated > 0 && t2 > t1 ? (generated / (t2 - t1)) * 1000 : 0,
    };
  }

  private forceBytes(bytes: Uint8Array, out: number[], emit: (ids: number[]) => void): number {
    const ids: number[] = [];
    for (const b of bytes) {
      const id = this.tokenizer.byteToken(b);
      if (id < 0) throw new Error(`kiln: vocabulary has no token for byte 0x${b.toString(16)}`);
      ids.push(id);
    }
    out.push(...ids);
    if (ids.length) emit(ids);
    // the forced tokens were never run through the model: the cache ends at the last sampled token
    return ids.length;
  }

  private capacity(): number {
    return this.backend.capacity;
  }
}
