/**
 * A tiny GBNF recogniser, for tests only: parses the grammar text and says
 * whether a string is in the language. Supports what toGbnf emits: string
 * literals, character classes, rule references, groups, alternation and
 * the ? * + {m,n} repetitions.
 */
type Node =
  | { t: "lit"; s: string }
  | { t: "cls"; neg: boolean; items: [number, number][] }
  | { t: "ref"; name: string }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "rep"; node: Node; min: number; max: number };

function unescape(src: string, i: number): [number, number] {
  // returns [char code, next index] for the character at src[i] (handles \ escapes)
  if (src[i] !== "\\") return [src.charCodeAt(i), i + 1];
  const c = src[i + 1];
  if (c === "x") return [parseInt(src.slice(i + 2, i + 4), 16), i + 4];
  const map: Record<string, number> = { n: 10, t: 9, r: 13 };
  return [map[c] ?? c.charCodeAt(0), i + 2];
}

export function parseGbnf(text: string): Map<string, Node> {
  const rules = new Map<string, Node>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf("::=");
    const name = line.slice(0, at).trim();
    const src = line.slice(at + 3);
    let i = 0;
    const ws = () => {
      while (src[i] === " ") i++;
    };
    const alt = (): Node => {
      const items = [seq()];
      ws();
      while (src[i] === "|") {
        i++;
        items.push(seq());
        ws();
      }
      return items.length === 1 ? items[0] : { t: "alt", items };
    };
    const seq = (): Node => {
      const items: Node[] = [];
      for (;;) {
        ws();
        if (i >= src.length || src[i] === "|" || src[i] === ")") break;
        let n = atom();
        ws();
        for (;;) {
          if (src[i] === "?") n = { t: "rep", node: n, min: 0, max: 1 };
          else if (src[i] === "*") n = { t: "rep", node: n, min: 0, max: Infinity };
          else if (src[i] === "+") n = { t: "rep", node: n, min: 1, max: Infinity };
          else if (src[i] === "{") {
            const end = src.indexOf("}", i);
            const [a, b] = src.slice(i + 1, end).split(",");
            n = { t: "rep", node: n, min: Number(a), max: b === undefined ? Number(a) : b === "" ? Infinity : Number(b) };
            i = end;
          } else break;
          i++;
        }
        items.push(n);
      }
      return items.length === 1 ? items[0] : { t: "seq", items };
    };
    const atom = (): Node => {
      if (src[i] === '"') {
        i++;
        let s = "";
        while (src[i] !== '"') {
          const [c, next] = unescape(src, i);
          s += String.fromCharCode(c);
          i = next;
        }
        i++;
        return { t: "lit", s };
      }
      if (src[i] === "[") {
        i++;
        const neg = src[i] === "^";
        if (neg) i++;
        const items: [number, number][] = [];
        while (src[i] !== "]") {
          const [a, n1] = unescape(src, i);
          i = n1;
          if (src[i] === "-" && src[i + 1] !== "]") {
            const [b, n2] = unescape(src, i + 1);
            items.push([a, b]);
            i = n2;
          } else items.push([a, a]);
        }
        i++;
        return { t: "cls", neg, items };
      }
      if (src[i] === "(") {
        i++;
        const n = alt();
        ws();
        i++; // )
        return n;
      }
      const m = /^[a-zA-Z0-9-]+/.exec(src.slice(i))!;
      i += m[0].length;
      return { t: "ref", name: m[0] };
    };
    rules.set(name, alt());
  }
  return rules;
}

/** Does `root` match the whole input? */
export function gbnfAccepts(grammar: string, input: string, root = "root"): boolean {
  const rules = parseGbnf(grammar);
  const memo = new Map<string, Set<number>>();
  const match = (n: Node, pos: number): Set<number> => {
    switch (n.t) {
      case "lit":
        return input.startsWith(n.s, pos) ? new Set([pos + n.s.length]) : new Set();
      case "cls": {
        if (pos >= input.length) return new Set();
        const c = input.charCodeAt(pos);
        const hit = n.items.some(([a, b]) => c >= a && c <= b);
        return hit !== n.neg ? new Set([pos + 1]) : new Set();
      }
      case "ref": {
        const key = `${n.name}@${pos}`;
        const hit = memo.get(key);
        if (hit) return hit;
        const rule = rules.get(n.name);
        if (!rule) throw new Error(`undefined rule ${n.name}`);
        memo.set(key, new Set()); // no left recursion in our grammars
        const out = match(rule, pos);
        memo.set(key, out);
        return out;
      }
      case "seq": {
        let cur = new Set([pos]);
        for (const item of n.items) {
          const next = new Set<number>();
          for (const p of cur) for (const q of match(item, p)) next.add(q);
          cur = next;
          if (!cur.size) break;
        }
        return cur;
      }
      case "alt": {
        const out = new Set<number>();
        for (const item of n.items) for (const q of match(item, pos)) out.add(q);
        return out;
      }
      case "rep": {
        const out = new Set<number>();
        let cur = new Set([pos]);
        if (n.min === 0) out.add(pos);
        for (let k = 1; k <= n.max && cur.size; k++) {
          const next = new Set<number>();
          for (const p of cur) for (const q of match(n.node, p)) if (q !== p) next.add(q);
          if (k >= n.min) for (const q of next) out.add(q);
          cur = next;
        }
        return out;
      }
    }
  };
  return match({ t: "ref", name: root }, 0).has(input.length);
}

/** Every rule referenced is defined. */
export function undefinedRules(grammar: string): string[] {
  const rules = parseGbnf(grammar);
  const missing = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === "ref" && !rules.has(n.name)) missing.add(n.name);
    if (n.t === "seq" || n.t === "alt") n.items.forEach(walk);
    if (n.t === "rep") walk(n.node);
  };
  for (const r of rules.values()) walk(r);
  return [...missing];
}
