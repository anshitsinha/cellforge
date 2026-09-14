/**
 * A small set of stroke icons, drawn for cellforge on a 24×24 grid with a
 * 1.75 stroke in currentColor (so they take the text colour of whatever
 * holds them). Use at 16px in toolbars, menus and buttons, 20px in the rail.
 *
 *   button.append(icon("undo"), "Undo");                 // icon + label
 *   const b = iconButton("search", "Search (Ctrl+K)");    // icon-only, labelled
 *   el.innerHTML = iconSvg("check", { size: 20 });        // as a string
 *
 * An icon next to text is decorative (aria-hidden). An icon on its own
 * needs a name: pass `label`, or use iconButton(), which sets aria-label.
 */

/** Inner markup of each icon (24×24 view box, stroked unless a shape says otherwise). */
const PATHS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sparkles: '<path d="M11 3.5 12.9 9 18.5 11l-5.6 2L11 18.5 9.1 13 3.5 11l5.6-2z"/><path d="M19 3v4"/><path d="M17 5h4"/><path d="M19 17v3"/><path d="M17.5 18.5h3"/>',
  upload: '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  open: '<path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V10"/><path d="M3 7.5V18a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.6 12a1.5 1.5 0 0 0-1.4-2H8.2a2 2 0 0 0-1.9 1.4L3.5 19"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><path d="M7 21v-7h10v7"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  export: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1"/><path d="m8.2 13.2 7.6 4.1"/>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/>',
  sort: '<path d="M7 4v16"/><path d="m3 16 4 4 4-4"/><path d="M17 20V4"/><path d="m13 8 4-4 4 4"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 16v-4"/><path d="M12 16V8"/><path d="M16 16v-6"/>',
  pivot: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v18"/><path d="M13 13h4v4"/><path d="m13 17 4-4"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M10 10v10"/>',
  reconcile: '<path d="M4 8h14"/><path d="m15 5 3 3-3 3"/><path d="M20 16H6"/><path d="m9 13-3 3 3 3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  audit: '<path d="M9 3.5h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4.5"/>',
  shield: '<path d="M12 3 19 6v5.5c0 4.6-3 7.9-7 9.5-4-1.6-7-4.9-7-9.5V6z"/><path d="m9 12 2 2 4-4.5"/>',
  signoff: '<path d="M14.5 4.5 19.5 9.5"/><path d="M16.8 2.8a2.1 2.1 0 0 1 3 0l1.4 1.4a2.1 2.1 0 0 1 0 3L9 19.4 4 20.5l1.1-5z"/><path d="M13 20.5h8"/>',
  report: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="M9 17v-2.5"/><path d="M12 17v-5"/><path d="M15 17v-3.5"/>',
  settings: '<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><path d="M19 18h1"/><circle cx="17" cy="18" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .9-1 1.6v.4"/><path d="M12 17.2v.1"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m6 15 6-6 6 6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "chevron-left": '<path d="m15 6-6 6 6 6"/>',
  "arrow-left": '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7z"/>',
  document: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  scale: '<path d="M12 4v16"/><path d="M8 20h8"/><path d="M5 7h14"/><path d="M12 4.5 12 7"/><path d="m5 7-2.5 6a2.5 2.5 0 0 0 5 0z"/><path d="m19 7-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6v.1"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16 9.5"/>',
  warning: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 16.9v.1"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  formula: '<path d="M9.5 20c2 0 2.6-1.2 3-3.5l1.6-9c.4-2.3 1-3.5 3-3.5"/><path d="M8 10h8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof PATHS;

/** Every icon name, for pickers and tests. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Friendlier names some callers will reach for. */
const ALIASES: Record<string, IconName> = {
  ai: "sparkles",
  evidence: "shield",
  review: "signoff",
  sql: "database",
  scenario: "scale",
  x: "close",
  add: "plus",
  run: "play",
  delete: "trash",
  fx: "formula",
};

export interface IconOptions {
  /** px; 16 (default) or 20 */
  size?: number;
  /** a spoken name: makes the icon role="img" instead of decorative */
  label?: string;
  className?: string;
  /** stroke width in view-box units (default 1.75) */
  stroke?: number;
}

/** Resolve a name or alias; undefined for an unknown name. */
export function resolveIcon(name: string): IconName | undefined {
  if (name in PATHS) return name as IconName;
  return ALIASES[name];
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The icon as an SVG string (pure; usable without a DOM). Unknown names give an empty 16px box. */
export function iconSvg(name: IconName | string, opts: IconOptions = {}): string {
  const size = opts.size ?? 16;
  const key = resolveIcon(name);
  const body = key ? PATHS[key] : "";
  const a11y = opts.label ? `role="img" aria-label="${escapeAttr(opts.label)}"` : `aria-hidden="true" focusable="false"`;
  const cls = `cf-icon cf-icon-${key ?? "missing"}${opts.className ? ` ${escapeAttr(opts.className)}` : ""}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${opts.stroke ?? 1.75}" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

/** The icon as an element. */
export function icon(name: IconName | string, opts: IconOptions = {}): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = iconSvg(name, opts);
  return t.content.firstElementChild as SVGSVGElement;
}

/**
 * An icon-only button with a name for screen readers and a tooltip.
 * kind: "ghost" (default, for toolbars) or "secondary".
 */
export function iconButton(name: IconName | string, label: string, opts: { kind?: "ghost" | "secondary"; size?: "sm" | "md"; onClick?: (e: MouseEvent) => void } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn-${opts.kind ?? "ghost"} btn-icon${opts.size === "sm" ? " btn-sm" : ""}`;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(icon(name, { size: opts.size === "sm" ? 14 : 16 }));
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}
