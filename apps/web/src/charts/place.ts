/**
 * Where a new chart goes: in empty space beside the data it charts (to the
 * right of the used columns, else below the used rows), never on top of it
 * when there's room on screen. Pure: page rectangles in, a frame out.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CHART_SIZE = { w: 560, h: 340 };
export const CHART_MIN = { w: 320, h: 220 };
const GAP = 16;
const EDGE = 8;
/** below the column headers */
const HEAD = 40;

/**
 * A frame for a new chart. `view` is the sheet area on screen, `data` the
 * data's cells on screen (null for an empty sheet). `clear` says whether it
 * stays off the data; with no room beside or below it, a smaller chart goes
 * in the bottom-right corner.
 */
export function placeChart(view: Box, data: Box | null, nth = 0, want = CHART_SIZE, min = CHART_MIN): Frame & { clear: boolean } {
  const off = (nth % 5) * 24;
  const vw = view.right - view.left;
  const vh = view.bottom - view.top;
  if (!data) {
    const w = Math.min(want.w, Math.max(min.w, Math.round(vw * 0.48)));
    const h = Math.min(want.h, Math.max(min.h, Math.round(vh * 0.55)));
    return { x: Math.round(view.right - w - 32 - off), y: Math.round(view.top + 48 + off), w, h, clear: true };
  }
  // to the right of the data
  const right = Math.max(view.left, data.right) + GAP;
  const roomRight = view.right - EDGE - right;
  if (roomRight >= min.w) {
    const w = Math.min(want.w, roomRight);
    const top = Math.max(view.top + HEAD, Math.min(data.top, view.bottom - min.h - EDGE)) + off;
    const h = Math.max(min.h, Math.min(want.h, view.bottom - EDGE - top));
    return { x: Math.round(right), y: Math.round(top), w: Math.round(w), h: Math.round(h), clear: true };
  }
  // below it
  const below = Math.max(view.top + HEAD, data.bottom) + GAP;
  const roomBelow = view.bottom - EDGE - below;
  if (roomBelow >= min.h) {
    const h = Math.min(want.h, roomBelow);
    const x = Math.max(view.left + 48, Math.min(data.left, view.right - min.w - EDGE)) + off;
    const w = Math.max(min.w, Math.min(want.w, view.right - EDGE - x));
    return { x: Math.round(x), y: Math.round(below), w: Math.round(w), h: Math.round(h), clear: true };
  }
  // no room on screen: small, in the corner
  const w = Math.min(min.w + 60, vw - 2 * EDGE);
  const h = Math.min(min.h + 20, vh - 2 * EDGE);
  return { x: Math.round(view.right - w - GAP - off), y: Math.round(view.bottom - h - GAP - off), w, h, clear: false };
}
