import type { ColumnInput, Node, ScalarInput } from "@cellforge/core";

/**
 * WGSL code generation for fill-down formulas - the GPU twin of
 * core/formula/compile.ts, over the same formula subset.
 *
 * What's different from the JS kernel, on purpose:
 *
 * - **f32, not f64.** WGSL has no 64-bit floats. Results are approximate and
 *   the benchmark reports the error against the f64 kernel.
 * - **No exact fallback contract.** WGSL leaves NaN/Inf behaviour largely
 *   implementation-defined (compilers may assume they never happen), so we
 *   can't use NaN as a reliable "ask the interpreter" signal the way the JS
 *   kernel does. The GPU path is for clean numeric inputs; the app keeps
 *   using the JS kernel for correctness.
 * - **pow** is exp2(y * log2(x)) on most GPUs, so negative bases give NaN.
 * - **round** in WGSL is round-half-to-even; we emit Excel's half-away-from-
 *   zero explicitly.
 */

export interface WgslKernel {
  code: string;
  columns: ColumnInput[];
  scalars: ScalarInput[];
  minOffset: number;
  maxOffset: number;
}

export const WORKGROUP_SIZE = 256;

class Unsupported extends Error {}

function f32(n: number): string {
  // WGSL wants a decimal point or exponent for float literals
  if (!Number.isFinite(n)) throw new Unsupported();
  const s = String(n);
  return /[.eE]/.test(s) ? `f32(${s})` : `f32(${s}.0)`;
}

export function compileWgsl(ast: Node, origin: number): WgslKernel | null {
  const columns: ColumnInput[] = [];
  const scalars: ScalarInput[] = [];
  const colIndex = new Map<string, number>();
  const scalarIndex = new Map<string, number>();
  let minOffset = 0;
  let maxOffset = 0;

  function ref(node: Extract<Node, { type: "ref" }>): string {
    if (node.absRow) {
      const k = `${node.col},${node.row}`;
      let i = scalarIndex.get(k);
      if (i === undefined) {
        i = scalars.length;
        scalars.push({ col: node.col, row: node.row });
        scalarIndex.set(k, i);
      }
      return `scalars[${i}]`;
    }
    const offset = node.row - origin;
    const k = `${node.col},${offset}`;
    let i = colIndex.get(k);
    if (i === undefined) {
      i = columns.length;
      columns.push({ col: node.col, offset });
      colIndex.set(k, i);
      minOffset = Math.min(minOffset, offset);
      maxOffset = Math.max(maxOffset, offset);
    }
    // inputs are uploaded with the window already shifted so element 0 is
    // row `lo`; see runtime.ts
    return `in${i}[i32(row) + ${offset} - params.lo]`;
  }

  function num(node: Node): string {
    switch (node.type) {
      case "number":
        return f32(node.value);
      case "ref":
        return ref(node);
      case "unary": {
        const a = num(node.arg);
        if (node.op === "-") return `(-${a})`;
        if (node.op === "+") return a;
        return `(${a} / 100.0)`;
      }
      case "binary":
        if (["+", "-", "*", "/"].includes(node.op)) return `(${num(node.left)} ${node.op} ${num(node.right)})`;
        if (node.op === "^") return `pow(${num(node.left)}, ${num(node.right)})`;
        throw new Unsupported();
      case "call":
        return call(node);
      default:
        throw new Unsupported();
    }
  }

  function cond(node: Node): string {
    if (node.type === "binary" && ["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
      const op = node.op === "=" ? "==" : node.op === "<>" ? "!=" : node.op;
      return `(${num(node.left)} ${op} ${num(node.right)})`;
    }
    return `(${num(node)} != 0.0)`;
  }

  function call(node: Extract<Node, { type: "call" }>): string {
    const args = node.args;
    if (args.some((a) => a.type === "range")) throw new Unsupported();
    const one = () => {
      if (args.length !== 1) throw new Unsupported();
      return num(args[0]);
    };
    switch (node.name) {
      case "ABS":
        return `abs(${one()})`;
      case "SQRT":
        return `sqrt(${one()})`;
      case "INT":
        return `floor(${one()})`;
      case "ROUND": {
        if (args.length < 1 || args.length > 2) throw new Unsupported();
        return `round_half_away(${num(args[0])}, ${args.length === 2 ? num(args[1]) : "0.0"})`;
      }
      case "MOD": {
        if (args.length !== 2) throw new Unsupported();
        return `excel_mod(${num(args[0])}, ${num(args[1])})`;
      }
      case "POWER":
        if (args.length !== 2) throw new Unsupported();
        return `pow(${num(args[0])}, ${num(args[1])})`;
      case "SUM":
      case "AVERAGE": {
        if (args.length === 0) throw new Unsupported();
        const sum = `(${args.map((a) => num(a)).join(" + ")})`;
        return node.name === "SUM" ? sum : `(${sum} / ${f32(args.length)})`;
      }
      case "MIN":
      case "MAX": {
        if (args.length === 0) throw new Unsupported();
        const fn = node.name === "MIN" ? "min" : "max";
        return args.map((a) => num(a)).reduce((acc, a) => `${fn}(${acc}, ${a})`);
      }
      case "IF":
        if (args.length !== 3) throw new Unsupported();
        // select(falseValue, trueValue, condition)
        return `select(${num(args[2])}, ${num(args[1])}, ${cond(args[0])})`;
      default:
        throw new Unsupported();
    }
  }

  let expr: string;
  try {
    expr = num(ast);
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }

  const bindings = columns.map(
    (_, i) => `@group(0) @binding(${i + 3}) var<storage, read> in${i}: array<f32>;`,
  );

  const code = /* wgsl */ `
struct Params {
  start: u32,   // first row this dispatch computes
  count: u32,   // how many rows
  n: u32,       // rows in the sheet
  lo: i32,      // row that in*[0] corresponds to
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> scalars: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
${bindings.join("\n")}

fn round_half_away(x: f32, d: f32) -> f32 {
  let f = pow(10.0, trunc(d));
  return sign(x) * floor(abs(x) * f + 0.5) / f;
}

fn excel_mod(a: f32, b: f32) -> f32 {
  return a - b * floor(a / b);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(num_workgroups) groups: vec3<u32>) {
  // 2D dispatch so we can go past the 65535-workgroup limit per dimension
  let k = gid.x + gid.y * groups.x * ${WORKGROUP_SIZE}u;
  if (k >= params.count) { return; }
  let row = params.start + k;
  out[k] = ${expr};
}
`;

  return { code, columns, scalars, minOffset, maxOffset };
}
