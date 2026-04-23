import { EXAMPLE_CELLS, FUNCTION_INFO, signature, type FunctionInfo } from "@cellforge/core";

const code = (s: string) => "`" + s + "`";
const cell = (v: string | number | boolean) => (typeof v === "boolean" ? String(v).toUpperCase() : String(v)).replace(/\|/g, "\\|");

/**
 * The function reference, generated from the same data the app's
 * autocomplete and the AI use, so the three never disagree.
 */
export function functionReference(): string {
  const cats = new Map<string, FunctionInfo[]>();
  for (const f of Object.values(FUNCTION_INFO)) cats.set(f.category, [...(cats.get(f.category) ?? []), f]);
  const cells = Object.entries(EXAMPLE_CELLS)
    .map(([ref, v]) => `${code(ref)} = ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join(", ");
  const out: string[] = [
    "# Function reference",
    "",
    `${Object.keys(FUNCTION_INFO).length} functions so far, with more in every release. Each example below is run by the test suite, so it shows exactly what cellforge gives.`,
    "",
    `The examples use these cells: ${cells}; A5 is empty.`,
    "",
    "While typing a formula, cellforge suggests function names as you type and shows each one's arguments, with the one you're on in bold.",
    "",
  ];
  for (const [cat, list] of [...cats].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`## ${cat}`, "");
    for (const f of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`### ${f.name}`, "", code(signature(f)), "", f.summary, "");
      out.push("| Argument | |", "| --- | --- |");
      for (const a of f.args) out.push(`| ${a.name}${a.optional ? " (optional)" : ""} | ${cell(a.description)} |`);
      out.push("", "| Example | Result |", "| --- | --- |");
      for (const [formula, result] of f.examples) out.push(`| ${code(formula)} | ${cell(result)} |`);
      out.push("");
      if (f.notes) out.push(`> ${f.notes}`, "");
    }
  }
  return out.join("\n");
}
