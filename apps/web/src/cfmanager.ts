/**
 * The conditional formatting rules manager: the sheet's rules in priority
 * order (first wins), with add / edit / move / delete, and a rule editor
 * that covers highlight rules, colour scales, data bars and icon sets.
 */
import type { Action } from "@cellforge/actions";
import { columnLetter, type CellRange } from "@cellforge/grid";
import { describeRule, ICON_SETS, type CfFormat, type CfRule, type CfRuleBody } from "./condformat";
import type { EditableSource } from "./editable";
import "./analysis.css";
import "./cfmanager.css";
import { openDialog } from "./ui/dialog";
import { iconButton } from "./ui/icons";
import { toast } from "./ui/toast";

export interface CfDeps {
  source: () => EditableSource;
  range: () => CellRange;
  run: (a: Action) => Promise<unknown>;
  focusGrid: () => void;
}

/** "A1:B10, D2" for a list of ranges. */
export function rangesToText(ranges: readonly CellRange[]): string {
  const cell = (r: number, c: number) => `${columnLetter(c)}${r + 1}`;
  return ranges.map((r) => (r.top === r.bottom && r.left === r.right ? cell(r.top, r.left) : `${cell(r.top, r.left)}:${cell(r.bottom, r.right)}`)).join(", ");
}

/** Parse "A1:B10, D2, C:C, 3:5" into ranges (whole columns / rows up to the sheet's size). */
export function parseRanges(text: string, rows: number, cols: number): CellRange[] {
  const colOf = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const out: CellRange[] = [];
  for (const part of text.split(/[,;]/).map((p) => p.trim().replace(/\$/g, "")).filter(Boolean)) {
    let m: RegExpExecArray | null;
    if ((m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(part))) {
      const [r1, c1] = [Number(m[2]) - 1, colOf(m[1])];
      const [r2, c2] = m[3] ? [Number(m[4]) - 1, colOf(m[3])] : [r1, c1];
      out.push({ top: Math.min(r1, r2), left: Math.min(c1, c2), bottom: Math.max(r1, r2), right: Math.max(c1, c2) });
    } else if ((m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(part))) {
      const [a, b] = [colOf(m[1]), colOf(m[2])];
      out.push({ top: 0, left: Math.min(a, b), bottom: rows - 1, right: Math.max(a, b) });
    } else if ((m = /^(\d+):(\d+)$/.exec(part))) {
      const [a, b] = [Number(m[1]) - 1, Number(m[2]) - 1];
      out.push({ top: Math.min(a, b), left: 0, bottom: Math.max(a, b), right: cols - 1 });
    } else throw new Error(`"${part}" isn't a range like A1:B10.`);
  }
  if (!out.length) throw new Error("Say which cells the rule applies to, like A2:A100.");
  if (out.some((r) => r.top < 0 || r.left < 0)) throw new Error("Rows and columns start at 1 and A.");
  return out;
}

const PRESETS: { label: string; format: CfFormat }[] = [
  { label: "Light red fill, dark red text", format: { fill: "#ffc7ce", color: "#9c0006" } },
  { label: "Yellow fill, dark yellow text", format: { fill: "#ffeb9c", color: "#9c5700" } },
  { label: "Green fill, dark green text", format: { fill: "#c6efce", color: "#006100" } },
  { label: "Light red fill", format: { fill: "#ffc7ce" } },
  { label: "Red text", format: { color: "#c00000" } },
  { label: "Bold", format: { bold: true } },
];

type Kind = CfRuleBody["kind"];
const KINDS: { kind: Kind; label: string }[] = [
  { kind: "cell", label: "Cell value is…" },
  { kind: "text", label: "Text…" },
  { kind: "date", label: "A date occurring…" },
  { kind: "blanks", label: "Blank" },
  { kind: "noBlanks", label: "Not blank" },
  { kind: "errors", label: "Errors" },
  { kind: "noErrors", label: "No errors" },
  { kind: "duplicates", label: "Duplicate values" },
  { kind: "unique", label: "Unique values" },
  { kind: "top", label: "Top or bottom…" },
  { kind: "average", label: "Above or below average" },
  { kind: "formula", label: "Formula is true…" },
  { kind: "scale", label: "Colour scale" },
  { kind: "bar", label: "Data bar" },
  { kind: "icons", label: "Icon set" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function select(label: string, options: [string, string][], value: string): HTMLSelectElement {
  const s = el("select");
  s.setAttribute("aria-label", label);
  for (const [v, t] of options) s.append(new Option(t, v, false, v === value));
  return s;
}

/** A caption over a control. */
function field(label: string, ...controls: (Node | string)[]): HTMLLabelElement {
  return el("label", { className: "an-field" }, el("span", { textContent: label }), ...controls);
}

/** A checkbox with its text. */
function check(input: HTMLInputElement, text: string): HTMLLabelElement {
  return el("label", { className: "an-check" }, input, el("span", { textContent: text }));
}

/** The editor for one rule; resolves with the rule (without id) or null if cancelled. */
export function editRule(d: CfDeps, rule: CfRule | null): Promise<Omit<CfRule, "id"> | null> {
  const src = d.source();
  const r = (rule ?? {}) as Partial<CfRule> & Record<string, unknown>;
  const applies = el("input", { value: rangesToText(rule?.ranges ?? [d.range()]) });
  const kind = select("Rule type", KINDS.map((k) => [k.kind, k.label]), rule?.kind ?? "cell");
  const fields = el("div", { className: "cf-fields" });
  const formatRow = el("div", { className: "cf-format" });
  const stop = el("input", { type: "checkbox", checked: !!rule?.stopIfTrue });
  const top = el("div", { className: "an-row" }, field("Apply to", applies), field("Format cells where", kind));
  const body = el("div", { className: "an-stack cf-editor" }, top, el("div", { className: "an-field" }, el("span", { textContent: "Condition" }), fields), formatRow, check(stop, "Stop here when this rule applies (rules below are skipped)"));

  // the format for highlight rules
  const fmt: CfFormat = { ...(rule?.format ?? PRESETS[0].format) };
  const preset = select("Format", [...PRESETS.map((p, i): [string, string] => [String(i), p.label]), ["custom", "Custom…"]], String(PRESETS.findIndex((p) => JSON.stringify(p.format) === JSON.stringify(fmt))).replace("-1", "custom"));
  const fill = el("input", { type: "color", value: fmt.fill ?? "#ffffff" });
  fill.setAttribute("aria-label", "Fill colour");
  const color = el("input", { type: "color", value: fmt.color ?? "#000000" });
  color.setAttribute("aria-label", "Text colour");
  const useFill = el("input", { type: "checkbox", checked: fmt.fill !== undefined });
  const useColor = el("input", { type: "checkbox", checked: fmt.color !== undefined });
  const bold = el("input", { type: "checkbox", checked: !!fmt.bold });
  const italic = el("input", { type: "checkbox", checked: !!fmt.italic });
  const custom = el("div", { className: "cf-custom" }, el("label", { className: "an-check" }, useFill, el("span", { textContent: "Fill" }), fill), el("label", { className: "an-check" }, useColor, el("span", { textContent: "Text" }), color), check(bold, "Bold"), check(italic, "Italic"));
  const sample = el("span", { className: "cf-sample", textContent: "1,234.56" });
  sample.setAttribute("aria-hidden", "true");
  const paintSample = () => {
    sample.style.background = useFill.checked ? fill.value : "";
    sample.style.color = useColor.checked ? color.value : "";
    sample.style.fontWeight = bold.checked ? "700" : "";
    sample.style.fontStyle = italic.checked ? "italic" : "";
  };
  preset.addEventListener("change", () => {
    const p = PRESETS[Number(preset.value)];
    if (p) {
      useFill.checked = p.format.fill !== undefined;
      if (p.format.fill) fill.value = p.format.fill;
      useColor.checked = p.format.color !== undefined;
      if (p.format.color) color.value = p.format.color;
      bold.checked = !!p.format.bold;
      italic.checked = false;
    }
    custom.hidden = preset.value !== "custom";
    paintSample();
  });
  for (const i of [fill, color, useFill, useColor, bold, italic]) i.addEventListener("input", paintSample);
  custom.hidden = preset.value !== "custom";
  formatRow.append(el("div", { className: "an-row" }, field("Look", preset), el("div", { className: "an-field an-fit" }, el("span", { textContent: "Preview" }), sample)), custom);
  paintSample();

  // per-kind fields
  let read: () => Partial<CfRuleBody> = () => ({});
  const num = (v: unknown, label: string) => {
    const i = el("input", { value: v === undefined ? "" : String(v), size: 8 });
    i.setAttribute("aria-label", label);
    return i;
  };
  const hint = (text: string) => el("p", { className: "an-hint cf-hint", textContent: text });
  const renderFields = () => {
    fields.replaceChildren();
    const k = kind.value as Kind;
    formatRow.hidden = k === "scale" || k === "bar" || k === "icons";
    const toNum = (i: HTMLInputElement) => (i.value.trim() === "" || Number.isNaN(Number(i.value)) ? i.value : Number(i.value));
    if (k === "cell") {
      const op = select("Comparison", [[">", "greater than"], [">=", "greater than or equal to"], ["<", "less than"], ["<=", "less than or equal to"], ["=", "equal to"], ["!=", "not equal to"], ["between", "between"], ["notBetween", "not between"]], (r.op as string) ?? ">");
      const a = num(r.a, "Value");
      a.placeholder = "10,000 or =$B$1";
      const b = num(r.b, "Second value");
      const and = el("span", { className: "an-hint", textContent: "and" });
      const sync = () => (b.hidden = and.hidden = !(op.value === "between" || op.value === "notBetween"));
      op.addEventListener("change", sync);
      sync();
      fields.append(op, a, and, b);
      read = () => ({ kind: "cell", op: op.value as ">", a: toNum(a) as number, ...(b.hidden ? {} : { b: Number(b.value) }) });
    } else if (k === "text") {
      const op = select("Text test", [["contains", "contains"], ["notContains", "doesn't contain"], ["begins", "begins with"], ["ends", "ends with"]], (r.op as string) ?? "contains");
      const v = el("input", { value: (r.value as string) ?? "" });
      v.setAttribute("aria-label", "Text");
      fields.append(op, v);
      read = () => ({ kind: "text", op: op.value as "contains", value: v.value });
    } else if (k === "date") {
      const w = select("When", [["yesterday", "yesterday"], ["today", "today"], ["tomorrow", "tomorrow"], ["last7", "in the last 7 days"], ["lastWeek", "last week"], ["thisWeek", "this week"], ["nextWeek", "next week"], ["lastMonth", "last month"], ["thisMonth", "this month"], ["nextMonth", "next month"], ["past", "in the past"], ["future", "in the future"]], (r.when as string) ?? "today");
      fields.append(w);
      read = () => ({ kind: "date", when: w.value as "today" });
    } else if (k === "top") {
      const which = select("Top or bottom", [["top", "Top"], ["bottom", "Bottom"]], r.bottom ? "bottom" : "top");
      const n = num(r.n ?? 10, "How many");
      const pct = el("input", { type: "checkbox", checked: !!r.percent });
      fields.append(which, n, check(pct, "per cent"));
      read = () => ({ kind: "top", n: Number(n.value), bottom: which.value === "bottom", percent: pct.checked });
    } else if (k === "average") {
      const which = select("Above or below", [["above", "above average"], ["below", "below average"], ["aboveEq", "equal to or above average"], ["belowEq", "equal to or below average"]], `${r.below ? "below" : "above"}${r.orEqual ? "Eq" : ""}`);
      fields.append(which);
      read = () => ({ kind: "average", below: which.value.startsWith("below"), orEqual: which.value.endsWith("Eq") });
    } else if (k === "formula") {
      const f = el("input", { value: (r.formula as string) ?? "=", className: "cf-formula" });
      f.setAttribute("aria-label", "Formula");
      fields.append(f, hint("Write it for the first cell of the range; it moves for the others like a copied formula. Use $ to keep a column fixed, e.g. =$C2>100."));
      read = () => ({ kind: "formula", formula: f.value });
    } else if (k === "scale") {
      const three = el("input", { type: "checkbox", checked: Array.isArray(r.colors) ? (r.colors as string[]).length === 3 : true });
      const cs = ((r.colors as string[] | undefined) ?? ["#f8696b", "#ffeb84", "#63be7b"]).slice();
      while (cs.length < 3) cs.splice(1, 0, "#ffeb84");
      const low = el("input", { type: "color", value: cs[0] });
      const mid = el("input", { type: "color", value: cs[1] });
      const high = el("input", { type: "color", value: cs[2] });
      const sync = () => (mid.hidden = !three.checked);
      three.addEventListener("change", sync);
      sync();
      fields.append(el("label", { className: "an-check" }, el("span", { textContent: "Lowest" }), low), el("label", { className: "an-check" }, three, el("span", { textContent: "Middle" }), mid), el("label", { className: "an-check" }, el("span", { textContent: "Highest" }), high));
      read = () => ({
        kind: "scale",
        min: { type: "min" },
        max: { type: "max" },
        ...(three.checked ? { mid: { type: "percentile", value: 50 }, colors: [low.value, mid.value, high.value] } : { colors: [low.value, high.value] }),
      });
    } else if (k === "bar") {
      const c = el("input", { type: "color", value: (r.color as string) ?? "#638ec6" });
      const only = el("input", { type: "checkbox", checked: r.showValue === false });
      fields.append(el("label", { className: "an-check" }, el("span", { textContent: "Colour" }), c), check(only, "Show the bar only"));
      read = () => ({ kind: "bar", color: c.value, ...(only.checked ? { showValue: false } : {}) });
    } else if (k === "icons") {
      const set = select("Icon set", ICON_SETS.map((s): [string, string] => [s, { arrows3: "3 arrows", traffic3: "3 traffic lights", signs3: "3 signs", flags3: "3 flags", arrows5: "5 arrows", ratings5: "5 ratings" }[s]]), (r.set as string) ?? "arrows3");
      const rev = el("input", { type: "checkbox", checked: !!r.reverse });
      const only = el("input", { type: "checkbox", checked: r.showValue === false });
      fields.append(set, check(rev, "Reverse"), check(only, "Show the icon only"));
      fields.append(hint("Icons split the range into equal bands from the lowest value to the highest."));
      read = () => ({ kind: "icons", set: set.value as "arrows3", reverse: rev.checked, ...(only.checked ? { showValue: false } : {}) });
    } else read = () => ({ kind: k }) as Partial<CfRuleBody>;
  };
  kind.addEventListener("change", renderFields);
  renderFields();

  let result: Omit<CfRule, "id"> | null = null;
  const dlg = openDialog({
    title: rule ? "Edit rule" : "New formatting rule",
    subtitle: "Highlight cells that meet a condition, or shade them by value",
    size: "md",
    body,
    initialFocus: kind,
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: rule ? "Save rule" : "Add rule",
        kind: "primary",
        onClick: () => {
          const ranges = parseRanges(applies.value, src.rowCount, src.colCount);
          const format: CfFormat = {};
          if (useFill.checked) format.fill = fill.value;
          if (useColor.checked) format.color = color.value;
          if (bold.checked) format.bold = true;
          if (italic.checked) format.italic = true;
          const b = read();
          const highlight = !["scale", "bar", "icons"].includes(b.kind as string);
          result = { ...(b as CfRuleBody), ranges, ...(highlight ? { format } : {}), ...(stop.checked ? { stopIfTrue: true } : {}) } as Omit<CfRule, "id">;
        },
      },
    ],
  });
  return dlg.closed.then(() => result);
}

/** The rules manager for the active sheet. */
export function openCfManager(d: CfDeps): void {
  const list = el("ol", { className: "cf-list" });
  const empty = el("div", { className: "an-empty" }, el("p", { textContent: "No rules on this sheet yet. A rule colours cells that meet a condition: amounts over 10,000, dates in the past, the top 10, or a colour scale from low to high." }));
  const body = el("div", { className: "an-stack" }, list, empty);
  const dlg = openDialog({
    title: "Conditional formatting",
    subtitle: "Rules higher up the list win when two set the same thing",
    size: "lg",
    body,
    actions: [
      {
        label: "Clear rules from the selection",
        start: true,
        kind: "ghost",
        onClick: () => {
          void runThen({ type: "format.conditionalDelete", params: { range: d.range() } });
          return false;
        },
      },
      { label: "Close", id: "close" },
      {
        label: "New rule…",
        kind: "primary",
        onClick: async () => {
          const next = await editRule(d, null);
          if (next) await runThen({ type: "format.conditionalAdd", params: { rule: next } });
          return false;
        },
      },
    ],
    onClose: () => d.focusGrid(),
  });

  const runThen = async (a: Action) => {
    await d.run(a);
    render();
  };
  const render = () => {
    const rules = d.source().condFormats;
    list.replaceChildren();
    empty.hidden = rules.length > 0;
    list.hidden = !rules.length;
    rules.forEach((rule, i) => {
      const sw = el("span", { className: "cf-sample", textContent: rule.kind === "scale" ? "" : rule.kind === "bar" ? "▇▇▇" : rule.kind === "icons" ? "▲▶▼" : "Aa" });
      sw.setAttribute("aria-hidden", "true");
      if (rule.kind === "scale") sw.style.background = `linear-gradient(90deg, ${rule.colors.join(", ")})`;
      if (rule.kind === "bar") sw.style.color = rule.color;
      if (rule.format) {
        sw.style.background = rule.format.fill ?? "";
        sw.style.color = rule.format.color ?? "";
        sw.style.fontWeight = rule.format.bold ? "700" : "";
      }
      const desc = describeRule(rule) + (rule.stopIfTrue ? " (then stop)" : "");
      const tools = el("span", { className: "cf-tools" });
      if (i > 0) tools.append(iconButton("chevron-up", `Move "${desc}" up`, { size: "sm", onClick: () => void runThen({ type: "format.conditionalMove", params: { id: rule.id, to: i - 1 } }) }));
      if (i < rules.length - 1) tools.append(iconButton("chevron-down", `Move "${desc}" down`, { size: "sm", onClick: () => void runThen({ type: "format.conditionalMove", params: { id: rule.id, to: i + 1 } }) }));
      tools.append(
        iconButton("settings", `Edit "${desc}"`, {
          size: "sm",
          onClick: async () => {
            const next = await editRule(d, rule);
            if (next) await runThen({ type: "format.conditionalUpdate", params: { id: rule.id, rule: next } });
          },
        }),
        iconButton("trash", `Delete "${desc}"`, {
          size: "sm",
          onClick: () => void runThen({ type: "format.conditionalDelete", params: { id: rule.id } }).then(() => toast({ text: "Rule deleted. Ctrl+Z brings it back." })),
        }),
      );
      list.append(el("li", { className: "cf-row" }, sw, el("span", { className: "cf-desc", textContent: desc }), el("span", { className: "cf-range", textContent: rangesToText(rule.ranges) }), tools));
    });
  };
  render();
  void dlg;
}
