/**
 * Goal Seek: find the input x that makes f(x) equal a target. Secant steps
 * (fast on smooth formulas), switching to bisection once the answer is
 * bracketed and the secant misbehaves, and searching outwards for a
 * bracket when it can't make progress.
 */

export interface GoalSeekOptions {
  /** Close enough: |f(x) - target| at or below this. Default 1e-7 times the larger of 1 and |target|. */
  tolerance?: number;
  /** Most steps to try. Default 100. */
  maxIter?: number;
}

export interface GoalSeekResult {
  converged: boolean;
  /** The best input found (the answer when converged). */
  x: number;
  /** f(x). */
  value: number;
  iterations: number;
  /** Why it stopped without converging, in plain words. */
  reason?: string;
}

export function goalSeek(f: (x: number) => number, target: number, start: number, opts: GoalSeekOptions = {}): GoalSeekResult {
  const tol = opts.tolerance ?? 1e-7 * Math.max(1, Math.abs(target));
  const maxIter = opts.maxIter ?? 100;
  const g = (x: number): number => {
    let y: number;
    try {
      y = f(x);
    } catch {
      return NaN;
    }
    return typeof y === "number" ? y - target : NaN;
  };
  if (!Number.isFinite(start)) start = 0;
  let x0 = start;
  let g0 = g(x0);
  if (!Number.isFinite(g0)) return { converged: false, x: start, value: NaN, iterations: 0, reason: "The formula doesn't give a number with the starting value." };
  let best = { x: x0, g: g0 };
  const done = (x: number, gx: number, iterations: number): GoalSeekResult => ({ converged: true, x, value: gx + target, iterations });
  if (Math.abs(g0) <= tol) return done(x0, g0, 0);

  // a bracket [lo, hi] with g(lo) and g(hi) of opposite signs, once one is seen
  let lo = NaN;
  let hi = NaN;
  let glo = NaN;
  /** Take in a new point (x, gx); (px, pgx) is the one before it. */
  const note = (x: number, gx: number, px: number, pgx: number) => {
    if (!Number.isFinite(gx)) return;
    if (Math.abs(gx) < Math.abs(best.g)) best = { x, g: gx };
    if (Number.isNaN(lo)) {
      if (Math.sign(gx) !== Math.sign(pgx) && x !== px) {
        [lo, hi] = x < px ? [x, px] : [px, x];
        glo = x < px ? gx : pgx;
      }
      return;
    }
    if (x <= lo || x >= hi) return;
    if (Math.sign(gx) === Math.sign(glo)) {
      lo = x;
      glo = gx;
    } else hi = x;
  };

  const h = Math.max(Math.abs(start) * 0.01, 0.01);
  let x1 = start + h;
  let g1 = g(x1);
  if (!Number.isFinite(g1)) {
    x1 = start - h;
    g1 = g(x1);
  }
  if (!Number.isFinite(g1)) return { converged: false, x: start, value: g0 + target, iterations: 1, reason: "The formula doesn't give a number near the starting value." };
  note(x1, g1, x0, g0);
  let width = Number.isNaN(lo) ? Infinity : hi - lo;
  let stalls = 0;

  for (let iter = 1; iter <= maxIter; iter++) {
    if (Math.abs(g1) <= tol) return done(x1, g1, iter);
    const bracketed = !Number.isNaN(lo);
    let next = g1 !== g0 ? x1 - (g1 * (x1 - x0)) / (g1 - g0) : NaN;
    if (bracketed) {
      // stay inside the bracket, and bisect when the secant stops shrinking it
      if (!Number.isFinite(next) || next <= lo || next >= hi || stalls >= 2) {
        next = (lo + hi) / 2;
        stalls = 0;
      }
    } else if (!Number.isFinite(next) || Math.abs(next - x1) > 1e6 * Math.max(1, Math.abs(x1))) {
      // flat or wild: step further out in the direction that helped
      const dir = Math.abs(g1) < Math.abs(g0) ? Math.sign(x1 - x0) || 1 : -(Math.sign(x1 - x0) || 1);
      next = x1 + dir * Math.max(Math.abs(x1 - x0) * 2, h);
    }
    let gn = g(next);
    // no number there (a #DIV/0!, a square root of a negative): back off towards x1
    for (let k = 0; k < 30 && !Number.isFinite(gn); k++) {
      next = (next + x1) / 2;
      gn = g(next);
    }
    if (!Number.isFinite(gn)) break;
    note(next, gn, x1, g1);
    x0 = x1;
    g0 = g1;
    x1 = next;
    g1 = gn;
    if (!Number.isNaN(lo)) {
      const w = hi - lo;
      stalls = w > width / 2 ? stalls + 1 : 0;
      width = w;
      if (w <= 4 * Number.EPSILON * Math.max(1, Math.abs(lo), Math.abs(hi)) && Math.abs(g1) > tol) {
        return { converged: false, x: x1, value: g1 + target, iterations: iter, reason: "The result jumps past the target here instead of reaching it." };
      }
    }
  }
  if (Math.abs(g1) <= tol) return done(x1, g1, maxIter);
  return {
    converged: false,
    x: best.x,
    value: best.g + target,
    iterations: maxIter,
    reason: Number.isNaN(lo) ? "Couldn't find a value that reaches the target. Try a different starting value." : "Didn't get close enough in the steps allowed.",
  };
}
