import type { Node } from "./ast";
import { roundHalfAway } from "./evaluate";

/**
 * Fill-down compiler: turn a formula that's been filled down a column into
 * one loop over typed arrays, instead of N separate interpreter calls.
 *
 *   =B2*C2*(1-D2)   filled down 100M rows
 *     becomes
 *   for (v = start; v < end; v++) out[v-start] = F(F(c0[v]*c1[v]) * F(1 - c2[v]))
 *
 * ## Correctness contract
 *
 * The interpreter (evaluate.ts) defines what a formula means. A kernel is
 * only a fast path, and it must never disagree with it:
 *
 *   if kernel(row) is finite, it is bit-identical to the interpreter's
 *   numeric result for that row.
 *
 * Anything the kernel can't decide cheaply - text inputs, booleans, errors,
 * division by zero, overflow, refs off the edge of the sheet - comes out as
 * NaN, and the caller re-evaluates just that row with the interpreter. Inputs
 * are pre-converted so blanks are 0 (as in the interpreter) and anything
 * non-numeric is NaN; every arithmetic result goes through F(), which turns
 * Infinity into NaN, so a non-finite intermediate can't be laundered into a
 * finite final answer (1/(1/0) would otherwise come out as 0).
 *
 * Bit-identical results fall out of using the same IEEE operations in the
 * same order as the interpreter - which is why the interpreter doesn't round
 * intermediate results.
 *
 * ## Supported subset
 *
 * Numbers, cell refs (relative or $-anchored), + - * / ^, unary - + %,
 * comparisons inside IF, and ABS SQRT INT ROUND MOD POWER MIN MAX SUM AVERAGE
 * with scalar arguments. Anything else (strings, ranges, other functions, a
 * formula whose result is a boolean) makes compileFill return null and the
 * fill is simply interpreted.
 */

/** A relative ref: reads row (v + offset) of column `col`. */
export interface ColumnInput {
  col: number;
  offset: number;
}

/** A $row-anchored ref: the same cell for every row, read once. */
export interface ScalarInput {
  col: number;
  row: number;
}

export type KernelFn = (
  cols: Float64Array[], // one per ColumnInput; index (row - lo)
  scalars: Float64Array, // one per ScalarInput
  out: Float64Array, // index (v - start)
  start: number, // first view row to compute
  end: number, // one past the last
  n: number, // rows in the sheet (refs outside [0, n) read as NaN)
  lo: number, // row that cols[i][0] corresponds to
) => void;

export interface CompiledFill {
  columns: ColumnInput[];
  scalars: ScalarInput[];
  run: KernelFn;
  /** Generated JS body, kept for debugging and for the paper's examples. */
  source: string;
  /** Smallest / largest relative offset, to size the input window. */
  minOffset: number;
  maxOffset: number;
}

class Unsupported extends Error {}

// Helpers the generated code closes over. Kept tiny so V8 inlines them.
const RUNTIME = {
  // finite or NaN - Infinity - Infinity is NaN, x - x is 0 for finite x
  F: (x: number) => (x - x === 0 ? x : NaN),
  // x ** 0 is 1 even for x = NaN, which would turn an error into a number.
  // Another fuzz-test find.
  P: (a: number, b: number) => (a !== a ? NaN : a ** b),
  // For a ref whose value *is* the result (=B1, or an IF branch). Inputs store
  // blanks as 0, but the interpreter returns blank (not 0) there - so a 0 is
  // ambiguous and goes back to the interpreter to decide.
  Z: (x: number) => (x === 0 ? NaN : x),
  ROUND: (x: number, d: number) => roundHalfAway(x, d),
  // MIN/MAX fold left exactly like the interpreter's numericFold. The b !== b
  // check matters: `NaN < a` is false, so without it a NaN argument (an
  // error / text / off-sheet ref) would be silently skipped instead of
  // forcing a fallback. The fuzz test caught this one.
  MIN: (a: number, b: number) => (b !== b ? b : b < a ? b : a),
  MAX: (a: number, b: number) => (b !== b ? b : b > a ? b : a),
};

/**
 * Compile a fill-down template. `origin` is the view row the template's refs
 * are written relative to (i.e. where rowShift is 0).
 */
export function compileFill(ast: Node, origin: number): CompiledFill | null {
  const columns: ColumnInput[] = [];
  const scalars: ScalarInput[] = [];
  const colIndex = new Map<string, number>();
  const scalarIndex = new Map<string, number>();
  let minOffset = 0;
  let maxOffset = 0;

  // Each use site gets its own temporary. Sharing one would break as soon as
  // expressions nest: in ((_d = r) === 0 ? NaN : l / _d), if `l` contains
  // another division it would overwrite _d before the outer one reads it.
  let temps = 0;
  const temp = () => `t${temps++}`;

  function ref(node: Extract<Node, { type: "ref" }>, valuePos: boolean): string {
    const read = refRead(node);
    return valuePos ? `Z(${read})` : read;
  }

  function refRead(node: Extract<Node, { type: "ref" }>): string {
    if (node.absRow) {
      const k = `${node.col},${node.row}`;
      let i = scalarIndex.get(k);
      if (i === undefined) {
        i = scalars.length;
        scalars.push({ col: node.col, row: node.row });
        scalarIndex.set(k, i);
      }
      return `s${i}`;
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
    // offset 0 is by far the common case (=B2*C2) and can't go out of bounds
    if (offset === 0) return `c${i}[v - lo]`;
    return `(v + ${offset} < 0 || v + ${offset} >= n ? NaN : c${i}[v + ${offset} - lo])`;
  }

  /**
   * Code for a numeric-valued expression. `valuePos` is true when this
   * expression's value is the cell's result as-is (top level, or an IF
   * branch) rather than an operand of arithmetic - that only changes how a
   * bare ref treats blanks, see Z above.
   */
  function num(node: Node, valuePos = false): string {
    switch (node.type) {
      case "number":
        // String(n) round-trips doubles exactly; parens keep "-1" safe
        return `(${String(node.value)})`;
      case "ref":
        return ref(node, valuePos);
      case "unary": {
        const a = num(node.arg);
        if (node.op === "-") return `(-${a})`;
        if (node.op === "+") return a;
        return `F(${a} / 100)`;
      }
      case "binary": {
        switch (node.op) {
          case "+":
          case "-":
          case "*":
            return `F(${num(node.left)} ${node.op} ${num(node.right)})`;
          case "/": {
            // x/0 is #DIV/0! in the interpreter; let it fall back
            const d = temp();
            return `((${d} = ${num(node.right)}) === 0 ? NaN : F(${num(node.left)} / ${d}))`;
          }
          case "^":
            return `F(P(${num(node.left)}, ${num(node.right)}))`;
          default:
            // comparisons/& produce booleans/strings - not a number
            throw new Unsupported();
        }
      }
      case "call":
        return call(node, valuePos);
      default:
        throw new Unsupported();
    }
  }

  /** Code for a condition: 1, 0, or NaN when undecidable. */
  function cond(node: Node): string {
    if (node.type === "binary" && ["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
      const op = node.op === "=" ? "===" : node.op === "<>" ? "!==" : node.op;
      const a = temp();
      const b = temp();
      // NaN in either side (text etc.) must poison the result - the
      // interpreter would compare as text, which we don't model
      return `((${a} = ${num(node.left)}) !== ${a} || (${b} = ${num(node.right)}) !== ${b} ? NaN : (${a} ${op} ${b} ? 1 : 0))`;
    }
    return num(node);
  }

  function call(node: Extract<Node, { type: "call" }>, valuePos: boolean): string {
    const args = node.args;
    // ranges as arguments mean "aggregate over many cells" - not this kernel
    if (args.some((a) => a.type === "range")) throw new Unsupported();
    const one = () => {
      if (args.length !== 1) throw new Unsupported();
      return num(args[0]);
    };
    switch (node.name) {
      case "ABS":
        return `Math.abs(${one()})`;
      case "SQRT":
        return `Math.sqrt(${one()})`; // sqrt(-1) is NaN -> interpreter gives #NUM!
      case "INT":
        return `Math.floor(${one()})`;
      case "ROUND": {
        if (args.length < 1 || args.length > 2) throw new Unsupported();
        return `F(ROUND(${num(args[0])}, ${args.length === 2 ? num(args[1]) : "0"}))`;
      }
      case "MOD": {
        if (args.length !== 2) throw new Unsupported();
        const m = temp();
        const x = temp();
        return `((${m} = ${num(args[1])}) === 0 ? NaN : F((${x} = ${num(args[0])}) - ${m} * Math.floor(${x} / ${m})))`;
      }
      case "POWER":
        if (args.length !== 2) throw new Unsupported();
        return `F(P(${num(args[0])}, ${num(args[1])}))`;
      case "SUM":
      case "AVERAGE": {
        if (args.length === 0) throw new Unsupported();
        // fold from 0 in argument order, exactly like numericFold
        const sum = args.reduce((acc, a) => `(${acc} + ${num(a)})`, "0");
        return node.name === "SUM" ? `F${sum}` : `F(F${sum} / ${args.length})`;
      }
      case "MIN":
      case "MAX": {
        if (args.length === 0) throw new Unsupported();
        // (not args.map(num) - map would pass the index as valuePos)
        return args.map((a) => num(a)).reduce((acc, a) => `${node.name}(${acc}, ${a})`);
      }
      case "IF": {
        // the 2-arg form returns FALSE (a boolean) when the condition fails
        if (args.length !== 3) throw new Unsupported();
        const c = temp();
        return `((${c} = ${cond(args[0])}) !== ${c} ? NaN : ${c} ? ${num(args[1], valuePos)} : ${num(args[2], valuePos)})`;
      }
      default:
        throw new Unsupported();
    }
  }

  let expr: string;
  try {
    expr = num(ast, true);
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }

  const source = [
    `const { F, Z, P, ROUND, MIN, MAX } = R;`,
    ...columns.map((_, i) => `const c${i} = cols[${i}];`),
    ...scalars.map((_, i) => `const s${i} = scalars[${i}];`),
    ...(temps ? [`let ${Array.from({ length: temps }, (_, i) => `t${i}`).join(", ")};`] : []),
    `for (let v = start; v < end; v++) {`,
    `  out[v - start] = ${expr};`,
    `}`,
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("R", `return function kernel(cols, scalars, out, start, end, n, lo) {\n${source}\n};`);
  return { columns, scalars, run: factory(RUNTIME) as KernelFn, source, minOffset, maxOffset };
}
