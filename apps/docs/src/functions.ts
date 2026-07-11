import { EXAMPLE_CELLS, FUNCTION_INFO, signature, type FunctionCategory, type FunctionInfo } from "@cellforge/core";
import { slugify } from "./search";

/**
 * The function reference, generated from FUNCTION_INFO: the same data the
 * app's autocomplete and the AI use, so the three never disagree. Every
 * example shown is also run by the core test suite.
 *
 * One page per group, plus an index page with every function A to Z.
 */

export interface ReferencePage {
  /** route segment, e.g. "functions-lookup" */
  slug: string;
  title: string;
  markdown: string;
}

interface Group {
  key: string;
  title: string;
  intro: string;
}

/** The pages, in the order they are listed. */
export const GROUPS: Group[] = [
  { key: "lookup", title: "Lookup functions", intro: "Find a value in a table, pick an item from a list, count the rows or columns of a range." },
  { key: "maths", title: "Maths functions", intro: "Totals, rounding, conditional sums and the usual arithmetic." },
  { key: "statistics", title: "Statistics functions", intro: "Averages, counts, conditional counts, spread, ranks and percentiles." },
  { key: "text", title: "Text functions", intro: "Cut, join, tidy, search and convert text." },
  { key: "logical", title: "Logical functions", intro: "Decisions (IF, IFS, SWITCH), error handling, and naming parts of a formula with LET and LAMBDA." },
  { key: "financial", title: "Financial functions", intro: "Loans, annuities, present and future values, NPV and IRR, and depreciation." },
  { key: "dates", title: "Date and time functions", intro: "Build, take apart and count dates and times. Dates are serial numbers, as in Excel: 1 is 1 January 1900." },
  { key: "arrays", title: "Array functions", intro: "Functions that return a whole block of values, which spills into the cells below and to the right, and the LAMBDA helpers that work through an array." },
  { key: "information", title: "Information functions", intro: "Test what kind of value a cell holds." },
];

/** Each category's page. A Record, so a new category in core won't compile until it has a page. */
const CATEGORY_GROUP: Record<FunctionCategory, string> = {
  Lookup: "lookup",
  Maths: "maths",
  Statistics: "statistics",
  Text: "text",
  Logic: "logical",
  Financial: "financial",
  "Date and time": "dates",
  Information: "information",
};

/**
 * Functions that return arrays, or work through them with a LAMBDA, get
 * their own page whatever their category in core.
 */
export const ARRAY_FUNCTIONS = [
  "FILTER", "SORT", "SORTBY", "UNIQUE", "SEQUENCE", "TRANSPOSE", "TAKE", "DROP", "VSTACK", "HSTACK",
  "TOCOL", "TOROW", "CHOOSECOLS", "CHOOSEROWS", "MAP", "REDUCE", "SCAN", "BYROW", "BYCOL", "MAKEARRAY",
];

export const groupOf = (f: FunctionInfo): string => (ARRAY_FUNCTIONS.includes(f.name) ? "arrays" : CATEGORY_GROUP[f.category]);

export const slugOf = (group: string) => `functions-${group}`;

/** The heading id a function gets on its page. */
const anchorOf = (name: string) => slugify(name);

const linkTo = (f: FunctionInfo) => `[${f.name}](#/reference/${slugOf(groupOf(f))}?h=${anchorOf(f.name)})`;

const code = (s: string) => "`" + s + "`";
const cell = (v: string | number | boolean) => (typeof v === "boolean" ? String(v).toUpperCase() : String(v)).replace(/\|/g, "\\|");

function exampleCells(): string {
  return Object.entries(EXAMPLE_CELLS)
    .map(([ref, v]) => `${code(ref)} = ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join(", ");
}

function entry(f: FunctionInfo): string[] {
  const out = [`### ${f.name}`, "", code(signature(f)), "", f.summary, ""];
  if (f.args.length) {
    out.push("| Argument | What it is |", "| --- | --- |");
    for (const a of f.args) {
      const tags = [a.optional ? "optional" : "", a.repeats ? "can repeat" : ""].filter(Boolean).join(", ");
      out.push(`| ${code(a.name)}${tags ? ` (${tags})` : ""} | ${cell(a.description)} |`);
    }
  } else {
    out.push("No arguments.");
  }
  out.push("", "| Example | Result |", "| --- | --- |");
  for (const [formula, result] of f.examples) out.push(`| ${code(formula)} | ${cell(result)} |`);
  out.push("");
  if (f.notes) out.push(`> **Note:** ${f.notes}`, "");
  return out;
}

const byName = (a: FunctionInfo, b: FunctionInfo) => a.name.localeCompare(b.name);

/** One page per group, in GROUPS order. */
export function functionPages(): ReferencePage[] {
  const all = Object.values(FUNCTION_INFO);
  return GROUPS.map((g) => {
    const list = all.filter((f) => groupOf(f) === g.key).sort(byName);
    const out = [
      `# ${g.title}`,
      "",
      g.intro,
      "",
      `${list.length} functions: ${list.map(linkTo).join(", ")}.`,
      "",
      `The examples use these cells: ${exampleCells()}; A5 is empty. The test suite runs every example, so each result is exactly what cellforge gives.`,
      "",
    ];
    for (const f of list) out.push(...entry(f));
    return { slug: slugOf(g.key), title: g.title, markdown: out.join("\n") };
  });
}

/** The index page: the groups, then every function A to Z. */
export function functionIndex(): ReferencePage {
  const all = Object.values(FUNCTION_INFO).sort(byName);
  const out = [
    "# Function reference",
    "",
    `cellforge has ${all.length} functions, with more in every release. Each works as in Excel unless its entry has a note that says otherwise.`,
    "",
    "While you type a formula, cellforge suggests function names and shows each one's arguments, with the one you're on in bold.",
    "",
    "## By group",
    "",
    ...GROUPS.map((g) => `- [${g.title}](#/reference/${slugOf(g.key)}): ${g.intro}`),
    "",
    "## A to Z",
    "",
    "| Function | What it does |",
    "| --- | --- |",
    ...all.map((f) => `| ${linkTo(f)} | ${cell(f.summary)} |`),
    "",
  ];
  return { slug: "functions", title: "Function reference", markdown: out.join("\n") };
}
