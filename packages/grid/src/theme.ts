import type { Theme } from "./types";

/**
 * Pull colours from CSS custom properties on the container so the canvas
 * matches whatever the app's stylesheet says (including dark mode).
 */
export function readTheme(el: HTMLElement): Theme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;

  return {
    background: v("--bg", "#ffffff"),
    headerBackground: v("--panel", "#f6f7f9"),
    gridLine: v("--border", "#dadce0"),
    text: v("--text", "#1f2328"),
    mutedText: v("--muted", "#656d76"),
    accent: v("--accent", "#1a73e8"),
  };
}
