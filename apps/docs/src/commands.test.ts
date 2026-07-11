/**
 * The tutorials and migration guides name command palette entries. This
 * checks every one of them exists in the app, and that a command not built
 * yet is marked "(coming soon)", so the docs never promise a command that
 * isn't there (and say so once it is).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Every string literal inside paletteCommands(): the titles, among other things. */
function paletteStrings(): Set<string> {
  const app = read("apps/web/src/app.ts");
  const start = app.indexOf("function paletteCommands(");
  const end = app.indexOf("setupPalette(", start);
  expect(start).toBeGreaterThan(0);
  return new Set([...app.slice(start, end).matchAll(/"([^"\n]+)"/g)].map((m) => m[1]));
}

/** Commands the docs describe before they're built. */
const COMING_SOON = ["Pivot table…", "Join two sheets…", "Compare two versions by key…"];

/** Commands without a trailing "…" that the pages below name. */
const NAMED = ["Show history and versions", "Number format: Percent", "Number format: Number", "Export Excel (.xlsx)", "Export CSV", "Load the 100M-row demo", "Circle invalid data", "Fill down"];

const pages = [
  ...readdirSync(new URL("docs/tutorials/", root)).map((f) => `docs/tutorials/${f}`),
  "docs/guide/moving-from-excel.md",
  "docs/guide/moving-from-idea-acl.md",
  "docs/guide/audit-test-catalogue.md",
];

describe("commands named in the tutorials and migration guides", () => {
  const titles = paletteStrings();

  it("knows the palette", () => {
    expect(titles.has("Reconcile two sheets…")).toBe(true);
  });

  for (const page of pages) {
    it(`${page}: every "…" command exists, or is marked coming soon`, () => {
      const md = read(page);
      const paragraphs = md.split(/\n\s*\n/);
      for (const para of paragraphs) {
        for (const m of para.matchAll(/\*\*([^*\n]+…)\*\*/g)) {
          const name = m[1];
          if (COMING_SOON.includes(name)) expect(para, `${name} needs "(coming soon)" next to it`).toContain("(coming soon)");
          else expect(titles.has(name), `${page}: no palette command called "${name}"`).toBe(true);
        }
      }
    });
  }

  it("the other commands the pages name exist", () => {
    const formats = read("apps/web/src/formatbar.ts"); // "Number format: <name>" for each of NUMBER_FORMATS
    for (const name of NAMED) {
      const fmt = /^Number format: (.+)$/.exec(name);
      if (fmt) expect(formats, name).toContain(`["${fmt[1]}", `);
      else expect(titles.has(name), name).toBe(true);
    }
  });

  it("coming-soon commands aren't in the app yet (when one lands, remove its coming-soon notes)", () => {
    for (const name of COMING_SOON) expect(titles.has(name), `"${name}" is in the app now: drop "(coming soon)" from the docs`).toBe(false);
  });
});
