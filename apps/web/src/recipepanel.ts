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
import "./analysis.css";
import "./recipes.css";
import { makeButton, openDialog } from "./ui/dialog";
import { icon, iconButton } from "./ui/icons";
import { openSidePanel } from "./ui/sidepanel";
import { toast } from "./ui/toast";

export interface RecipeDeps {
  /** this session's recorded steps */
  sessionSteps: () => readonly RecipeStep[];
  recipes: () => readonly Recipe[];
  registry: ActionRegistry<unknown>;
  run: (a: Action) => Promise<unknown>;
  /** step the workbook back (or forward) until `count` of this session's steps are applied */
  showAfter: (count: number) => Promise<void>;
  /** run a saved recipe on new files or a folder */
  runOnFiles?: (recipe: Recipe) => void;
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
  const area = el("textarea", { className: "recipe-json", value: JSON.stringify(step.action.params, null, 2), rows: 14 });
  area.setAttribute("aria-label", "Step settings (JSON)");
  area.spellcheck = false;
  let result: Action | null = null;
  const help = registry.get(step.action.type)?.title ?? "";
  const dlg = openDialog({
    title: `Edit step: ${step.label}`,
    subtitle: help || undefined,
    size: "md",
    body: [area, el("p", { className: "an-hint", textContent: 'Sheet names written as "@Name" are checked when the recipe runs.' })],
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: "Save step",
        kind: "primary",
        onClick: () => {
          let params: unknown;
          try {
            params = JSON.parse(area.value);
          } catch (e) {
            throw new Error(`That isn't valid JSON: ${(e as Error).message}`);
          }
          const action = { type: step.action.type, params };
          // sheet names ("@Name") are checked when the recipe runs; check the rest now
          const probe = JSON.parse(JSON.stringify(action).replace(/"@[^"]*"/g, '"x"')) as Action;
          const problems = registry.check(probe);
          if (problems.length) throw new Error(problems.slice(0, 3).join("; "));
          result = action;
        },
      },
    ],
    initialFocus: area,
  });
  return dlg.closed.then(() => result);
}

async function askName(): Promise<string | null> {
  const input = el("input", { placeholder: "e.g. Monthly bank clean-up" });
  input.setAttribute("aria-label", "Recipe name");
  let name: string | null = null;
  const dlg = openDialog({
    title: "Save as a recipe",
    subtitle: "Run the same steps on next month's file in one go",
    size: "sm",
    body: [el("label", { className: "an-field" }, el("span", { textContent: "Name" }), input)],
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: "Save recipe",
        kind: "primary",
        onClick: () => {
          if (!input.value.trim()) {
            input.focus();
            throw new Error("Give the recipe a name.");
          }
          name = input.value.trim();
        },
      },
    ],
    initialFocus: input,
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dlg.button("Save recipe")?.click();
    }
  });
  await dlg.closed;
  return name;
}

/**
 * Recipes in the side panel: this session's steps (switch off, reorder,
 * edit, step back to any point) to save as a recipe, and the saved recipes
 * to run again, on files, edit or delete.
 */
export function openRecipes(d: RecipeDeps): void {
  // the list being edited: this session's steps, or a saved recipe loaded for editing
  let editing: { name: string | null; steps: RecipeStep[] } = { name: null, steps: d.sessionSteps().map((s) => structuredClone(s)) };
  let showing: number | null = null;

  openSidePanel({
    id: "recipes",
    title: "Recipes",
    subtitle: "Record the work once, run it again next month",
    onClose: () => d.focusGrid(),
    render: (p) => {
      const render = () => {
        p.setTitle(editing.name ? `Recipe: ${editing.name}` : "Recipes", editing.name ? `${editing.steps.filter((s) => s.enabled).length} steps` : "Record the work once, run it again next month");
        const root = el("div", { className: "an-stack an-stack--loose recipe-panel-body" });

        // ---- steps
        const sec = el("section", { className: "an-section" });
        const head = el("div", { className: "an-section__head" }, el("h3", { className: "an-section__title", textContent: editing.name ? "Steps" : "This session's steps" }));
        if (editing.steps.length) head.append(el("span", { className: "cf-badge", textContent: String(editing.steps.length) }));
        sec.append(head);
        if (!editing.steps.length) {
          const empty = el("div", { className: "an-empty" });
          empty.append(
            el("span", { className: "an-empty__icon" }, icon("history", { size: 20 })),
            el("h3", { className: "an-empty__title", textContent: "Nothing recorded yet" }),
            el("p", { textContent: "Every edit, format, sort, filter and clean-up you make is recorded here as a step. Save the steps as a recipe and run them on next month's export in one go." }),
          );
          sec.append(empty);
        }
        const list = el("ol", { className: "recipe-steps" });
        editing.steps.forEach((step, i) => {
          const li = el("li", { className: `recipe-step${step.enabled ? "" : " is-off"}${showing === i + 1 ? " is-showing" : ""}` });
          const on = el("input", { type: "checkbox", checked: step.enabled });
          on.setAttribute("aria-label", `Include step ${i + 1}: ${step.label}`);
          on.addEventListener("change", () => {
            step.enabled = on.checked;
            render();
          });
          const main = el("div", { className: "recipe-step__main" });
          main.append(el("span", { className: "recipe-step__label", textContent: step.label, title: step.label }));
          const meta = [step.sheet ? `on ${step.sheet}` : "", step.ms !== undefined ? `${step.ms < 1 ? "<1" : Math.round(step.ms)} ms` : "", step.ms !== undefined ? memoryText(step.memory) : ""].filter(Boolean).join(" · ");
          if (meta) main.append(el("span", { className: "an-list__sub", textContent: meta }));
          const tools = el("span", { className: "recipe-tools" });
          if (!editing.name)
            tools.append(
              iconButton("play", showing === i + 1 ? "Showing the workbook after this step" : "Show the workbook as it was after this step", {
                size: "sm",
                onClick: async () => {
                  showing = i + 1;
                  await d.showAfter(i + 1);
                  render();
                },
              }),
            );
          tools.append(
            iconButton("settings", "Edit this step's settings", {
              size: "sm",
              onClick: async () => {
                const a = await editParams(d.registry, step);
                if (a) {
                  step.action = a;
                  render();
                }
              },
            }),
          );
          if (i > 0)
            tools.append(
              iconButton("chevron-up", "Move up", {
                size: "sm",
                onClick: () => {
                  [editing.steps[i - 1], editing.steps[i]] = [editing.steps[i], editing.steps[i - 1]];
                  render();
                },
              }),
            );
          if (i < editing.steps.length - 1)
            tools.append(
              iconButton("chevron-down", "Move down", {
                size: "sm",
                onClick: () => {
                  [editing.steps[i + 1], editing.steps[i]] = [editing.steps[i], editing.steps[i + 1]];
                  render();
                },
              }),
            );
          tools.append(
            iconButton("trash", "Remove this step", {
              size: "sm",
              onClick: () => {
                editing.steps.splice(i, 1);
                render();
              },
            }),
          );
          li.append(el("span", { className: "recipe-step__n", textContent: String(i + 1) }), on, main, tools);
          list.append(li);
        });
        if (editing.steps.length) sec.append(list);
        if (showing !== null && !editing.name) {
          const note = el("div", { className: "an-note an-note--warning" });
          const now = makeButton("Back to now", "secondary");
          now.classList.add("btn-sm");
          now.addEventListener("click", async () => {
            await d.showAfter(d.sessionSteps().length + Infinity);
            showing = null;
            render();
          });
          note.append(icon("history"), el("span", { textContent: `Showing the workbook after step ${showing}. ` }), now);
          sec.append(note);
        }
        root.append(sec);

        // ---- saved recipes
        const saved = d.recipes();
        const ss = el("section", { className: "an-section" });
        ss.append(el("div", { className: "an-section__head" }, el("h3", { className: "an-section__title", textContent: "Saved recipes" })));
        if (!saved.length) ss.append(el("p", { className: "an-hint", textContent: "None yet. Recipes are saved with the workbook." }));
        const ul = el("ul", { className: "an-list recipe-saved" });
        for (const r of saved) {
          const main = el("div", { className: "an-list__main" }, el("strong", { textContent: r.name }), el("span", { className: "an-list__sub", textContent: `${r.steps.filter((s) => s.enabled).length} steps` }));
          const run = makeButton("Run", "secondary", "play");
          run.classList.add("btn-sm");
          run.title = "Run it on this workbook now";
          run.addEventListener("click", () => void d.run({ type: "recipe.run", params: { name: r.name, steps: r.steps } }).then(() => toast({ kind: "success", text: `Ran the recipe "${r.name}"` })));
          const li = el("li", {}, main, run);
          if (d.runOnFiles) li.append(iconButton("open", "Run it on files or a folder", { size: "sm", onClick: () => d.runOnFiles?.(r) }));
          li.append(
            iconButton("settings", "Open it to edit the steps", {
              size: "sm",
              onClick: () => {
                editing = { name: r.name, steps: r.steps.map((s) => structuredClone(s)) };
                showing = null;
                render();
              },
            }),
            iconButton("trash", `Delete the recipe ${r.name}`, {
              size: "sm",
              onClick: async () => {
                await d.run({ type: "recipe.delete", params: { name: r.name } });
                if (editing.name === r.name) editing = { name: null, steps: d.sessionSteps().map((s) => structuredClone(s)) };
                toast({ text: `Deleted the recipe "${r.name}". Undo (Ctrl+Z) brings it back.` });
                render();
              },
            }),
          );
          ul.append(li);
        }
        if (saved.length) ss.append(ul);
        root.append(ss);
        p.body.replaceChildren(root);

        // ---- footer
        const foot = el("div", { className: "an-footer" });
        if (editing.name) {
          const back = makeButton("This session", "ghost", "arrow-left");
          back.addEventListener("click", () => {
            editing = { name: null, steps: d.sessionSteps().map((s) => structuredClone(s)) };
            render();
          });
          const runIt = makeButton("Run now", "secondary", "play");
          runIt.addEventListener("click", () => void d.run({ type: "recipe.run", params: { name: editing.name!, steps: editing.steps } }));
          foot.append(back, el("span", { className: "an-spacer" }), runIt);
        } else foot.append(el("span", { className: "an-spacer" }));
        const save = makeButton(editing.name ? "Save changes" : "Save as recipe", "primary");
        save.disabled = !editing.steps.length;
        if (save.disabled) save.title = "Make some changes first; they're recorded as steps";
        save.addEventListener("click", async () => {
          const name = editing.name ?? (await askName());
          if (!name) return;
          await d.run({ type: "recipe.save", params: { recipe: { name, steps: editing.steps, at: Date.now() } } });
          editing = { name, steps: editing.steps };
          toast({ kind: "success", text: `Saved the recipe "${name}" with the workbook` });
          render();
        });
        foot.append(save);
        p.footer.replaceChildren(foot);
      };
      render();
    },
  });
}
