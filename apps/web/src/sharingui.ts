/** Sharing safely in the app: the hidden-content check, password dialogs, clearing local data. */
import { shareCheck, type ShareFinding } from "./sharing";
import type { Workbook } from "./workbook";

function dialog(title: string): { back: HTMLElement; body: HTMLElement; actions: HTMLElement; close: () => void } {
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog" role="dialog" aria-modal="true"><div class="palette-form"><h3></h3><div class="share-body"></div><div class="numfmt-actions"></div></div></div>`;
  back.querySelector("h3")!.textContent = title;
  const close = () => back.remove();
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.body.append(back);
  return { back, body: back.querySelector<HTMLElement>(".share-body")!, actions: back.querySelector<HTMLElement>(".numfmt-actions")!, close };
}

const button = (text: string, onClick: () => void) => {
  const b = Object.assign(document.createElement("button"), { type: "button", textContent: text });
  b.addEventListener("click", onClick);
  return b;
};

/** The "before you share" checklist. */
export function openShareCheck(wb: Workbook, goToSheet: (id: string) => void): void {
  const findings = shareCheck(wb);
  const { body, actions, close } = dialog("Before you share this workbook");
  if (!findings.length) body.append(Object.assign(document.createElement("p"), { textContent: "Nothing hidden or personal found. What you see is what's in the file." }));
  else {
    body.append(Object.assign(document.createElement("p"), { className: "hp-muted", textContent: "Things in this workbook a recipient could find that may not be on screen. Which file type carries each:" }));
    const t = document.createElement("table");
    t.className = "cleanup-cols";
    t.innerHTML = "<tr><th>What</th><th>.cellforge</th><th>Excel</th><th>CSV</th></tr>";
    const tick = (f: ShareFinding, k: "cellforge" | "xlsx" | "csv") => (f.carriedBy.includes(k) ? "yes" : "—");
    for (const f of findings) {
      const tr = document.createElement("tr");
      const what = document.createElement("td");
      what.textContent = f.text;
      if (f.sheetId) {
        const go = button("Show", () => {
          close();
          goToSheet(f.sheetId!);
        });
        what.append(" ", go);
      }
      tr.append(what, ...(["cellforge", "xlsx", "csv"] as const).map((k) => Object.assign(document.createElement("td"), { textContent: tick(f, k) })));
      t.append(tr);
    }
    const wrap = document.createElement("div");
    wrap.className = "import-preview";
    wrap.append(t);
    body.append(wrap);
    body.append(
      Object.assign(document.createElement("p"), {
        className: "hp-muted",
        textContent:
          "To share less: delete what you don't need, use “PII scan and safe copy…” for personal data, export Excel or CSV (they leave out the history and versions), or save a password-protected copy.",
      }),
    );
  }
  const ok = button("Close", close);
  actions.append(ok);
  ok.focus();
}

/** Ask for a password (twice when setting one). Resolves with it, or null if cancelled. */
export function askPassword(title: string, confirm: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, actions, close } = dialog(title);
    const p1 = Object.assign(document.createElement("input"), { type: "password", autocomplete: confirm ? "new-password" : "current-password" });
    p1.setAttribute("aria-label", "Password");
    const p2 = Object.assign(document.createElement("input"), { type: "password", autocomplete: "new-password" });
    p2.setAttribute("aria-label", "The password again");
    const err = Object.assign(document.createElement("p"), { className: "cleanup-warn", hidden: true });
    const label = (text: string, el: HTMLElement) => {
      const l = document.createElement("label");
      l.append(text, " ", el);
      return l;
    };
    body.append(label("Password", p1));
    if (confirm) {
      body.append(label("Again", p2));
      body.append(
        Object.assign(document.createElement("p"), {
          className: "hp-muted",
          textContent: "At least 8 characters. There's no way to get the data back without it, so keep it somewhere safe. Send the password separately from the file.",
        }),
      );
    }
    body.append(err);
    const done = (v: string | null) => {
      close();
      resolve(v);
    };
    const submit = () => {
      if (confirm && p1.value.length < 8) {
        err.textContent = "Use at least 8 characters.";
        err.hidden = false;
        return;
      }
      if (confirm && p1.value !== p2.value) {
        err.textContent = "The two passwords don't match.";
        err.hidden = false;
        return;
      }
      done(p1.value);
    };
    actions.append(button("Cancel", () => done(null)), button("OK", submit));
    for (const f of [p1, p2]) f.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    p1.focus();
  });
}

/** Confirm clearing everything kept in this browser. */
export function confirmClear(): Promise<boolean> {
  return new Promise((resolve) => {
    const { body, actions, close } = dialog("Clear everything cellforge keeps in this browser?");
    body.append(
      Object.assign(document.createElement("p"), {
        textContent:
          "This deletes the autosaved workbook, its saved versions, the change journal and your settings (recent commands, your reviewer name, locale) from this browser. Files you saved or exported are not touched. It can't be undone.",
      }),
    );
    const done = (v: boolean) => {
      close();
      resolve(v);
    };
    const cancel = button("Keep everything", () => done(false));
    actions.append(cancel, button("Clear it all", () => done(true)));
    cancel.focus();
  });
}
