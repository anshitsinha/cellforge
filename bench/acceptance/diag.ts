// Matching diagnostics without the CSV round trip: generate the month, build
// the records straight from the generator (as the pipeline would read them),
// reconcile, score, and break the wrong matches down by planted category.
//   node --max-old-space-size=8000 --import ./bench/acceptance/register.mjs bench/acceptance/diag.ts 6000000
import { reconcile, type RecRecord } from "../../packages/core/src/recon/match";
import { recStatement } from "../../packages/core/src/recon/statement";
import { bankRef, bankText, CATEGORY_LIST, closingCents, generate, ledgerRef, ledgerText } from "./generate";
import { score } from "./pipeline";

const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rows = Number(pos[0] ?? 6_000_000);
const seed = pos[1] !== undefined ? Number(pos[1]) : undefined;
const g = generate({ rows, seed });
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const base = 45716; // 1 Mar 2025 - 1
const ledger: RecRecord[] = [];
for (let i = 0; i < g.ledger.n; i++) ledger.push({ row: i, key: ledgerRef(g.ledger.style[i], g.ledger.ref[i]), text: ledgerText(g.ledger, i), date: base + g.ledger.day[i], amount: g.ledger.cents[i] / 100 });
const bank: RecRecord[] = [];
for (let j = 0; j < g.bank.n; j++) {
  const r: RecRecord = { row: j, text: bankText(g.bank, j, `${String(g.bank.day[j]).padStart(2, "0")}${MON[g.month - 1]}`), date: base + g.bank.day[j], amount: g.bank.cents[j] / 100 };
  const k = bankRef(g.bank.style[j], g.bank.variant[j], g.bank.ref[j]);
  if (k) r.key = k;
  bank.push(r);
}
const t = performance.now();
const r = reconcile(ledger, bank);
console.log(`reconcile ${Math.round(performance.now() - t)} ms`);
const cc = closingCents(g);
const st = recStatement(r, ledger, bank, { bankBalance: cc.bank / 100, ledgerBalance: cc.ledger / 100 });
const idA = Int32Array.from({ length: g.ledger.n }, (_, i) => i);
const idB = Int32Array.from({ length: g.bank.n }, (_, j) => j);
const sc = score(g, r, st, idA, idB);
for (const c of sc.categories) console.log(`${c.category.padEnd(14)} ${String(c.planted).padStart(8)} ${String(c.found).padStart(8)} ${(c.recall * 100).toFixed(1).padStart(6)}%  need ${(c.threshold * 100).toFixed(0)}%${c.recall + 1e-12 < c.threshold ? "  FAIL" : ""}`);
for (const x of sc.rules) console.log(`${x.rule.padEnd(12)} ${String(x.matches).padStart(8)} ${String(x.correct).padStart(8)} ${(x.precision * 100).toFixed(2)}%`);
console.log(`wrong ${sc.wrongMatches} (interchangeable ${sc.interchangeable}); flags ${sc.flags} false ${sc.falseFlags}; dups ${sc.duplicates} false ${sc.falseDuplicates}; diff ${st.difference}`);
// wrong matches by rule and the categories of their two sides
const catA = (i: number) => CATEGORY_LIST[g.groupCat[g.ledger.group[i]]];
const catB = (j: number) => CATEGORY_LIST[g.bank.group[j] >= 0 ? g.groupCat[g.bank.group[j]] : 0];
const tally = new Map<string, number>();
const samples = new Map<string, string[]>();
for (const m of r.matches) {
  const grp = m.a.length ? g.ledger.group[m.a[0]] : g.bank.group[m.b[0]];
  const ok = m.a.every((i) => g.ledger.group[i] === grp) && m.b.every((j) => g.bank.group[j] === grp) && m.a.length === g.groupA[grp] && m.b.length === g.groupB[grp];
  if (ok) continue;
  const k = `${m.rule}: ${[...new Set(m.a.map(catA))].join("+")} x ${[...new Set(m.b.map(catB))].join("+")}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
  const ss = samples.get(k) ?? [];
  if (ss.length < 3) ss.push(`${m.a.map((i) => `[${ledger[i].key} | ${ledger[i].text} | ${ledger[i].amount} d${g.ledger.day[i]}]`).join(" ")} ~ ${m.b.map((j) => `[${bank[j].key ?? ""} | ${bank[j].text} | ${bank[j].amount} d${g.bank.day[j]}]`).join(" ")}`);
  samples.set(k, ss);
}
for (const [k, v] of [...tally].sort((x, y) => y[1] - x[1])) {
  console.log(`${String(v).padStart(7)}  ${k}`);
  for (const s of samples.get(k)!) console.log(`           ${s}`);
}
// why planted groups of a category were missed: what happened to each of their lines
const why = process.argv.find((a) => a.startsWith("--why="))?.slice(6).split(",") ?? [];
if (why.length) {
  const mA = new Int32Array(g.ledger.n).fill(-1);
  const mB = new Int32Array(g.bank.n).fill(-1);
  r.matches.forEach((m, k) => {
    for (const i of m.a) mA[i] = k;
    for (const j of m.b) mB[j] = k;
  });
  const misA = new Set(r.mismatched.map((p) => p.a));
  const misB = new Set(r.mismatched.map((p) => p.b));
  const flA = new Map<number, string>();
  const flB = new Map<number, string>();
  for (const f of r.flags) {
    flA.set(f.a, `flag ${f.field}/${f.kind} with ${catB(f.b)}`);
    flB.set(f.b, `flag ${f.field}/${f.kind} with ${catA(f.a)}`);
  }
  const dA = new Map<number, number>();
  const dB = new Map<number, number>();
  for (const d of r.duplicates) for (const k of d.items) (d.side === "A" ? dA : dB).set(k, d.items.length);
  const lnA = new Map<number, string>();
  const lnB = new Map<number, string>();
  for (const l of [...st.bankLines, ...st.ledgerLines])
    for (const it of l.items) {
      for (const i of it.a) lnA.set(i, l.id);
      for (const j of it.b) lnB.set(j, l.id);
    }
  const where = (side: "A" | "B", k: number): string => {
    const m = side === "A" ? mA[k] : mB[k];
    if (m >= 0) {
      const x = r.matches[m];
      return `matched(${x.rule} with ${side === "A" ? x.b.map((j) => catB(j)).join("+") : x.a.map((i) => catA(i)).join("+")})`;
    }
    if ((side === "A" ? misA : misB).has(k)) return "mismatched";
    const f = (side === "A" ? flA : flB).get(k);
    const d = (side === "A" ? dA : dB).get(k);
    const l = (side === "A" ? lnA : lnB).get(k);
    return `unmatched [${[f, d ? `dup x${d}` : undefined, l].filter(Boolean).join("; ")}]`;
  };
  const linesA = new Map<number, number[]>();
  const linesB = new Map<number, number[]>();
  for (let i = 0; i < g.ledger.n; i++) (linesA.get(g.ledger.group[i]) ?? linesA.set(g.ledger.group[i], []).get(g.ledger.group[i])!).push(i);
  for (let j = 0; j < g.bank.n; j++) (linesB.get(g.bank.group[j]) ?? linesB.set(g.bank.group[j], []).get(g.bank.group[j])!).push(j);
  for (const c of why) {
    const ids = sc.missed[c as keyof typeof sc.missed] ?? [];
    const kinds = new Map<string, number>();
    const ex = new Map<string, string>();
    for (const grp of ids) {
      const parts: string[] = [];
      let sample = "";
      for (const i of linesA.get(grp) ?? []) {
        parts.push("A:" + where("A", i));
        sample += ` A[${ledger[i].key} ${ledger[i].text} ${ledger[i].amount} d${g.ledger.day[i]}]`;
      }
      for (const j of linesB.get(grp) ?? []) {
        parts.push("B:" + where("B", j));
        sample += ` B[${bank[j].text} ${bank[j].amount} d${g.bank.day[j]}]`;
      }
      const k = parts.join(" | ");
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      if (!ex.has(k)) ex.set(k, sample);
    }
    console.log(`\n${c}: ${ids.length} missed`);
    for (const [k, v] of [...kinds].sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`${String(v).padStart(7)}  ${k}\n           ${ex.get(k)}`);
  }
}
