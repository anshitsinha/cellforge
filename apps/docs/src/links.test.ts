import { describe, expect, it } from "vitest";
import { pages } from "./pages";
import { slugify } from "./search";

/** The heading anchors on a page, as the renderer makes them. */
const anchors = (md: string) => new Set([...md.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6} (.+)$/gm)].map((m) => slugify(m[1].replace(/[*`]/g, ""))));

describe("links between docs pages", () => {
  it("lists the tutorials, the guide, the generated reference and the developer pages", () => {
    const sections = new Set(pages.map((p) => p.section));
    expect([...sections].sort()).toEqual(["dev", "guide", "reference", "tutorial"]);
    expect(pages.filter((p) => p.section === "tutorial").map((p) => p.slug)).toEqual(["01-monthly-close", "02-bank-reconciliation", "03-audit-tests"]);
  });

  for (const page of pages) {
    it(`${page.section}/${page.slug}: every #/ link goes to a page and heading that exist`, () => {
      for (const m of page.markdown.matchAll(/\]\(#\/([a-z]+)\/([^)?#\s]+)(?:\?h=([^)\s]+))?\)/g)) {
        const [, section, slug, h] = m;
        const target = pages.find((p) => p.section === section && p.slug === slug);
        expect(target, `${m[0]} on ${page.slug}`).toBeDefined();
        if (h) expect(anchors(target!.markdown).has(h), `${m[0]}: no heading with id ${h}`).toBe(true);
      }
    });
  }
});
