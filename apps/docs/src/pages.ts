import { functionReference } from "./functions";

/**
 * Every markdown file under docs/ becomes a page. Guide pages are ordered by
 * their numeric prefix; developer pages put the development guide first.
 */
const guideFiles = import.meta.glob("../../../docs/guide/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const devFiles = import.meta.glob(["../../../docs/*.md", "../../../docs/dev/*.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Page {
  section: "guide" | "dev";
  slug: string; // route segment, e.g. "02-editing" or "ARCHITECTURE"
  title: string;
  markdown: string;
}

const stem = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

function titleOf(markdown: string, fallback: string) {
  return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? fallback;
}

const DEV_ORDER = ["development", "VISION", "PLAN", "ARCHITECTURE", "USER-RESEARCH", "RESEARCH", "ROADMAP"];

export const pages: Page[] = [
  ...Object.entries(guideFiles)
    .map(([path, markdown]) => ({ section: "guide" as const, slug: stem(path), title: titleOf(markdown, stem(path)), markdown }))
    .sort((a, b) => a.slug.localeCompare(b.slug)),
  { section: "guide" as const, slug: "functions", title: "Function reference", markdown: functionReference() },
  ...Object.entries(devFiles)
    .map(([path, markdown]) => ({ section: "dev" as const, slug: stem(path), title: titleOf(markdown, stem(path)), markdown }))
    .sort((a, b) => {
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
