/** Building small PDFs for tests: objects in order, a page tree, fonts. */
export async function deflate(text: string): Promise<string> {
  const s = new Blob([Uint8Array.from(text, (c) => c.charCodeAt(0))]).stream().pipeThrough(new CompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>);
  const b = new Uint8Array(await new Response(s).arrayBuffer());
  let out = "";
  for (const x of b) out += String.fromCharCode(x);
  return out;
}

export function stream(dict: string, data: string): string {
  return `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
}

/** objects[i] becomes object i+1. Object 1 must be the catalog. */
export function pdf(objects: (string | null)[]): Uint8Array {
  let out = "%PDF-1.5\n%\xe2\xe3\xcf\xd3\n";
  objects.forEach((o, i) => {
    if (o === null) return; // supplied by an object stream
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  out += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/** A page's content: text pieces at (x, y-from-top) in Helvetica (font F1), size 10. */
export function textContent(pieces: [number, number, string][], height = 792): string {
  return pieces
    .map(([x, y, t]) => `BT /F1 10 Tf 1 0 0 1 ${x} ${height - y} Tm (${t.replace(/([()\\])/g, "\\$1")}) Tj ET`)
    .join("\n");
}

/** A one-font, n-page PDF whose pages hold the given content streams. */
export function simplePdf(contents: string[], compressed?: string[]): Uint8Array {
  const n = contents.length;
  // 1 catalog, 2 pages, 3 font, then per page: page obj, content obj
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const kids: string[] = [];
  contents.forEach((c, i) => {
    const pageNum = objs.length + 1;
    kids.push(`${pageNum} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNum + 1} 0 R >>`);
    objs.push(compressed?.[i] !== undefined ? stream("/Filter /FlateDecode", compressed[i]) : stream("", c));
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  return pdf(objs);
}
