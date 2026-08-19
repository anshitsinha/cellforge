/**
 * Writing PDFs, with no dependencies. Two layers:
 *
 * - PdfDocument: pages of a fixed size, text in the standard fonts
 *   (Helvetica, Times, Courier, regular and bold) in WinAnsi encoding, lines,
 *   filled boxes, images (JPEG as is, or RGB pixels Flate-compressed) and an
 *   outline (bookmarks).
 * - writeBook: flowing content (headings, wrapped paragraphs, tables that
 *   carry on across pages with their header rows repeated, images, page
 *   breaks) laid out on pages, with page numbers and a contents page.
 *
 * Positions are in points (1/72 inch) measured from the top-left of the
 * page, which is how readPdfText reports them back. Text y is the baseline.
 */

// ------------------------------------------------------------------ fonts --

export type StdFont = "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique" | "Times-Roman" | "Times-Bold" | "Courier" | "Courier-Bold";

export const STD_FONTS: readonly StdFont[] = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Courier", "Courier-Bold"];

// Adobe's metrics for codes 32-126, in 1/1000 of the font size
const ASCII_W: Record<"h" | "hb" | "t" | "tb", number[]> = {
  h: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
    611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  hb: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
    611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
  t: [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556,
    611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
  ],
  tb: [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556,
    667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
  ],
};

// widths of the WinAnsi characters above 127 that aren't accented letters: h, hb, t, tb
const HIGH_W: Record<string, [number, number, number, number]> = {
  "€": [556, 556, 500, 500], "‚": [222, 278, 333, 333], "ƒ": [556, 556, 500, 500], "„": [333, 500, 444, 500], "…": [1000, 1000, 1000, 1000],
  "†": [556, 556, 500, 500], "‡": [556, 556, 500, 500], "ˆ": [333, 333, 333, 333], "‰": [1000, 1000, 1000, 1000], "‹": [333, 333, 333, 333],
  "Œ": [1000, 1000, 889, 1000], "‘": [222, 278, 333, 333], "’": [222, 278, 333, 333], "“": [333, 500, 444, 500], "”": [333, 500, 444, 500],
  "•": [350, 350, 350, 350], "–": [556, 556, 500, 500], "—": [1000, 1000, 1000, 1000], "˜": [333, 333, 333, 333], "™": [1000, 1000, 980, 1000],
  "›": [333, 333, 333, 333], "œ": [944, 944, 722, 722], " ": [278, 278, 250, 250], "¡": [333, 333, 333, 333], "¢": [556, 556, 500, 500],
  "£": [556, 556, 500, 500], "¤": [556, 556, 500, 500], "¥": [556, 556, 500, 500], "¦": [260, 280, 200, 220], "§": [556, 556, 500, 500],
  "¨": [333, 333, 333, 333], "©": [737, 737, 760, 747], "ª": [370, 370, 276, 300], "«": [556, 556, 500, 500], "¬": [584, 584, 564, 570],
  "­": [333, 333, 333, 333], "®": [737, 737, 760, 747], "¯": [333, 333, 333, 333], "°": [400, 400, 400, 400], "±": [584, 584, 564, 570],
  "²": [333, 333, 300, 300], "³": [333, 333, 300, 300], "´": [333, 333, 333, 333], "µ": [556, 611, 500, 556], "¶": [537, 556, 453, 540],
  "·": [278, 278, 250, 250], "¸": [333, 333, 333, 333], "¹": [333, 333, 300, 300], "º": [365, 365, 310, 330], "»": [556, 556, 500, 500],
  "¼": [834, 834, 750, 750], "½": [834, 834, 750, 750], "¾": [834, 834, 750, 750], "¿": [611, 611, 444, 500], "×": [584, 584, 564, 570],
  "÷": [584, 584, 564, 570], "Æ": [1000, 1000, 889, 1000], "æ": [889, 889, 667, 722], "ß": [611, 611, 500, 556], "Ø": [778, 778, 722, 778],
  "ø": [611, 611, 500, 500], "Ð": [722, 722, 722, 722], "ð": [556, 611, 500, 500], "Þ": [667, 667, 556, 611], "þ": [556, 611, 500, 556],
};

/** WinAnsi codes 128-159 (the rest of 160-255 is Latin-1). */
const WIN_ANSI_HIGH: Record<string, number> = {
  "€": 128, "‚": 130, "ƒ": 131, "„": 132, "…": 133, "†": 134, "‡": 135, "ˆ": 136, "‰": 137, "Š": 138, "‹": 139, "Œ": 140, "Ž": 142,
  "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "˜": 152, "™": 153, "š": 154, "›": 155, "œ": 156, "ž": 158, "Ÿ": 159,
};
const FROM_WIN_ANSI = new Map(Object.entries(WIN_ANSI_HIGH).map(([ch, code]) => [code, ch]));

/** The WinAnsi code of a character, or 63 ("?") when it has none. */
export function winAnsiCode(ch: string): number {
  const c = ch.codePointAt(0) ?? 63;
  if (c >= 32 && c <= 126) return c;
  if (c >= 160 && c <= 255) return c;
  if (c === 9) return 32;
  return WIN_ANSI_HIGH[ch] ?? 63;
}

/** Text as WinAnsi bytes (one char per byte); characters it can't hold become "?". */
export function winAnsi(text: string): string {
  let out = "";
  for (const ch of text) out += String.fromCharCode(winAnsiCode(ch));
  return out;
}

const metricKey = (font: StdFont): "h" | "hb" | "t" | "tb" | "c" =>
  font.startsWith("Courier") ? "c" : font.startsWith("Times") ? (font === "Times-Bold" ? "tb" : "t") : font.includes("Bold") ? "hb" : "h";

/** Width of a WinAnsi code in 1/1000 of the font size. */
function codeWidth(code: number, key: "h" | "hb" | "t" | "tb" | "c"): number {
  if (key === "c") return 600;
  if (code >= 32 && code <= 126) return ASCII_W[key][code - 32];
  const ch = FROM_WIN_ANSI.get(code) ?? String.fromCharCode(code);
  const slot = key === "h" ? 0 : key === "hb" ? 1 : key === "t" ? 2 : 3;
  const hw = HIGH_W[ch];
  if (hw) return hw[slot];
  // accented letters are as wide as the letter
  const base = ch.normalize("NFD")[0];
  const b = base ? base.charCodeAt(0) : 0;
  if (b >= 32 && b <= 126) return ASCII_W[key][b - 32];
  return key === "h" || key === "hb" ? 556 : 500;
}

const widthCache = new Map<string, number[]>();
/** Widths of codes 32..255 for a font (what goes in the font's /Widths). */
export function fontWidths(font: StdFont): number[] {
  const key = metricKey(font);
  let w = widthCache.get(key);
  if (!w) {
    w = [];
    for (let c = 32; c <= 255; c++) w.push(codeWidth(c, key));
    widthCache.set(key, w);
  }
  return w;
}

/** How wide `text` is in `font` at `size` points. */
export function textWidth(text: string, font: StdFont, size: number): number {
  const w = fontWidths(font);
  let total = 0;
  for (const ch of text) total += w[winAnsiCode(ch) - 32] ?? 500;
  return (total * size) / 1000;
}

/** Cut text to fit `width`, ending in "…" when it was cut. */
export function fitText(text: string, font: StdFont, size: number, width: number): string {
  if (textWidth(text, font, size) <= width) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(chars.slice(0, mid).join("") + "…", font, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join("").trimEnd() + "…" : "";
}

/** Break text into lines no wider than `width`, at spaces (long words are split). "\n" starts a new line. */
export function wrapText(text: string, font: StdFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    const words = para.split(/ +/).filter((w, i) => w || i === 0);
    let line = "";
    for (let word of words) {
      const tryLine = line ? `${line} ${word}` : word;
      if (textWidth(tryLine, font, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) out.push(line);
      // a word wider than the line: split it
      while (textWidth(word, font, size) > width && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && textWidth(word.slice(0, n), font, size) > width) n--;
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}

// ------------------------------------------------------------------ pages --

export type PageSize = "A4" | "Letter" | [number, number];
export const PAGE_SIZES: Record<"A4" | "Letter", [number, number]> = { A4: [595.28, 841.89], Letter: [612, 792] };

export function pageDimensions(size: PageSize = "A4", landscape = false): [number, number] {
  const [w, h] = typeof size === "string" ? PAGE_SIZES[size] : size;
  return landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
}

/** A colour: "#rrggbb" / "#rgb", or [r, g, b] from 0 to 1. */
export type PdfColor = string | [number, number, number];

function rgb(c: PdfColor): [number, number, number] {
  if (Array.isArray(c)) return c;
  let h = c.replace(/^#/, "");
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const fmt = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
const colorOp = (c: PdfColor, stroke: boolean) => `${rgb(c).map(fmt).join(" ")} ${stroke ? "RG" : "rg"}`;

/** A literal string for a content stream: bytes over 127 as octal escapes so the file stays ASCII. */
function pdfString(bytes: string): string {
  let out = "(";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes.charCodeAt(i);
    if (c === 40 || c === 41 || c === 92) out += "\\" + bytes[i];
    else if (c < 32 || c > 126) out += "\\" + c.toString(8).padStart(3, "0");
    else out += bytes[i];
  }
  return out + ")";
}

/** A text string outside content (titles, bookmarks): ASCII as is, anything else as UTF-16. */
function textString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return pdfString(text);
  let hex = "<FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return hex + ">";
}

/**
 * A picture to put on a page. Give JPEG bytes (embedded as they are) or
 * 8-bit RGB pixels, row by row (Flate-compressed), with an optional alpha
 * channel (one byte a pixel).
 */
export interface PdfImage {
  width: number;
  height: number;
  jpeg?: Uint8Array;
  rgb?: Uint8Array;
  alpha?: Uint8Array;
}

/** Width, height and colour channels of a JPEG, from its frame header. */
export function jpegInfo(bytes: Uint8Array): { width: number; height: number; components: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // start-of-frame markers (not DHT C4, JPG C8, DAC CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/** RGBA pixels (a canvas's ImageData) to a PdfImage, laid over white when `flatten`, else keeping the alpha. */
export function imageFromRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, flatten = true): PdfImage {
  const n = width * height;
  const out = new Uint8Array(n * 3);
  const alpha = flatten ? undefined : new Uint8Array(n);
  let opaque = true;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (flatten) {
      const k = a / 255;
      for (let j = 0; j < 3; j++) out[i * 3 + j] = Math.round(rgba[i * 4 + j] * k + 255 * (1 - k));
    } else {
      out[i * 3] = rgba[i * 4];
      out[i * 3 + 1] = rgba[i * 4 + 1];
      out[i * 3 + 2] = rgba[i * 4 + 2];
      alpha![i] = a;
      if (a !== 255) opaque = false;
    }
  }
  return { width, height, rgb: out, ...(alpha && !opaque ? { alpha } : {}) };
}

export interface TextOptions {
  font?: StdFont;
  size?: number;
  color?: PdfColor;
  /** x is the left edge (default), the right edge or the centre */
  align?: "left" | "right" | "center";
}

/** One page: drawing operations in page coordinates (top-left origin). */
export class PdfPageBuilder {
  /** content stream operators */
  readonly ops: string[] = [];

  constructor(
    private readonly doc: PdfDocument,
    readonly width: number,
    readonly height: number,
  ) {}

  /** Text with its baseline at y. Returns where it starts and its width. */
  text(x: number, y: number, text: string, o: TextOptions = {}): { x: number; width: number } {
    const font = o.font ?? "Helvetica";
    const size = o.size ?? 10;
    const w = textWidth(text, font, size);
    const left = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    if (!text) return { x: left, width: 0 };
    const res = this.doc.fontResource(font);
    const color = o.color ? colorOp(o.color, false) + " " : "";
    this.ops.push(`BT ${color}/${res} ${fmt(size)} Tf 1 0 0 1 ${fmt(left)} ${fmt(this.height - y)} Tm ${pdfString(winAnsi(text))} Tj ET`);
    return { x: left, width: w };
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; color?: PdfColor } = {}): void {
    this.ops.push(`q ${colorOp(o.color ?? [0, 0, 0], true)} ${fmt(o.width ?? 0.5)} w ${fmt(x1)} ${fmt(this.height - y1)} m ${fmt(x2)} ${fmt(this.height - y2)} l S Q`);
  }

  /** A box with its top-left at (x, y): filled, outlined or both. */
  rect(x: number, y: number, w: number, h: number, o: { fill?: PdfColor; stroke?: PdfColor; width?: number }): void {
    const paint = o.fill && o.stroke ? "B" : o.fill ? "f" : "S";
    const parts = ["q"];
    if (o.fill) parts.push(colorOp(o.fill, false));
    if (o.stroke) parts.push(colorOp(o.stroke, true), `${fmt(o.width ?? 0.5)} w`);
    parts.push(`${fmt(x)} ${fmt(this.height - y - h)} ${fmt(w)} ${fmt(h)} re ${paint} Q`);
    this.ops.push(parts.join(" "));
  }

  /** An image with its top-left at (x, y), stretched to w by h. */
  image(img: PdfImage, x: number, y: number, w: number, h: number): void {
    const res = this.doc.imageResource(img);
    this.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(this.height - y - h)} cm /${res} Do Q`);
  }
}

/** A bookmark in the PDF's outline. */
export interface OutlineItem {
  title: string;
  page: number;
  /** where on the page (from the top); default the top */
  y?: number;
  children: OutlineItem[];
}

export interface DocInfo {
  title?: string;
  author?: string;
  subject?: string;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const bytesOf = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
};

/** A PDF being built: add pages, draw on them, then save(). */
export class PdfDocument {
  readonly pages: PdfPageBuilder[] = [];
  /** top-level bookmarks */
  readonly outline: OutlineItem[] = [];
  private readonly fonts = new Map<StdFont, string>();
  private readonly images = new Map<PdfImage, string>();

  constructor(readonly info: DocInfo = {}) {}

  addPage(size: PageSize = "A4", landscape = false): PdfPageBuilder {
    const [w, h] = pageDimensions(size, landscape);
    const p = new PdfPageBuilder(this, w, h);
    this.pages.push(p);
    return p;
  }

  /** Add a bookmark (under `parent`, or at the top level). */
  bookmark(title: string, page: number, y?: number, parent?: OutlineItem): OutlineItem {
    const item: OutlineItem = { title, page, ...(y !== undefined ? { y } : {}), children: [] };
    (parent ? parent.children : this.outline).push(item);
    return item;
  }

  /** @internal resource name of a font, registering it */
  fontResource(font: StdFont): string {
    let r = this.fonts.get(font);
    if (!r) {
      r = `F${this.fonts.size + 1}`;
      this.fonts.set(font, r);
    }
    return r;
  }

  /** @internal resource name of an image, registering it */
  imageResource(img: PdfImage): string {
    let r = this.images.get(img);
    if (!r) {
      if (!img.jpeg && !img.rgb) throw new Error("An image needs JPEG bytes or RGB pixels.");
      if (img.rgb && img.rgb.length < img.width * img.height * 3) throw new Error("Not enough RGB pixels for the image size.");
      r = `Im${this.images.size + 1}`;
      this.images.set(img, r);
    }
    return r;
  }

  /** The finished file. Streams are Flate-compressed unless compress is false. */
  async save(opts: { compress?: boolean } = {}): Promise<Uint8Array> {
    const compress = opts.compress !== false;
    const objects: (Uint8Array | string)[] = [];
    const alloc = () => objects.push("") ;
    const set = (n: number, v: Uint8Array | string) => (objects[n - 1] = v);
    const streamObj = async (dict: string, data: Uint8Array, flate: boolean | "already"): Promise<Uint8Array> => {
      let body = data;
      let filter = "";
      if (flate === "already") filter = "";
      else if (flate) {
        body = await deflate(data);
        filter = " /Filter /FlateDecode";
      }
      const head = bytesOf(`<< ${dict}${filter} /Length ${body.length} >>\nstream\n`);
      const tail = bytesOf("\nendstream");
      const out = new Uint8Array(head.length + body.length + tail.length);
      out.set(head, 0);
      out.set(body, head.length);
      out.set(tail, head.length + body.length);
      return out;
    };

    const catalog = alloc();
    const pagesObj = alloc();
    const infoObj = alloc();
    const resources = alloc();

    // fonts
    const fontRefs: string[] = [];
    for (const [font, res] of this.fonts) {
      const n = alloc();
      set(n, `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${fontWidths(font).join(" ")}] >>`);
      fontRefs.push(`/${res} ${n} 0 R`);
    }
    // images
    const imageRefs: string[] = [];
    for (const [img, res] of this.images) {
      const n = alloc();
      if (img.jpeg) {
        const info = jpegInfo(img.jpeg);
        const cs = info?.components === 1 ? "/DeviceGray" : info?.components === 4 ? "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : "/DeviceRGB";
        set(n, await streamObj(`/Type /XObject /Subtype /Image /Width ${info?.width ?? img.width} /Height ${info?.height ?? img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, img.jpeg, "already"));
      } else {
        let smask = "";
        if (img.alpha) {
          const m = alloc();
          set(m, await streamObj(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, img.alpha.subarray(0, img.width * img.height), true));
          smask = ` /SMask ${m} 0 R`;
        }
        set(n, await streamObj(`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${smask}`, img.rgb!.subarray(0, img.width * img.height * 3), true));
      }
      imageRefs.push(`/${res} ${n} 0 R`);
    }
    set(resources, `<< /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fontRefs.join(" ")} >>${imageRefs.length ? ` /XObject << ${imageRefs.join(" ")} >>` : ""} >>`);

    // pages
    const pageNums: number[] = [];
    for (const p of this.pages) {
      const n = alloc();
      const c = alloc();
      pageNums.push(n);
      set(n, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${fmt(p.width)} ${fmt(p.height)}] /Resources ${resources} 0 R /Contents ${c} 0 R >>`);
      set(c, await streamObj("", bytesOf(p.ops.join("\n")), compress));
    }
    set(pagesObj, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`);

    // outline
    let outlineRef = "";
    if (this.outline.length) {
      const root = alloc();
      const count = (items: OutlineItem[]): number => items.reduce((s, it) => s + 1 + count(it.children), 0);
      const write = (items: OutlineItem[], parent: number): { first: number; last: number } => {
        const nums = items.map(() => alloc());
        items.forEach((it, i) => {
          const page = this.pages[Math.max(0, Math.min(it.page, this.pages.length - 1))];
          const pref = pageNums[Math.max(0, Math.min(it.page, pageNums.length - 1))];
          const top = page ? page.height - (it.y ?? 0) : 0;
          let d = `<< /Title ${textString(it.title)} /Parent ${parent} 0 R /Dest [${pref} 0 R /XYZ 0 ${fmt(top)} 0]`;
          if (i > 0) d += ` /Prev ${nums[i - 1]} 0 R`;
          if (i < items.length - 1) d += ` /Next ${nums[i + 1]} 0 R`;
          if (it.children.length) {
            const k = write(it.children, nums[i]);
            d += ` /First ${k.first} 0 R /Last ${k.last} 0 R /Count ${count(it.children)}`;
          }
          set(nums[i], d + " >>");
        });
        return { first: nums[0], last: nums[nums.length - 1] };
      };
      const k = write(this.outline, root);
      set(root, `<< /Type /Outlines /First ${k.first} 0 R /Last ${k.last} 0 R /Count ${count(this.outline)} >>`);
      outlineRef = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
    }
    set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlineRef} >>`);
    const info: string[] = ["/Producer (cellforge)"];
    if (this.info.title) info.push(`/Title ${textString(this.info.title)}`);
    if (this.info.author) info.push(`/Author ${textString(this.info.author)}`);
    if (this.info.subject) info.push(`/Subject ${textString(this.info.subject)}`);
    set(infoObj, `<< ${info.join(" ")} >>`);

    // the file
    const chunks: Uint8Array[] = [bytesOf("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
    let pos = chunks[0].length;
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(pos);
      const head = bytesOf(`${i + 1} 0 obj\n`);
      const body = typeof o === "string" ? bytesOf(o) : o;
      const tail = bytesOf("\nendobj\n");
      chunks.push(head, body, tail);
      pos += head.length + body.length + tail.length;
    });
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(bytesOf(xref));
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

// ------------------------------------------------------------------- flow --

export interface TableColumn {
  header: string;
  /** "auto" (the default): right for columns of numbers, left otherwise */
  align?: "left" | "right" | "center" | "auto";
  /** relative width; by default from the longest text */
  width?: number;
}

export interface TableRow {
  cells: string[];
  /** totals: bold with a line above */
  bold?: boolean;
  /** a light background */
  shade?: boolean;
}

export type FlowBlock =
  | { kind: "heading"; text: string; level?: 1 | 2 | 3 }
  | { kind: "paragraph"; text: string; size?: number; bold?: boolean; italic?: boolean; color?: PdfColor; align?: "left" | "right" | "center" }
  | { kind: "table"; columns: TableColumn[]; rows: TableRow[]; size?: number; caption?: string }
  | { kind: "image"; image: PdfImage; width?: number; height?: number; caption?: string }
  | { kind: "pageBreak" }
  | { kind: "spacer"; height: number };

/** One report in a book: starts on a new page under its title. */
export interface BookSection {
  title: string;
  /** a line under the title (an entity, a period) */
  subtitle?: string;
  blocks: FlowBlock[];
}

export interface BookOptions {
  title?: string;
  author?: string;
  size?: PageSize;
  landscape?: boolean;
  /** page margin in points (default 50) */
  margin?: number;
  /** body text: Helvetica (default) or Times */
  family?: "Helvetica" | "Times";
  /** body text size (default 10) */
  fontSize?: number;
  /** a contents page first (default: when there's more than one section) */
  contents?: boolean;
  /** "Page n of N" at the foot of each page (default true) */
  pageNumbers?: boolean;
  /** text at the bottom left of every page */
  footer?: string;
  /** compress page content (default true) */
  compress?: boolean;
}

/** A line of the contents page. */
export interface ContentsEntry {
  title: string;
  /** 0 a section, 1 and 2 headings in it */
  level: number;
  /** page index (0-based, in the finished file) */
  page: number;
  y: number;
}

const NUMERIC = /^[-+−(]?\s*[$€£¥]?\s*[-+]?(\d[\d,.\s]*|\.\d+)(e[-+]?\d+)?\s*%?\)?$|^[-–—]$/i;
/** Text that reads as a number ("1,234.50", "(12)", "45%", "-"). */
export function looksNumeric(s: string): boolean {
  return NUMERIC.test(s.trim());
}

interface LaidPage {
  draw: ((p: PdfPageBuilder, pageNo: number, pages: number) => void)[];
}

const GREY: PdfColor = [0.4, 0.4, 0.4];
const RULE: PdfColor = [0.55, 0.55, 0.55];
const SHADE: PdfColor = [0.94, 0.95, 0.96];

/**
 * Lay out sections on pages and write the PDF: an optional contents page
 * (with page numbers and dot leaders), each section from a new page, page
 * numbers and an outline of sections and headings.
 */
export async function writeBook(sections: BookSection[], o: BookOptions = {}): Promise<Uint8Array> {
  return (await layoutBook(sections, o)).doc.save({ compress: o.compress });
}

/** writeBook without saving: the document, and where the contents entries landed. */
export async function layoutBook(sections: BookSection[], o: BookOptions = {}): Promise<{ doc: PdfDocument; contents: ContentsEntry[] }> {
  const [W, H] = pageDimensions(o.size ?? "A4", o.landscape);
  const M = o.margin ?? 50;
  const regular: StdFont = o.family === "Times" ? "Times-Roman" : "Helvetica";
  const bold: StdFont = o.family === "Times" ? "Times-Bold" : "Helvetica-Bold";
  const italic: StdFont = o.family === "Times" ? "Times-Roman" : "Helvetica-Oblique";
  const base = o.fontSize ?? 10;
  const footerSpace = o.pageNumbers === false && !o.footer ? 0 : 24;
  const top = M;
  const bottom = H - M - footerSpace;
  const left = M;
  const avail = W - 2 * M;

  const pages: LaidPage[] = [];
  const entries: (Omit<ContentsEntry, "page"> & { body: number })[] = [];
  let page: LaidPage = { draw: [] };
  let y = top;
  const newPage = () => {
    page = { draw: [] };
    pages.push(page);
    y = top;
  };
  /** room for h more points, or a new page (unless this one is still empty) */
  const ensure = (h: number) => {
    if (y + h > bottom && y > top + 0.01) newPage();
  };
  const text = (x: number, yy: number, t: string, opts: TextOptions) => page.draw.push((p) => void p.text(x, yy, t, opts));

  for (const sec of sections) {
    newPage();
    entries.push({ title: sec.title, level: 0, body: pages.length - 1, y });
    const ts = base * 1.8;
    for (const line of wrapText(sec.title, bold, ts, avail)) {
      text(left, y + ts, line, { font: bold, size: ts });
      y += ts * 1.25;
    }
    if (sec.subtitle) {
      const ss = base * 1.1;
      for (const line of wrapText(sec.subtitle, regular, ss, avail)) {
        text(left, y + ss, line, { font: regular, size: ss, color: GREY });
        y += ss * 1.4;
      }
    }
    const ruleY = y + 4;
    page.draw.push((p) => p.line(left, ruleY, left + avail, ruleY, { width: 0.75, color: RULE }));
    y += base * 1.6;

    for (const b of sec.blocks) {
      switch (b.kind) {
        case "heading": {
          const level = b.level ?? 1;
          const size = level === 1 ? base * 1.4 : level === 2 ? base * 1.2 : base * 1.05;
          // keep a heading with at least a few lines of what follows
          ensure(size * 1.5 + base * 4);
          if (y > top + 0.01) y += size * 0.5;
          if (level <= 2) entries.push({ title: b.text, level, body: pages.length - 1, y });
          for (const line of wrapText(b.text, bold, size, avail)) {
            text(left, y + size, line, { font: bold, size });
            y += size * 1.3;
          }
          y += size * 0.3;
          break;
        }
        case "paragraph": {
          const size = b.size ?? base;
          const font = b.bold ? bold : b.italic ? italic : regular;
          const lh = size * 1.4;
          for (const line of wrapText(b.text, font, size, avail)) {
            ensure(lh);
            const x = b.align === "right" ? left + avail : b.align === "center" ? left + avail / 2 : left;
            text(x, y + size, line, { font, size, align: b.align ?? "left", ...(b.color ? { color: b.color } : {}) });
            y += lh;
          }
          y += size * 0.6;
          break;
        }
        case "table":
          layTable(b);
          break;
        case "image": {
          const ratio = b.image.height / Math.max(1, b.image.width);
          let w = Math.min(avail, b.width ?? avail);
          let h = b.height ?? w * ratio;
          const capH = b.caption ? base * 1.6 : 0;
          const maxH = bottom - top - capH;
          if (h > maxH) {
            w = (w * maxH) / h;
            h = maxH;
          }
          ensure(h + capH);
          const img = b.image;
          const iy = y;
          page.draw.push((p) => p.image(img, left, iy, w, h));
          y += h;
          if (b.caption) {
            text(left, y + base * 1.1, b.caption, { font: italic, size: base * 0.9, color: GREY });
            y += capH;
          }
          y += base;
          break;
        }
        case "pageBreak":
          if (y > top + 0.01) newPage();
          break;
        case "spacer":
          ensure(b.height);
          y += b.height;
          break;
      }
    }
  }

  function layTable(b: Extract<FlowBlock, { kind: "table" }>) {
    const size = b.size ?? base * 0.9;
    const pad = size * 0.45;
    const rh = size * 1.6;
    const n = b.columns.length;
    if (!n) return;
    // alignment
    const align = b.columns.map((c, j) => {
      if (c.align && c.align !== "auto") return c.align;
      let nums = 0;
      for (const r of b.rows) {
        const v = r.cells[j] ?? "";
        if (!v.trim()) continue;
        if (!looksNumeric(v)) return "left";
        nums++;
      }
      return nums ? "right" : "left";
    });
    // widths: given, or the longest text (header words count by the longest word, as headers wrap)
    const natural = b.columns.map((c, j) => {
      let w = Math.max(...c.header.split(/\s+/).map((word) => textWidth(word, bold, size)), 0);
      for (const r of b.rows) w = Math.max(w, textWidth(r.cells[j] ?? "", r.bold ? bold : regular, size));
      return Math.min(w, avail * 0.6) + 2 * pad;
    });
    let widths: number[];
    if (b.columns.some((c) => c.width)) {
      const rel = b.columns.map((c, j) => c.width ?? natural[j]);
      const sum = rel.reduce((s, x) => s + x, 0);
      widths = rel.map((x) => (x / sum) * avail);
    } else {
      const sum = natural.reduce((s, x) => s + x, 0);
      widths = sum <= avail ? natural : natural.map((x) => (x / sum) * avail);
    }
    const xs: number[] = [left];
    for (const w of widths) xs.push(xs[xs.length - 1] + w);
    const tableW = xs[n] - left;
    // header lines (wrapped, up to 3)
    const headLines = b.columns.map((c, j) => wrapText(c.header, bold, size, widths[j] - 2 * pad).slice(0, 3).map((l, i, a) => (i === 2 && a.length === 3 ? fitText(l, bold, size, widths[j] - 2 * pad) : l)));
    const headH = Math.max(1, ...headLines.map((l) => l.length)) * size * 1.25 + size * 0.6;
    const cellX = (j: number) => (align[j] === "right" ? xs[j + 1] - pad : align[j] === "center" ? (xs[j] + xs[j + 1]) / 2 : xs[j] + pad);

    if (b.caption) {
      ensure(base * 1.5 + headH + rh);
      text(left, y + base, b.caption, { font: bold, size: base });
      y += base * 1.5;
    }
    const header = () => {
      const y0 = y;
      page.draw.push((p) => p.line(left, y0, left + tableW, y0, { width: 0.75 }));
      headLines.forEach((lines, j) => {
        // headers sit on the bottom line of the header row
        lines.forEach((l, i) => text(cellX(j), y0 + headH - size * 0.45 - (lines.length - 1 - i) * size * 1.25, l, { font: bold, size, align: align[j] }));
      });
      y += headH;
      const y1 = y;
      page.draw.push((p) => p.line(left, y1, left + tableW, y1, { width: 0.75 }));
    };
    ensure(headH + rh);
    header();
    b.rows.forEach((r) => {
      if (y + rh > bottom) {
        const yb = y;
        page.draw.push((p) => p.line(left, yb, left + tableW, yb, { width: 0.75 }));
        newPage();
        header();
      }
      const y0 = y;
      if (r.shade) page.draw.push((p) => p.rect(left, y0, tableW, rh, { fill: SHADE }));
      if (r.bold) page.draw.push((p) => p.line(left, y0, left + tableW, y0, { width: 0.5, color: RULE }));
      const font = r.bold ? bold : regular;
      for (let j = 0; j < n; j++) {
        const v = r.cells[j] ?? "";
        if (!v) continue;
        text(cellX(j), y0 + rh / 2 + size * 0.35, fitText(v, font, size, widths[j] - 2 * pad), { font, size, align: align[j] });
      }
      y += rh;
    });
    const yb = y;
    page.draw.push((p) => p.line(left, yb, left + tableW, yb, { width: 0.75 }));
    y += base;
  }

  // ---- contents
  const wantContents = o.contents ?? sections.length > 1;
  const lh = base * 1.6;
  const ts = base * 1.8;
  const perPage = Math.max(1, Math.floor((bottom - top - ts * 1.25 - base * 1.6) / lh));
  const contentsPages = wantContents ? Math.max(1, Math.ceil(entries.length / perPage)) : 0;
  const contents: ContentsEntry[] = entries.map((e) => ({ title: e.title, level: e.level, page: e.body + contentsPages, y: e.y }));

  const doc = new PdfDocument({ title: o.title, author: o.author });
  const total = contentsPages + pages.length;
  const footer = (p: PdfPageBuilder, i: number) => {
    const fy = H - M + 4;
    if (o.pageNumbers !== false) p.text(W - M, fy, `Page ${i + 1} of ${total}`, { font: regular, size: base * 0.8, color: GREY, align: "right" });
    if (o.footer) p.text(M, fy, fitText(o.footer, regular, base * 0.8, avail * 0.7), { font: regular, size: base * 0.8, color: GREY });
  };
  for (let c = 0; c < contentsPages; c++) {
    const p = doc.addPage(o.size ?? "A4", o.landscape);
    let cy = top;
    if (c === 0) {
      p.text(left, cy + ts, "Contents", { font: bold, size: ts });
      cy += ts * 1.25 + base * 1.6;
    }
    for (const e of contents.slice(c * perPage, (c + 1) * perPage)) {
      const font = e.level === 0 ? bold : regular;
      const indent = e.level * 16;
      const num = String(e.page + 1);
      const numW = textWidth(num, font, base);
      const room = avail - indent - numW - 12;
      const title = fitText(e.title, font, base, room);
      const tw = textWidth(title, font, base);
      p.text(left + indent, cy + base, title, { font, size: base });
      // dot leaders between the title and the number
      const dotW = textWidth(" .", regular, base);
      const dots = Math.floor((avail - indent - tw - numW - 8) / dotW);
      if (dots > 1) p.text(left + avail - numW - 4, cy + base, " .".repeat(dots), { font: regular, size: base, color: GREY, align: "right" });
      p.text(left + avail, cy + base, num, { font, size: base, align: "right" });
      cy += lh;
    }
    footer(p, c);
  }
  pages.forEach((lp, i) => {
    const p = doc.addPage(o.size ?? "A4", o.landscape);
    for (const d of lp.draw) d(p, contentsPages + i, total);
    footer(p, contentsPages + i);
  });

  // ---- outline
  if (contentsPages) doc.bookmark("Contents", 0);
  let sec: OutlineItem | undefined;
  let h1: OutlineItem | undefined;
  for (const e of contents) {
    if (e.level === 0) {
      sec = doc.bookmark(e.title, e.page, e.y);
      h1 = undefined;
    } else if (e.level === 1 || !h1) h1 = doc.bookmark(e.title, e.page, e.y, sec);
    else doc.bookmark(e.title, e.page, e.y, h1);
  }
  return { doc, contents };
}
