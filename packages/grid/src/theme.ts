import type { StyleRole, Theme } from "./types";

/**
 * Pull colours from CSS custom properties on the container so the canvas
 * matches whatever the app's stylesheet says (including dark mode).
 *
 * In a forced-colours mode (Windows High Contrast and the like) the page's
 * own colours are replaced by the user's system colours, but a canvas is
 * just pixels and isn't touched; so the grid paints with those system
 * colours itself.
 */
export function readTheme(el: HTMLElement): Theme {
  if (typeof matchMedia === "function" && matchMedia("(forced-colors: active)").matches) {
    return forcedColorsTheme((name) => resolveSystemColor(el, name));
  }
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;

  return {
    background: v("--bg", LIGHT.background),
    headerBackground: v("--panel", LIGHT.headerBackground),
    gridLine: v("--border", LIGHT.gridLine),
    text: v("--text", LIGHT.text),
    mutedText: v("--muted", LIGHT.mutedText),
    accent: v("--accent", LIGHT.accent),
  };
}

/**
 * The fallback light theme. Text colours pass WCAG AA (4.5:1) on both the
 * background and the header background: text 14.7:1, muted 4.9:1, accent
 * 5.0:1 (#1a73e8 was 4.2:1 on the header and failed).
 */
export const LIGHT: Theme = {
  background: "#ffffff",
  headerBackground: "#f6f7f9",
  gridLine: "#dadce0",
  text: "#1f2328",
  mutedText: "#656d76",
  accent: "#1967d2",
};

/** The dark theme the app's stylesheet uses (all text at least 5.2:1). */
export const DARK: Theme = {
  background: "#1e1f22",
  headerBackground: "#2b2d31",
  gridLine: "#3f4147",
  text: "#e3e5e8",
  mutedText: "#9aa0a6",
  accent: "#8ab4f8",
};

/**
 * A theme built from CSS system colours (Canvas, CanvasText, GrayText,
 * Highlight...). `resolve` turns a system colour name into something the
 * canvas can paint (rgb()); pure so it can be tested.
 */
export function forcedColorsTheme(resolve: (systemColor: string) => string): Theme {
  return {
    background: resolve("Canvas"),
    headerBackground: resolve("ButtonFace"),
    // grid lines in the text colour: GrayText can be too faint to see
    gridLine: resolve("CanvasText"),
    text: resolve("CanvasText"),
    mutedText: resolve("CanvasText"),
    accent: resolve("Highlight"),
  };
}

/** A system colour as rgb(), via a throwaway element (canvas can't always parse the keywords). */
function resolveSystemColor(el: HTMLElement, name: string): string {
  const probe = document.createElement("span");
  probe.style.color = name;
  probe.style.display = "none";
  el.appendChild(probe);
  const out = getComputedStyle(probe).color || name;
  probe.remove();
  return out;
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ------------------------------------------------- cell colours, by theme --
//
// Sheets carry their own fills and text colours (templates, conditional
// formats, files from Excel), chosen for a white page. On a dark grid a pale
// header band or a bright yellow flag glares, and dark text disappears. So in
// dark mode the renderer maps them: the common "light" fills (grey header,
// Excel's good/bad/neutral, pastel highlights) to their dark equivalents, any
// other pale fill to a deep tint of the same hue, and dark ink to the theme's
// text (coloured ink is lifted until it reads). Light mode paints as stored.

/** Each role's fill and ink, per theme. */
export const ROLE_COLORS: Record<"light" | "dark", Record<StyleRole, { fill: string; ink: string }>> = {
  light: {
    header: { fill: "#e8eaed", ink: "#202124" },
    total: { fill: "#f1f3f4", ink: "#202124" },
    "flag-warn": { fill: "#ffeb9c", ink: "#7a4a00" },
    "flag-bad": { fill: "#ffc7ce", ink: "#9c0006" },
    "flag-good": { fill: "#c6efce", ink: "#006100" },
    input: { fill: "#fff2cc", ink: "#202124" },
  },
  dark: {
    header: { fill: "#2f3237", ink: "#e3e5e8" },
    total: { fill: "#282a2e", ink: "#e3e5e8" },
    "flag-warn": { fill: "#4a3b12", ink: "#fbd775" },
    "flag-bad": { fill: "#4d2329", ink: "#ffb3b8" },
    "flag-good": { fill: "#1d3b26", ink: "#9fdcab" },
    input: { fill: "#3d3520", ink: "#e3e5e8" },
  },
};

/** Light fills that have a designed dark twin (Excel's styles, the templates' header grey). */
const DARK_FILLS: Record<string, string> = {
  "#e8eaed": "#2f3237",
  "#f1f3f4": "#282a2e",
  "#f8f9fa": "#25272b",
  "#d9d9d9": "#33363b",
  "#ffc7ce": "#4d2329",
  "#ffeb9c": "#4a3b12",
  "#c6efce": "#1d3b26",
  "#fff2cc": "#3d3520",
  "#fce8e6": "#47262a",
  "#fef7e0": "#3d3520",
  "#e6f4ea": "#1f3527",
  "#e8f0fe": "#1f2d45",
  "#ffff00": "#5a5410",
};

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (rgb: readonly number[]) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Is this theme dark (by its background)? */
export function isDarkTheme(t: Pick<Theme, "background">): boolean {
  const rgb = parseHex(t.background) ?? parseRgb(t.background);
  return !!rgb && luminance(rgb) < 0.2;
}

function parseRgb(c: string): [number, number, number] | null {
  const m = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(c.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * A stored cell colour as it should paint on this theme. `kind` is "fill"
 * (backgrounds) or "ink" (text). Light themes get the colour unchanged.
 */
export function themedColor(color: string, kind: "fill" | "ink", theme: Pick<Theme, "background" | "text">, dark = isDarkTheme(theme)): string {
  if (!dark) return color;
  const rgb = parseHex(color);
  if (!rgb) return color;
  const lum = luminance(rgb);
  const bg = parseHex(theme.background) ?? parseRgb(theme.background) ?? [30, 31, 34];
  if (kind === "fill") {
    const known = DARK_FILLS[toHex(rgb)];
    if (known) return known;
    // a pale fill becomes a deep tint of the same hue; strong fills keep their colour, a little dimmer
    return lum > 0.5 ? toHex(mix(bg, rgb, 0.22)) : toHex(mix(bg, rgb, 0.7));
  }
  // ink: near-black text becomes the theme's text; other dark ink is lifted
  if (lum < 0.03) return theme.text;
  if (lum < 0.18) return toHex(mix(rgb, [255, 255, 255], 0.55));
  return color;
}
