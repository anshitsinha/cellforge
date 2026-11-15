/**
 * Lab A, the scroll-told story's first two chapters: the sample month's bank
 * statement and cash book in the real grid. Chapter 1 shows the statement as
 * it arrives; chapter 2 runs the real matching engine and writes its notes
 * into the cash book, line by line, then points at the keying error.
 */
import { bankRecSample } from "../samples";
import { runBankRec, type Tone } from "../landing/compute";
import { countUp, h, ms, reduceMotion, sheetTabs } from "../landing/frame";
import { cashSheet } from "../landing/hero";
import { int, LiveSheet, type SheetView } from "../landing/sheet";

export interface RecStage {
  setStep(step: number): void;
}

type Note = { text: string; tone: Tone };

export function mountRec(layer: HTMLElement): RecStage {
  const frame = layer.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const result = layer.querySelector<HTMLElement>(".la-result")!;
  const dropSub = layer.querySelector<HTMLElement>(".la-drop-sub");
  const sample = bankRecSample();

  const t0 = performance.now();
  const rec = runBankRec(sample.ledger, sample.bank);
  const took = performance.now() - t0;

  // the notes, shown up to a line (so they can arrive one by one); cached per side
  let upTo = -1;
  const cache = { a: new Map<number, Note>(), b: new Map<number, Note>(), at: -2 };
  const notes = (side: "a" | "b") => {
    if (upTo < 0) return undefined;
    if (cache.at !== upTo) {
      for (const s of ["a", "b"] as const) {
        const m = new Map<number, Note>();
        for (const [k, v] of rec.notes[s]) if (k <= upTo) m.set(k, v);
        cache[s] = m;
      }
      cache.at = upTo;
    }
    return cache[side];
  };
  const cash = cashSheet(sample.ledger, () => notes("a"));
  const bank = cashSheet(sample.bank, () => notes("b"));
  const sheets = [cash, bank];
  const lines = Math.max(sample.ledger.length, sample.bank.length);

  const narrow = matchMedia("(max-width: 640px)").matches;
  const view: SheetView = narrow ? { widths: [80, 80, 120, 92, 210], frozenRows: 1, hiddenCols: [0, 1] } : { widths: [92, 86, 176, 100, 250], frozenRows: 1 };

  host.replaceChildren();
  let active = 1;
  const sheet = new LiveSheet(host, bank, {
    label: "Sample bank statement and cash book, a live cellforge sheet",
    frame,
    idleStatus: () => `${int.format(sheets[active].rows.length)} lines`,
  });
  sheet.layout(view);
  const tabs = sheetTabs(
    frame,
    ["Cash book", "Bank statement"],
    (i) => {
      active = i;
      sheet.grid.setHighlights([]);
      sheet.show(sheets[i], view);
    },
    1,
  );
  if (dropSub) dropSub.textContent = `October 2026 · ${int.format(sample.bank.length)} lines`;

  // the result card, from the run above
  const c = rec.card;
  const big = result.querySelector<HTMLElement>(".la-result-big b")!;
  const list = result.querySelector<HTMLElement>(".la-result-list")!;
  const row = (label: string, value: string, tone = "") => h("div", {}, h("dt", { textContent: label }), h("dd", { class: tone, textContent: value }));
  list.replaceChildren(
    row("Cash book lines", `${c.matchedA} of ${c.countA}`),
    row("Split payments found", String(c.splits), "ok"),
    row("Keying errors caught", String(c.keying), c.keying ? "warn" : "ok"),
    row("Posted twice", String(c.postedTwice), c.postedTwice ? "warn" : "ok"),
  );
  result.querySelector<HTMLElement>(".la-result-sub")!.textContent = `Matched in ${ms(took)}, in this tab. Nothing uploaded.`;
  big.textContent = c.matchPct.toFixed(1);

  let ran = false;
  let anim = 0;
  const pointAtKeying = () => {
    const k = rec.keyingExample;
    if (!k || active !== 0) return;
    sheet.reveal({ top: k.a + 1, left: 0, bottom: k.a + 1, right: 4 }, "#d93025");
  };
  const run = () => {
    if (ran) {
      upTo = lines;
      sheet.refresh();
      pointAtKeying();
      return;
    }
    ran = true;
    countUp(big, c.matchPct, 1, 1100);
    if (reduceMotion()) {
      upTo = lines;
      sheet.refresh();
      pointAtKeying();
      return;
    }
    const start = performance.now();
    const dur = 1300;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      upTo = Math.floor(t * lines);
      sheet.refresh();
      if (t < 1) anim = requestAnimationFrame(tick);
      else setTimeout(pointAtKeying, 250);
    };
    anim = requestAnimationFrame(tick);
  };

  return {
    setStep(step) {
      if (step === 0) {
        cancelAnimationFrame(anim);
        upTo = -1;
        tabs.set(1);
        sheet.refresh();
      } else if (step === 1) {
        tabs.set(0);
        run();
      }
    },
  };
}
