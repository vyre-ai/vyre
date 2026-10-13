// @ts-check
// The one @Engineer chat's handoff (owner, 13 Oct 03:13Z and 03:17Z): every "Describe it" (Playbooks, Objects, Flows, Agents) opens the same long-running chat and
// sends, at once, a context card: where the person came from, the thing and its current shape, their words and what they want. The Engineer opens with a brainstorm.
// Pure, so Node tests it: the shapes in words, the card, and the message that carries it.

/** @typedef {"playbook"|"object"|"flow"|"agent"} Source */
/** @typedef {"create"|"change"|"explain"} Intent */
/** @typedef {{ source: Source, ref?: string, words?: string, intent?: Intent }} Handoff */
/** @typedef {{ source: Source, label: string, ref: string, name: string, intent: Intent, words: string, shape: string[] }} Card */

/** Where a request can come from, in the words the card uses. */
export const SOURCES = /** @type {Record<Source, { label: string, thing: string }>} */ ({
  playbook: { label: "Playbooks", thing: "playbook" },
  object: { label: "Objects", thing: "object type" },
  flow: { label: "Flows", thing: "Flow" },
  agent: { label: "Agents", thing: "agent" },
});

export const INTENTS = /** @type {Record<Intent, string>} */ ({ create: "Make a new one", change: "Change this one", explain: "Explain this one" });

/** What the person wants, when they did not say: a thing named means change it, none means make one. @param {Handoff} h @returns {Intent} */
export const intentOf = (h) => (h.intent && h.intent in INTENTS ? h.intent : h.ref ? "change" : "create");

const MAX_STAGES = 10, MAX_TASKS = 8, MAX_FIELDS = 24, MAX_STEPS = 16;
const clip = (/** @type {unknown} */ t, n = 80) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const more = (/** @type {number} */ total, /** @type {number} */ shown) => (total > shown ? [`… and ${total - shown} more`] : []);

/** A playbook (a template version) in a few lines: its name and noun, then each stage with its tasks. @param {any} v */
export function playbookShape(v) {
  const b = v?.body ?? v ?? {};
  const stages = Array.isArray(b.stages) ? b.stages : [];
  const head = [clip(b.name || v?.name || "Untitled", 60), b.noun?.one ? `Its projects are called ${b.noun.many || b.noun.one}.` : "", v?.state ? `State: ${v.state}.` : "", b.description ? clip(b.description, 160) : ""].filter(Boolean);
  const lines = stages.slice(0, MAX_STAGES).map((/** @type {any} */ s, /** @type {number} */ i) => {
    const tasks = (Array.isArray(s.tasks) ? s.tasks : []);
    return `${i + 1}. ${clip(s.name, 50)}${tasks.length ? `: ${tasks.slice(0, MAX_TASKS).map((/** @type {any} */ t) => clip(t.title, 40)).join("; ")}${tasks.length > MAX_TASKS ? `; and ${tasks.length - MAX_TASKS} more` : ""}` : " (no tasks yet)"}`;
  });
  return [...head, ...lines, ...more(stages.length, MAX_STAGES), ...(stages.length ? [] : ["No stages yet."])];
}

/** An object type: its name and fields with their kinds. @param {any} t */
export function objectShape(t) {
  const fields = Array.isArray(t?.fields) ? t.fields : [];
  return [clip(t?.plural || t?.label || t?.name || "Object", 60), ...fields.slice(0, MAX_FIELDS).map((/** @type {any} */ f) => `${clip(f.label || f.name, 40)} (${f.kind || "text"})`), ...more(fields.length, MAX_FIELDS), ...(fields.length ? [] : ["No fields yet."])];
}

/** A Flow: its name, state, trigger and steps. @param {{ name?: string, status?: string, trigger?: string, steps?: string[] }} f */
export function flowShape(f) {
  const steps = f.steps ?? [];
  return [clip(f.name || "A Flow", 60), f.status ? `State: ${f.status}.` : "", f.trigger ? `Starts: ${clip(f.trigger, 120)}` : "", ...steps.slice(0, MAX_STEPS).map((s, i) => `${i + 1}. ${clip(s, 80)}`), ...more(steps.length, MAX_STEPS)].filter(Boolean);
}

/** An agent's configuration in a few lines (never a secret: only what agents.list says). @param {any} a */
export function agentShape(a) {
  const works = a?.projects === "*" ? "every project" : Array.isArray(a?.projects) ? `${a.projects.length} project${a.projects.length === 1 ? "" : "s"}` : "no project";
  return [clip(a?.name || "An agent", 60), a?.kind ? `Kind: ${a.kind}.` : "", a?.model ? `Model: ${a.model}.` : "", `Works on ${works}.`, a?.computer ? "Has a computer." : "", a?.status ? `Status: ${a.status}.` : ""].filter(Boolean);
}

/** The card: everything the Engineer needs to start in the right place. @param {Handoff} h @param {{ name?: string, shape?: string[] }} [found] @returns {Card} */
export function contextCard(h, found = {}) {
  return { source: h.source, label: SOURCES[h.source]?.label ?? "Vyre", ref: h.ref ?? "", name: found.name ?? "", intent: intentOf(h), words: String(h.words ?? "").trim(), shape: found.shape ?? [] };
}

/**
 * The message that opens the chat. Human-readable first (the chat draws it as it is), then the same facts as one fenced JSON block the Engineer reads as structured context.
 * @param {Card} c
 */
export function handoffText(c) {
  const thing = SOURCES[c.source]?.thing ?? "thing";
  const where = `From ${c.label}${c.name ? `: ${c.name}` : ""}`;
  const ask = c.words || (c.intent === "create" ? `Help me make a new ${thing}.` : c.intent === "explain" ? `Explain this ${thing} to me.` : `Help me change this ${thing}.`);
  const shape = c.shape.length ? `What it is now:\n${c.shape.map((l) => `- ${l}`).join("\n")}` : c.intent === "create" ? `There is no ${thing} yet: this one is new.` : "";
  const json = JSON.stringify({ source: c.source, ref: c.ref || null, name: c.name || null, intent: c.intent, words: c.words || null, shape: c.shape });
  return [`${where} (${INTENTS[c.intent].toLowerCase()})`, shape, `What I want: ${ask}`, "Start the brainstorm: your read of this, the two or three questions that matter most, and a first draft I can say yes to.", "```engineer-context\n" + json + "\n```"].filter(Boolean).join("\n\n");
}

/** A handoff waiting for the Engineer chat to open. One at a time; taking it clears it, so a reload never sends it twice. */
/** @type {Handoff | null} */
let waiting = null;
export const queueHandoff = (/** @type {Handoff} */ h) => { waiting = { ...h }; };
export const takeHandoff = () => { const h = waiting; waiting = null; return h; };

/** The words when the Engineer cannot be opened. @param {string | undefined} code @param {string} [message] */
export function openRefusal(code, message = "") {
  if (code === "not_allowed" || code === "denied") return "@Engineer is for an owner or an admin of this Space.";
  return message || "The Engineer chat did not open.";
}
