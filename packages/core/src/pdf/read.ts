/**
 * Reading the text of a PDF, with where each piece sits on the page. Enough
 * of PDF for statements and reports exported by banks and accounting
 * systems: objects and object streams, Flate-compressed streams, fonts with
 * ToUnicode maps (or simple encodings), and the text operators. Scanned
 * PDFs (pictures of text) have no text to read.
 */

export interface TextItem {
  x: number;
  /** distance from the top of the page */
  y: number;
  /** where the text ends */
  x2: number;
  text: string;
  size: number;
}

export interface PdfPage {
  width: number;
  height: number;
  items: TextItem[];
}

// ----------------------------------------------------------------- objects --

type PdfValue = number | boolean | null | string | PdfName | PdfRef | PdfValue[] | PdfDict | PdfStream;
class PdfName {
  constructor(readonly name: string) {}
}
class PdfRef {
  constructor(readonly num: number) {}
}
type PdfDict = Map<string, PdfValue>;
interface PdfStream {
  dict: PdfDict;
  raw: Uint8Array;
}
/** A string is kept as the bytes it holds (one char per byte), since fonts decide what they mean. */

const isStream = (v: PdfValue | undefined): v is PdfStream => typeof v === "object" && v !== null && "raw" in (v as object);
const isDict = (v: PdfValue | undefined): v is PdfDict => v instanceof Map;

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

class Lexer {
  pos: number;
  constructor(
    readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }

  skipWs(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        // % comment
        while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
      } else break;
    }
  }

  /** The next token as a value, or an operator/keyword as { op }. */
  next(): PdfValue | { op: string } | undefined {
    this.skipWs();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos];
    if (c === "/") {
      let e = this.pos + 1;
      while (e < s.length && !WS.has(s.charCodeAt(e)) && !DELIM.has(s.charCodeAt(e))) e++;
      const raw = s.slice(this.pos + 1, e).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.pos = e;
      return new PdfName(raw);
    }
    if (c === "(") return this.literal();
    if (c === "<") {
      if (s[this.pos + 1] === "<") {
        this.pos += 2;
        return this.dict();
      }
      const e = s.indexOf(">", this.pos);
      let hex = s.slice(this.pos + 1, e).replace(/[^0-9a-f]/gi, "");
      if (hex.length % 2) hex += "0";
      this.pos = e + 1;
      let out = "";
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return out;
    }
    if (c === "[") {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (this.s[this.pos] === "]") {
          this.pos++;
          return arr;
        }
        const v = this.value();
        if (v === undefined) return arr;
        arr.push(v);
      }
    }
    if (c === "]" || c === ">" || c === "{" || c === "}") {
      this.pos++;
      return { op: c };
    }
    let e = this.pos;
    while (e < s.length && !WS.has(s.charCodeAt(e)) && !DELIM.has(s.charCodeAt(e))) e++;
    if (e === this.pos) e++;
    const word = s.slice(this.pos, e);
    this.pos = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  }

  /** A value, with "N G R" read as a reference. */
  value(): PdfValue | undefined {
    const v = this.next();
    if (v === undefined) return undefined;
    if (typeof v === "number" && Number.isInteger(v)) {
      const save = this.pos;
      const g = this.next();
      if (typeof g === "number" && Number.isInteger(g)) {
        const r = this.next();
        if (r && typeof r === "object" && "op" in r && r.op === "R") return new PdfRef(v);
      }
      this.pos = save;
      return v;
    }
    if (v && typeof v === "object" && "op" in v) return null;
    return v as PdfValue;
  }

  dict(): PdfDict {
    const d: PdfDict = new Map();
    for (;;) {
      this.skipWs();
      if (this.s.startsWith(">>", this.pos)) {
        this.pos += 2;
        return d;
      }
      const k = this.next();
      if (!(k instanceof PdfName)) {
        if (k === undefined) return d;
        continue;
      }
      const v = this.value();
      if (v === undefined) return d;
      d.set(k.name, v);
    }
  }

  literal(): string {
    const s = this.s;
    let depth = 0;
    let out = "";
    let i = this.pos + 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        const n = s[++i];
        if (n === "n") out += "\n";
        else if (n === "r") out += "\r";
        else if (n === "t") out += "\t";
        else if (n === "b") out += "\b";
        else if (n === "f") out += "\f";
        else if (n === "\r") {
          if (s[i + 1] === "\n") i++;
        } else if (n === "\n") {
          /* line continuation */
        } else if (n >= "0" && n <= "7") {
          let oct = n;
          while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else out += n;
      } else if (c === "(") {
        depth++;
        out += c;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
        out += c;
      } else out += c;
    }
    this.pos = i + 1;
    return out;
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

const toBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const run = async (format: "deflate" | "deflate-raw") => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format) as unknown as TransformStream<Uint8Array, Uint8Array>);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await run("deflate");
  } catch {
    return run("deflate-raw").catch(() => new Uint8Array(0));
  }
}

class PdfFile {
  private readonly objects = new Map<number, PdfValue>();
  private readonly decoded = new Map<PdfStream, Promise<string>>();

  constructor(readonly text: string) {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let m; (m = re.exec(text)); ) {
      const lx = new Lexer(text, m.index + m[0].length);
      let v = lx.value();
      if (v === undefined) continue;
      lx.skipWs();
      if (isDict(v) && text.startsWith("stream", lx.pos)) {
        let start = lx.pos + 6;
        if (text[start] === "\r") start++;
        if (text[start] === "\n") start++;
        const len = v.get("Length");
        let end = typeof len === "number" && text.startsWith("endstream", skipEol(text, start + len)) ? start + len : -1;
        if (end < 0) {
          end = text.indexOf("endstream", start);
          if (end < 0) continue;
          if (text[end - 1] === "\n") end--;
          if (text[end - 1] === "\r") end--;
        }
        v = { dict: v, raw: toBytes(text.slice(start, end)) };
        re.lastIndex = end;
      }
      this.objects.set(Number(m[1]), v);
    }
  }

  /** Objects packed inside object streams (PDF 1.5+). */
  async loadObjectStreams(): Promise<void> {
    for (const v of [...this.objects.values()]) {
      if (!isStream(v) || (v.dict.get("Type") as PdfName | undefined)?.name !== "ObjStm") continue;
      const body = await this.decode(v);
      const n = this.get(v.dict.get("N")) as number;
      const first = this.get(v.dict.get("First")) as number;
      const head = new Lexer(body);
      const entries: [number, number][] = [];
      for (let i = 0; i < n; i++) entries.push([head.next() as number, head.next() as number]);
      for (const [num, off] of entries) {
        if (this.objects.has(num)) continue;
        const val = new Lexer(body, first + off).value();
        if (val !== undefined) this.objects.set(num, val);
      }
    }
  }

  get(v: PdfValue | undefined): PdfValue | undefined {
    for (let hops = 0; v instanceof PdfRef && hops < 20; hops++) v = this.objects.get(v.num);
    return v;
  }

  dict(v: PdfValue | undefined): PdfDict | undefined {
    const d = this.get(v);
    if (isDict(d)) return d;
    if (d && isStream(d)) return d.dict;
    return undefined;
  }

  decode(s: PdfStream): Promise<string> {
    let p = this.decoded.get(s);
    if (!p) {
      p = (async () => {
        let data = s.raw;
        const f = this.get(s.dict.get("Filter"));
        const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => (this.get(x) as PdfName).name);
        for (const name of filters) {
          if (name === "FlateDecode" || name === "Fl") data = await inflate(data);
          else if (name === "ASCIIHexDecode" || name === "AHx") data = toBytes((new Lexer("<" + latin1(data).replace(/>.*$/s, "") + ">").next() as string) ?? "");
          else return ""; // pictures and other encodings carry no text
        }
        return latin1(data);
      })();
      this.decoded.set(s, p);
    }
    return p;
  }

  catalog(): PdfDict | undefined {
    const trailer = this.text.lastIndexOf("trailer");
    if (trailer >= 0) {
      const d = new Lexer(this.text, trailer + 7).value();
      if (isDict(d)) {
        const root = this.dict(d.get("Root"));
        if (root) return root;
      }
    }
    for (const v of this.objects.values()) {
      const d = isDict(v) ? v : isStream(v) ? v.dict : undefined;
      if (!d) continue;
      if ((d.get("Type") as PdfName | undefined)?.name === "XRef") {
        const root = this.dict(d.get("Root"));
        if (root) return root;
      }
    }
    for (const v of this.objects.values()) if (isDict(v) && (v.get("Type") as PdfName | undefined)?.name === "Catalog") return v;
    return undefined;
  }

  /** The pages in order, each with the resources it inherits. */
  pages(): { page: PdfDict; resources: PdfDict | undefined; box: number[] }[] {
    const out: { page: PdfDict; resources: PdfDict | undefined; box: number[] }[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | undefined, res: PdfDict | undefined, box: number[]) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const r = this.dict(node.get("Resources")) ?? res;
      const mb = this.get(node.get("MediaBox"));
      const b = Array.isArray(mb) ? mb.map((x) => this.get(x) as number) : box;
      const kids = this.get(node.get("Kids"));
      if (Array.isArray(kids)) for (const k of kids) walk(this.dict(k), r, b);
      else out.push({ page: node, resources: r, box: b });
    };
    walk(this.dict(this.catalog()?.get("Pages")), undefined, [0, 0, 612, 792]);
    if (!out.length) {
      // no usable page tree: take every page object in file order
      for (const v of this.objects.values()) if (isDict(v) && (v.get("Type") as PdfName | undefined)?.name === "Page") out.push({ page: v, resources: this.dict(v.get("Resources")), box: [0, 0, 612, 792] });
    }
    return out;
  }
}

function skipEol(s: string, i: number): number {
  while (s[i] === "\r" || s[i] === "\n" || s[i] === " ") i++;
  return i;
}

// ------------------------------------------------------------------- fonts --

interface Font {
  /** bytes per character code */
  bytes: 1 | 2;
  toText(code: number): string;
  /** width in text space units (1/1000 of the font size) */
  width(code: number): number;
}

const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "-", period: ".", slash: "/",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[",
  backslash: "\\", bracketright: "]", underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}",
  quoteright: "’", quoteleft: "‘", quotedblleft: "“", quotedblright: "”", endash: "–", emdash: "—", bullet: "•",
  sterling: "£", Euro: "€", yen: "¥", cent: "¢", nbspace: " ", degree: "°",
};

/** WinAnsi codes 128-159 that differ from Latin-1. */
const WIN_ANSI: Record<number, string> = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š", 139: "‹", 140: "Œ",
  142: "Ž", 145: "‘", 146: "’", 147: "“", 148: "”", 149: "•", 150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›",
  156: "œ", 158: "ž", 159: "Ÿ",
};

function parseCMap(text: string): { map: Map<number, string>; bytes: 1 | 2 } {
  const map = new Map<number, string>();
  const hexText = (h: string) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length === 2) out = String.fromCharCode(parseInt(h, 16));
    return out;
  };
  let bytes: 1 | 2 = 1;
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) if (/<[0-9a-f]{4}>/i.test(m[1])) bytes = 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      if (m[1].length >= 4) bytes = 2;
      map.set(parseInt(m[1], 16), hexText(m[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
      if (m[1].length >= 4) bytes = 2;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3].startsWith("[")) {
        const list = [...m[3].matchAll(/<([0-9a-f]*)>/gi)].map((x) => hexText(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      } else {
        const start = m[3].slice(1, -1);
        const base = parseInt(start.slice(-4) || "0", 16);
        const prefix = hexText(start.slice(0, -4));
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, prefix + String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return { map, bytes };
}

async function loadFont(pdf: PdfFile, ref: PdfValue | undefined): Promise<Font> {
  const d = pdf.dict(ref) ?? new Map();
  const subtype = (pdf.get(d.get("Subtype")) as PdfName | undefined)?.name;
  let map: Map<number, string> | undefined;
  let bytes: 1 | 2 = subtype === "Type0" ? 2 : 1;
  const tu = pdf.get(d.get("ToUnicode"));
  if (tu && isStream(tu)) {
    const cmap = parseCMap(await pdf.decode(tu));
    map = cmap.map;
    if (subtype === "Type0") bytes = 2;
    else bytes = cmap.bytes === 2 && subtype !== "Type1" && subtype !== "TrueType" ? 2 : 1;
  }
  // widths
  const widths = new Map<number, number>();
  let dw = subtype === "Type0" ? 1000 : 500;
  if (subtype === "Type0") {
    const desc = pdf.get(d.get("DescendantFonts"));
    const cid = pdf.dict(Array.isArray(desc) ? desc[0] : undefined);
    if (cid) {
      dw = (pdf.get(cid.get("DW")) as number | undefined) ?? 1000;
      const w = pdf.get(cid.get("W"));
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length; ) {
          const first = pdf.get(w[i]) as number;
          const next = pdf.get(w[i + 1]);
          if (Array.isArray(next)) {
            next.forEach((x, k) => widths.set(first + k, pdf.get(x) as number));
            i += 2;
          } else {
            const last = next as number;
            const width = pdf.get(w[i + 2]) as number;
            for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
            i += 3;
          }
        }
      }
    }
  } else {
    const first = (pdf.get(d.get("FirstChar")) as number | undefined) ?? 0;
    const w = pdf.get(d.get("Widths"));
    if (Array.isArray(w)) w.forEach((x, k) => widths.set(first + k, pdf.get(x) as number));
  }
  // simple-font encoding differences
  const diffs = new Map<number, string>();
  const enc = pdf.get(d.get("Encoding"));
  const encDict = isDict(enc) ? enc : undefined;
  const differences = encDict ? pdf.get(encDict.get("Differences")) : undefined;
  if (Array.isArray(differences)) {
    let code = 0;
    for (const x of differences) {
      const v = pdf.get(x);
      if (typeof v === "number") code = v;
      else if (v instanceof PdfName) {
        const g = v.name;
        const ch = GLYPHS[g] ?? (g.length === 1 ? g : /^uni([0-9A-F]{4})$/.test(g) ? String.fromCharCode(parseInt(g.slice(3), 16)) : undefined);
        if (ch !== undefined) diffs.set(code, ch);
        code++;
      }
    }
  }
  return {
    bytes,
    toText(code) {
      const m = map?.get(code);
      if (m !== undefined) return m;
      const df = diffs.get(code);
      if (df !== undefined) return df;
      if (bytes === 2) return code ? String.fromCharCode(code) : "";
      return WIN_ANSI[code] ?? String.fromCharCode(code);
    },
    width(code) {
      return widths.get(code) ?? dw;
    },
  };
}

// ------------------------------------------------------------ the content --

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

async function pageItems(pdf: PdfFile, page: PdfDict, resources: PdfDict | undefined, height: number): Promise<TextItem[]> {
  const contents = pdf.get(page.get("Contents"));
  const streams = (Array.isArray(contents) ? contents : contents ? [contents] : []).map((c) => pdf.get(c)).filter((c): c is PdfStream => !!c && isStream(c));
  const text = (await Promise.all(streams.map((s) => pdf.decode(s)))).join("\n");
  const items: TextItem[] = [];
  await runContent(pdf, text, resources, [1, 0, 0, 1, 0, 0], items, height, 0);
  return items;
}

async function runContent(pdf: PdfFile, content: string, resources: PdfDict | undefined, startCtm: Matrix, items: TextItem[], height: number, depth: number): Promise<void> {
  const fontDict = pdf.dict(resources?.get("Font"));
  const fonts = new Map<string, Font>();
  const xobjects = pdf.dict(resources?.get("XObject"));
  let ctm: Matrix = startCtm;
  const stack: { ctm: Matrix; font: Font | undefined; size: number; tc: number; tw: number; tz: number; tl: number; rise: number }[] = [];
  let font: Font | undefined;
  let size = 0;
  let tc = 0,
    tw = 0,
    tz = 1,
    tl = 0,
    rise = 0;
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  const ops: PdfValue[] = [];
  const lx = new Lexer(content);

  const show = (s: string) => {
    if (!font) return;
    const f = font;
    const trm = mul([size * tz, 0, 0, size, 0, rise], mul(tm, ctm));
    const scale = Math.hypot(trm[2], trm[3]) || size;
    const x = trm[4];
    const y = height - trm[5];
    let out = "";
    let advance = 0;
    for (let i = 0; i < s.length; i += f.bytes) {
      const code = f.bytes === 2 ? (s.charCodeAt(i) << 8) | (s.charCodeAt(i + 1) || 0) : s.charCodeAt(i);
      out += f.toText(code);
      const w = (f.width(code) / 1000) * size + tc + (f.bytes === 1 && code === 32 ? tw : 0);
      advance += w * tz;
    }
    tm = mul([1, 0, 0, 1, advance, 0], tm);
    const end = mul(tm, ctm)[4];
    if (out.trim()) items.push({ x, y, x2: Math.max(end, x), text: out, size: scale });
  };

  for (;;) {
    const t = lx.next();
    if (t === undefined) break;
    if (!(t && typeof t === "object" && "op" in t)) {
      ops.push(t as PdfValue);
      continue;
    }
    const op = t.op;
    const n = (i: number) => (typeof ops[i] === "number" ? (ops[i] as number) : 0);
    switch (op) {
      case "q":
        stack.push({ ctm, font, size, tc, tw, tz, tl, rise });
        break;
      case "Q": {
        const st = stack.pop();
        if (st) ({ ctm, font, size, tc, tw, tz, tl, rise } = st);
        break;
      }
      case "cm":
        ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm);
        break;
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        tlm = tm;
        break;
      case "Tf": {
        const name = (ops[0] as PdfName | undefined)?.name ?? "";
        size = n(1);
        let f = fonts.get(name);
        if (!f) {
          f = await loadFont(pdf, fontDict?.get(name));
          fonts.set(name, f);
        }
        font = f;
        break;
      }
      case "Tc":
        tc = n(0);
        break;
      case "Tw":
        tw = n(0);
        break;
      case "Tz":
        tz = n(0) / 100;
        break;
      case "TL":
        tl = n(0);
        break;
      case "Ts":
        rise = n(0);
        break;
      case "Td":
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case "TD":
        tl = -n(1);
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case "Tm":
        tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        tm = tlm;
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        break;
      case "Tj":
        if (typeof ops[0] === "string") show(ops[0]);
        break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        if (typeof ops[0] === "string") show(ops[0]);
        break;
      case '"':
        tw = n(0);
        tc = n(1);
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        if (typeof ops[2] === "string") show(ops[2]);
        break;
      case "TJ":
        if (Array.isArray(ops[0])) {
          for (const part of ops[0]) {
            if (typeof part === "string") show(part);
            else if (typeof part === "number") tm = mul([1, 0, 0, 1, (-part / 1000) * size * tz, 0], tm);
          }
        }
        break;
      case "Do": {
        // a form XObject can hold text too (some generators put whole pages in one)
        const name = (ops[0] as PdfName | undefined)?.name;
        const xo = name ? pdf.get(xobjects?.get(name)) : undefined;
        if (xo && isStream(xo) && (pdf.get(xo.dict.get("Subtype")) as PdfName | undefined)?.name === "Form" && depth < 5) {
          const m = pdf.get(xo.dict.get("Matrix"));
          const fm = Array.isArray(m) ? (m.map((v) => pdf.get(v) as number) as Matrix) : ([1, 0, 0, 1, 0, 0] as Matrix);
          await runContent(pdf, await pdf.decode(xo), pdf.dict(xo.dict.get("Resources")) ?? resources, mul(fm, ctm), items, height, depth + 1);
        }
        break;
      }
      case "BI": {
        // inline image: skip its data
        const end = content.indexOf("EI", content.indexOf("ID", lx.pos) + 2);
        lx.pos = end < 0 ? content.length : end + 2;
        break;
      }
    }
    ops.length = 0;
  }
}

/** Every page's text pieces, top to bottom. */
export async function readPdfText(bytes: Uint8Array): Promise<PdfPage[]> {
  const text = latin1(bytes);
  if (!text.startsWith("%PDF")) throw new Error("This isn't a PDF file.");
  if (/\/Encrypt\s/.test(text.slice(text.lastIndexOf("trailer") >= 0 ? text.lastIndexOf("trailer") : 0)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) {
    throw new Error("This PDF is password-protected or encrypted. Save an unprotected copy first.");
  }
  const pdf = new PdfFile(text);
  await pdf.loadObjectStreams();
  const out: PdfPage[] = [];
  for (const { page, resources, box } of pdf.pages()) {
    const width = (box[2] ?? 612) - (box[0] ?? 0);
    const height = (box[3] ?? 792) - (box[1] ?? 0);
    const items = await pageItems(pdf, page, resources, (box[3] ?? 792));
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    out.push({ width, height, items });
  }
  return out;
}

export interface LineCell {
  x: number;
  x2: number;
  text: string;
}

/**
 * The page as lines of cells: pieces on the same baseline make a line, and
 * a gap wider than about a character splits the line into cells (columns).
 */
export function pageLines(page: PdfPage): LineCell[][] {
  const lines: TextItem[][] = [];
  for (const it of page.items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= Math.max(2, Math.min(last[0].size, it.size) * 0.4)) last.push(it);
    else lines.push([it]);
  }
  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    const cells: LineCell[] = [];
    for (const it of line) {
      const cell = cells[cells.length - 1];
      const gap = cell ? it.x - cell.x2 : Infinity;
      if (cell && gap < it.size * 0.9) {
        const space = gap > it.size * 0.15 && !cell.text.endsWith(" ") && !it.text.startsWith(" ") ? " " : "";
        cell.text += space + it.text;
        cell.x2 = Math.max(cell.x2, it.x2);
      } else cells.push({ x: it.x, x2: it.x2, text: it.text });
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
    return cells.filter((c) => c.text);
  });
}
