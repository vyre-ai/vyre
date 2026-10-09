// @ts-check
// The owner's Design changes screen, as rules without a screen: what each proposal says in a line, and what its answer sends. Pure, so Node tests it.

/** @typedef {{ id: number, kind: "screen" | "css", screenId: string, title: string, why: string, by: string, status: string, before: any, after: any, uses: { reads: string[], runs: string[] }, appliesTo?: string }} Proposal */

/** @param {string} scope */
const scopeWords = scope => (scope === "space" ? "the whole space" : `the ${scope.replace(/^screen:/, "")} screen`);

/** One plain line of what a proposal changes. @param {Proposal} p */
export function headline(p) {
  if (p.kind === "css") return p.before ? `Changes the styling of ${scopeWords(p.screenId)}` : `Adds styling to ${scopeWords(p.screenId)}`;
  return p.before ? `Changes the ${p.title} screen` : `Adds a ${p.title} screen`;
}

/** What the screen reads and what its buttons run, as the owner's yes covers them. @param {Proposal} p */
export function usesLine(p) {
  if (p.kind === "css") return "Styles the web app only. Phones and Lumen keep the design tokens.";
  const r = p.uses.reads.length ? `Reads ${p.uses.reads.join(", ")}.` : "Reads nothing of yours.";
  const x = p.uses.runs.length ? ` Its buttons run ${p.uses.runs.join(", ")}.` : " It has no buttons that run anything.";
  return r + x;
}

/** What the person's tap sends to design.decide. @param {Proposal} p @param {boolean} yes */
export const decision = (p, yes) => ({ id: p.id, yes });

/** Who proposed it, in words: an agent's label is not a name a person knows. @param {string} by */
export function byWords(by) {
  const m = /^mcp:agent:(.+)$/.exec(by);
  if (m) return m[1] === "engineer" ? "The Engineer" : m[1];
  return /^(cli|local|deck|capsule|mobile)$/.test(by) ? "You" : "An agent";
}
