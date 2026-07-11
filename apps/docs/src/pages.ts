import { functionIndex, functionPages } from "./functions";

/**
 * Every markdown file under docs/ becomes a page. Guide and tutorial pages
 * are ordered by their file name (numbered ones first); developer pages put
 * the development guide first. The function reference is generated.
 */
const guideFiles = import.meta.glob("../../../docs/guide/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const tutorialFiles = import.meta.glob("../../../docs/tutorials/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const devFiles = import.meta.glob(["../../../docs/*.md", "../../../docs/dev/*.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type Section = "guide" | "tutorial" | "reference" | "dev";

/** How each section is labelled in the navigation and search results, in nav order. */
export const SECTIONS: { id: Section; label: string }[] = [
  { id: "tutorial", label: "Tutorials" },
  { id: "guide", label: "User guide" },
  { id: "reference", label: "Function reference" },
  { id: "dev", label: "Developer guide" },
];

export interface Page {
  section: Section;
  slug: string; // route segment, e.g. "02-editing" or "ARCHITECTURE"
  title: string;
  markdown: string;
}

const stem = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

function titleOf(markdown: string, fallback: string) {
  return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? fallback;
}

const DEV_ORDER = ["development", "VISION", "PLAN", "ARCHITECTURE", "USER-RESEARCH", "RESEARCH", "ROADMAP"];

const fromFiles = (section: Section, files: Record<string, string>): Page[] =>
  Object.entries(files)
    .map(([path, markdown]) => ({ section, slug: stem(path), title: titleOf(markdown, stem(path)), markdown }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

export const pages: Page[] = [
  ...fromFiles("tutorial", tutorialFiles),
  ...fromFiles("guide", guideFiles),
  ...[functionIndex(), ...functionPages()].map((p) => ({ section: "reference" as const, ...p })),
  ...fromFiles("dev", devFiles).sort((a, b) => {
    const ia = DEV_ORDER.indexOf(a.slug);
    const ib = DEV_ORDER.indexOf(b.slug);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.slug.localeCompare(b.slug);
  }),
];

export const planMarkdown = devFiles["../../../docs/PLAN.md"] ?? "";

export function findPage(section: string, slug: string): Page | undefined {
  return pages.find((p) => p.section === section && p.slug === slug);
}

/** Map a markdown link target (e.g. "PLAN.md", "../guide/02-editing.md") to a route. */
export function routeForLink(href: string): string | null {
  if (/^[a-z]+:|^#|^\//i.test(href)) return null;
  const [file, hash] = href.split("#");
  if (!file.endsWith(".md")) return null;
  const slug = stem(file);
  const page = pages.find((p) => p.slug === slug);
  return page ? `#/${page.section}/${page.slug}${hash ? `?h=${hash}` : ""}` : null;
}
