// @ts-check
// What the real Flows screens say, from what flows.list, flows.get and flows.graph answer. Pure: the words and the two questions a screen asks ("does this Flow wait for the person?" and "what is it called?"), in one place so
// the list and the page cannot disagree.

/**
 * The warnings of a Flow's page, as lines a person can act on: the kernel's own words without their path, and none about the powers the Flow derives for itself (that note is for whoever writes Flows, and every
 * Flow without declared powers has it).
 * @param {(string | { path?: string, message: string })[] | undefined} ws @returns {string[]}
 */
export const shownWarnings = (ws) => (ws || []).filter((w) => typeof w === "string" || w.path !== "caps").map((w) => (typeof w === "string" ? w : w.message));

/** A Flow's name for a person: its label, else its code name, never its id. @param {{ label?: string, name?: string } | null | undefined} f @param {string} id */
export const titleOf = (f, id) => (f && (f.label || f.name)) || id;

/** A row of flows.list waits for the person when none of its versions is approved yet (an approved Flow has its switch; a paused one is the switch off). @param {{ active?: unknown }} row */
export const listWaits = (row) => !row.active;

/** The version flows.get shows (the one that runs, else the newest) waits for the person when nobody has approved it. @param {{ approver?: unknown }} meta */
export const versionWaits = (meta) => !meta.approver;

/** What the approval button says. Approving a Flow version is a person's own yes in their own session; it is not one of the moments (pairing, the vault, sending) that ask a device for its proof, so the button names no check. */
export const APPROVE_LABEL = "Approve";

/** What a run that shrank to one line says, or null for a run that kept its details. @param {any} run @returns {string | null} */
export const shrunkNote = (run) => (run && run.pruned ? String(run.summary || "This run kept only its outcome.") : null);

/**
 * What a row in the Flows list says about how the Flow is doing: its trigger and the kernel's health line (last run, how many went well this week, what needs you, the next time), and one chip only when it
 * is red (a connection it uses is down, a saved test fails, most runs this week failed). Never invented here: the words come from flows.list.
 * @param {{ trigger?: string, level?: string, line?: string }} f @returns {{ sub: string | undefined, chip: string | null }}
 */
export const healthRow = (f) => {
  // the health first: on a phone the line is cut at one line, and "Red: google is down" must not be the part that is cut
  const sub = [f.line, f.trigger].filter(Boolean).join(" · ");
  return { sub: sub || undefined, chip: f.level === "red" ? "Needs a look" : null };
};

/** How a Flow's own page says how it is doing: a banner for a red or amber one (what is wrong comes first in the line), a quiet line for the rest. @param {{ level?: string, line?: string } | null | undefined} h @returns {{ tone: "err" | "warn" | "quiet", text: string } | null} */
export const healthBanner = (h) => (h && h.line ? { tone: h.level === "red" ? "err" : h.level === "amber" ? "warn" : "quiet", text: h.line } : null);

/** The one plain paragraph flows.describe gives for a run (explain), or nothing: a box without it, or an answer with no words, shows no card. @param {any} d */
export const explainText = (d) => (d && typeof d.explain === "string" ? d.explain.trim() : "");
