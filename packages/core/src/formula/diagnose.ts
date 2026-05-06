/**
 * Why a lookup found nothing, when it nearly did: the classic silent #N/A
 * causes in exported data.
 */
import { CellError, errors, type ErrorHint, type RangeRef } from "./ast";
import type { Scalar } from "./arrays";

/** Spaces of every kind (including the non-breaking ones exports love) squeezed and trimmed. */
export const squeeze = (s: string) => s.replace(/[\s   ]+/g, " ").trim();

const numericText = (s: string): number | null => {
  const t = squeeze(s);
  return t !== "" && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : null;
};

/**
 * Look for near misses of `key` among the looked-up values. Returns a hint
 * for the first kind found, or null when it really isn't there.
 */
export function diagnoseMiss(
  key: Scalar,
  get: (i: number) => Scalar,
  n: number,
  where: { range: RangeRef; sheet?: string },
): ErrorHint | null {
  if (key === null || key instanceof CellError || typeof key === "boolean") return null;
  const limit = Math.min(n, 200_000);
  const keyNum = typeof key === "number" ? key : numericText(key);
  const keyText = typeof key === "string" ? squeeze(key).toLowerCase() : null;
  for (let i = 0; i < limit; i++) {
    const v = get(i);
    if (typeof key === "number" && typeof v === "string" && numericText(v) === key) {
      return {
        message: `${key} is in the list, but stored as text ("${v}"), so the lookup can't see it.`,
        fix: { kind: "toNumber", ...where, label: "Convert that column to numbers" },
      };
    }
    if (typeof key === "string" && typeof v === "number" && keyNum !== null && keyNum === v) {
      return { message: `The value you're looking for is text ("${key}") but the list holds the number ${v}. Wrap it in VALUE(), or store the key as a number.` };
    }
    if (typeof key === "string" && typeof v === "string" && keyText !== null && squeeze(v).toLowerCase() === keyText) {
      const extra = v !== squeeze(v) ? `"${v}" in the list has extra spaces` : `the value you're looking for has extra spaces`;
      return {
        message: `Found it except for spaces: ${extra}.`,
        ...(v !== squeeze(v) ? { fix: { kind: "trim" as const, ...where, label: "Trim the spaces in that column" } } : {}),
      };
    }
  }
  return null;
}

/** #N/A, explained when there's a near miss. */
export function notFound(key: Scalar, get: (i: number) => Scalar, n: number, where?: { range: RangeRef; sheet?: string }): CellError {
  if (!where) return errors.na;
  const hint = diagnoseMiss(key, get, n, where);
  return hint ? new CellError("#N/A", hint) : errors.na;
}
