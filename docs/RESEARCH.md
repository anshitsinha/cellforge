# Research notes: compiling fill-down formulas

Working notes toward a paper. Numbers here are **preliminary** — one machine,
one browser, a handful of formulas — and are meant to show the shape of the
results, not to be quoted as final.

## The idea

Big spreadsheets are mostly tables, and their formulas are mostly the *same*
formula filled down a column: `=B2*C2*(1-D2)` on row 2, `=B3*C3*(1-D3)` on
row 3, and so on for a million rows. Spreadsheet engines store and evaluate
those as a million independent formulas.

cellforge instead:

1. **Stores a fill once.** Fill-down creates a single `Fill` (a template AST
   plus the row it's relative to), O(1) memory however many rows it covers.
   Row *v* evaluates the template with `rowShift = v - origin`.
2. **Compiles the template** to a loop over typed arrays (`compileFill`,
   `packages/core/src/formula/compile.ts`), generated as JS with
   `new Function` so V8 JITs it like hand-written code.
3. **Evaluates lazily in chunks** of 64K rows, only for rows something
   actually reads (the visible window, a SUM, a sort key), with an LRU cap.
4. Optionally **targets WebGPU** with the same codegen approach
   (`packages/gpu`).

## Correctness: the interpreter is the spec

The tree-walking interpreter (`evaluate.ts`) defines what a formula means.
The compiled kernel is only a fast path, under this contract:

> If the kernel's output for a row is finite, it is bit-identical to the
> interpreter's result for that row. Otherwise (NaN) the caller re-evaluates
> that row with the interpreter.

What makes this work:

- Inputs are encoded as numbers, blanks as 0, and *everything else* (text,
  booleans, errors, off-sheet refs) as NaN.
- Every arithmetic result is passed through `F(x) = (x - x === 0) ? x : NaN`,
  so an infinite intermediate can't turn into a finite answer (`1/(1/0)`).
- Division by zero, `MOD(x, 0)` → NaN (the interpreter says `#DIV/0!`).
- Comparisons poison to NaN when either side is NaN, because the interpreter
  compares text as text, which the kernel doesn't model.
- Where a ref's value *is* the result (`=B1`, an `IF` branch), a 0 is
  ambiguous (0 or blank?) and goes back to the interpreter.
- The interpreter does plain IEEE double arithmetic in a fixed order with no
  intermediate rounding, and the kernel emits the same operations in the same
  order — so results match bit for bit, not just approximately.

**Validation.** A property-based fuzz test (`packages/core/test/compile.test.ts`)
generates random formulas from the supported grammar over random sheets
containing blanks, zeros, text, numeric-looking text, booleans, error values
and 1e308 (overflow bait), and checks the contract on every row. Soak-tested at
5 seeds × 50,000 formulas × 60 rows with no violations. While it was being
written, it found three real bugs:

| Bug | Why it mattered |
| --- | --- |
| `MIN`/`MAX` helpers used `b < a ? b : a`; `NaN < a` is false, so a NaN argument was silently skipped | an error in one argument produced a plausible-looking number |
| `NaN ** 0` is `1` in JS | `POWER(error, 0)` came out as 1 instead of `#NUM!` |
| `args.map(num)` passed the array index as the `valuePos` flag | blank-vs-zero handling was applied to the wrong arguments |

## Preliminary performance

Setup: Brave (Chromium 157, headless), NVIDIA Turing GPU, Windows 11. Inputs
are random positive doubles with no blanks, so every row takes the fast path.
Median of 3 runs after a warm-up run. The interpreter is measured on 2M rows
and reported as a rate. GPU time is end to end (f64→f32 conversion, upload,
dispatch, readback); "compute" is the dispatch alone. Reproduce at
`/bench.html`.

### 16M rows

| Formula | Interpreter (M rows/s) | JS kernel (M rows/s) | JS speedup | WebGPU end-to-end (M rows/s) | GPU compute only (ms) | GPU max rel. error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `=A1*B1` | 27.9 | 167.4 | 6.0× | 103.9 | 4.5 | 1.7e-7 |
| `=A1*B1*(1-C1)` | 12.4 | 76.8 | 6.2× | 73.9 | 20.7 | **3.2e-1** |
| `=IF(A1>B1, SQRT(A1*B1), ROUND(A1/B1, 2))` | 3.0 | 55.8 | 18.4× | 68.9 | 50.7 | **8.3e-2** |
| `=ABS(A1-B1)^2+MOD(C1*100, 7)` | 4.0 | 36.0 | 9.1× | 80.9 | 4.7 | 5.0e-4 |
| `=MAX(A1,B1,C1)-MIN(A1,B1,C1)+A1*0.5` | 2.5 | 55.4 | 22.2× | 74.6 | 19.4 | 1.6e-7 |

In every run so far: 0 mismatches between JS kernel and interpreter, 0 fallback rows.

### Observations so far

1. **Compiling pays off a lot, more for richer formulas.** 6× for a single
   multiply, ~20× once there are function calls and branches — the
   interpreter's per-node overhead grows with the formula, the kernel's
   doesn't (much).
2. **GPU compute is fast; getting data to it isn't.** The dispatch itself is
   ~5–50 ms for 16M rows, but end to end the GPU only beats the JS kernel on
   the heaviest formula. Converting f64→f32 and copying over PCIe dominates.
   The GPU would only win across the board if columns lived on the GPU
   persistently (upload once, run many formulas).
3. **f32 isn't good enough for spreadsheets.** WebGPU has no f64. Most rows
   are within ~1e-7 relative error, but catastrophic cancellation (`1-C1`
   when C1 ≈ 1) gives up to 32% error, and `ROUND` flips results that sit
   near a rounding boundary. A spreadsheet can't silently show a wrong
   number, so GPU results would need error bounds, f64 emulation (double-f32),
   or CPU verification of risky rows.

## Next experiments

- [ ] Persistent GPU-resident columns: upload once, measure many formulas.
- [ ] Double-f32 ("df64") emulation on the GPU: cost vs exactness.
- [ ] Static error analysis to decide per formula whether f32 is safe.
- [ ] Compare against Excel / LibreOffice / Google Sheets recalculation on the
      same sheets (where they can load them at all).
- [ ] Fill-down *detection* for sheets imported with per-cell formulas
      (e.g. from .xlsx), not just fills created in the UI.
- [ ] Multi-threaded JS kernels (SharedArrayBuffer + workers).
- [ ] More machines, more browsers; report variance, not just medians.
