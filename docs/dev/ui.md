# UI kit: tokens, buttons, dialogs, panels, toasts, tables, icons

Everything here lives in `apps/web/src/tokens.css`, `apps/web/src/style.css`
and `apps/web/src/ui/`. No dependencies. New UI should use these pieces
instead of building its own backdrop, panel or table.

## Tokens (`tokens.css`)

`style.css` imports `tokens.css` first, so every stylesheet can use them.
Use a token, never a raw colour, size or shadow.

| Group | Tokens |
| --- | --- |
| Type | `--font-ui` (all UI text, titles included), `--font-mono` (formulas, SQL, code only) · `--text-xs` 11 · `--text-sm` 12 · `--text-md` 13 (base) · `--text-lg` 15 (dialog/panel titles) · `--text-xl` 18 · `--text-2xl` 24 · `--weight-regular/medium/semibold/bold` · `--leading`, `--leading-tight` |
| Space | `--space-0-5` 2 · `--space-1` 4 · `--space-1-5` 6 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-8` 32 |
| Shape | `--radius-sm` 4 · `--radius-md` 6 (buttons, inputs) · `--radius-lg` 10 (cards, menus) · `--radius-xl` 14 (dialogs) · `--radius-full` · `--control-h` 30 / `-sm` 24 / `-lg` 36 |
| Surfaces | `--surface-0` sheet and inputs · `--surface-1` chrome, panels, table headers · `--surface-2` dialogs, menus · `--surface-3` hover · `--surface-sunken` wells |
| Lines | `--border-subtle` hairlines · `--border-default` grid lines, control borders · `--border-strong` hover |
| Text | `--text-strong` titles · `--text-default` · `--text-muted` secondary (AA on every surface) · `--text-subtle` placeholders only |
| Accent | `--accent-default` links, focus, selection · `--accent-solid` + `--on-accent` primary buttons · `--accent-soft`, `--accent-soft-strong` selected backgrounds |
| Status | `--success`, `--warning`, `--danger` (text), `-solid` (fills, bars), `-soft` (backgrounds) · finance roles `--match`, `--mismatch`, `--unmatched` |
| Depth | `--shadow-1` buttons · `--shadow-2` menus, popovers · `--shadow-3` dialogs, toasts · `--scrim` modal backdrop |
| Focus | `--focus-ring-color` (a11y.css draws the ring; don't draw your own) |
| Motion | `--dur-fast` 120 · `--dur-med` 180 · `--dur-slow` 260 · `--ease-out`, `--ease-in-out` (reduced motion is honoured globally) |
| Layout | `--dialog-sm/md/lg/xl` 420/560/840/1080 · `--dialog-top` · `--sidepanel-w` · `--z-panel` 40 · `--z-chart` 45 · `--z-dialog` 50 · `--z-popover` 60 · `--z-toast` 70 |

**Themes.** Light by default, dark when the OS asks
(`prefers-color-scheme`). `<html data-theme="light|dark">` forces one. The
grid canvas and charts read the short legacy names (`--bg`, `--panel`,
`--border`, `--text`, `--muted`, `--accent`), which are aliases of the tokens
above; keep them. A future in-app theme switch must also ask the grid and
charts to repaint (they listen to the OS change event only).

## Buttons

Any `<button>` without a class is a **secondary** button. Add a class for
anything else:

| Class | Use |
| --- | --- |
| `btn-primary` | the one main action of a dialog or panel; far right |
| `btn-secondary` | explicit secondary (bordered, with a hairline shadow) |
| `btn-ghost` | toolbars, tertiary actions, icon buttons |
| `btn-danger` | confirms something destructive (filled red) |
| `btn-danger-ghost` | "Delete" inside a list row (red text) |
| `btn-sm` | 24 px tall, for rows and inline tools |
| `btn-icon` | square icon-only button (needs `aria-label`; `iconButton()` does it) |
| `primary` | legacy alias of `btn-primary` |

Footer order: `[tertiary, left] … [Cancel] [Primary]`. Disabled buttons
fade to 45%; give them a `title` saying why.

Existing dialogs (`.palette-backdrop … .numfmt-actions`) get this order and
the primary style automatically from `a11y.ts` (`styleActionRow`): the last
button you can press that isn't Cancel/Close becomes primary (red if it
starts with Delete/Remove/Discard), and Cancel/Close move left of it. A row
with `data-cf-plain`, or one where a button already has a `btn-*` class, is
left alone.

## Form controls

Inputs, selects and textareas are styled globally (30 px, 6 px radius,
accent border and halo on focus, custom select chevron, `accent-color`
checkboxes). Don't restyle them per dialog; set widths only. Labels inside
`.palette-form` / `.cf-dialog__body` stack the caption over the field; a
label holding a checkbox lays out in a row.

## Data tables

`<table class="data-table">`, or any table inside a dialog or panel, gets:
hairline rows, a sticky header (wrap it in `.table-wrap` to scroll), row
hover, tabular numerals. Put `class="num"` on numeric `td`/`th` to
right-align them. Modifiers: `data-table--zebra`, `data-table--dense`;
rows: `is-clickable`, `is-selected`.

`ui/table.ts` builds one for you:

```ts
import { renderTable } from "./ui/table";

const t = renderTable({
  columns: [
    { key: "vendor", label: "Vendor" },
    { key: "date", label: "Date", format: "date" },        // 46023 → 2026-01-01
    { key: "amount", label: "Amount", format: "amount" },  // 1,234.50 · (1,234.50)
    { key: "rows", label: "Rows", format: "integer" },
  ],
  rows: groups,
  select: { initial: (r) => r.flagged, onChange: (idx) => (apply.disabled = !idx.length) },
  onRowClick: (r) => goTo(r.sheetRow),
  maxHeight: "40vh",
  empty: "No duplicates found.",
});
body.append(t.element);
```

Formats: `text`, `number`, `integer`, `amount`, `percent`, `date`, or a
function `(value, row) => string`. `formatCell(value, format, locale)` is
the same formatting on its own.

## Dialog (`ui/dialog.ts`)

```ts
import { openDialog } from "./ui/dialog";

const d = openDialog({
  title: "Find duplicates",
  subtitle: "Rows that match on every key column",
  size: "lg",                         // sm 420 · md 560 (default) · lg 840 · xl 1080
  body: form,                         // Node | string | (Node | string)[]
  actions: [
    { label: "Reset", start: true, onClick: () => { reset(); return false; } },
    { label: "Cancel", dismiss: true },
    { label: "Add result sheet", kind: "primary", onClick: async (dlg) => { await addSheet(); } },
  ],
});
const result = await d.closed;        // "Add result sheet" (or the action's id), or "dismiss"
```

- Fixed header (title, subtitle, ×) and footer; the body scrolls; the
  dialog is never taller than the window and always opens at the same
  height (`--dialog-top`).
- Esc, × and a click on the dimmed backdrop close with `"dismiss"`
  (`dismissible: false` to require an answer).
- `onClick` may return `false` to stay open. A returned promise disables
  the footer while it runs; a thrown error shows in the footer and keeps
  the dialog open (`d.setError(msg)` does the same by hand).
- Focus is trapped, starts at `initialFocus` (element, selector or
  `"primary"`), else the first field that isn't a dropdown (the dialog
  itself when it only has dropdowns), else the primary button, and returns
  to where it was. Esc closes the dialog even when a closed dropdown has
  focus; only an open picker keeps its Esc (`ui/selectpicker.ts`).
- One modal at a time (`ui/modalgate.ts`): while a dialog, the palette or
  the ask bar is open, the app's global shortcuts (Ctrl+K, Ctrl+/, F1, F10,
  Ctrl+F, …) do nothing, and the palette and ask bar refuse to open over it. `role="dialog"` (or `"alertdialog"`), `aria-modal`,
  `aria-labelledby` the title, `aria-describedby` the subtitle.
- Handle: `element`, `body`, `footer`, `button(idOrLabel)`, `setTitle`,
  `setError`, `setBusy`, `close(result?)`, `closed`.

Use a dialog for short, single-step forms and confirmations. Long tools that
need the grid visible (recon results, JE tests, pivot field list, history,
explain, AI chat) belong in the side panel.

## Confirm (`ui/confirm.ts`)

Never call `window.confirm()`/`alert()`.

```ts
import { confirmDialog } from "./ui/confirm";

if (!(await confirmDialog({ title: `Delete "${name}"?`, text: "You can undo this.", confirm: "Delete sheet", danger: true }))) return;
```

Resolves `true` for the confirm button, `false` for anything else. A
`danger` confirmation starts focus on Cancel. Use a verb for `confirm`.
When the action can be undone, prefer doing it and showing a toast with
Undo over asking first.

## Side panel (`ui/sidepanel.ts`)

One right-hand panel for every tool. The grid shrinks to make room (on a
phone the panel covers the sheet). Only one panel shows at a time; opening
another replaces it and shows a Back button. Esc or × closes it. The width
is draggable (300-640 px, remembered) and keyboard-resizable (focus the
left edge, arrow keys).

The shell mounts the host once around the grid's container (if nobody does,
the first `openSidePanel()` mounts it around `#sheet`):

```ts
import { mountSidePanelHost } from "./ui/sidepanel";
mountSidePanelHost(document.getElementById("sheet")!, () => {/* grid watches its own size; optional */});
```

A tool opens a panel:

```ts
import { openSidePanel, closeSidePanel, toggleSidePanel } from "./ui/sidepanel";
import { iconButton } from "./ui/icons";

openSidePanel({
  id: "explain",
  title: "Explain this number",
  subtitle: "Sheet1!F12",
  tools: [iconButton("copy", "Copy the write-up", { onClick: copy })],
  render: (p) => {
    p.body.append(tree);                 // scrolling body
    p.footer.append(doneButton);         // optional fixed footer
    const stop = watchWorkbook(update);
    return stop;                         // runs when the panel leaves
  },
  onClose: () => grid.focus(),           // only on close, not when replaced
});
```

`render` runs again when the user comes Back, so build from state. Also:
`closeSidePanel()`, `sidePanelBack()`, `toggleSidePanel(opts)`,
`currentSidePanel()`, `onSidePanelChange(fn)` (e.g. to light up a rail
button). Inside a panel, `<section class="cf-section"><h3
class="cf-section__title">…` gives the standard section look.

## Toasts (`ui/toast.ts`)

Results and errors go here, not to the status bar.

```ts
import { toast } from "./ui/toast";

toast("Saved on this computer");
toast({ kind: "success", text: "Matched 1,184 of 1,190 rows" });
toast({ kind: "info", text: "Sheet deleted", action: { label: "Undo", run: undo } });
toast({ kind: "error", title: "Couldn't open the file", text: err.message });
const t = toast({ text: "Exporting… 0%", duration: 0 }); t.update("Exporting… 40%"); t.close();
```

info/success leave after 4 s, warnings 6 s, anything with an action at least
6 s; errors stay until closed (`duration: 0` keeps any toast). Hover or
focus pauses the timer; a repeat bumps a ×N counter; at most 4 show. They
are announced to screen readers (errors assertively). `clearToasts()` empties
the stack.

## Icons (`ui/icons.ts`)

Hand-drawn 24×24 stroke icons in `currentColor`: undo, redo, search,
sparkles (ai), upload, open, save, download, export, share, filter, sort,
chart, pivot, table, reconcile, check, audit, shield (evidence), signoff
(review), report, settings, help, close, chevron-up/down/left/right,
arrow-left, plus, more, play, document, database (sql), scale (scenario),
history, info, success, warning, error, trash, copy, formula, calendar,
sidebar, wand (clean up), list-check (checks), checkbox (tick boxes),
dropdown (validation), merge (variants), decimal-more, decimal-less.
Never use `check` as a command icon in a menu: it reads as "this option is
on".

```ts
import { icon, iconButton, iconSvg } from "./ui/icons";

btn.append(icon("undo"), "Undo");                       // 16 px, decorative
rail.append(iconButton("reconcile", "Reconcile"));       // icon-only, aria-label + tooltip
el.innerHTML = iconSvg("sparkles", { size: 20 });        // string form
```

An icon beside text is `aria-hidden`; an icon alone needs a `label` (or use
`iconButton`).

## Focus and accessibility

`a11y.css` draws one ring for keyboard focus everywhere (2 px
`--focus-ring-color`, 2 px offset; inset inside menus and lists). Text
fields show focus with their border and halo instead. Never write
`outline: none` without a visible replacement. Older dialogs built on
`.palette-backdrop` get role, name, Tab trap, Esc and focus return from
`installA11y()`; new ones get them from `openDialog()`.

## Small pieces

- `.cf-badge` (+ `--success`, `--warning`, `--danger`, `--accent`): counts and states.
- `.cf-empty`: centred empty state (icon, line of text, a button).
- `.cf-sr-only`: text for screen readers only.
