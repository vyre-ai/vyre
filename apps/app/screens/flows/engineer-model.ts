// The pure half of writing a Flow in text on the real box: flows.compile-text and flows.define answers (kernel/flows canvas.js fromCode, index.js define) as the lines the screen shows.
// Nothing runs until a person approves a version in Flows.

export type Problem = { path?: string; message: string };
export type Effects = { reads?: string[]; writes?: string[]; outward?: string[]; services?: string[]; code?: string[]; asks?: number; assigns?: string[]; sealed_uses?: string[]; destinations?: string[]; model_steps?: string[]; needs_run_ask?: boolean };
export type Checked = { ok: boolean; errors: Problem[]; warnings?: (string | Problem)[]; effects?: Effects; changes?: string[]; hash?: string };
export type Defined = { ok: boolean; id?: string; version?: number; hash?: string; errors?: Problem[]; warnings?: (string | Problem)[]; changes?: string[] };

/** One problem as a line: where, then what. */
export const problemLine = (p: Problem): string => (p.path ? `${p.path}: ${p.message}` : p.message);
export const warnLine = (w: string | Problem): string => (typeof w === "string" ? w : problemLine(w));

/** What the Flow would do, in words, from the kernel's own effects. Empty when it does nothing but wait. */
export function effectLines(e: Effects | undefined): string[] {
  if (!e) return [];
  const list = (a?: string[]) => (a && a.length ? a.join(", ") : "");
  return [
    list(e.reads) && `Reads: ${list(e.reads)}.`,
    list(e.writes) && `Writes: ${list(e.writes)}.`,
    list(e.outward) && `Sends or publishes: ${list(e.outward)}.`,
    list(e.services) && `Calls outside services: ${list(e.services)}.`,
    list(e.destinations) && `Goes to: ${list(e.destinations)}.`,
    list(e.sealed_uses) && `Uses sealed values: ${list(e.sealed_uses)}.`,
    list(e.model_steps) && `Asks a model: ${list(e.model_steps)}.`,
    e.asks ? `Asks a person ${e.asks} ${e.asks === 1 ? "time" : "times"}.` : "",
    list(e.assigns) && `Hands work to: ${list(e.assigns)}.`,
    list(e.code) && `Runs code: ${list(e.code)}.`,
  ].filter(Boolean) as string[];
}

/** The verdict under the editor after Check. */
export function verdict(c: Checked): { tone: "ok" | "warn"; title: string } {
  return c.ok ? { tone: "ok", title: "This is a Flow. Nothing runs until you approve a version." } : { tone: "warn", title: `${c.errors.length} ${c.errors.length === 1 ? "problem" : "problems"} to fix` };
}

/** Where a saved draft lives: the Flow's own page, which shows its card and the approval. */
export const flowHref = (d: Defined): string | null => (d.ok && d.id ? `/u/flows/${d.id}` : null);

export function engineerRefusal(code: string | undefined, message: string): string {
  if (code === "forbidden" || code === "not_allowed") return "You may not write Flows in this space.";
  return message || "Flows did not answer.";
}

export const STARTER = "";
