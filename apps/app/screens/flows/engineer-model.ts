// The pure half of writing a Flow in text on the real box: flows.compile-text and flows.define answers (kernel/flows canvas.js fromCode, index.js define) as the lines the screen shows.
// Nothing runs until a person approves a version in Flows.

export type Problem = { path?: string; message: string };
/** One thing a Flow does, as the kernel gives it (a name, or an object naming the step, the action, the connector, the person or the field it is about). */
type Item = string | { step?: string; action?: string; to?: string; connector?: string; method?: string; path?: string; field?: string; note?: string; with?: string };
export type Effects = { reads?: string[]; writes?: string[]; outward?: Item[]; services?: Item[]; code?: Item[]; asks?: number; assigns?: Item[]; sealed_uses?: Item[]; destinations?: Item[]; model_steps?: string[]; needs_run_ask?: boolean; sends?: Sends };
type Sends = { steps: { step: string; action: string; to: string[]; source: "literal" | "outside"; approve: boolean }[]; allow: string[]; max: number; per_minute: number; outside: "ask" | "run" };
export type Checked = { ok: boolean; errors: Problem[]; warnings?: (string | Problem)[]; effects?: Effects; changes?: string[]; hash?: string };
export type Defined = { ok: boolean; id?: string; version?: number; hash?: string; errors?: Problem[]; warnings?: (string | Problem)[]; changes?: string[] };

/** One problem as a line: where, then what. */
export const problemLine = (p: Problem): string => (p.path ? `${p.path}: ${p.message}` : p.message);
export const warnLine = (w: string | Problem): string => (typeof w === "string" ? w : problemLine(w));

/** What the Flow would do, in words, from the kernel's own effects. Empty when it does nothing but wait. */
export function effectLines(e: Effects | undefined): string[] {
  if (!e) return [];
  // the kernel's effects are objects (the step, the action, who gets the task ...): each is said by the one word that names it, never as "[object Object]"
  const who = (to: string): string => (/^role:/.test(to) ? `the ${to.slice(5)} role` : /^pool:/.test(to) ? `the ${to.slice(5)} pool` : /^teammate:/.test(to) ? to.slice(9) : /^person:/.test(to) ? "a person" : to);
  const word = (x: Item): string => (typeof x === "string" ? (/^(role|pool|teammate|person):/.test(x) ? who(x) : x) : `${x.action || (x.to ? who(x.to) : "") || x.connector || x.field || x.note || x.step || ""}${x.with ? ` (with the yes for ${x.with})` : ""}`);
  const list = (a?: Item[]) => (a && a.length ? [...new Set(a.map(word).filter(Boolean))].join(", ") : "");
  // the one yes at turn-on: who a send goes to on its own, how many, and what still asks a person
  const sd = e.sends, plural = (n: number) => `${n} ${n === 1 ? "send" : "sends"}`;
  const own = sd ? sd.steps.filter(x => !x.approve && (x.source === "literal" || sd.outside === "run")) : [];
  const asks = sd ? sd.steps.filter(x => !own.includes(x)) : [];
  return [
    sd && own.length ? `After you approve it, it sends on its own to ${sd.allow.length ? sd.allow.join(", ") : "its fixed destination"}: up to ${plural(sd.max)} in all and ${plural(sd.per_minute)} a minute, then it stops and tells you.` : "",
    sd && asks.length ? `Still asks you first: ${asks.map(x => x.approve ? `${x.action} (you marked it to always ask)` : `${x.action} (it goes to someone found in the message)`).join(", ")}.` : "",
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
