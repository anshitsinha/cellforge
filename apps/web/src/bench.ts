import "./bench.css";
import { compileFill, evaluate, parseFormula, type EvalContext, type Scalar } from "@cellforge/core";
import { compileWgsl, GpuRunner } from "@cellforge/gpu";

/**
 * Interpreter vs compiled JS kernel vs WebGPU, on formulas filled down N
 * rows. This page is the evaluation harness for the fill-down compiler.
 */

const FORMULAS = [
  "=A1*B1",
  "=A1*B1*(1-C1)",
  "=IF(A1>B1, SQRT(A1*B1), ROUND(A1/B1, 2))",
  "=ABS(A1-B1)^2+MOD(C1*100, 7)",
  "=MAX(A1, B1, C1)-MIN(A1, B1, C1)+A1*0.5",
];

const INTERP_CAP = 2_000_000;

interface Row {
  formula: string;
  method: string;
  rows: number;
  medianMs: number;
  notes: string;
  speedup?: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const progress = $("progress");
const tbody = $("results").querySelector("tbody")!;
const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const results: Row[] = [];

const tick = () => new Promise((r) => setTimeout(r, 0));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function makeData(n: number): Float64Array[] {
  // deterministic xorshift so runs are comparable
  let s = 0x9e3779b9;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = 1 + rand() * 999;
    b[i] = 0.5 + rand() * 500;
    c[i] = rand();
  }
  return [a, b, c];
}

async function timeIt(runs: number, fn: () => void | Promise<void>): Promise<number[]> {
  await fn(); // warm up (JIT, pipeline creation)
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
    await tick();
  }
  return times;
}

function addRow(r: Row, first: boolean) {
  results.push(r);
  const tr = document.createElement("tr");
  if (first) tr.className = "first";
  const rate = r.rows / r.medianMs / 1000;
  tr.innerHTML = `
    <td>${first ? `<code>${r.formula}</code>` : ""}</td>
    <td>${r.method}</td>
    <td class="num">${fmt.format(r.rows / 1e6)}M</td>
    <td class="num">${fmt.format(r.medianMs)}</td>
    <td class="num">${fmt.format(rate)}</td>
    <td class="num ${r.speedup && r.speedup > 1 ? "speedup" : ""}">${r.speedup ? fmt.format(r.speedup) + "×" : "—"}</td>
    <td>${r.notes}</td>`;
  tbody.appendChild(tr);
}

async function run(n: number, runs: number, withInterp: boolean) {
  tbody.innerHTML = "";
  results.length = 0;
  $("results").hidden = false;

  progress.textContent = `generating ${fmt.format(n / 1e6)}M rows of data…`;
  await tick();
  const data = makeData(n);
  const gpu = await GpuRunner.create().catch(() => null);
  $("env").textContent =
    `${navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/)?.[0] ?? "browser"} · ` +
    `${navigator.hardwareConcurrency} threads · GPU: ${gpu ? gpu.adapterInfo : "WebGPU unavailable"}`;

  for (const formula of FORMULAS) {
    const ast = parseFormula(formula);
    let interpRate = 0;
    let first = true;

    // --- interpreter --------------------------------------------------------
    const interpRows = Math.min(n, INTERP_CAP);
    let interpOut: Scalar[] | null = null;
    if (withInterp) {
      progress.textContent = `${formula}: interpreter…`;
      await tick();
      const ctx: EvalContext = {
        cell: (r, c) => (c < 3 && r < n ? data[c][r] : null),
        eachInRange: () => {
          throw new Error("no ranges in benchmark formulas");
        },
      };
      const out: Scalar[] = new Array(interpRows);
      const times = await timeIt(runs, () => {
        for (let v = 0; v < interpRows; v++) out[v] = evaluate(ast, ctx, v);
      });
      interpOut = out;
      const ms = median(times);
      interpRate = interpRows / ms;
      addRow({ formula, method: "interpreter", rows: interpRows, medianMs: ms, notes: "tree walk, f64" }, first);
      first = false;
    }

    // --- compiled JS kernel ---------------------------------------------------
    progress.textContent = `${formula}: JS kernel…`;
    await tick();
    const k = compileFill(ast, 0);
    let jsOut: Float64Array | null = null;
    if (k) {
      const cols = k.columns.map(({ col }) => data[col]);
      const out = new Float64Array(n);
      const times = await timeIt(runs, () => k.run(cols, new Float64Array(0), out, 0, n, n, 0));
      jsOut = out;
      const ms = median(times);
      let mismatches = 0;
      let fallbacks = 0;
      for (let v = 0; v < n; v++) if (!(out[v] - out[v] === 0)) fallbacks++;
      if (interpOut) {
        for (let v = 0; v < interpRows; v++) {
          const x = out[v];
          if (x - x === 0 && !Object.is(x, interpOut[v])) mismatches++;
        }
      }
      addRow(
        {
          formula,
          method: "JS kernel",
          rows: n,
          medianMs: ms,
          speedup: interpRate ? n / ms / interpRate : undefined,
          notes: `f64 · ${interpOut ? `${mismatches} mismatches vs interpreter` : "not checked"} · ${fallbacks} fallback rows`,
        },
        first,
      );
      first = false;
    } else {
      addRow({ formula, method: "JS kernel", rows: 0, medianMs: NaN, notes: "not compilable" }, first);
      first = false;
    }

    // --- WebGPU ------------------------------------------------------------------
    const w = compileWgsl(ast, 0);
    if (gpu && w) {
      progress.textContent = `${formula}: WebGPU…`;
      await tick();
      const cols = w.columns.map(({ col }) => data[col]);
      let last: Awaited<ReturnType<GpuRunner["run"]>> | null = null;
      const computeTimes: number[] = [];
      const times = await timeIt(runs, async () => {
        last = await gpu.run(w, cols, [], n);
        computeTimes.push(last.timings.computeMs);
      });
      const ms = median(times);
      // error vs f64 kernel
      let maxRel = 0;
      let sumRel = 0;
      if (jsOut && last) {
        const g = (last as { out: Float32Array }).out;
        for (let v = 0; v < n; v++) {
          const ref = jsOut[v];
          if (!(ref - ref === 0)) continue;
          const rel = Math.abs(g[v] - ref) / Math.max(Math.abs(ref), 1e-12);
          if (rel > maxRel) maxRel = rel;
          sumRel += rel;
        }
      }
      addRow(
        {
          formula,
          method: "WebGPU (f32)",
          rows: n,
          medianMs: ms,
          speedup: interpRate ? n / ms / interpRate : undefined,
          notes: `compute ${fmt.format(median(computeTimes.slice(1)))} ms · max rel err ${maxRel.toExponential(1)} · mean ${(sumRel / n).toExponential(1)}`,
        },
        first,
      );
    } else {
      addRow({ formula, method: "WebGPU (f32)", rows: 0, medianMs: NaN, notes: gpu ? "not compilable" : "WebGPU unavailable" }, first);
    }
  }

  progress.textContent = "done.";
  $("copy").hidden = false;
  gpu?.destroy();
}

$("controls").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("run");
  btn.disabled = true;
  try {
    await run(
      Number($<HTMLSelectElement>("rows").value),
      Number($<HTMLInputElement>("runs").value),
      $<HTMLInputElement>("interp").checked,
    );
  } catch (err) {
    progress.textContent = `error: ${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
});

$("copy").addEventListener("click", async () => {
  const header = "formula,method,rows,median_ms,mrows_per_s,speedup_vs_interp,notes";
  const lines = results.map((r) =>
    [
      `"${r.formula}"`,
      r.method,
      r.rows,
      r.medianMs.toFixed(2),
      (r.rows / r.medianMs / 1000).toFixed(2),
      r.speedup?.toFixed(2) ?? "",
      `"${r.notes}"`,
    ].join(","),
  );
  await navigator.clipboard.writeText([header, ...lines].join("\n"));
  progress.textContent = "copied.";
});

// expose for automated runs
declare global {
  interface Window {
    runBench: typeof run;
    benchResults: Row[];
  }
}
window.runBench = run;
window.benchResults = results;
