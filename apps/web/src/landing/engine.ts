/**
 * The engine functions the landing page's light demos run, imported from
 * their own modules rather than the @cellforge/core index. The index also
 * brings every file reader and writer (xlsx, pdf, parquet, sql…), which would
 * put the whole of core in the hero's download; these modules are small and
 * have no side effects, so only they are loaded.
 */
export { reconcile, type RecRecord, type RecResult, type RecRule, type RecMatch } from "../../../../packages/core/src/recon/match";
export { recStatement, type RecItem, type RecStatement } from "../../../../packages/core/src/recon/statement";
export { KEYING_LABEL } from "../../../../packages/core/src/recon/text";
export { dateToSerial, formatValue } from "../../../../packages/core/src/numfmt";
export { jeLines, runJeTests, JE_TEST_LABEL, type JeResult, type JeTestId } from "../../../../packages/core/src/jetest/journal";
export { benford, type BenfordResult } from "../../../../packages/core/src/audit/benford";
