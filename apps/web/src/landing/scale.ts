/**
 * The scale demo: the real grid over the 100M-line ledger (computed from the
 * row number, nothing stored). It glides down and jumps deeper on its own
 * until someone uses it; then it's theirs to scroll, select and jump.
 */
import { SyntheticSource } from "../demo";
import { BIG_ROWS } from "../samples";
import { h, reduceMotion } from "./frame";
import { int, LiveSheet } from "./sheet";

export function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const tools = frame.querySelector<HTMLElement>(".af-tools")!;
  const label = frame.querySelector<HTMLElement>(".af-status")!;
  host.replaceChildren();

  const source = new SyntheticSource(BIG_ROWS);
  const at = () => `Line ${int.format(sheet.grid.selection.row + 1)} of ${int.format(BIG_ROWS)}`;
  const sheet = new LiveSheet(host, source, { label: "General ledger demo, 100 million lines", frame, defaultColumnWidth: 96, idleStatus: at });
  sheet.layout({ widths: [84, 94, 76, 168, 104, 104, 300, 86] });
  sheet.grid.select(0, 0);

  let auto = !reduceMotion();
  let row = 0;
  let jump = 0;
  let visible = false;
  const JUMPS = [0, 1_250_000, 18_000_000, 47_500_000, 99_999_000];
  const go = (r: number) => {
    sheet.grid.select(r, 0);
    sheet.grid.scrollIntoView(Math.min(BIG_ROWS - 1, r + 6), 0);
    sheet.grid.scrollIntoView(r, 0);
  };
  const stop = () => {
    if (!auto) return;
    auto = false;
    root.classList.add("is-yours");
  };

  // jump buttons
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Go to a line");
  for (const [text, r] of [["Line 1", 0], ["1 million", 999_999], ["50 million", 49_999_999], ["Last", BIG_ROWS - 1]] as const) {
    tools.append(
      h("button", {
        type: "button",
        class: "af-btn",
        textContent: text,
        onclick: () => {
          stop();
          go(r);
          sheet.grid.focus();
        },
      }),
    );
  }

  // any use of the grid hands it over
  for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"]) host.addEventListener(ev, stop, { passive: true });

  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(host);
  if (reduceMotion()) {
    // still worth showing how deep it goes: one static jump
    go(47_500_000);
    return;
  }
  const tick = () => {
    if (auto && visible && !document.hidden) {
      row += 0.06;
      // stay on the first column, so the grid doesn't scroll sideways
      sheet.grid.select(Math.floor(row), 0);
    }
    if (auto) requestAnimationFrame(tick);
  };
  const timer = setInterval(() => {
    if (!auto) return clearInterval(timer);
    if (!visible || document.hidden) return;
    jump = (jump + 1) % JUMPS.length;
    row = JUMPS[jump];
  }, 4000);
  requestAnimationFrame(tick);
  label.textContent = at();
}
