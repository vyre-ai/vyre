// @ts-check
// New project, pure: the four ways a project runs, the stage list a Stages project starts with, and the call that makes one. Personal is pinned and private, never a choice. Tested by kinds.test.js.

export const DEFAULT_STAGES = Object.freeze(["Brief", "Draft", "Review", "Launch", "Wrap up"]);

/** @type {readonly { key: "stages" | "client" | "ongoing" | "simple", label: string, blurb: string }[]} */
export const KINDS = Object.freeze([
  { key: "stages", label: "Stages", blurb: "Moves through steps you name, like Brief, Draft, Review, Launch." },
  { key: "client", label: "For a client", blurb: "Tied to a company or person in Records. Their emails show up here." },
  { key: "ongoing", label: "Ongoing", blurb: "No end date. A board of work, plus Flows that run on their own." },
  { key: "simple", label: "Simple", blurb: "Chats, files and to-dos. Start here if you're not sure." },
]);

/** "Brief, Draft, Review" -> ["Brief", "Draft", "Review"]: trimmed, blanks and repeats dropped (a person typing a list). @param {string} text */
export function parseStages(text) {
  const out = [];
  for (const raw of String(text || "").split(/[,\n]/)) { const s = raw.trim(); if (s && !out.includes(s)) out.push(s); }
  return out;
}

/** Why a stage list cannot start a project, in words, or null. @param {string[]} stages */
export function stagesProblem(stages) {
  if (!stages.length) return "Name at least one stage.";
  if (stages.length > 12) return "Twelve stages at most.";
  if (stages.some((s) => s.length > 60)) return "A stage name is 60 characters at most.";
  return null;
}

/**
 * The work.project.create call for a new project of a kind. `stages` and `client` count only for the kind they belong to.
 * @param {"stages" | "client" | "ongoing" | "simple"} kind @param {{ name: string, stages?: string[], client?: string }} o
 */
export function createInput(kind, o) {
  const input = /** @type {{ name: string, kind: string, stages?: string[], client?: string }} */ ({ name: o.name.trim(), kind });
  if (kind === "stages") input.stages = o.stages && o.stages.length ? o.stages : [...DEFAULT_STAGES];
  if (kind === "client" && o.client) input.client = o.client;
  return input;
}
