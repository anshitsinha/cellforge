/**
 * Local full-text search over the docs: split every page into sections at
 * its headings, score sections by how many query words they contain (with
 * headings weighted up), and return the best passages. Runs entirely in the
 * page; nothing is sent anywhere.
 */
import type { Page } from "./pages";

export interface Passage {
  page: Page;
  heading: string;
  anchor: string;
  text: string;
  score: number;
}

interface Section {
  page: Page;
  heading: string;
  anchor: string;
  text: string;
  lower: string;
  headingLower: string;
}

const STOP = new Set("a an and are as at be by can do does for from how i in is it of on or the this to what when where which who why with you your".split(" "));

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function plain(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildIndex(pages: Page[]): Section[] {
  const sections: Section[] = [];
  for (const page of pages) {
    const parts = page.markdown.split(/^(?=#{1,3} )/m);
    for (const part of parts) {
      const heading = /^#{1,3} (.+)$/m.exec(part)?.[1].trim() ?? page.title;
      const text = plain(part.replace(/^#{1,3} .+$/m, ""));
      if (!text) continue;
      sections.push({ page, heading, anchor: slugify(heading), text, lower: text.toLowerCase(), headingLower: heading.toLowerCase() });
    }
  }
  return sections;
}

export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\w#/!?.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function search(index: Section[], query: string, limit = 8): Passage[] {
  const words = terms(query);
  if (!words.length) return [];
  const results: Passage[] = [];
  for (const s of index) {
    let score = 0;
    let matched = 0;
    for (const w of words) {
      const inHeading = s.headingLower.includes(w);
      const count = s.lower.split(w).length - 1;
      if (inHeading || count) matched++;
      score += (inHeading ? 4 : 0) + Math.min(count, 5);
    }
    if (!matched) continue;
    score *= matched / words.length; // reward covering every word
    if (s.page.section === "guide") score *= 1.3; // user answers first
    results.push({ page: s.page, heading: s.heading, anchor: s.anchor, text: snippet(s.text, words), score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(text: string, words: string[], radius = 110) {
  const lower = text.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)));
  const start = Math.max(0, at - radius / 2);
  const out = text.slice(start, start + radius * 2);
  return (start > 0 ? "…" : "") + out + (start + radius * 2 < text.length ? "…" : "");
}
