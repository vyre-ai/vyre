// The pure half of a run's record: the canvas nodes the kernel painted for one run (kernel/flows/canvas.js paintRun) as the lines of what it did.
export type PaintedNode = { id: string; kind?: string; label: string; state?: string; note?: string; count?: number };

const WORD: Record<string, string> = { done: "Done", failed: "Failed", waiting: "Waiting", running: "Running", paused: "Paused", pending: "Not reached" };

/** One line per step, in the Flow's order: its words, what happened, and how many turns a loop took. */
export function recordLines(nodes: PaintedNode[]): { id: string; title: string; sub: string; state: string }[] {
  return nodes.map((n) => {
    const state = n.state ?? "pending";
    const bits = [WORD[state] ?? state, n.count ? `${n.count} times` : "", n.note ?? ""].filter(Boolean);
    return { id: n.id, title: n.label, sub: bits.join(", "), state };
  });
}

/** Only a failed or paused run can be retried (flows.retry puts it back to work after its cause was fixed). */
export const canRetry = (state: string): boolean => state === "failed" || state === "paused";

/** The words for a refused start, from the box's code. */
export function startRefusal(code: string | undefined, message: string): string {
  if (code === "not_active") return "That Flow is paused or has no approved version, so it cannot run.";
  if (code === "not_found") return "That Flow is not yours to run.";
  return message || "That did not start.";
}
