/**
 * Searching the user guide on the computer: pages are split into passages
 * at their headings, ranked with BM25 (with light stemming and the words
 * finance people use for the same thing), and each passage knows which
 * palette commands it names, so an answer can offer to run them.
 */

export interface Passage {
  /** page title, then the heading the passage sits under */
  page: string;
  heading: string;
  /** the page's file, for linking */
  file: string;
  text: string;
  /** palette command titles named in bold, e.g. "Reconcile two sheets…" */
  commands: string[];
}

export interface Hit {
  passage: Passage;
  score: number;
  /** the best sentence or two, for showing */
  snippet: string;
}

/** Words that mean the same thing to someone looking for help. */
const SYNONYMS: Record<string, string[]> = {
  rec: ["reconcile", "reconciliation", "match"],
  reconcile: ["reconciliation", "match", "rec"],
  match: ["reconcile", "matching"],
  dupe: ["duplicate"],
  duplicate: ["dupe", "double", "repeated"],
  gl: ["ledger", "general"],
  ledger: ["gl", "cash", "book"],
  tb: ["trial", "balance"],
  vlookup: ["xlookup", "lookup"],
  xlookup: ["vlookup", "lookup"],
  lookup: ["xlookup", "vlookup"],
  macro: ["recipe", "record", "replay"],
  recipe: ["macro", "record"],
  comment: ["note"],
  note: ["comment"],
  hyperlink: ["link"],
  merge: ["combine", "join", "append"],
  combine: ["merge", "append", "folder"],
  join: ["merge", "lookup"],
  pdf: ["statement"],
  statement: ["pdf", "bank"],
  dropdown: ["validation", "list"],
  validation: ["dropdown", "allowed"],
  pivot: ["summarise", "summary", "group"],
  summarise: ["pivot", "group", "total"],
  sample: ["sampling", "pick"],
  benford: ["digit"],
  gap: ["sequence", "missing"],
  highlight: ["conditional", "colour", "format"],
  colour: ["color", "fill", "highlight"],
  color: ["colour"],
  undo: ["history"],
  history: ["undo", "version", "log"],
  password: ["encrypt", "protect"],
  private: ["privacy", "personal", "pii"],
  pii: ["personal", "privacy", "mask"],
  chart: ["graph", "plot"],
  graph: ["chart"],
  checkbox: ["tick", "box"],
  tick: ["mark", "checkbox"],
  signoff: ["sign", "review"],
  evidence: ["document", "attach", "support"],
};

const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it its me my of on or that the this to what when where which who why will with you your".split(" "),
);

/** A crude English stemmer: enough that "reconciling", "reconciled" and "reconciles" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  for (const [suffix, repl] of [
    ["ations", "ate"],
    ["ation", "ate"],
    ["ies", "y"],
    ["ied", "y"],
    ["ing", ""],
    ["edly", ""],
    ["ed", ""],
    ["es", ""],
    ["s", ""],
    ["ly", ""],
  ] as const) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length) + repl;
      break;
    }
  }
  return w.replace(/e$/, "");
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t)).map(stem);
}

/** Split a markdown page into passages at its ## and ### headings. */
export function passagesOf(file: string, markdown: string): Passage[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const title = (lines.find((l) => l.startsWith("# ")) ?? file).replace(/^#\s+/, "");
  const out: Passage[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) {
      const commands = [...text.matchAll(/\*\*([^*]+?…)\*\*/g)].map((m) => m[1]);
      out.push({ page: title, heading, file, text, commands: [...new Set(commands)] });
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1] === "#" ? "" : m[2];
    } else buf.push(line);
  }
  flush();
  return out;
}

export class DocIndex {
  private readonly docs: { passage: Passage; terms: Map<string, number>; length: number }[] = [];
  private readonly df = new Map<string, number>();
  private avgLength = 1;

  constructor(passages: readonly Passage[]) {
    for (const passage of passages) {
      // the heading and page title count extra: they say what the passage is about
      const words = [...tokens(passage.text), ...tokens(passage.heading), ...tokens(passage.heading), ...tokens(passage.page)];
      const terms = new Map<string, number>();
      for (const w of words) terms.set(w, (terms.get(w) ?? 0) + 1);
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ passage, terms, length: words.length });
    }
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / (this.docs.length || 1);
  }

  get size(): number {
    return this.docs.length;
  }

  /** The best passages for a question (BM25, synonyms counted at half weight). */
  search(question: string, limit = 5): Hit[] {
    const asked = tokens(question);
    if (!asked.length) return [];
    const weights = new Map<string, number>();
    for (const t of asked) {
      weights.set(t, Math.max(weights.get(t) ?? 0, 1));
      for (const syn of SYNONYMS[t] ?? []) {
        const s = stem(syn);
        weights.set(s, Math.max(weights.get(s) ?? 0, 0.5));
      }
    }
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored: Hit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const [t, w] of weights) {
        const tf = d.terms.get(t);
        if (!tf) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += w * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / this.avgLength)));
      }
      if (score > 0) scored.push({ passage: d.passage, score, snippet: snippet(d.passage.text, weights) });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, limit);
  }
}

/** The sentence(s) with the most of the asked words. */
function snippet(text: string, weights: Map<string, number>): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: just their text
    .replace(/[*`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.split(/(?<=[.!?:])\s+/);
  let best = 0;
  let bestScore = -1;
  sentences.forEach((s, i) => {
    const sc = tokens(s).reduce((n, t) => n + (weights.get(t) ?? 0), 0);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  });
  const out = sentences.slice(best, best + 2).join(" ");
  return out.length > 320 ? out.slice(0, 317) + "…" : out;
}

/** Function reference entries as passages, so "how do I look up a value" finds XLOOKUP. */
type FnInfo = { name: string; summary: string; args: readonly { name: string; description: string }[] };
export function functionPassages(info: readonly FnInfo[] | Record<string, FnInfo>): Passage[] {
  return (Array.isArray(info) ? info : Object.values(info)).map((f: FnInfo) => ({
    page: "Functions",
    heading: f.name,
    file: "functions",
    text: `${f.name}(${f.args.map((a) => a.name).join(", ")}): ${f.summary} ${f.args.map((a) => `${a.name}: ${a.description}.`).join(" ")}`,
    commands: [],
  }));
}
