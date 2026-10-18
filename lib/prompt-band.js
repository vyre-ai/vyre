// @ts-check
// prompt-band: whether text that reaches an agent's prompt is an INSTRUCTION or INFORMATION, decided from kernel facts only, never from the field the text sits in or from the text itself
// (team/0.6/DESIGN-agent-prompt.md, sec53's rule). The one function; its callers pass the facts they hold and place the text accordingly (instructions, or inside the fence of lib/prompt-data.js).
//
// Text is an instruction only if
//   (a) it is the APPROVED version of a Flow step's instructions (the version the run is pinned to, not the live draft), and the chain is not tainted; or
//   (b) its requester is a person who holds a use grant on the agent RIGHT NOW (judged by the Gate when the task is built, not stored on the task), and the chain is not tainted.
// A task made from an email, form, webhook, record text or another agent's output is information. A task made by an agent is information unless that agent acts for a person who meets (b) and the chain is
// untainted. Values a Flow fills into a step's instructions (record fields, form answers) are information even where the surrounding step text is instructions. A teammate request from another agent is information.

/**
 * @typedef {{ flowStep?: boolean, flowApproved?: boolean, requesterUses?: boolean, tainted?: boolean, byAgent?: boolean, actsForUses?: boolean, substituted?: boolean, teammate?: boolean }} BandFacts
 * @param {BandFacts} f
 * @returns {"instructions" | "information"}
 */
export function bandOf(f) {
  if (!f || f.tainted === true || f.substituted === true || f.teammate === true) return "information";
  if (f.flowStep === true) return f.flowApproved === true ? "instructions" : "information";
  if (f.byAgent === true) return f.actsForUses === true ? "instructions" : "information";
  return f.requesterUses === true ? "instructions" : "information";
}
