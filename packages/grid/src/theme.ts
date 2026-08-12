import type { Theme } from "./types";

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
