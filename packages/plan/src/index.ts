/**
 * Parses docs/PLAN.md into milestones and items, so the progress page is
 * generated from the plan itself and can never drift from it.
 *
 *   ### M1: Spreadsheet core 🔨      ← milestone (status icon optional)
 *   - ✅ Some item                    ← item; indented lines continue it
 *   ## Now / ### Title / - [x] step  ← the item being built, with its steps
 */

export type Status = "done" | "doing" | "todo";

export interface PlanItem {
  status: Status;
  text: string;
}

export interface Milestone {
  id: string; // "M1"
  title: string; // "Spreadsheet core"
  status: Status;
  items: PlanItem[];
}

export interface NowSection {
  title: string;
  steps: { done: boolean; text: string }[];
}

export interface Plan {
  milestones: Milestone[];
  now: NowSection | null;
}

const ICONS: Record<string, Status> = { "✅": "done", "🔨": "doing", "⬜": "todo" };

function statusOf(icon: string | undefined): Status | null {
  return icon ? (ICONS[icon] ?? null) : null;
}

export function parsePlan(markdown: string): Plan {
  const milestones: Milestone[] = [];
  let now: NowSection | null = null;
  let section = "";
  let current: Milestone | null = null;
  let lastItem: { text: string } | null = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      section = h2[1].trim();
      current = null;
      lastItem = null;
      continue;
    }
    const h3 = /^### (.+)$/.exec(line);
    if (h3) {
      lastItem = null;
      if (section === "Now") {
        now = { title: h3[1].trim(), steps: [] };
      } else if (section === "Milestones") {
        const m = /^(M\d+):\s*(.*?)\s*(✅|🔨|⬜)?$/u.exec(h3[1].trim());
        if (m) {
          current = { id: m[1], title: m[2], status: statusOf(m[3]) ?? "todo", items: [] };
          milestones.push(current);
        }
      }
      continue;
    }
    if (section === "Now" && now) {
      const step = /^- \[( |x|X)\] (.+)$/.exec(line);
      if (step) {
        const item = { done: step[1] !== " ", text: step[2] };
        now.steps.push(item);
        lastItem = item;
      } else if (lastItem && /^\s{2,}\S/.test(line)) {
        lastItem.text += " " + line.trim();
      }
      continue;
    }
    if (section === "Milestones" && current) {
      const item = /^- (✅|🔨|⬜) (.+)$/u.exec(line);
      if (item) {
        const it: PlanItem = { status: statusOf(item[1])!, text: item[2] };
        current.items.push(it);
        lastItem = it;
      } else if (lastItem && /^\s{2,}\S/.test(line)) {
        lastItem.text += " " + line.trim();
      } else if (line.trim() === "") {
        lastItem = null;
      }
    }
  }

  // a milestone's status follows its items when it doesn't say otherwise
  for (const m of milestones) {
    if (m.items.length && m.items.every((i) => i.status === "done")) m.status = "done";
    else if (m.items.some((i) => i.status !== "todo")) m.status = "doing";
  }
  return { milestones, now };
}

export function counts(items: { status: Status }[]) {
  const done = items.filter((i) => i.status === "done").length;
  const doing = items.filter((i) => i.status === "doing").length;
  return { done, doing, total: items.length, percent: items.length ? Math.round((done / items.length) * 100) : 0 };
}
