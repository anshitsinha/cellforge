// The acceptance test at any size, with time per stage and memory.
// Run with (from the repo root):
//   node --max-old-space-size=12288 --import ./bench/acceptance/register.mjs bench/acceptance/run.ts 6000000
// Arguments: total rows (default 6,000,000), seed (optional), --no-statement-check
import { failures, formatReport, runAcceptance } from "./pipeline";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rows = Number(args[0] ?? 6_000_000);
const seed = args[1] !== undefined ? Number(args[1]) : undefined;
const statementCheck = !process.argv.includes("--no-statement-check");

const t0 = performance.now();
const rep = runAcceptance({
  rows,
  seed,
  statementCheck,
  onStage: (s) => process.stderr.write(`  ${s.name}: ${s.ms} ms, heap ${s.heapMB} MB, rss ${s.rssMB} MB\n`),
});
console.log(formatReport(rep));
console.log(`total ${Math.round(performance.now() - t0)} ms`);
const fails = failures(rep);
if (fails.length) {
  console.log("\nNOT MET:\n" + fails.map((f) => "  - " + f).join("\n"));
  process.exitCode = 1;
} else console.log("\nall thresholds met");
