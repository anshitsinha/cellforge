/**
 * Messages for the user. Tools report what happened through one
 * `status(text)` callback; this turns each message into the right toast:
 * errors stay until closed, warnings linger, results come and go, and
 * progress ("Importing… 40%") updates one toast in place that goes away
 * when the job reports its result. The status bar keeps selection stats
 * and the save state only.
 */
import { toast, type ToastHandle, type ToastKind } from "./ui/toast";

export type MessageKind = ToastKind | "progress" | "ignore";

/** What kind of message a tool's status text is. Pure. */
export function classifyMessage(text: string): MessageKind {
  const t = text.trim();
  if (!t || /^ready\.?$/i.test(t)) return "ignore";
  if (/^(couldn'?t|could not|can'?t|cannot|unable|error\b|failed)|\b(failed|went wrong)\b/i.test(t)) return "error";
  if (/(…|\.\.\.)\s*$/.test(t) || /…\s*\d+\s*%/.test(t) || /\b\d{1,3}%\s*(\(|$)/.test(t)) return "progress";
  if (/^(no |nothing|select |pick |choose |at least|there (is|are) no|only |first )|\b(needs?|isn'?t supported|is limited to|not supported|is empty|doesn'?t|don'?t)\b/i.test(t)) return "warning";
  if (/^(saved|downloaded|exported|opened|imported|loaded|added|created|made|matched|sorted|filled|cleared|removed|copied|started|wrote|applied|found|reconciled|picked up|linked|signed|ticked|every |all )/i.test(t)) return "success";
  return "info";
}

export interface Notifier {
  (text: string): void;
  /** close a progress toast that never got its result */
  endProgress(): void;
}

/** A status callback that shows toasts (show is injectable for tests). */
export function createNotifier(show: (o: { kind: ToastKind; text: string; duration?: number }) => ToastHandle = toast): Notifier {
  let progress: ToastHandle | null = null;
  let stale = 0;
  const endProgress = () => {
    progress?.close();
    progress = null;
    clearTimeout(stale);
  };
  const notify = ((text: string) => {
    const kind = classifyMessage(text);
    if (kind === "ignore") return endProgress();
    if (kind === "progress") {
      if (progress) progress.update(text);
      else progress = show({ kind: "info", text, duration: 0 });
      // a job that stops reporting doesn't leave its toast behind forever
      clearTimeout(stale);
      stale = setTimeout(endProgress, 60_000) as unknown as number;
      return;
    }
    endProgress();
    show({ kind, text });
  }) as Notifier;
  notify.endProgress = endProgress;
  return notify;
}
