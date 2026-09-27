// The approve swipe's answers: optimistic, through the outbox, with a 4 s Undo (ADR 0027 section 5,
// the `approve` bar). Pure: timers, the clock and delivery are passed in, so the Node tests drive
// it with plain numbers.
//
//   held      the row collapsed on the commit frame; the answer waits here for the Undo window.
//             Undo takes it back and the row returns. Nothing has reached the outbox.
//   sending   the window closed (or the page is going away): handed to the outbox, which shows it
//             as sending and delivers it once. No Undo from here: the outbox cannot take an
//             entry back and the box has no reverse for an approval, so Undo is shown only
//             while the answer is unsent.
//   done      the box took it. The row stays gone until the item leaves the list (its event).
//   refused   the box said no: the row comes back with the reason until it is dismissed or
//             answered again.
//
// Why hold instead of queueing at once: core/resilience/outbox.js delivers an entry the moment it
// is added and has no cancel(key), so "cancel the outbox entry if not yet sent" is only possible
// before it is added. The page's hide and pagehide flush every held answer to the outbox
// (flushAll), so closing the app inside the window loses nothing.

import type { Decision, Need } from "./needs-model.ts";

export type Phase = "held" | "sending" | "done" | "refused";

export type Answer = {
  id: string;
  need: Need;
  decision: Decision;
  phase: Phase;
  /** When it was committed. */
  at: number;
  /** When the Undo window closes. */
  until: number;
  reason?: string;
};

export type Outcome = { ok: true } | { ok: false; reason: string };

export type AnswersDeps = {
  undoMs: number;
  now: () => number;
  setTimer: (f: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Hand the answer to the outbox; resolves with the box's answer (never rejects). */
  deliver: (need: Need, decision: Decision) => Promise<Outcome>;
  onChange?: () => void;
  /** The box took an answer: the caller drops the item without waiting for its event. */
  onDone?: (need: Need, decision: Decision) => void;
};

export function createAnswers(d: AnswersDeps) {
  const answers = new Map<string, Answer>();
  const timers = new Map<string, unknown>();
  const changed = () => d.onChange?.();

  function stopTimer(id: string) {
    const t = timers.get(id);
    if (t !== undefined) d.clearTimer(t);
    timers.delete(id);
  }

  async function flush(id: string): Promise<void> {
    const a = answers.get(id);
    if (!a || a.phase !== "held") return;
    stopTimer(id);
    a.phase = "sending";
    changed();
    let out: Outcome;
    try {
      out = await d.deliver(a.need, a.decision);
    } catch (e) {
      out = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    // Undone or replaced meanwhile: only the answer that was sent may settle.
    if (answers.get(id) !== a) return;
    if (out.ok) {
      a.phase = "done";
      d.onDone?.(a.need, a.decision);
    } else {
      a.phase = "refused";
      a.reason = out.reason;
    }
    changed();
  }

  return {
    /**
     * A swipe committed. Returns false when this item already has an answer on its way (a second
     * swipe on a row mid-collapse is ignored).
     */
    commit(need: Need, decision: Decision): boolean {
      const was = answers.get(need.id);
      if (was && was.phase !== "refused") return false;
      const now = d.now();
      answers.set(need.id, { id: need.id, need, decision, phase: "held", at: now, until: now + d.undoMs });
      timers.set(need.id, d.setTimer(() => void flush(need.id), d.undoMs));
      changed();
      return true;
    },
    /** Take a held answer back. False once it has reached the outbox. */
    undo(id: string): boolean {
      const a = answers.get(id);
      if (!a || a.phase !== "held") return false;
      stopTimer(id);
      answers.delete(id);
      changed();
      return true;
    },
    /** Send it now (the Undo window closed early). */
    flush,
    /** The page is going away: every held answer goes to the outbox, which keeps it across a reload. */
    flushAll(): Promise<void[]> {
      return Promise.all([...answers.values()].filter((a) => a.phase === "held").map((a) => flush(a.id)));
    },
    /** The outbox holds the entry for a proof after all: the row comes back with why. */
    refuse(id: string, reason: string): void {
      const a = answers.get(id);
      if (!a || a.phase === "refused" || a.phase === "done") return;
      stopTimer(id);
      a.phase = "refused";
      a.reason = reason;
      changed();
    },
    /** Forget a refusal (the person read it). */
    dismiss(id: string): void {
      const a = answers.get(id);
      if (a && a.phase === "refused") {
        answers.delete(id);
        changed();
      }
    },
    /** The list changed: answers for items that left it are over (done ones, and refusals of gone items). */
    prune(present: Iterable<string>): void {
      const keep = new Set(present);
      let any = false;
      for (const a of [...answers.values()]) {
        if (keep.has(a.id)) continue;
        if (a.phase === "done" || a.phase === "refused") {
          answers.delete(a.id);
          any = true;
        }
      }
      if (any) changed();
    },
    /** Rows the list does not draw: held, sending or done. */
    hidden(): Set<string> {
      const out = new Set<string>();
      for (const a of answers.values()) if (a.phase !== "refused") out.add(a.id);
      return out;
    },
    /** Rows drawn with a reason. */
    refused(): Map<string, string> {
      const out = new Map<string, string>();
      for (const a of answers.values()) if (a.phase === "refused") out.set(a.id, a.reason ?? "Refused");
      return out;
    },
    /** The newest answer still in its Undo window, for the toast. */
    latestHeld(): Answer | null {
      let best: Answer | null = null;
      for (const a of answers.values()) if (a.phase === "held" && (!best || a.at >= best.at)) best = a;
      return best;
    },
    get(id: string): Answer | undefined {
      return answers.get(id);
    },
    get size(): number {
      return answers.size;
    },
  };
}

export type Answers = ReturnType<typeof createAnswers>;

/** The list a view draws: the items minus those answered, oldest first as given. */
export function visibleNeeds(list: readonly Need[], hidden: ReadonlySet<string>): Need[] {
  return hidden.size ? list.filter((n) => !hidden.has(n.id)) : [...list];
}
