/**
 * The recipe panel: the steps of this session's work (each with the time it
 * took and the memory it used), to tidy up and save as a recipe; and the
 * workbook's saved recipes, to run again, edit or delete. A step's
 * parameters can be edited as JSON (checked against the action's schema),
 * steps can be switched off, moved and removed, and "Show after this step"
 * steps the workbook back to how it was after any step of this session.
 */
import type { Action, ActionRegistry } from "@cellforge/actions";
import { memoryText, type Recipe, type RecipeStep } from "./recipe";

export interface RecipeDeps {
  /** this session's recorded steps */
  sessionSteps: () => readonly RecipeStep[];
  recipes: () => readonly Recipe[];
  registry: ActionRegistry<unknown>;
  run: (a: Action) => Promise<unknown>;
  /** step the workbook back (or forward) until `count` of this session's steps are applied */
  showAfter: (count: number) => Promise<void>;
  status: (t: string) => void;
  focusGrid: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** Ask for a step's parameters as JSON; resolves with the new action, or null. */
function editParams(registry: ActionRegistry<unknown>, step: RecipeStep): Promise<Action | null> {
  return new Promise((resolve) => {
    const back = el("div", { className: "palette-backdrop" });
    const box = el("div", { className: "palette import-dialog" });
    box.setAttribute("role", "dialog");
    const area = el("textarea", { className: "recipe-json", value: JSON.stringify(step.action.params, null, 2), rows: 14 });
    area.setAttribute("aria-label", "Step parameters (JSON)");
    const error = el("p", { className: "cleanup-warn", hidden: true });
    const help = registry.get(step.action.type)?.title ?? "";
    const ok = el("button", { type: "button", textContent: "Save" });
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    box.append(el("div", { className: "palette-form" }, el("h3", { textContent: `Edit step: ${step.label}` }), el("p", { className: "hp-muted", textContent: help }), area, error, el("div", { className: "numfmt-actions" }, cancel, ok)));
    back.append(box);
    document.body.append(back);
    const done = (a: Action | null) => {
      back.remove();
      resolve(a);
    };
    cancel.addEventListener("click", () => done(null));
    back.addEventListener("keydown", (e) => e.key === "Escape" && done(null));
    ok.addEventListener("click", () => {
      let params: unknown;
      try {
        params = JSON.parse(area.value);
      } catch (e) {
        error.textContent = `That isn't valid JSON: ${(e as Error).message}`;
        error.hidden = false;
        return;
      }
      const action = { type: step.action.type, params };
      // sheet names ("@Name") are checked when the recipe runs; check the rest now
      const probe = JSON.parse(JSON.stringify(action).replace(/"@[^"]*"/g, '"x"')) as Action;
      const problems = registry.check(probe);
      if (problems.length) {
        error.textContent = problems.slice(0, 5).join("; ");
        error.hidden = false;
        return;
      }
      done(action);
    });
    area.focus();
  });
}

export function openRecipes(d: RecipeDeps): void {
  document.querySelector(".recipe-panel")?.remove();
  const panel = el("aside", { className: "recipe-panel" });
  panel.setAttribute("aria-label", "Recipes");
  document.body.append(panel);

  // the list being edited: this session's steps, or a saved recipe loaded for editing
  let editing: { name: string | null; steps: RecipeStep[] } = { name: null, steps: d.sessionSteps().map((s) => structuredClone(s)) };
  let showing: number | null = null;

  const close = () => {
    panel.remove();
    d.focusGrid();
  };

  const render = () => {
    panel.replaceChildren();
    const head = el("div", { className: "recipe-head" }, el("strong", { textContent: editing.name ? `Recipe: ${editing.name}` : "This session's steps" }));
    const x = el("button", { type: "button", textContent: "×", title: "Close" });
    x.addEventListener("click", close);
    head.append(x);
    panel.append(head);

    if (!editing.steps.length) {
      panel.append(el("p", { className: "hp-muted", textContent: "No steps yet. Edits, formats, sorts, filters, clean-ups and other changes are recorded here as you work." }));
    }
    const list = el("ol", { className: "recipe-steps" });
    editing.steps.forEach((step, i) => {
      const li = el("li", { className: step.enabled ? "" : "recipe-off" });
      const on = el("input", { type: "checkbox", checked: step.enabled, title: "Include this step" });
      on.addEventListener("change", () => {
        step.enabled = on.checked;
        render();
      });
      const label = el("span", { className: "recipe-label", textContent: step.label });
      const where = el("span", { className: "hp-muted", textContent: step.sheet ? ` on ${step.sheet}` : "" });
      const cost = el("span", { className: "hp-muted recipe-cost", textContent: step.ms !== undefined ? `${step.ms < 1 ? "<1" : Math.round(step.ms)} ms ${memoryText(step.memory)}` : "" });
      const btn = (text: string, title: string, fn: () => void, disabled = false) => {
        const b = el("button", { type: "button", textContent: text, title, disabled });
        b.addEventListener("click", fn);
        return b;
      };
      const tools = el(
        "span",
        { className: "recipe-tools" },
        btn("↑", "Move up", () => {
          [editing.steps[i - 1], editing.steps[i]] = [editing.steps[i], editing.steps[i - 1]];
          render();
        }, i === 0),
        btn("↓", "Move down", () => {
          [editing.steps[i + 1], editing.steps[i]] = [editing.steps[i], editing.steps[i + 1]];
          render();
        }, i === editing.steps.length - 1),
        btn("Edit", "Edit this step's settings", async () => {
          const a = await editParams(d.registry, step);
          if (a) {
            step.action = a;
            render();
          }
        }),
        btn("✕", "Remove this step", () => {
          editing.steps.splice(i, 1);
          render();
        }),
      );
      if (!editing.name) {
        tools.prepend(
          btn(showing === i + 1 ? "Showing" : "Show", "Show the workbook as it was after this step", async () => {
            showing = i + 1;
            await d.showAfter(i + 1);
            render();
          }),
        );
      }
      li.append(on, " ", label, where, cost, tools);
      list.append(li);
    });
    panel.append(list);

    const actions = el("div", { className: "numfmt-actions recipe-actions" });
    if (showing !== null && !editing.name) {
      const now = el("button", { type: "button", textContent: "Back to now" });
      now.addEventListener("click", async () => {
        await d.showAfter(d.sessionSteps().length + Infinity);
        showing = null;
        render();
      });
      actions.append(now);
    }
    const save = el("button", { type: "button", textContent: editing.name ? "Save changes" : "Save as a recipe…", disabled: !editing.steps.length });
    save.addEventListener("click", async () => {
      const name = editing.name ?? (await askName());
      if (!name) return;
      await d.run({ type: "recipe.save", params: { recipe: { name, steps: editing.steps, at: Date.now() } } });
      editing = { name, steps: editing.steps };
      d.status(`Saved recipe "${name}"`);
      render();
    });
    actions.append(save);
    if (editing.name) {
      const runIt = el("button", { type: "button", textContent: "Run it now" });
      runIt.addEventListener("click", async () => {
        await d.run({ type: "recipe.run", params: { name: editing.name!, steps: editing.steps } });
      });
      const back = el("button", { type: "button", textContent: "This session's steps" });
      back.addEventListener("click", () => {
        editing = { name: null, steps: d.sessionSteps().map((s) => structuredClone(s)) };
        render();
      });
      actions.append(runIt, back);
    }
    panel.append(actions);

    const saved = d.recipes();
    if (saved.length) {
      panel.append(el("strong", { className: "recipe-saved-title", textContent: "Saved recipes" }));
      const ul = el("ul", { className: "recipe-saved" });
      for (const r of saved) {
        const run = el("button", { type: "button", textContent: "Run" });
        run.addEventListener("click", async () => {
          await d.run({ type: "recipe.run", params: { name: r.name, steps: r.steps } });
        });
        const edit = el("button", { type: "button", textContent: "Open" });
        edit.addEventListener("click", () => {
          editing = { name: r.name, steps: r.steps.map((s) => structuredClone(s)) };
          showing = null;
          render();
        });
        const del = el("button", { type: "button", textContent: "Delete" });
        del.addEventListener("click", async () => {
          await d.run({ type: "recipe.delete", params: { name: r.name } });
          if (editing.name === r.name) editing = { name: null, steps: d.sessionSteps().map((s) => structuredClone(s)) };
          render();
        });
        ul.append(el("li", {}, el("span", { textContent: `${r.name} (${r.steps.filter((s) => s.enabled).length} steps)` }), run, edit, del));
      }
      panel.append(ul);
    }
  };
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  render();
}

function askName(): Promise<string | null> {
  return new Promise((resolve) => {
    const back = el("div", { className: "palette-backdrop" });
    const input = el("input", { placeholder: "e.g. Monthly bank clean-up" });
    input.setAttribute("aria-label", "Recipe name");
    const ok = el("button", { type: "button", textContent: "Save" });
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    back.append(el("div", { className: "palette" }, el("div", { className: "palette-form" }, el("h3", { textContent: "Name the recipe" }), input, el("div", { className: "numfmt-actions" }, cancel, ok))));
    document.body.append(back);
    const done = (v: string | null) => {
      back.remove();
      resolve(v);
    };
    ok.addEventListener("click", () => input.value.trim() && done(input.value.trim()));
    cancel.addEventListener("click", () => done(null));
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      if (e.key === "Enter" && input.value.trim()) done(input.value.trim());
    });
    input.focus();
  });
}
